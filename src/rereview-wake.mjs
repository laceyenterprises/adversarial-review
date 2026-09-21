// RPL-04: the durable, idempotent rereview wake queue.
//
// Before this module the only rereview wake was `requestWatcherWake` — a
// single-slot file that the watcher consumes once and forgets. That made the
// wake a fire-and-forget hint: if the watcher was mid-poll, wedged, bouncing,
// or rate-capped when the wake landed, the request evaporated and the PR fell
// back to a full coarse poll interval. Nothing recorded that a rereview had
// ever been asked for, so "why did agent-os#6603 wait 198 minutes after
// remediation pushed?" was unanswerable from the outside.
//
// This queue adds the missing durability without adding a second scheduler:
//
//   producer  -> writes a durable request record AND fires the ordinary
//                watcher wake file. Requests coalesce on
//                (repo, PR, head SHA, reason), so a burst of remediation
//                closeouts on one head is one request, not N.
//   consumer  -> the watcher's admission lane claims pending records for the
//                PR it is already processing, then settles them against the
//                review row it just evaluated.
//
// The consumer deliberately performs NO review-state mutation. It does not
// call `requestReviewRereview`, claim rows, or spawn reviewers. Arming the
// rereview is the producer's job (remediation closeout and the CI-transition
// path both reset the row before they enqueue a wake); this queue only records
// that a wake was asked for and observes what admission did with it. That
// keeps the wake hook outside the bounded-convergence machinery — it cannot
// re-drive a terminal PR, cannot double-spawn a reviewer, and cannot become a
// parallel admission authority. Normal polling remains the fallback for every
// case this queue drops, expires, or never sees.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  ensureReviewStateSchema,
  openReviewStateDb,
  recordReviewLatencyEvent,
} from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const REREVIEW_WAKE_SCHEMA_VERSION = 1;

// Wake reasons are part of the dedupe key, so they must be a closed,
// operator-legible set rather than free text: two producers describing the
// same transition differently would each get their own record for one head.
const REREVIEW_WAKE_REASONS = Object.freeze({
  REMEDIATION_CLOSEOUT: 'remediation-closeout',
  CI_TRANSITION: 'ci-transition',
  FOLLOW_UP_ELIGIBLE: 'follow-up-eligible',
  OPERATOR: 'operator',
});
const KNOWN_REREVIEW_WAKE_REASONS = Object.freeze(new Set(Object.values(REREVIEW_WAKE_REASONS)));

// Watcher-wake reasons. `remediation-closeout` keeps emitting the historical
// `remediation-to-rereview` string because handoff telemetry keys its step
// ledger on it; renaming it would silently zero that surface.
const WATCHER_WAKE_REASON_BY_REREVIEW_REASON = Object.freeze({
  [REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT]: 'remediation-to-rereview',
  [REREVIEW_WAKE_REASONS.CI_TRANSITION]: 'ci-transition-to-rereview',
  [REREVIEW_WAKE_REASONS.FOLLOW_UP_ELIGIBLE]: 'follow-up-to-rereview',
  [REREVIEW_WAKE_REASONS.OPERATOR]: 'operator-rereview-wake',
});

const REREVIEW_WAKE_STATES = Object.freeze({
  REQUESTED: 'requested',
  CLAIMED: 'claimed',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
});

// Kill switch. Deliberately env-only: config.yaml is parsed by three strict
// loaders in two repositories (Python `_schema_v1`, this repo's Node
// config-loader, and the shell allowed-key list), and a key that lands in one
// before the others has crash-looped the watcher before. An env var on the
// launchd plist is the whole lever and needs no schema parity.
const REREVIEW_WAKE_ENABLED_ENV = 'ADVERSARIAL_REREVIEW_WAKE';
const REREVIEW_WAKE_MAX_AGE_ENV = 'ADVERSARIAL_REREVIEW_WAKE_MAX_AGE_MS';

// A request that admission has not been able to settle within this window is
// retired. It is not an error path: polling still covers the PR, and a genuine
// later transition writes a fresh request. The bound exists so a permanently
// blocked PR cannot pin a queue entry forever.
const DEFAULT_REREVIEW_WAKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// How long a settled record suppresses a fresh request for the same key.
//
// Deliberately SHORT, and deliberately not "forever". The race this guards is
// narrow: a second producer firing moments after the first request settled,
// which would re-wake a PR whose re-review already completed. But a head does
// not always move between remediation rounds — a round that only posts a
// refutation leaves the head unchanged — so an unbounded guard would silently
// disable the wake for that PR/head for the rest of retention, and the PR would
// quietly fall back to poll latency with nothing saying why. Past the window, a
// fresh transition is treated as genuinely new.
const REREVIEW_WAKE_RESETTLE_GUARD_MS = 10 * 60 * 1000;
const REREVIEW_WAKE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REREVIEW_WAKE_RETENTION_MAX_FILES = 5000;
// Per-tick drain bound: a backlog must never turn one watcher tick into an
// unbounded filesystem walk.
const REREVIEW_WAKE_SWEEP_LIMIT = 200;

// Review statuses that mean admission has taken the rereview: either it is
// queued for a reviewer or a reviewer already holds it.
const ADMITTED_REVIEW_STATUSES = Object.freeze(new Set(['pending', 'reviewing']));
// Review statuses no wake can move. Settling as `skipped` (rather than holding)
// keeps the backlog honest — an operator reading a non-zero backlog should be
// looking at work that is actually waiting.
const TERMINAL_REVIEW_STATUSES = Object.freeze(new Set([
  'malformed',
  'unroutable-bot-author',
  'argus-security-queued',
]));
const CI_BLOCKED_REVIEW_STATUS = 'ci-blocked';

function rereviewWakeDir(rootDir) {
  return join(rootDir, 'data', 'rereview-wakes');
}

function rereviewWakePendingDir(rootDir) {
  return join(rereviewWakeDir(rootDir), 'pending');
}

function rereviewWakeSettledDir(rootDir) {
  return join(rereviewWakeDir(rootDir), 'settled');
}

function parseBooleanFlag(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  return null;
}

/**
 * Default ON. RPL-04's entire deliverable is that rereviews stop waiting for a
 * coarse poll; shipping it default-off would mean shipping nothing. The lever
 * exists so an operator can disable the queue in place without a revert, and
 * disabling it degrades to exactly the pre-RPL-04 behaviour (poll cadence),
 * never to a stopped pipeline.
 */
function isRereviewWakeEnabled(env = process.env) {
  const parsed = parseBooleanFlag(env?.[REREVIEW_WAKE_ENABLED_ENV]);
  return parsed === null ? true : parsed;
}

function resolveRereviewWakeMaxAgeMs(env = process.env) {
  const parsed = Number.parseInt(String(env?.[REREVIEW_WAKE_MAX_AGE_ENV] ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REREVIEW_WAKE_MAX_AGE_MS;
}

function normalizeRereviewWakeIdentity({ repo, prNumber, headSha = null, reason } = {}) {
  const normalizedRepo = String(repo || '').trim();
  const normalizedPr = Number(prNumber);
  const normalizedHead = String(headSha || '').trim();
  const normalizedReason = String(reason || '').trim();
  if (!normalizedRepo) return { valid: false, invalidReason: 'invalid-wake-repo' };
  if (!Number.isInteger(normalizedPr) || normalizedPr <= 0) {
    return { valid: false, invalidReason: 'invalid-wake-pr-number' };
  }
  if (!normalizedReason) return { valid: false, invalidReason: 'invalid-wake-reason' };
  if (!KNOWN_REREVIEW_WAKE_REASONS.has(normalizedReason)) {
    return { valid: false, invalidReason: 'unknown-wake-reason' };
  }
  return {
    valid: true,
    identity: {
      repo: normalizedRepo,
      prNumber: normalizedPr,
      headSha: normalizedHead || null,
      reason: normalizedReason,
    },
  };
}

// The head SHA is part of the key, so a remediation push that moves the head
// gets its own request rather than colliding with the previous head's. A
// request with no known head collapses to the `-` slot for its (repo, PR,
// reason): without that, an unknown head would defeat dedupe entirely.
function rereviewWakeDedupeKey({ repo, prNumber, headSha = null, reason } = {}) {
  return `${String(repo || '').trim()}#${Number(prNumber)}@${String(headSha || '').trim() || '-'}:${String(reason || '').trim()}`;
}

function rereviewWakeDigest(identity) {
  return createHash('sha256').update(rereviewWakeDedupeKey(identity)).digest('hex');
}

// The subject is carried in the FILENAME, not just the digest, so the per-PR
// drain can reject non-matching records from the directory entry alone. Parsing
// every pending file for every PR in the tick would make a backlog quadratic in
// the merge-critical loop. The digest still decides identity; the slug is only
// a filter key, so a sanitised collision cannot merge two distinct requests.
function rereviewWakeSubjectSlug({ repo, prNumber }) {
  const safeRepo = String(repo || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    // A single dot is legitimate in a repo name; a run of them is only ever a
    // traversal segment surviving the separator rewrite, so collapse it.
    .replace(/\.{2,}/g, '_');
  return `${safeRepo}__pr-${Number(prNumber)}`;
}

function rereviewWakePendingPath(rootDir, identity) {
  return join(
    rereviewWakePendingDir(rootDir),
    `${rereviewWakeSubjectSlug(identity)}__${rereviewWakeDigest(identity)}.json`
  );
}

function rereviewWakeSettledPath(rootDir, identity, state) {
  return join(
    rereviewWakeSettledDir(rootDir),
    `${rereviewWakeSubjectSlug(identity)}__${rereviewWakeDigest(identity)}.${state}.json`
  );
}

function readRereviewWake(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function sweepSettledRereviewWakes(
  rootDir,
  {
    nowMs = Date.now(),
    maxAgeMs = REREVIEW_WAKE_RETENTION_MS,
    maxFiles = REREVIEW_WAKE_RETENTION_MAX_FILES,
  } = {}
) {
  const dir = rereviewWakeSettledDir(rootDir);
  let entries;
  try {
    entries = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return { removed: 0, retained: null };
  }
  let removed = 0;
  let retained = 0;
  for (const entry of entries) {
    const expired = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && nowMs - entry.mtimeMs > maxAgeMs;
    const overLimit = Number.isFinite(maxFiles) && maxFiles >= 0 && retained >= maxFiles;
    if (!expired && !overLimit) {
      retained += 1;
      continue;
    }
    try {
      rmSync(entry.path, { force: true });
      removed += 1;
    } catch {
      retained += 1;
    }
  }
  return { removed, retained };
}

/**
 * Write one `rereview_wake` latency row. Telemetry is strictly best-effort:
 * the queue's correctness lives in the request files, and a locked or missing
 * reviews.db must never turn a delivered wake into a failed one.
 */
function recordRereviewWakeLatencyEvent({
  rootDir,
  record,
  state,
  reason,
  at,
  db: dbOverride = null,
  log = console,
} = {}) {
  const db = dbOverride || null;
  let owned = null;
  try {
    const handle = db || (owned = openReviewStateDb(rootDir));
    ensureReviewStateSchema(handle);
    const key = rereviewWakeDedupeKey(record);
    recordReviewLatencyEvent(handle, {
      repo: record.repo,
      prNumber: record.prNumber,
      domainId: record.domainId || 'code-pr',
      subjectExternalId: record.subjectExternalId || `${record.repo}#${record.prNumber}`,
      revisionRef: record.headSha || null,
      eventType: 'rereview_wake',
      at,
      source: record.source || 'rereview-wake',
      sourceRef: record.sourceRef || record.requestId || null,
      idempotencyKey: `rereview-wake:${state}:${key}`,
      reason: reason || record.reason,
      payload: {
        state,
        wakeReason: record.reason,
        headSha: record.headSha || null,
        requestId: record.requestId || null,
        source: record.source || null,
        sourceRef: record.sourceRef || null,
        ...(reason && reason !== record.reason ? { stateReason: reason } : {}),
      },
    });
    return { recorded: true, state };
  } catch (err) {
    log?.warn?.(
      `[rereview-wake] latency event (${state}) failed for `
      + `${record?.repo}#${record?.prNumber}: ${err?.message || err}`
    );
    return { recorded: false, state, error: err?.message || String(err) };
  } finally {
    try {
      owned?.close?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

/**
 * Open one review-state handle for a whole drain/sweep pass.
 *
 * Every state transition writes a latency row, and opening a connection per
 * row would mean 2N connections per PR per tick in the merge-critical loop.
 * The handle is opened lazily — only once a pass knows it has work — and a
 * failure to open degrades to `null`, which each event writer already treats
 * as "open your own, best-effort".
 */
function withReviewStateHandle(rootDir, injected, run) {
  if (injected) return run(injected);
  let owned = null;
  try {
    owned = openReviewStateDb(rootDir);
  } catch {
    owned = null;
  }
  try {
    return run(owned);
  } finally {
    try {
      owned?.close?.();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

/**
 * Enqueue a durable rereview wake and nudge the watcher.
 *
 * Idempotency is the exclusive-create on the pending record: the second caller
 * for the same (repo, PR, head, reason) gets `outcome: 'duplicate'` and fires
 * no second watcher wake. A record that has already been settled for this key
 * is treated the same way — a completed rereview must not be re-woken by a
 * late duplicate producer.
 */
function requestRereviewWake({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha = null,
  reason = REREVIEW_WAKE_REASONS.FOLLOW_UP_ELIGIBLE,
  source = 'unknown',
  sourceRef = null,
  domainId = null,
  subjectExternalId = null,
  requestedAt = new Date().toISOString(),
  requestId = randomUUID(),
  env = process.env,
  requestWatcherWakeImpl = requestWatcherWake,
  db = null,
  log = console,
} = {}) {
  const normalized = normalizeRereviewWakeIdentity({ repo, prNumber, headSha, reason });
  if (!normalized.valid) {
    return { requested: false, outcome: 'invalid', reason: normalized.invalidReason };
  }
  const identity = normalized.identity;
  // Subject fields only. Spreading the whole identity here would drag its
  // `reason` (the WAKE reason) over every return's diagnostic `reason`, which
  // is how a coalesced duplicate would come back looking like a fresh request.
  const subject = { repo: identity.repo, prNumber: identity.prNumber, headSha: identity.headSha };
  const wakeReason = identity.reason;
  if (!isRereviewWakeEnabled(env)) {
    return { requested: false, outcome: 'disabled', reason: 'rereview-wake-disabled', wakeReason, ...subject };
  }

  const recordPath = rereviewWakePendingPath(rootDir, identity);
  const record = {
    schemaVersion: REREVIEW_WAKE_SCHEMA_VERSION,
    event: 'rereview_wake',
    requestId: String(requestId),
    ...identity,
    source: String(source || 'unknown'),
    sourceRef: sourceRef ? String(sourceRef) : null,
    domainId: domainId || null,
    subjectExternalId: subjectExternalId || null,
    state: REREVIEW_WAKE_STATES.REQUESTED,
    requestedAt,
    claimedAt: null,
    claimCount: 0,
    holdReason: null,
    holdCount: 0,
    lastObservedAt: null,
    settledAt: null,
    settledReason: null,
    watcherWake: null,
  };

  try {
    mkdirSync(rereviewWakePendingDir(rootDir), { recursive: true });
    mkdirSync(rereviewWakeSettledDir(rootDir), { recursive: true });
  } catch (err) {
    return {
      requested: false,
      outcome: 'failed',
      reason: 'wake-queue-dir-unavailable',
      error: err?.message || String(err),
      wakeReason,
      ...subject,
    };
  }
  sweepSettledRereviewWakes(rootDir);

  // A record that settled moments ago means this head+reason has just run its
  // course; re-enqueueing would re-wake a PR whose re-review already completed.
  // The guard is time-bounded (see REREVIEW_WAKE_RESETTLE_GUARD_MS) so a later,
  // genuinely new transition on an unchanged head is not suppressed forever.
  const requestedMs = toMs(requestedAt) ?? Date.now();
  for (const state of [REREVIEW_WAKE_STATES.COMPLETED, REREVIEW_WAKE_STATES.SKIPPED]) {
    const prior = readRereviewWake(rereviewWakeSettledPath(rootDir, identity, state));
    if (!prior) continue;
    const settledMs = toMs(prior.settledAt);
    // An unreadable settle time fails OPEN — toward flow, not toward a silently
    // wedged wake.
    if (settledMs === null || requestedMs - settledMs > REREVIEW_WAKE_RESETTLE_GUARD_MS) continue;
    return { requested: false, outcome: 'duplicate', reason: `wake-already-${state}`, wakeReason, ...subject };
  }

  try {
    writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`, { overwrite: false });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { requested: false, outcome: 'duplicate', reason: 'wake-already-pending', recordPath, wakeReason, ...subject };
    }
    return {
      requested: false,
      outcome: 'failed',
      reason: 'wake-reservation-failed',
      error: err?.message || String(err),
      recordPath,
      wakeReason,
      ...subject,
    };
  }

  let watcherWake;
  try {
    const wake = requestWatcherWakeImpl({
      rootDir,
      reason: WATCHER_WAKE_REASON_BY_REREVIEW_REASON[identity.reason] || 'rereview-eligible',
      repo: identity.repo,
      prNumber: identity.prNumber,
      ...(identity.headSha ? { headSha: identity.headSha } : {}),
      requestedAt,
    });
    watcherWake = {
      requested: wake?.requested === true,
      reason: wake?.payload?.reason || null,
      requestedAt: wake?.payload?.requested_at || requestedAt,
      requestId: wake?.payload?.request_id || null,
    };
  } catch (err) {
    // The durable record survives a failed transport on purpose. The watcher's
    // next ordinary poll drains it, so a wake-file failure costs poll latency
    // rather than the rereview itself.
    watcherWake = { requested: false, reason: 'wake-transport-failed', error: err?.message || String(err) };
    log?.warn?.(
      `[rereview-wake] watcher wake transport failed for ${identity.repo}#${identity.prNumber}: `
      + `${err?.message || err}`
    );
  }
  record.watcherWake = watcherWake;
  try {
    writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // The reservation is already durable; the transport annotation is not.
  }

  const latencyEvent = recordRereviewWakeLatencyEvent({
    rootDir,
    record,
    state: REREVIEW_WAKE_STATES.REQUESTED,
    reason: identity.reason,
    at: requestedAt,
    db,
    log,
  });

  return {
    requested: true,
    outcome: REREVIEW_WAKE_STATES.REQUESTED,
    reason: 'wake-enqueued',
    wakeReason,
    requestedAt,
    requestId: record.requestId,
    recordPath,
    watcherWake,
    latencyEvent,
    ...subject,
  };
}

function listPendingRereviewWakes(rootDir, { repo = null, prNumber = null, limit = null } = {}) {
  let names;
  try {
    names = readdirSync(rereviewWakePendingDir(rootDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const wantRepo = String(repo || '').trim();
  const wantPr = Number(prNumber);
  const hasPrFilter = Number.isInteger(wantPr) && wantPr > 0;
  // Subject-scoped lookups never open a file that cannot match. The record
  // contents are still authoritative — the slug prefix only narrows the scan.
  const namePrefix = wantRepo && hasPrFilter
    ? `${rereviewWakeSubjectSlug({ repo: wantRepo, prNumber: wantPr })}__`
    : null;
  const records = [];
  for (const name of names) {
    if (namePrefix && !name.startsWith(namePrefix)) continue;
    const path = join(rereviewWakePendingDir(rootDir), name);
    const record = readRereviewWake(path);
    if (!record) continue;
    if (wantRepo && String(record.repo || '') !== wantRepo) continue;
    if (hasPrFilter && Number(record.prNumber) !== wantPr) continue;
    records.push({ ...record, recordPath: path });
  }
  records.sort((a, b) => (toMs(a.requestedAt) || 0) - (toMs(b.requestedAt) || 0));
  return Number.isInteger(limit) && limit > 0 ? records.slice(0, limit) : records;
}

/**
 * Decide what admission did with a pending request. Pure: no filesystem, no
 * database, no clock beyond the `nowMs` it is handed — so every branch below
 * is directly testable from a fixture row.
 */
function classifyRereviewWakeOutcome({
  record,
  reviewRow = null,
  currentHeadSha = null,
  subjectTerminal = false,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_REREVIEW_WAKE_MAX_AGE_MS,
} = {}) {
  const prState = String(reviewRow?.pr_state || '').trim();
  const reviewStatus = String(reviewRow?.review_status || '').trim();
  const requestedHead = String(record?.headSha || '').trim();
  const observedHead = String(currentHeadSha || '').trim();

  if (subjectTerminal || prState === 'merged' || prState === 'closed') {
    return { state: REREVIEW_WAKE_STATES.SKIPPED, reason: 'pr-terminal' };
  }
  if (!reviewRow) {
    return { state: REREVIEW_WAKE_STATES.SKIPPED, reason: 'review-row-missing' };
  }
  // A newer head has landed since the wake was written. The wake for THAT head
  // is the live one; this record describes work that no longer exists.
  if (requestedHead && observedHead && requestedHead !== observedHead) {
    return { state: REREVIEW_WAKE_STATES.SKIPPED, reason: 'head-superseded' };
  }
  if (TERMINAL_REVIEW_STATUSES.has(reviewStatus)) {
    return { state: REREVIEW_WAKE_STATES.SKIPPED, reason: `review-status-terminal:${reviewStatus}` };
  }
  if (ADMITTED_REVIEW_STATUSES.has(reviewStatus)) {
    return { state: REREVIEW_WAKE_STATES.COMPLETED, reason: `rereview-admitted:${reviewStatus}` };
  }
  // The reviewer already posted on the head this wake asked about, at or after
  // the request — the wake got what it wanted even though it never observed
  // the intermediate `pending`/`reviewing` window.
  if (reviewStatus === 'posted') {
    const postedMs = toMs(reviewRow.posted_at);
    const requestedMs = toMs(record?.requestedAt);
    const postedHead = String(reviewRow.reviewer_head_sha || reviewRow.revision_ref || '').trim();
    const headMatches = !requestedHead || !postedHead || postedHead === requestedHead;
    if (headMatches && postedMs !== null && requestedMs !== null && postedMs >= requestedMs) {
      return { state: REREVIEW_WAKE_STATES.COMPLETED, reason: 'rereview-posted' };
    }
  }

  const hold = reviewStatus === CI_BLOCKED_REVIEW_STATUS
    ? 'ci-blocked'
    : `awaiting-admission:${reviewStatus || 'unknown'}`;
  const requestedMs = toMs(record?.requestedAt);
  if (requestedMs !== null && Number.isFinite(maxAgeMs) && nowMs - requestedMs > maxAgeMs) {
    return { state: REREVIEW_WAKE_STATES.SKIPPED, reason: `wake-expired:${hold}` };
  }
  return { state: 'pending', reason: hold };
}

function persistPendingRereviewWake(record, log) {
  try {
    writeFileAtomic(record.recordPath, `${JSON.stringify(stripRuntimeFields(record), null, 2)}\n`);
    return true;
  } catch (err) {
    log?.warn?.(
      `[rereview-wake] could not persist wake state for ${record?.repo}#${record?.prNumber}: `
      + `${err?.message || err}`
    );
    return false;
  }
}

// `recordPath` is where the record lives, not part of the record. Strip it
// before every write so a queue file never carries a stale absolute path.
function stripRuntimeFields({ recordPath: _recordPath, ...rest }) {
  return rest;
}

/**
 * Move a pending record into its terminal slot.
 *
 * The rename is the CAS and it happens FIRST, before the enriched content is
 * written. Writing the settled file and then unlinking the pending one is not a
 * CAS: the loser of a race recreates the pending file with its own write and
 * both callers "settle" the same request, producing two terminal records and
 * two terminal latency events. Renaming first means exactly one caller can move
 * the inode; every other caller gets ENOENT and reports the request as already
 * settled without emitting anything.
 */
function settleRereviewWake({
  rootDir = ROOT,
  record,
  state,
  reason,
  at = new Date().toISOString(),
  db = null,
  log = console,
} = {}) {
  const settledPath = rereviewWakeSettledPath(rootDir, record, state);
  const settled = {
    ...stripRuntimeFields(record),
    state,
    settledAt: at,
    settledReason: reason,
    lastObservedAt: at,
  };
  try {
    mkdirSync(rereviewWakeSettledDir(rootDir), { recursive: true });
    renameSync(record.recordPath, settledPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { settled: false, state, reason: 'wake-already-settled' };
    }
    log?.warn?.(
      `[rereview-wake] could not settle wake for ${record?.repo}#${record?.prNumber}: `
      + `${err?.message || err}`
    );
    return { settled: false, state, reason, error: err?.message || String(err) };
  }
  try {
    writeFileAtomic(settledPath, `${JSON.stringify(settled, null, 2)}\n`);
  } catch (err) {
    // The transition already happened; only the enrichment is missing. The
    // record is out of the backlog either way, which is what correctness needs.
    log?.warn?.(
      `[rereview-wake] settled wake for ${record?.repo}#${record?.prNumber} but could not `
      + `annotate it: ${err?.message || err}`
    );
  }
  const latencyEvent = recordRereviewWakeLatencyEvent({
    rootDir, record: settled, state, reason, at, db, log,
  });
  return { settled: true, state, reason, settledPath, latencyEvent };
}

/**
 * Drain every pending request for one PR against the review row admission just
 * evaluated. Called from the watcher's admission lane, so "claimed" is the
 * moment the admission lane actually looked at the request — that is the
 * number the latency report turns into rereview wake pickup time.
 */
function consumeRereviewWakes({
  rootDir = ROOT,
  repo,
  prNumber,
  reviewRow = null,
  currentHeadSha = null,
  subjectTerminal = false,
  at = new Date().toISOString(),
  env = process.env,
  db = null,
  log = console,
  limit = REREVIEW_WAKE_SWEEP_LIMIT,
} = {}) {
  const summary = { claimed: 0, completed: 0, skipped: 0, held: 0, outcomes: [] };
  let pending;
  try {
    pending = listPendingRereviewWakes(rootDir, { repo, prNumber, limit });
  } catch (err) {
    log?.warn?.(`[rereview-wake] could not list wakes for ${repo}#${prNumber}: ${err?.message || err}`);
    return summary;
  }
  if (pending.length === 0) return summary;

  const nowMs = toMs(at) ?? Date.now();
  const maxAgeMs = resolveRereviewWakeMaxAgeMs(env);
  return withReviewStateHandle(rootDir, db, (handle) => {
    for (const record of pending) {
      // Claim first, unconditionally: a request that is observed but never
      // settled still needs a visible pickup time, otherwise a permanently held
      // wake looks identical to one the watcher never saw.
      const firstClaim = record.state === REREVIEW_WAKE_STATES.REQUESTED;
      record.state = REREVIEW_WAKE_STATES.CLAIMED;
      record.claimCount = Number(record.claimCount || 0) + 1;
      record.claimedAt = record.claimedAt || at;
      record.lastObservedAt = at;
      if (firstClaim) {
        summary.claimed += 1;
        recordRereviewWakeLatencyEvent({
          rootDir,
          record,
          state: REREVIEW_WAKE_STATES.CLAIMED,
          reason: record.reason,
          at,
          db: handle,
          log,
        });
      }

      const outcome = classifyRereviewWakeOutcome({
        record, reviewRow, currentHeadSha, subjectTerminal, nowMs, maxAgeMs,
      });
      if (outcome.state === 'pending') {
        record.state = REREVIEW_WAKE_STATES.CLAIMED;
        record.holdReason = outcome.reason;
        record.holdCount = Number(record.holdCount || 0) + 1;
        persistPendingRereviewWake(record, log);
        summary.held += 1;
        summary.outcomes.push({ requestId: record.requestId, state: 'pending', reason: outcome.reason });
        continue;
      }
      const settleResult = settleRereviewWake({
        rootDir, record, state: outcome.state, reason: outcome.reason, at, db: handle, log,
      });
      if (outcome.state === REREVIEW_WAKE_STATES.COMPLETED) summary.completed += 1;
      else summary.skipped += 1;
      summary.outcomes.push({
        requestId: record.requestId,
        state: outcome.state,
        reason: outcome.reason,
        settled: settleResult.settled,
      });
    }
    return summary;
  });
}

/**
 * Once-per-tick backstop for requests the per-PR admission lane never reaches:
 * a PR that dropped out of the open-PR listing, a repo removed from the watch
 * set, or a request written for a PR the watcher has never seen. Without it
 * those records would sit in the backlog until retention age.
 */
function sweepRereviewWakeQueue({
  rootDir = ROOT,
  lookupReviewRow,
  at = new Date().toISOString(),
  env = process.env,
  db = null,
  log = console,
  limit = REREVIEW_WAKE_SWEEP_LIMIT,
} = {}) {
  const summary = { scanned: 0, completed: 0, skipped: 0, held: 0 };
  if (typeof lookupReviewRow !== 'function') return summary;
  let pending;
  try {
    pending = listPendingRereviewWakes(rootDir, { limit });
  } catch (err) {
    log?.warn?.(`[rereview-wake] backlog sweep could not list wakes: ${err?.message || err}`);
    return summary;
  }
  if (pending.length === 0) return summary;
  const nowMs = toMs(at) ?? Date.now();
  const maxAgeMs = resolveRereviewWakeMaxAgeMs(env);
  return withReviewStateHandle(rootDir, db, (handle) => {
    for (const record of pending) {
      summary.scanned += 1;
      let reviewRow = null;
      try {
        reviewRow = lookupReviewRow(record.repo, record.prNumber) || null;
      } catch (err) {
        log?.warn?.(
          `[rereview-wake] backlog sweep could not read ${record.repo}#${record.prNumber}: `
          + `${err?.message || err}`
        );
        summary.held += 1;
        continue;
      }
      const outcome = classifyRereviewWakeOutcome({
        record,
        reviewRow,
        // The sweep has no live subject snapshot; the mirrored row's pr_state is
        // the only terminal signal it can honour, and `classifyRereviewWakeOutcome`
        // already reads it.
        currentHeadSha: reviewRow?.revision_ref || null,
        nowMs,
        maxAgeMs,
      });
      if (outcome.state === 'pending') {
        record.holdReason = outcome.reason;
        record.lastObservedAt = at;
        persistPendingRereviewWake(record, log);
        summary.held += 1;
        continue;
      }
      settleRereviewWake({ rootDir, record, state: outcome.state, reason: outcome.reason, at, db: handle, log });
      if (outcome.state === REREVIEW_WAKE_STATES.COMPLETED) summary.completed += 1;
      else summary.skipped += 1;
    }
    return summary;
  });
}

/**
 * Backlog shape for the RPL latency report and the operator CLI: how many
 * rereview wakes are outstanding, how old the oldest one is, and what is
 * holding them.
 */
function rereviewWakeBacklog({ rootDir = ROOT, nowMs = Date.now(), limit = null } = {}) {
  const pending = listPendingRereviewWakes(rootDir, { limit });
  const byReason = new Map();
  const byHoldReason = new Map();
  let oldest = null;
  let claimed = 0;
  const entries = pending.map((record) => {
    const requestedMs = toMs(record.requestedAt);
    const ageMs = requestedMs === null ? null : Math.max(0, nowMs - requestedMs);
    const claimedMs = toMs(record.claimedAt);
    const entry = {
      repo: record.repo,
      prNumber: record.prNumber,
      headSha: record.headSha || null,
      reason: record.reason,
      source: record.source || null,
      state: record.state,
      requestedAt: record.requestedAt,
      claimedAt: record.claimedAt || null,
      claimCount: Number(record.claimCount || 0),
      holdReason: record.holdReason || null,
      holdCount: Number(record.holdCount || 0),
      ageMs,
      claimLatencyMs: requestedMs !== null && claimedMs !== null ? Math.max(0, claimedMs - requestedMs) : null,
    };
    byReason.set(record.reason, (byReason.get(record.reason) || 0) + 1);
    if (entry.holdReason) byHoldReason.set(entry.holdReason, (byHoldReason.get(entry.holdReason) || 0) + 1);
    if (entry.state === REREVIEW_WAKE_STATES.CLAIMED) claimed += 1;
    if (ageMs !== null && (oldest === null || ageMs > oldest.ageMs)) oldest = entry;
    return entry;
  });
  entries.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  const toSortedCounts = (map) => [...map.entries()]
    .map(([key, count]) => ({ reason: key, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return {
    pending: entries.length,
    claimed,
    unclaimed: entries.length - claimed,
    oldest,
    oldestAgeMs: oldest ? oldest.ageMs : null,
    byReason: toSortedCounts(byReason),
    byHoldReason: toSortedCounts(byHoldReason),
    entries,
  };
}

export {
  DEFAULT_REREVIEW_WAKE_MAX_AGE_MS,
  KNOWN_REREVIEW_WAKE_REASONS,
  REREVIEW_WAKE_ENABLED_ENV,
  REREVIEW_WAKE_MAX_AGE_ENV,
  REREVIEW_WAKE_REASONS,
  REREVIEW_WAKE_RESETTLE_GUARD_MS,
  REREVIEW_WAKE_RETENTION_MAX_FILES,
  REREVIEW_WAKE_RETENTION_MS,
  REREVIEW_WAKE_SCHEMA_VERSION,
  REREVIEW_WAKE_STATES,
  REREVIEW_WAKE_SWEEP_LIMIT,
  WATCHER_WAKE_REASON_BY_REREVIEW_REASON,
  classifyRereviewWakeOutcome,
  consumeRereviewWakes,
  isRereviewWakeEnabled,
  listPendingRereviewWakes,
  normalizeRereviewWakeIdentity,
  readRereviewWake,
  rereviewWakeBacklog,
  rereviewWakeDedupeKey,
  rereviewWakeDir,
  rereviewWakePendingDir,
  rereviewWakePendingPath,
  rereviewWakeSettledDir,
  rereviewWakeSettledPath,
  requestRereviewWake,
  resolveRereviewWakeMaxAgeMs,
  settleRereviewWake,
  sweepRereviewWakeQueue,
  sweepSettledRereviewWakes,
};
