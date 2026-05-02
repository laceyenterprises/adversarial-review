// Durable PR-comment delivery state for terminal follow-up jobs.
//
// Why this exists: reconcile must move a job to a terminal directory
// (completed/stopped/failed) atomically — otherwise a crash mid-tick
// leaves the queue in a bad state. But comment posting is an
// unreliable network call (gh outage, auth flakiness, missing token,
// the recently-added timeout). If the comment fails AFTER the
// terminal move, the queue advanced but the PR is silent. Without a
// durable record of "the comment is owed but not yet delivered", we
// have no way to retry, and the docs would lie when they say
// "if there's no PR comment, reconcile didn't run".
//
// Design:
//   1. After reconcile moves a job to terminal, post the comment
//      (with a hard timeout — see src/pr-comments.mjs).
//   2. Stamp the result into the terminal job record under
//      `commentDelivery`. Includes the rendered body so the retry
//      path can re-post without recomputing it from scratch.
//   3. On every tick, `retryFailedCommentDeliveries` walks the
//      terminal directories, picks up records where
//      `commentDelivery.posted === false` and `attempts < cap`,
//      retries via the same poster, updates the record on success.
//
// Cap: 5 attempts. After that the record stays at posted=false for
// human inspection; the daemon does not silently keep hammering.

import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { getFollowUpJobDir, readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { buildRemediationOutcomeCommentBody, postRemediationOutcomeComment } from './pr-comments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Maximum number of times the retry pass will re-attempt a failed
// comment. After this, the record sits in terminal/ with posted=false
// for an operator to inspect (or clear by hand).
const MAX_COMMENT_DELIVERY_ATTEMPTS = 5;

// How many retry candidates a single tick processes. Bounds the
// per-tick wall-clock so a backlog of failed deliveries doesn't
// starve the live consume/reconcile pipeline. With a 30s gh timeout
// + 5 records per tick + 120s tick interval, the worst-case retry
// drain is 5 records per 2 minutes — slow enough not to crowd live
// work, fast enough that a transient outage clears in minutes.
const RETRY_BUDGET_PER_TICK = 5;

// How long a delivery claim is honored before another process can
// take over. Set generously above the gh subprocess timeout (30s)
// + a safety margin: a process that took the claim must either
// finish before this timer expires or be considered crashed. A
// stale claim is reclaimable; this is the recovery window.
const DELIVERY_CLAIM_STALE_MS = 5 * 60 * 1000; // 5 minutes

// Reasons that mean "the comment was never going to be deliverable
// from this configuration" — retrying achieves nothing. The retry
// pass skips records with these reasons (but they still stay marked
// posted=false so an operator sees them).
const NON_RETRYABLE_DELIVERY_REASONS = new Set([
  'missing-pr-coordinates',
  'no-token-mapping',
]);

// Pre-move "comment owed" stamp. Used by reconcile to embed delivery
// debt into the terminal record atomically with the move-to-terminal
// write — otherwise there is a crash window where a record can land in
// completed/stopped/failed without any commentDelivery field, and the
// retry walker (which historically filtered out missing-delivery
// records) would skip it forever. With this shape on the record, the
// retry walker has every field it needs (body, repo, prNumber,
// workerClass) to deliver without touching any other artifact.
function buildOwedDelivery({
  body,
  repo,
  prNumber,
  workerClass,
  owedAt,
}) {
  return {
    posted: false,
    attempting: false,
    reason: null,
    error: null,
    timeoutMs: null,
    attempts: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    owedAt,
    body,
    repo,
    prNumber,
    workerClass,
  };
}

function buildPendingDelivery({
  body,
  repo,
  prNumber,
  workerClass,
  postResult,
  attemptedAt,
}) {
  // Always include the rendered body + addressing info so the retry
  // pass doesn't need to reconstruct the body from the job record
  // (which would require re-parsing the worker's reply artifact and
  // re-running the body builder, brittle across schema changes).
  // `attempting: false` is explicit so consumers can distinguish a
  // settled record (this shape) from an in-flight one
  // (buildAttemptingDelivery → attempting: true).
  return {
    posted: Boolean(postResult?.posted),
    attempting: false,
    reason: postResult?.posted ? null : (postResult?.reason || 'unknown'),
    error: postResult?.error || null,
    timeoutMs: postResult?.timeoutMs ?? null,
    attempts: 1,
    firstAttemptAt: attemptedAt,
    lastAttemptAt: attemptedAt,
    body,
    repo,
    prNumber,
    workerClass,
  };
}

function buildAttemptingDelivery({
  body,
  repo,
  prNumber,
  workerClass,
  attemptedAt,
  attempts = 1,
  firstAttemptAt,
}) {
  // Pre-flight stamp written BEFORE the gh call. If the process
  // dies between this write and the post-call update, the retry
  // pass sees attempting=true and (assuming the lock is stale)
  // takes ownership and re-attempts. Without this pre-write the
  // owed comment would be lost on a crash window between the gh
  // call and the post-call stamp.
  return {
    posted: false,
    attempting: true,
    reason: null,
    error: null,
    timeoutMs: null,
    attempts,
    firstAttemptAt: firstAttemptAt || attemptedAt,
    lastAttemptAt: attemptedAt,
    body,
    repo,
    prNumber,
    workerClass,
  };
}

function readTerminalRecord(jobPath) {
  const raw = readFileSync(jobPath, 'utf8');
  return JSON.parse(raw);
}

function writeTerminalRecord(jobPath, record) {
  // Atomic update: write to a sibling .tmp file then rename.
  // Truncating the original in-place would leave a half-written file
  // visible to a concurrent reader on a crash mid-write.
  const tmp = `${jobPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  renameSync(tmp, jobPath);
}

// ── Delivery claim (sidecar lock file) ────────────────────────────────────
//
// The retry path can run concurrently across overlapping daemon ticks
// (StartInterval=120 + occasional drift) and across an operator's
// manual `npm run follow-up:reconcile`. Without a claim, two processes
// can both read `posted=false`, both call `gh pr comment`, and both
// post — duplicate public PR spam.
//
// Claim mechanism: a sidecar `<jobPath>.delivery.lock` file created
// with O_EXCL (`openSync(... 'wx')`). The first to create it owns the
// lock. Stale claims (older than DELIVERY_CLAIM_STALE_MS) are
// recoverable: a process seeing a stale lock can overwrite it. There
// is a small TOCTOU window in stale recovery (two processes both see
// stale, both overwrite); that's acceptable because by definition the
// original claimer has crashed or hung past the timeout, and at most
// one duplicate post in that recovery window is much better than the
// alternative of unbounded duplicates.

function buildClaimerId() {
  return `${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
}

function deliveryLockPath(jobPath) {
  return `${jobPath}.delivery.lock`;
}

function tryAcquireDeliveryClaim(jobPath, claimerId, { now = () => new Date().toISOString(), staleMs = DELIVERY_CLAIM_STALE_MS } = {}) {
  const lockPath = deliveryLockPath(jobPath);
  const claim = { claimer: claimerId, claimedAt: now() };
  // Try the exclusive create first — this is the fast path and the
  // only one with strong atomicity (OS guarantees `O_EXCL`).
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
    writeSync(fd, JSON.stringify(claim));
    closeSync(fd);
    return { acquired: true, claimer: claimerId };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      // Filesystem error other than "lock exists" — surface it
      // rather than silently treating as "claim held".
      throw err;
    }
  }
  // Lock exists. Read the existing claim to decide if it's stale.
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    // Unreadable lock file — treat as stale.
  }
  const ageMs = existing?.claimedAt
    ? Math.max(0, Date.now() - new Date(existing.claimedAt).getTime())
    : Number.POSITIVE_INFINITY;
  if (ageMs <= staleMs) {
    return { acquired: false, claimer: existing?.claimer || null, ageMs };
  }
  // Stale → reclaim. (Small TOCTOU window here: documented at top of
  // section. Acceptable trade.)
  writeFileSync(lockPath, JSON.stringify(claim), 'utf8');
  return { acquired: true, claimer: claimerId, reclaimedFromStale: true, previousAgeMs: ageMs };
}

function releaseDeliveryClaim(jobPath) {
  const lockPath = deliveryLockPath(jobPath);
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Best-effort. Stale lock will time out and be recovered.
  }
}

// ── Post-success sidecar (R4 review #2 — dedupe gap) ──────────────────────
//
// If `gh pr comment` succeeds but the immediately-following
// `writeTerminalRecord()` fails (transient FS error, ENOSPC, signal
// during fsync, etc.), the on-disk record stays in `attempting=true`
// (or the prior shape) and a later retry will re-post the same public
// PR comment — duplicate noise visible to humans on the PR.
//
// Mitigation: between the gh success and the local stamp, write a
// `<jobPath>.delivery.posted` sidecar containing the gh result. If the
// stamp succeeds, the sidecar is removed. If the stamp fails, the
// sidecar persists and serves as a "posted but not stamped" recovery
// marker. On retry, if the marker is present, we skip the gh call and
// just stamp the record from the marker — no duplicate post.
//
// This is best-effort durability over the dedupe gap: a crash between
// gh-success and sidecar-write is still a possible duplicate, but the
// window is microseconds (a single writeFileSync), much smaller than
// the seconds-long gh subprocess + record-write window the reviewer
// flagged.

function postedSidecarPath(jobPath) {
  return `${jobPath}.delivery.posted`;
}

function readPostedSidecar(jobPath) {
  const path = postedSidecarPath(jobPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Corrupt sidecar → treat as no marker; the next retry will re-post.
    // That's strictly worse than a clean read but no worse than the
    // pre-sidecar behavior, so we don't escalate.
    return null;
  }
}

function writePostedSidecar(jobPath, { repo, prNumber, workerClass, postResult, attemptedAt }) {
  const path = postedSidecarPath(jobPath);
  try {
    writeFileSync(
      path,
      JSON.stringify({
        posted: true,
        repo,
        prNumber,
        workerClass,
        attemptedAt,
        postResult,
      }, null, 2),
      'utf8',
    );
    return true;
  } catch {
    // Sidecar best-effort. If we can't write it, the existing
    // attempting=true record + lock-stale window is the fallback.
    return false;
  }
}

function clearPostedSidecar(jobPath) {
  try {
    rmSync(postedSidecarPath(jobPath), { force: true });
  } catch {
    // Best-effort.
  }
}

// Durability-first comment delivery for the reconcile path.
//
// Old shape (pre-r3-review): call gh first, stamp commentDelivery
// AFTER. Crash window: a process death between gh-call and stamp
// loses the owed comment forever (retry pass skips records without
// commentDelivery).
//
// New shape: stamp `attempting=true` BEFORE the gh call. If we
// crash mid-call, the next retry pass sees the in-flight record,
// sees the lock is stale, and re-posts. After the gh call returns
// (or throws), we update the record with the actual result.
//
// We also acquire a delivery claim lock here so a concurrent retry
// pass running on the same record skips while we own it. The lock
// is released after the result is stamped.
function recordInitialCommentDelivery({
  jobPath,
  body,
  repo,
  prNumber,
  workerClass,
  postCommentImpl,
  postCommentArgs = null,
  now = () => new Date().toISOString(),
  log = console,
  // Test seam: lets callers verify the in-flight stamp without a
  // full async post. Production path leaves this null and the post
  // is done internally.
  postResult: precomputedPostResult = null,
}) {
  if (!jobPath) {
    return Promise.resolve(null);
  }

  return (async () => {
    const firstAttemptAt = now();

    // Pre-stamp commentDelivery BEFORE acquiring the claim. R5 review
    // flagged the previous order (claim → write commentDelivery) as a
    // durability hole: a crash between claim-acquire and the
    // commentDelivery write would leave a lock file with no
    // commentDelivery field, and the retry scanner filters out records
    // without commentDelivery — silent loss of the owed comment.
    //
    // By writing first, the durable record exists before any crash
    // window. If two reconcilers race here, both write the same shape
    // (deterministic from the same job inputs); last-writer-wins is
    // safe because the content is identical. The claim that follows
    // arbitrates which one actually posts.
    try {
      const record = readTerminalRecord(jobPath);
      record.commentDelivery = buildAttemptingDelivery({
        body,
        repo,
        prNumber,
        workerClass,
        attemptedAt: firstAttemptAt,
        attempts: 1,
        firstAttemptAt,
      });
      writeTerminalRecord(jobPath, record);
    } catch (err) {
      // Even if pre-stamp write fails, the retry walker can still
      // recover via the missing-`commentDelivery` recovery path
      // (listRetryCandidates → buildRecoveryCandidate). Don't escalate.
      log.error?.(`[comment-delivery] failed to pre-stamp ${jobPath}: ${err.message} — retry walker will reconstruct from record`);
      return null;
    }

    const claimerId = buildClaimerId();
    const claim = tryAcquireDeliveryClaim(jobPath, claimerId, { now });
    if (!claim.acquired) {
      // Another process owns the claim — they'll handle the post
      // (or retry will pick it up if they crash). The pre-stamp
      // we just wrote means the record is recoverable either way.
      log.error?.(
        `[comment-delivery] declining to post for ${jobPath}: claim held by ${claim.claimer} (${claim.ageMs}ms ago)`
      );
      return null;
    }

    // Recovery short-circuit: a posted-sidecar means a previous run
    // got a successful gh response but crashed before stamping the
    // record. Re-posting would duplicate the public comment. Just
    // stamp from the sidecar and clear it. (R4 non-blocking #2 dedupe
    // gap.)
    const existingSidecar = readPostedSidecar(jobPath);
    if (existingSidecar?.posted) {
      const recoveredAt = now();
      const recoveredDelivery = {
        ...buildPendingDelivery({
          body,
          repo,
          prNumber,
          workerClass,
          postResult: existingSidecar.postResult || { posted: true },
          attemptedAt: existingSidecar.attemptedAt || recoveredAt,
        }),
        firstAttemptAt,
        recoveredFromSidecar: true,
      };
      try {
        const record = readTerminalRecord(jobPath);
        record.commentDelivery = recoveredDelivery;
        writeTerminalRecord(jobPath, record);
        clearPostedSidecar(jobPath);
      } catch (err) {
        log.error?.(`[comment-delivery] failed to stamp sidecar-recovered delivery on ${jobPath}: ${err.message}`);
      } finally {
        releaseDeliveryClaim(jobPath);
      }
      return recoveredDelivery;
    }

    // Now do the post (or use the precomputed result if a caller is
    // testing the stamp behavior independently of a real post).
    let postResult = precomputedPostResult;
    if (!postResult) {
      try {
        postResult = await postCommentImpl(postCommentArgs || { repo, prNumber, workerClass, body, log });
      } catch (err) {
        // Synthesize a failure result rather than letting the throw
        // propagate — the durable record is what matters; without
        // this stamp the owed comment would be lost on a thrown
        // poster impl.
        log.error?.(`[comment-delivery] poster threw for ${jobPath}: ${err.message}`);
        postResult = { posted: false, reason: 'gh-cli-failure', error: err.message };
      }
    }

    const settledAt = now();

    // If gh succeeded, drop a "posted" sidecar BEFORE writing the
    // final stamp. If the stamp write then fails (FS hiccup, ENOSPC),
    // the sidecar survives to tell the next retry "this was already
    // posted; just stamp it, don't re-post." Without this, the same
    // comment would be reposted on the next tick — the reviewer's R4
    // non-blocking #2 dedupe gap.
    if (postResult?.posted) {
      writePostedSidecar(jobPath, {
        repo, prNumber, workerClass,
        postResult,
        attemptedAt: settledAt,
      });
    }

    const finalDelivery = {
      ...buildPendingDelivery({
        body,
        repo,
        prNumber,
        workerClass,
        postResult,
        attemptedAt: settledAt,
      }),
      firstAttemptAt,
    };

    try {
      const record = readTerminalRecord(jobPath);
      record.commentDelivery = finalDelivery;
      writeTerminalRecord(jobPath, record);
      // Final stamp succeeded → sidecar no longer needed. (If the
      // post failed, no sidecar was written, so this is a no-op.)
      if (postResult?.posted) {
        clearPostedSidecar(jobPath);
      }
    } catch (err) {
      log.error?.(`[comment-delivery] failed to stamp final delivery on ${jobPath}: ${err.message}`);
    } finally {
      releaseDeliveryClaim(jobPath);
    }

    return finalDelivery;
  })();
}

function listTerminalJobPaths(rootDir) {
  const dirs = ['completed', 'stopped', 'failed'];
  const out = [];
  for (const key of dirs) {
    const dir = getFollowUpJobDir(rootDir, key);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith('.json')) {
        out.push(join(dir, name));
      }
    }
  }
  return out;
}

// Reconstruct a delivery shape (body + addressing) from a terminal
// record that has missing or partial commentDelivery metadata. Used
// when reconcile crashed between the terminal move and the pre-stamp
// in `recordInitialCommentDelivery` — the record landed in
// completed/stopped/failed but never got a delivery field, so the
// retry walker has nothing to retry from. Treat that as "owed but
// unattempted debt": rebuild the body deterministically from the
// record fields and the worker reply artifact (still on disk), and
// hand the retry walker a synthesized candidate.
//
// Reviewer's R5 blocking #1 fix: "make the retry path treat
// missing/partial delivery metadata as recoverable debt instead of
// 'not a candidate.'"
function reconstructDeliveryFromRecord(record) {
  const action = record?.status === 'completed' ? 'completed'
    : record?.status === 'stopped' ? 'stopped'
    : record?.status === 'failed' ? 'failed'
    : null;
  if (!action) return null;
  if (!record?.repo || !record?.prNumber) return null;

  const workerClass = record?.remediationWorker?.model
    || record?.builderTag
    || 'codex';

  // Worker reply artifact is still on disk in the workspace; re-read
  // it so summary / validation / blockers / outcome show up in the
  // recovered comment. If unreadable, fall back to a degraded body
  // built with reply=null — the action / reReview / failure signal
  // alone is still informative and far better than no comment.
  let parsedReply = null;
  const replyPath = record?.remediationReply?.path || record?.remediationWorker?.replyPath || null;
  if (replyPath) {
    try {
      parsedReply = readRemediationReplyArtifact(replyPath, { expectedJob: record });
    } catch {
      parsedReply = null;
    }
  }

  let body;
  try {
    body = buildRemediationOutcomeCommentBody({
      workerClass,
      action,
      job: record,
      reply: parsedReply,
      reReview: record?.reReview || null,
      failure: record?.failure || null,
    });
  } catch {
    return null;
  }

  return {
    posted: false,
    attempting: false,
    reason: null,
    error: null,
    timeoutMs: null,
    attempts: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    owedAt: null,
    body,
    repo: record.repo,
    prNumber: record.prNumber,
    workerClass,
    reconstructed: true,
  };
}

// Build a list of retry candidates, sorted by firstAttemptAt
// ascending so the oldest still-failing comments drain first.
// Three candidate sources:
//   1. existing commentDelivery with posted=false, attempts<cap,
//      retryable reason — the normal failed-post retry case
//   2. missing commentDelivery — the record landed in terminal/
//      without ever getting a delivery field (crash between the
//      terminal move and pre-stamp). Reconstruct the delivery shape
//      from the record + worker reply artifact.
//   3. partial / "owed" commentDelivery (attempts=0, posted=false) —
//      the pre-move stamp landed but no post attempt ran yet.
function listRetryCandidates(rootDir, { maxAttempts, log }) {
  const paths = listTerminalJobPaths(rootDir);
  const candidates = [];
  for (const jobPath of paths) {
    let record;
    try {
      record = readTerminalRecord(jobPath);
    } catch (err) {
      log?.error?.(`[comment-delivery] cannot parse ${jobPath}: ${err.message}`);
      continue;
    }
    const delivery = record.commentDelivery;
    if (!delivery) {
      // Missing — try to reconstruct so the retry walker can post.
      const reconstructed = reconstructDeliveryFromRecord(record);
      if (!reconstructed) continue;
      candidates.push({ jobPath, delivery: reconstructed, record, reconstructed: true });
      continue;
    }
    if (delivery.posted) continue;
    if ((delivery.attempts || 0) >= maxAttempts) continue;
    if (NON_RETRYABLE_DELIVERY_REASONS.has(delivery.reason)) continue;
    // Partial owed shape with no body? Reconstruct.
    if (!delivery.body) {
      const reconstructed = reconstructDeliveryFromRecord(record);
      if (!reconstructed) continue;
      candidates.push({ jobPath, delivery: { ...delivery, ...reconstructed }, record, reconstructed: true });
      continue;
    }
    candidates.push({ jobPath, delivery, record });
  }
  candidates.sort((a, b) => {
    // Reconstructed / owed records (firstAttemptAt=null) sort to the
    // front via owedAt → 0 fallback so they drain before failed ones
    // with a real first-attempt timestamp.
    const aT = Date.parse(a.delivery.firstAttemptAt || a.delivery.owedAt || '') || 0;
    const bT = Date.parse(b.delivery.firstAttemptAt || b.delivery.owedAt || '') || 0;
    return aT - bT;
  });
  return candidates;
}

// Scan terminal records and retry up to `budget` failed comment
// deliveries per call. Bounded so a backlog (e.g. during a GitHub
// outage) doesn't starve the live consume/reconcile pipeline.
//
// Idempotent against concurrent ticks: each retry acquires the
// delivery claim lock before posting; another process holding the
// claim will be skipped (counted as `skipped` not `failed`).
//
// Returns { scanned, candidates, retried, posted, failed, skipped }.
async function retryFailedCommentDeliveries({
  rootDir = ROOT,
  postCommentImpl = postRemediationOutcomeComment,
  now = () => new Date().toISOString(),
  log = console,
  maxAttempts = MAX_COMMENT_DELIVERY_ATTEMPTS,
  budget = RETRY_BUDGET_PER_TICK,
} = {}) {
  const candidates = listRetryCandidates(rootDir, { maxAttempts, log });
  const scanned = candidates.length;
  let retried = 0;
  let posted = 0;
  let failed = 0;
  let skipped = 0;

  for (const { jobPath, delivery } of candidates) {
    if (retried >= budget) {
      // Remaining candidates wait until the next tick. They stay in
      // the candidate list forever (subject to maxAttempts), so this
      // is purely a per-tick rate limit, not an eviction policy.
      break;
    }

    // Claim BEFORE re-reading the record + posting. Another process
    // currently delivering this record will hold the claim; skip
    // those without counting as failure.
    const claimerId = buildClaimerId();
    const claim = tryAcquireDeliveryClaim(jobPath, claimerId, { now });
    if (!claim.acquired) {
      skipped += 1;
      continue;
    }

    // Sidecar short-circuit (R4 non-blocking #2 dedupe gap): a
    // posted-sidecar means a previous attempt got a successful gh
    // response but crashed before stamping the record. Re-posting
    // would duplicate the public comment. Just stamp from the
    // sidecar and clear it.
    const sidecar = readPostedSidecar(jobPath);
    if (sidecar?.posted) {
      const attemptedAt = sidecar.attemptedAt || now();
      let record;
      try {
        record = readTerminalRecord(jobPath);
      } catch (err) {
        log.error?.(`[comment-delivery] failed to re-read ${jobPath} for sidecar recovery: ${err.message}`);
        releaseDeliveryClaim(jobPath);
        // Treat as posted=true since gh did succeed previously.
        posted += 1;
        continue;
      }
      const previous = record.commentDelivery || delivery;
      record.commentDelivery = {
        ...previous,
        body: previous.body || delivery.body,
        repo: previous.repo || delivery.repo,
        prNumber: previous.prNumber || delivery.prNumber,
        workerClass: previous.workerClass || delivery.workerClass,
        attempts: Math.max((previous.attempts || 0), 1),
        firstAttemptAt: previous.firstAttemptAt || attemptedAt,
        lastAttemptAt: attemptedAt,
        attempting: false,
        posted: true,
        reason: null,
        error: null,
        timeoutMs: null,
        recoveredFromSidecar: true,
      };
      try {
        writeTerminalRecord(jobPath, record);
        clearPostedSidecar(jobPath);
      } catch (err) {
        log.error?.(`[comment-delivery] failed to stamp sidecar-recovered delivery on ${jobPath}: ${err.message}`);
      } finally {
        releaseDeliveryClaim(jobPath);
      }
      retried += 1;
      posted += 1;
      continue;
    }

    retried += 1;
    /* eslint-disable no-await-in-loop */
    let result;
    try {
      result = await postCommentImpl({
        repo: delivery.repo,
        prNumber: delivery.prNumber,
        workerClass: delivery.workerClass,
        body: delivery.body,
        log,
      });
    } catch (err) {
      // Poster impl threw — synthesize a failure result so we still
      // stamp the record (and the lock gets released in finally
      // below). Without this, a buggy poster would leave the record
      // in `attempting=true` until the lock goes stale.
      result = { posted: false, reason: 'gh-cli-failure', error: err.message };
    }
    /* eslint-enable no-await-in-loop */

    const attemptedAt = now();

    // Drop the posted-sidecar BEFORE writing the final stamp (R4
    // dedupe gap, retry path). Same rationale as
    // `recordInitialCommentDelivery`.
    if (result?.posted) {
      writePostedSidecar(jobPath, {
        repo: delivery.repo,
        prNumber: delivery.prNumber,
        workerClass: delivery.workerClass,
        postResult: result,
        attemptedAt,
      });
    }

    let record;
    try {
      record = readTerminalRecord(jobPath);
    } catch (err) {
      log.error?.(`[comment-delivery] failed to re-read ${jobPath} for update: ${err.message}`);
      releaseDeliveryClaim(jobPath);
      if (result?.posted) posted += 1; else failed += 1;
      continue;
    }
    const previous = record.commentDelivery || delivery;
    record.commentDelivery = {
      ...previous,
      // For reconstructed candidates the existing record had no
      // body/addressing; fold the reconstructed shape in so the
      // record gains a complete delivery field.
      body: previous.body || delivery.body,
      repo: previous.repo || delivery.repo,
      prNumber: previous.prNumber || delivery.prNumber,
      workerClass: previous.workerClass || delivery.workerClass,
      attempts: (previous.attempts || 0) + 1,
      firstAttemptAt: previous.firstAttemptAt || attemptedAt,
      lastAttemptAt: attemptedAt,
      attempting: false,
      posted: Boolean(result?.posted),
      reason: result?.posted ? null : (result?.reason || previous.reason || 'unknown'),
      error: result?.error || null,
      timeoutMs: result?.timeoutMs ?? null,
    };
    try {
      writeTerminalRecord(jobPath, record);
      if (result?.posted) {
        clearPostedSidecar(jobPath);
      }
    } catch (err) {
      log.error?.(`[comment-delivery] failed to update ${jobPath}: ${err.message}`);
    } finally {
      releaseDeliveryClaim(jobPath);
    }

    if (result?.posted) posted += 1;
    else failed += 1;
  }

  return { scanned, retried, posted, failed, skipped, budget };
}

export {
  MAX_COMMENT_DELIVERY_ATTEMPTS,
  RETRY_BUDGET_PER_TICK,
  DELIVERY_CLAIM_STALE_MS,
  NON_RETRYABLE_DELIVERY_REASONS,
  buildAttemptingDelivery,
  buildOwedDelivery,
  buildPendingDelivery,
  clearPostedSidecar,
  deliveryLockPath,
  listRetryCandidates,
  postedSidecarPath,
  reconstructDeliveryFromRecord,
  recordInitialCommentDelivery,
  releaseDeliveryClaim,
  retryFailedCommentDeliveries,
  tryAcquireDeliveryClaim,
  writePostedSidecar,
};
