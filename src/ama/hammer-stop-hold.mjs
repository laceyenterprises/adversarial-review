import { assertHoldRecord, createHoldRecord, normalizeHoldRecord, inputChangePredicates, changedHoldInputs, evaluateHoldRecord, markHoldEscalated, resetHoldEscalationsForTests } from './hold-record.mjs';
import { refundCiInfrastructureHammerStops } from './ci-infrastructure-refund.mjs';
import { CI_INFRASTRUCTURE_STOP_REASONS, infrastructureOnlyFailures, recordedCiFailures, checksExecutedAgain, enrichCiInfrastructureEvidence } from '../ci-infrastructure.mjs';
import { observeClosureResult } from './closure-next-action.mjs';
import { createHistoryReader } from './history-reader.mjs';
import { HISTORY_READ_ERROR_LIMIT } from './history-read-policy.mjs';
import { refundOperatorHeldHammerStop } from './operator-hold-refund.mjs';
import { readLatestHoldRelease } from '../operator-hold-release.mjs';
import { REVIEW_SERVICE_REVISION } from '../review-service-revision.mjs';
import { companionOnlyStop, evaluateCompanionWait, COMPANION_FLOAT_WAIT_MS } from './companion-stop-wait.mjs';
// CLOSERSTOPTRANSIENT-01: the historical input-change rule below applies only
// to explicitly listed deterministic refusals. Other no-merge stops use a
// durable five-minute backoff; ordinary retry and lifetime caps still apply.
// NOOWNER-01 (SEV1) — after a hammer stops without merging, the next hammer
// run on the same head waits for an input to change, and the operator is paged
// once with the predicate the hammer named.
//
// Operator decisions, 2026-10-10: "Hammers judgement is final"; "Any operator
// action outside of critical safety requirement should be considered a Sev 1".
//
// Two incidents that day:
//   - podium PR 15 (Case 4): both hammer runs on head 9a1372c8 stopped at
//     `ci-not-green` because the repository has no CI ("zero check runs and
//     statuses"). The second run read the same inputs as the first, could not
//     end differently, and spent the per-PR cap. The cap page did not say why.
//   - agent-os PR 8022 (Case 3): the hammer rebased, pushed closer head
//     c9006987 and stopped at `unmerged-subrepo-parity-fix`. The closer then
//     asked for an exact-head re-review that policy never spawns on a closer
//     head, and the PR sat with no owner for hours.
//
// The closer reads the hammer's own terminal audit for the live head. When the
// latest terminal attempt for that head is `failed-without-merge`, the hammer
// is not dispatched again until one of these inputs differs from what the
// hammer recorded in its terminal audit, falling back per input to the closer's
// first observation when that audit has no comparable reading. A prior release
// is also a known baseline for a subsequent stop. Aggregate CI conclusions are
// not complete check rollups and cannot stand in for them. Historical review
// handoff stops release for a fresh hammer pass without a new review.
//   - the PR head SHA,
//   - the base branch SHA (a dependency merged, main moved),
//   - mergeability (MERGEABLE / CONFLICTING; UNKNOWN is not a reading), or
//   - computable primary-change evidence after an evidence-collection failure, or
//   - the external check rollup (each check's latest state; the pipeline's own
//     gate context is excluded because the watcher writes it).
//   - the reviewed head, verdict and finding evidence.
// Once an input changes, the hold releases for that stop and the closer's
// ordinary gates, lease and per-PR retry cap decide the one re-dispatch. A new
// no-merge on the same head starts a new hold. The page is sent once per head.
// HAMUNKNOWN-02 also releases GitHub-read stops when the fresh exact-head gate
// is already green and MERGEABLE, even if the baseline captured that recovery.
//
// REMCONFLICT-01 (SEV1, 2026-10-10): the hold never holds a CONFLICTING PR.
// Operator: "What am I supposed to do with PRs that have merge conflicts? I
// can't resolve them myself". On a conflicting PR the only input change that
// helps is a rebase, and the hammer is the component that owns merge-conflict
// resolution (templates/hammer-prompt.md). Holding it until the input changes
// deadlocked agent-os PRs 8022 and 8017. So while GitHub reports a merge
// conflict (mergeable CONFLICTING, or mergeStateStatus DIRTY) the stop
// releases with `changed: ['conflicting']`, does not page, and the closer's
// ordinary gates, lease and per-PR retry cap decide the re-dispatch. Every
// non-conflict stop keeps the rule above: a stop the hammer cannot fix does not
// spend another hammer attempt.
//
// State: data/follow-up-jobs/hammer-stop-hold/<repo>-pr-<n>.json, per head.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { checkPrimaryChange, fetchPrimaryChange } from './primary-change.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { checkItemState, classifyCheckRollup, isAdversarialOwnStatusContext, latestCheckRollupItems } from '../checks-summary.mjs';
import { closureGateMergeability, isGithubMergeConflict } from '../github-mergeability.mjs';
import { readAmaAuditEntry } from './audit.mjs';

export const HAMMER_STOP_HOLD_REASON = 'hammer-stop-awaiting-input-change';
export const HAMMER_TRANSIENT_STOP_HOLD_REASON = 'hammer-stop-transient-backoff';
export const HAMMER_TRANSIENT_STOP_BACKOFF_MS = 5 * 60_000;
export const HAMMER_STOP_HOLD_PAGE_EVENT = 'ama_closer.hammer_stop_hold';

export const HAMMER_EVIDENCE_FAILURES = new Set(['primary-change-unknown', 'primary-change-read-failed', 'history-read-failed']);
export const HAMMER_GITHUB_READ_FAILURES = new Set(['github-gate-not-green', 'pr-mergeability-unknown']);
const LEGACY_REVIEW_HANDOFF_STOPS = new Set(['exact-head-review-required', 'stale-review-head']);
export const HAMMER_EVIDENCE_RECHECK_INTERVAL_MS = 5 * 60_000;
// Two ordinary five-minute polling intervals let a transport fault recover
// before paging. Start at the first failed probe, not the old hammer timestamp.
export const HISTORY_READ_FAILURE_PAGE_GRACE_MS = 10 * 60_000;
const execFileAsync = promisify(execFile);

const STOP_OUTCOMES = new Set(['failed-without-merge', 'no-merge']);
const STOP_REASON_WRAPPERS = new Set(['predicate-not-eligible', 'not-eligible', 'reason-not-recorded']);
const INFRASTRUCTURE_STOP_REASONS = new Set([
  // Dispatch-owned scratch scripts disappeared; fresh dispatch renders them again.
  'missing-dispatch-phase-scripts',
  // Dispatch left template placeholders in the phase-script paths.
  'unrendered-dispatch-phase-scripts',
  // The closing note's alternate name for the same unrendered dispatch paths.
  'unrendered-dispatch-phase-script-placeholders',
]);

export function isInfrastructureStop(stop) {
  const reasons = [...stopReasons(stop), ...(stop?.refusal?.reasons || []),
    ...[stop?.predicate, stop?.reason].filter(Boolean)];
  if (!reasons.length) return false;
  if (reasons.every(reason => INFRASTRUCTURE_STOP_REASONS.has(reason))) return true;
  return reasons.every(reason => CI_INFRASTRUCTURE_STOP_REASONS.has(reason))
    && infrastructureOnlyFailures(recordedCiFailures(stop));
}

const DETERMINISTIC_STOP_REASONS = new Set([
  'primary-change-reverted', 'primary-change-unknown', 'stale-review-head',
  'verdict-not-eligible', 'verdict-not-settled-success',
  'protective-predecessor-malformed-trailer', 'base-changed-file-overlap',
  // These require changed review/content evidence, rather than elapsed time.
  'blocking-findings-present', 'blocking-findings-unknown',
  'non-blocking-findings-present', 'non-blocking-findings-unknown',
  'review-currency-unproven',
  // Auth, predecessor state, CI and opaque merge failures can recover on the
  // same head. In particular permanent-merge-rejection includes HTTP 403 and
  // required checks; its name is not evidence of a deterministic refusal.
]);
// Process-local page debounce for a state file that cannot be written.
const PAGED_IN_PROCESS = new Set();

export function _resetHammerStopHoldPageDebounceForTests() {
  PAGED_IN_PROCESS.clear();
  resetHoldEscalationsForTests();
}
const TEXT_LIMIT = 300;
const HEADS_KEPT = 8;

function oneLine(value, limit = TEXT_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

function deterministicRefusal(attempt, { repo, prNumber, headSha }) {
  if (isInfrastructureStop(attempt)) return null;
  const reasons = classifiedStopReasons(attempt);
  if (!reasons.length || !reasons.every(reason => DETERMINISTIC_STOP_REASONS.has(reason))) return null;
  const missingEvidence = stable(attempt.missingEvidence || attempt.eligibilityTrace?.trace?.primaryChange?.missingEvidence
    || attempt.githubGate?.primaryChangeMissingEvidence || null);
  const key = createHash('sha256').update(JSON.stringify({ repo, prNumber: Number(prNumber), headSha, reasons, missingEvidence })).digest('hex');
  const next = attempt.next || (reasons.includes('primary-change-reverted')
    ? 'Restore the uncited reverted regions, then push the repaired head.'
    : reasons.includes('stale-review-head') ? 'Revalidate the full range from the last reviewed head under a hammer lease.'
      : `Supply the missing evidence for ${reasons[0]}.`);
  return { key, reasons, missingEvidence, next,
    repairable: Boolean(String(attempt.next || '').trim()) || reasons.includes('primary-change-reverted') };
}

function classifiedStopReasons(attempt) {
  const reasons = stopReasons(attempt).filter(reason => !INFRASTRUCTURE_STOP_REASONS.has(reason));
  // Structured reasons describe the failed predicates; the outer reason can
  // be a wrapper such as predicate-not-eligible. Bare legacy stops still count.
  const reason = attempt?.reason || attempt?.predicate;
  if (reason && !INFRASTRUCTURE_STOP_REASONS.has(reason)
    && (!reasons.length || !STOP_REASON_WRAPPERS.has(reason)) && !reasons.includes(reason)) reasons.push(reason);
  return reasons.sort();
}

function stopReasons(attempt) {
  return [...new Set([
    ...(attempt?.eligibilityTrace?.reasons || []), ...(attempt?.githubGate?.reasons || []),
    ...(attempt?.reasons || []),
  ])].sort();
}

export function isLegacyReviewHandoffStop(stop) {
  return LEGACY_REVIEW_HANDOFF_STOPS.has(stop?.predicate || stop?.reason)
    && stopReasons(stop).every(reason => LEGACY_REVIEW_HANDOFF_STOPS.has(reason));
}

function holdStatePath(rootDir, repo, prNumber) {
  const safeRepo = String(repo || '').replace(/[^A-Za-z0-9._-]/g, '-');
  return join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', `${safeRepo}-pr-${Number(prNumber)}.json`);
}

function readHoldState(rootDir, repo, prNumber) {
  try {
    const parsed = JSON.parse(readFileSync(holdStatePath(rootDir, repo, prNumber), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.heads && typeof parsed.heads === 'object'
      ? parsed
      : { heads: {} };
  } catch {
    return { heads: {} };
  }
}

// Both admission and skipped-subject sweeps upgrade legacy version-1 holds.
// Unknown provenance is not an anchor: retry it on a later observation. Once
// either component is known, preserve that baseline for this refusal.
export function anchorHammerStopGateRevision(entry, stop, observed) {
  if ((!stop?.refusal && !entry.refusal) || entry.mode === 'companion') return entry;
  const known = value => typeof value === 'string' && Boolean(value.trim());
  const keys = ['serviceRevision', 'predicateVersion'];
  const baseline = keys.some(key => known(entry.gateRevision?.[key])) ? entry.gateRevision
    : Object.fromEntries(keys.map(key => [key, stop?.refusal && known(stop.gateRevision?.[key]) ? stop.gateRevision[key]
      : known(observed?.[key]) ? observed[key] : null]));
  if (!keys.some(key => known(baseline[key]))) return entry;
  const awaits = entry.awaits;
  const predicates = awaits?.filter(p => p.kind === 'gate-revision-change');
  const needsPredicate = awaits && (predicates.length !== 1
    || keys.some(key => predicates[0].from?.[key] !== baseline[key]));
  if (baseline === entry.gateRevision && !needsPredicate) return entry;
  return { ...entry, gateRevision: baseline,
    ...(needsPredicate ? { awaits: [...awaits.filter(p => p.kind !== 'gate-revision-change'),
      { kind: 'gate-revision-change', from: baseline }] } : {}) };
}

export function normalizeHammerStopHold(entry, { repo, prNumber, headSha, now = new Date().toISOString() } = {}) {
  const firstObservedAt = entry.firstObservedAt || now;
  const companion = entry.mode === 'companion';
  const deadline = entry.waitUntil || new Date(Date.parse(companion ? entry.companionWait?.mergedAt || firstObservedAt : firstObservedAt)
    + (companion ? COMPANION_FLOAT_WAIT_MS : entry.predicate === 'history-read-failed' ? HISTORY_READ_FAILURE_PAGE_GRACE_MS : 0)).toISOString();
  const awaits = companion
    ? [{ kind: 'gitlink-contains-commit', ...(entry.companionWait || {}), changed: 'companion-floated' }]
    : entry.releasedAt && !entry.inputs && entry.releasedBy?.length
      ? entry.releasedBy.map(name => ({ kind: 'event', name, ...(name === 'conflicting' ? { fallback: true } : {}) }))
      : [...inputChangePredicates(entry.inputs),
      ...(entry.refusal && entry.gateRevision ? [{ kind: 'gate-revision-change', from: entry.gateRevision }] : []),
      ...['hold-released', 'github-gate-cleared', 'primary-change-evidence', 'conflicting'].map(name => ({ kind: 'event', name, ...(name === 'conflicting' ? { fallback: true } : {}) })),
      ...(entry.retryAfter ? [{ kind: 'retry-at', at: entry.retryAfter, fallback: true, changed: 'transient-stop-backoff' }] : [])];
  return normalizeHoldRecord(entry, { holdType: 'hammer-stop', repo, prNumber, headSha,
    firstObservedAt, owner: 'closure-recovery', deadline, awaits,
    onDeadline: HAMMER_STOP_HOLD_PAGE_EVENT, reason: entry.predicate || 'hammer-stop' });
}

export function readHammerStopHoldForHead({ rootDir, repo, prNumber, headSha, stopKey } = {}) {
  const entry = readHoldState(rootDir, repo, prNumber).heads[headSha];
  if (!entry || entry.stopKey !== stopKey) return null;
  const anchors = [['deadline', entry.deadline], ['retryAfter', entry.retryAfter],
    ['waitUntil', entry.waitUntil], ['firstObservedAt', entry.firstObservedAt],
    ['companionMergedAt', entry.mode === 'companion' && entry.companionWait?.mergedAt]];
  // A legacy normalization default is useful to its recovery owner, but cannot
  // prove a future TTM ownership deadline on every new observation.
  const deadlineSource = anchors.find(([, value]) => typeof value === 'string'
    && Number.isFinite(Date.parse(value)))?.[0] ?? null;
  return { ...normalizeHammerStopHold(entry, { repo, prNumber, headSha }), deadlineSource };
}

function writeHoldState(rootDir, repo, prNumber, state) {
  const path = holdStatePath(rootDir, repo, prNumber);
  mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold'), { recursive: true });
  const heads = Object.entries(state.heads || {})
    .sort(([, a], [, b]) => String(b?.firstObservedAt || '').localeCompare(String(a?.firstObservedAt || '')))
    .slice(0, HEADS_KEPT);
  for (const [, entry] of heads) assertHoldRecord(entry);
  writeFileAtomic(path, `${JSON.stringify({ ...state, heads: Object.fromEntries(heads) }, null, 2)}\n`);
}

function attemptHead(attempt, fileHead) {
  for (const value of [attempt?.head, attempt?.currentHead, attempt?.headSha, attempt?.validatedHead]) {
    const text = String(value || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(text)) return text;
  }
  return fileHead;
}

function headsMatch(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (!left || !right) return false;
  return left === right || (left.length < 40 && right.startsWith(left)) || (right.length < 40 && left.startsWith(right));
}

function isHammerAttempt(attempt, doc) {
  const phase = String(attempt?.attemptPhase || '').trim().toLowerCase();
  // Resume bookkeeping must not replace the helper's actual safety decision.
  if (phase === 'hammer-lease-admission' || phase === 'hammer-resume') return false;
  const path = String(attempt?.path || '').trim().toLowerCase();
  const hammerPaths = new Set(['hammer', 'ham-terminal-remediation']);
  // Per-attempt provenance wins over document metadata: daemon and hammer
  // attempts can share a file, including daemon calls on HAM-certified heads.
  if (phase) return /^(?:before-)?hammer-/.test(phase)
    && (!path || hammerPaths.has(path));
  if (path) return hammerPaths.has(path);
  // Legacy hammer attempts and hand-appended stop lines lacked provenance.
  // Accept them only in unattributed or hammer-owned documents; never infer a
  // hammer decision from an unmarked attempt in a daemon-owned audit.
  const authority = String(doc?.closureAuthority || '').trim().toLowerCase();
  return !authority || hammerPaths.has(authority);
}

/**
 * The hammer's latest terminal decision recorded for `headSha`, read from the
 * audit file for that head and from the reviewed head's file (a hammer that
 * pushes a new head records its stop on the reviewed head with the new head
 * named in `head`/`currentHead`). Returns the stop only when that latest
 * hammer terminal attempt is a no-merge. A later `deferred` clears legacy
 * opaque stops, but preserves deterministic refusals, as do packaging stops.
 * `succeeded` clears both.
 * Daemon attempts do not set or clear hammer decisions.
 */
export function readHammerStopForHead({
  hqRoot,
  repo,
  prNumber,
  headSha,
  reviewedSha = null,
  readAuditImpl = readAmaAuditEntry,
  logger = console,
} = {}) {
  if (!hqRoot || !repo || !headSha) return null;
  const terminal = [];
  const files = [...new Set([headSha, reviewedSha].filter(Boolean))];
  for (const fileHead of files) {
    let doc;
    try {
      doc = readAuditImpl(hqRoot, repo, prNumber, fileHead);
    } catch (err) {
      logger?.warn?.(`[ama-closer] hammer stop audit unreadable for ${repo}#${prNumber}@${String(fileHead).slice(0, 12)}: ${err?.message || err}`);
      continue;
    }
    const entries = [
      ...(Array.isArray(doc?.attempts) ? doc.attempts : []),
      ...(Array.isArray(doc?.appendedRecords) ? doc.appendedRecords : []),
    ];
    entries.forEach((attempt, index) => {
      if (!isHammerAttempt(attempt, doc)) return;
      const outcome = String(attempt?.outcome || '').trim().toLowerCase();
      if (!outcome || outcome === 'in_progress') return;
      if (!headsMatch(attemptHead(attempt, fileHead), headSha)) return;
      terminal.push({
        attempt,
        outcome,
        fileHead,
        launchRequestId: attempt?.launchRequestId || doc?.launchRequestId || null,
        order: index,
        at: Date.parse(attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || '') || 0,
      });
    });
  }
  if (terminal.length === 0) return null;
  terminal.sort((a, b) => (a.at - b.at) || (a.order - b.order));
  let latest = terminal.at(-1);
  if (latest.outcome === 'deferred' || (STOP_OUTCOMES.has(latest.outcome)
    && (isInfrastructureStop(latest.attempt) || isLegacyReviewHandoffStop(latest.attempt)))) {
    // Deferral, packaging failure or a legacy handoff is not new predicate evidence. It cannot
    // erase a deterministic refusal and re-arm dispatch on unchanged inputs.
    let refusal = null;
    for (const item of [...terminal].reverse()) {
      if (item.outcome === 'succeeded') break;
      if (STOP_OUTCOMES.has(item.outcome) && !isLegacyReviewHandoffStop(item.attempt)
        && deterministicRefusal(item.attempt, { repo, prNumber, headSha })) {
        refusal = item;
        break;
      }
    }
    if (refusal) latest = refusal;
  }
  if (!STOP_OUTCOMES.has(latest.outcome)) return null;
  const { attempt } = latest;
  const refusal = deterministicRefusal(attempt, { repo, prNumber, headSha });
  return {
    headSha,
    // Auditable stops in this review series let release refund multiple
    // hold-only runs without handing back any genuine code-work attempt.
    refundStops: terminal.filter(item => STOP_OUTCOMES.has(item.outcome)).map(item => ({
      auditHead: item.fileHead,
      headSha: attemptHead(item.attempt, item.fileHead),
      companionOnly: companionOnlyStop(item.attempt),
      ciInfrastructureOnly: isInfrastructureStop(item.attempt) && infrastructureOnlyFailures(recordedCiFailures(item.attempt)),
      launchRequestId: item.launchRequestId,
      noExecution: item.attempt?.noExecution === true || item.attempt?.workerState === 'never-spawned'
        || item.attempt?.executionStarted === false,
      predicate: oneLine(item.attempt?.reason, 120),
      recordedAt: item.attempt?.startedAt || item.attempt?.timestamp || item.attempt?.recordedAt || null,
      stopKey: `${item.fileHead}:${item.attempt?.attemptNumber ?? item.order}:${item.attempt?.startedAt || item.attempt?.timestamp || item.attempt?.recordedAt || ''}`,
    })),
    failedChecks: recordedCiFailures(attempt),
    companionWait: attempt?.companionWait || attempt?.githubGate?.companionWait || null,
    companionEvidence: [attempt?.closingStatus, attempt?.next].filter(Boolean).join('\n'),
    predicate: oneLine(attempt?.reason, 120) || 'reason-not-recorded',
    reasons: stopReasons(attempt),
    refusal,
    deterministic: Boolean(refusal),
    gateRevision: { serviceRevision: attempt?.reviewServiceRevision || null,
      predicateVersion: attempt?.gatePredicateVersion || null },
    closingStatus: oneLine(attempt?.closingStatus, attempt?.reason === 'history-read-failed' ? HISTORY_READ_ERROR_LIMIT : TEXT_LIMIT),
    ...(attempt?.historyReadError || attempt?.githubGate?.primaryChangeReason
      ? { historyReadError: oneLine(attempt.historyReadError || attempt.githubGate.primaryChangeReason, HISTORY_READ_ERROR_LIMIT) } : {}),
    next: oneLine(attempt?.next),
    recordedAt: attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || null,
    stopKey: `${latest.fileHead}:${attempt?.attemptNumber ?? latest.order}:${attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || ''}`,
    inputEvidence: recordedStopInputs(attempt),
  };
}

// Only compare readings actually present in the terminal attempt. In particular,
// checksConclusion/badChecks cannot reconstruct the full external check rollup.
function recordedStopInputs(attempt) {
  const trace = attempt?.eligibilityTrace?.trace;
  const inputs = {};
  const head = attempt?.githubGate?.liveHead || trace?.headMatch?.current;
  if (head) inputs.headSha = head;
  if (attempt?.rebasedOntoBase) inputs.baseSha = attempt.rebasedOntoBase;
  const mergeability = String(attempt?.githubGate?.mergeable || trace?.mergeability?.mergeableState || '').trim().toUpperCase();
  if (mergeability) inputs.mergeability = ['MERGEABLE', 'CONFLICTING'].includes(mergeability) ? mergeability : null;
  // Eligibility traces normalize verdicts and summarize findings differently
  // from closer reviewState. They cannot reconstruct its canonical fingerprint.
  // Historical review handoff stops release independently of verdict timestamps.
  return { inputs };
}

function stopBaseline(stop, fallback) {
  return { ...fallback, ...stop.inputEvidence.inputs };
}

function checkName(item) {
  return String(item?.name || item?.context || item?.workflowName || '').trim().toLowerCase();
}

/**
 * The inputs a repeated hammer run would read. `excludeContexts` names the
 * pipeline's own status contexts, which the watcher itself writes.
 */
export function hammerStopInputs(prMetadata, { excludeContexts = [], reviewState = null } = {}) {
  const excluded = new Set((excludeContexts || []).map((ctx) => String(ctx || '').trim().toLowerCase()).filter(Boolean));
  const rollup = Array.isArray(prMetadata?.statusCheckRollup) ? prMetadata.statusCheckRollup : [];
  const checks = latestCheckRollupItems(rollup.filter((item) => !isAdversarialOwnStatusContext(item, excluded)))
    .map((item) => `${checkName(item) || 'unnamed'}=${checkItemState(item) || 'NONE'}`)
    .sort();
  const mergeability = String(prMetadata?.mergeableState || '').trim().toUpperCase();
  return {
    headSha: prMetadata?.headSha || null,
    baseSha: prMetadata?.baseSha || null,
    mergeability: ['MERGEABLE', 'CONFLICTING'].includes(mergeability) ? mergeability : null,
    checks: checks.join('|'),
    review: JSON.stringify(stable(reviewState && Object.fromEntries([
      'headSha', 'verdict', 'remediationPending', 'blockingFindingState', 'blockingFindingCount',
      'nonBlockingFindingState', 'nonBlockingFindingCount', 'blockingFindingIdentities',
      'nonBlockingFindingIdentities', 'refusalReviewVersion',
    ].map(key => [key, reviewState[key]])))),
  };
}

/**
 * REMCONFLICT-01: whether the live PR has a merge conflict, the one stop the
 * hammer owns. Closer metadata carries the classified `mergeableState`
 * (CONFLICTING, or DIRTY when `mergeable` was empty); raw fields win when set.
 */
export function hammerStopPrIsConflicting(prMetadata) {
  const state = String(prMetadata?.mergeableState || '').trim().toUpperCase();
  return isGithubMergeConflict({
    mergeable: prMetadata?.mergeable || state,
    mergeStateStatus: prMetadata?.mergeStateStatus || state,
  });
}

// A missing current reading is not evidence of change; a newly available
// reading does release a hold whose previous observation was unknown (null).
export function changedHammerStopInputs(previous, current) {
  return changedHoldInputs(previous, current);
}

/**
 * Decide whether to hold the next hammer run on the live head.
 *
 * @returns {Promise<{ action: 'none' } | { action: 'hold', hammerStop: object }
 *   | { action: 'release', hammerStop: object, changed: string[] }>}
 */
export async function evaluateHammerStopHold({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  headSha,
  reviewedSha,
  prMetadata,
  reviewState = null,
  strictNonBlockingRemediation = true,
  sharedNextAction = null,
  excludeContexts = [],
  requiredCheckContexts = [],
  deliverAlertImpl = null,
  logger = console,
  now = new Date().toISOString(),
  readAuditImpl = readAmaAuditEntry,
  reviewServiceRevision = REVIEW_SERVICE_REVISION,
  gatePredicateVersion = null,
  fetchPrimaryChangeImpl = fetchPrimaryChange,
  execFileImpl = execFileAsync,
} = {}) {
  if (!rootDir || !headSha) return { action: 'none' };
  const state = readHoldState(rootDir, repo, prNumber);
  if (state.currentHead && state.currentHead !== headSha) {
    // A force-push away and back is still a changed head, not the old refusal.
    state.heads = {};
    state.currentHead = headSha;
    writeHoldState(rootDir, repo, prNumber, state);
  }
  // Keep one detached audit snapshot while enriching its selected CI evidence.
  // Re-run ordinary selection afterwards so an infrastructure stop cannot hide
  // an earlier real refusal whose history was already read on this pass.
  const auditSnapshots = new Map();
  const readSnapshot = (...args) => {
    const key = JSON.stringify(args);
    if (!auditSnapshots.has(key)) auditSnapshots.set(key, structuredClone(readAuditImpl(...args)));
    return auditSnapshots.get(key);
  };
  const readStop = () => readHammerStopForHead({ hqRoot, repo, prNumber, headSha, reviewedSha,
    readAuditImpl: readSnapshot, logger });
  let stop = readStop();
  if (stop?.failedChecks?.length && !isInfrastructureStop(stop)
    && [...stop.reasons, stop.predicate].every(reason => CI_INFRASTRUCTURE_STOP_REASONS.has(reason))) {
    const failedChecks = await enrichCiInfrastructureEvidence({ rollup: stop.failedChecks, repo, headSha, execFileImpl });
    stop.failedChecks.forEach((check, index) => {
      if (check && typeof check === 'object') Object.assign(check, failedChecks[index]);
    });
    stop = readStop();
  }
  for (const [head, value] of Object.entries(state.heads)) state.heads[head] = normalizeHammerStopHold(value, { repo, prNumber, headSha: head, now });
  const prior = state.heads[headSha];
  const gateRevision = { serviceRevision: reviewServiceRevision, predicateVersion: gatePredicateVersion };
  // External dependency events own this wait, before legacy transient upgrade,
  // changed-input, conflict and timer releases can widen closer admission.
  if (companionOnlyStop(stop)) return evaluateCompanionWait({ rootDir, repo, prNumber, headSha,
    prMetadata, stop, prior, execFileImpl, deliverAlertImpl, logger, now, persist,
    pageEvent: HAMMER_STOP_HOLD_PAGE_EVENT, pagedInProcess: PAGED_IN_PROCESS });
  // CIBLOCKINFRA-01: zero-step CI is not a deterministic refusal. Retain the
  // audit while blocked; green current-head evidence retires the old stop and
  // credits only its infrastructure charges, once.
  if (isInfrastructureStop(stop) && infrastructureOnlyFailures(recordedCiFailures(stop))
    && (!prior?.refusal || prior.releasedAt || isInfrastructureStop(prior) || prior.stopKey === stop.stopKey)) {
    const open = prMetadata?.isOpen === true || String(prMetadata?.state || '').toUpperCase() === 'OPEN';
    if (!open || prMetadata?.isOpen === false || prMetadata.headSha !== headSha
      || !checksExecutedAgain(prMetadata.statusCheckRollup, stop.failedChecks)
      || classifyCheckRollup(prMetadata.statusCheckRollup, {
        requiredContexts: requiredCheckContexts,
        excludeContexts: new Set(excludeContexts.map(ctx => String(ctx).trim().toLowerCase())),
      }) !== 'SUCCESS') return { action: 'none', infrastructureStop: stop };
    refundCiInfrastructureHammerStops(rootDir, { repo, prNumber }, stop, { now });
    const changed = ['ci-infrastructure-recovered'];
    if (prior?.stopKey !== stop.stopKey || !prior.releasedAt) {
      persist({ stopKey: stop.stopKey, predicate: stop.predicate, failedChecks: stop.failedChecks,
        releasedAt: now, releasedBy: changed, paged: false });
      logger?.log?.(JSON.stringify({ event: 'ama_closer.ci_infrastructure_stop_released',
        repo, prNumber, headSha, reason: 'checks-executed-again', stopKey: stop.stopKey }));
    }
    return { action: 'release', hammerStop: stop, infrastructureStop: stop, changed };
  }
  // Upgrade old catch-all refusals once, including when audit retention has
  // removed the stop. Never use cleanup alone to authorize dispatch or refunds.
  const priorReasons = prior && classifiedStopReasons({ ...prior, reasons: prior.refusal?.reasons || prior.reasons });
  if (prior && !prior.releasedAt && !prior.retryAfter && priorReasons.length
    && priorReasons.every(reason => !DETERMINISTIC_STOP_REASONS.has(reason))
    && !isInfrastructureStop(prior) && !stop?.refusal && stop?.predicate !== 'history-read-failed') {
    const changed = ['transient-stop-upgrade'];
    const entry = { ...prior, refusal: null, mode: 'transient', reasons: priorReasons,
      retryAfter: now, releasedAt: now, releasedBy: changed };
    persist(entry);
    logger?.log?.(JSON.stringify({ event: 'ama_closer.hammer_stop_hold_released',
      repo, prNumber, headSha, stopKey: prior.stopKey, predicate: prior.predicate, reasons: priorReasons, changed }));
    if (!stop) return { action: 'none' };
    if (stop.stopKey === prior.stopKey) return { action: 'release', hammerStop: stop, changed };
  }
  // STOPHOLDINFRA-01: packaging failures say nothing about the PR. Retire old
  // infrastructure holds once, without paging or refunding attempts. An incoming
  // packaging failure cannot release an unrelated refusal. Ordinary gates,
  // leases and retry caps still own re-dispatch; the audit may already be cleared.
  if (isInfrastructureStop(stop) || (!stop && isInfrastructureStop(prior))) {
    if (prior?.refusal && !prior.releasedAt && deterministicRefusal({ ...prior,
      reasons: prior.refusal.reasons }, { repo, prNumber, headSha })) {
      const inputs = hammerStopInputs(prMetadata, { excludeContexts, reviewState });
      const entry = anchorHammerStopGateRevision(prior, stop, gateRevision);
      const changed = evaluateHoldRecord(entry, { namespace: rootDir, now, inputs, gateRevision }).changed;
      const hammerStop = { headSha, predicate: prior.predicate, deterministic: true,
        refusal: prior.refusal, since: prior.firstObservedAt, paged: Boolean(prior.pagedAt) };
      if (changed.length > 0) {
        persist({ ...entry, releasedAt: now, releasedBy: changed, releasedInputs: inputs,
          ...(changed.includes('gate-revision-change') ? { releasedGateRevision: gateRevision } : {}) });
        return { action: 'release', hammerStop, changed };
      }
      if (entry !== prior) persist(entry);
      return { action: 'hold', hammerStop };
    }
    if (!isInfrastructureStop(prior) || prior.releasedAt) return { action: 'none' };
    const changed = ['infrastructure-stop'];
    const entry = { ...prior, releasedAt: now, releasedBy: changed };
    persist(entry);
    return stop ? { action: 'release', hammerStop: stop, changed } : { action: 'none' };
  }
  if (!stop) return { action: 'none' };
  // FINALCLOSE-01: transport evidence cannot become an input-change hold. The
  // launched hammer owns a fresh read; ordinary series/lifetime caps own retries.
  if (stop.predicate === 'history-read-failed' && !stop.refusal) {
    const changed = ['history-read-retry'];
    persist({ stopKey: stop.stopKey, releasedAt: now, releasedBy: changed, paged: false });
    return { action: 'release', hammerStop: stop, changed };
  }

  // These historical stops expressed an obsolete review handoff, not a code
  // or safety refusal. Retire them without waiting for a new verdict. Mixed
  // refusals still hold for their real evidence (notably HAMINTENT).
  if (isLegacyReviewHandoffStop(stop)) {
    const changed = ['hammer-responsibility'];
    if (prior?.stopKey !== stop.stopKey || !prior?.releasedBy?.includes('hammer-responsibility')) {
      persist({ stopKey: stop.stopKey, releasedAt: now, releasedBy: changed, paged: false });
    }
    return { action: 'release', hammerStop: stop, changed };
  }

  const inputs = hammerStopInputs(prMetadata, { excludeContexts, reviewState });
  const sameRefusal = stop.refusal && prior?.refusal?.key === stop.refusal.key;
  const reuseEntry = prior && (stop.refusal ? sameRefusal : prior.stopKey === stop.stopKey)
    && !(prior.releasedAt && prior.stopKey !== stop.stopKey);
  if (!reuseEntry) state.refusalGeneration = (Number(state.refusalGeneration) || 0) + 1;
  let entry = reuseEntry
    ? { ...prior, stopKey: stop.stopKey, refusal: stop.refusal }
    : {
      stopKey: stop.stopKey,
      refusalGeneration: state.refusalGeneration,
      predicate: stop.predicate,
      ...(stop.refusal ? { refusal: stop.refusal } : {}),
      ...(stop.historyReadError ? { historyReadError: stop.historyReadError } : {}),
      firstObservedAt: now,
      // A stop that follows a released hold read the inputs seen at release;
      // compare against those, not against this first observation.
      inputs: stopBaseline(stop, prior?.releasedInputs || inputs),
      pagedAt: stop.refusal ? null : prior?.pagedAt || null,
    };
  let dirty = !reuseEntry || prior.stopKey !== stop.stopKey || prior.holdVersion !== 1;
  // Legacy stops have no code provenance. Anchor them at first known observation,
  // rather than guessing which previous deployment made the decision. Preserve
  // that baseline across repeated audits of the same refusal and restarts.
  const anchored = anchorHammerStopGateRevision(entry, stop, gateRevision);
  if (anchored !== entry) { entry = anchored; dirty = true; }
  if (!stop.refusal && !entry.retryAfter) {
    entry = { ...entry, mode: 'transient', reasons: classifiedStopReasons(stop),
      retryAfter: new Date(Date.parse(now) + HAMMER_TRANSIENT_STOP_BACKOFF_MS).toISOString() };
    dirty = true;
  }
  entry = normalizeHammerStopHold(entry, { repo, prNumber, headSha, now });
  // Rebuild predicates from the current stop baseline, including legacy audit inputs.
  entry = createHoldRecord({ ...entry, excludeContexts, awaits: [...inputChangePredicates(stopBaseline(stop, entry.inputs)),
    ...(stop.refusal && entry.gateRevision ? [{ kind: 'gate-revision-change', from: entry.gateRevision }] : []),
    ...['hold-released', 'github-gate-cleared', 'primary-change-evidence', 'conflicting'].map(name => ({ kind: 'event', name, ...(name === 'conflicting' ? { fallback: true } : {}) })),
    ...(entry.retryAfter ? [{ kind: 'retry-at', at: entry.retryAfter, fallback: true, changed: 'transient-stop-backoff' }] : [])] });
  let evaluation;
  if (!entry.releasedAt) {
    const release = readLatestHoldRelease(rootDir, repo, prNumber, headSha);
    const holdReleased = release && Date.parse(release.released_at) > Date.parse(stop.recordedAt || entry.firstObservedAt);
    let changed = holdReleased ? ['hold-released'] : [];
    let inputsReadable = true;
    // HAMUNKNOWN-02: the first hold snapshot may already have recovered from
    // the hammer's transient read. Re-evaluate the named gate on this pass's
    // live metadata instead of waiting forever for another input change.
    // Structured findings/reversal refusals must retain their own hold.
    if (HAMMER_GITHUB_READ_FAILURES.has(stop.predicate)
      && stop.reasons.every(reason => ['ci-not-green', 'pr-not-mergeable', 'pr-mergeability-unknown'].includes(reason))
      && prMetadata?.headSha === headSha
      && (prMetadata?.isOpen === true || String(prMetadata?.state || '').toUpperCase() === 'OPEN')
      && prMetadata?.isOpen !== false
      && (!prMetadata.state || String(prMetadata.state).toUpperCase() === 'OPEN')
      && closureGateMergeability({ mergeable: prMetadata.mergeable || prMetadata.mergeableState,
        mergeStateStatus: prMetadata.mergeStateStatus }) === 'MERGEABLE'
      && classifyCheckRollup(prMetadata.statusCheckRollup, {
        requiredContexts: requiredCheckContexts,
        excludeContexts: new Set(excludeContexts.map(ctx => String(ctx).trim().toLowerCase())),
      }) === 'SUCCESS') changed.push('github-gate-cleared');
    if (holdReleased || stop.predicate === 'history-read-failed') {
      try {
        refundOperatorHeldHammerStop(rootDir, { repo, prNumber }, stop, { now });
      } catch (err) {
        logger?.warn?.(`[ama-closer] operator-hold refund failed for ${repo}#${prNumber}: ${err?.message || err}`);
      }
    }
    // Probe only evidence failures, once per evaluation/pass. A computable
    // refusal (e.g. reverted primary change) releases ownership, not merge gates.
    if (HAMMER_EVIDENCE_FAILURES.has(stop.predicate)
      || stop.refusal?.reasons.includes('primary-change-reverted')) {
      try {
        const evidence = await fetchPrimaryChangeImpl({
          repo, prNumber, headSha, rootDir,
          get: createHistoryReader({ execFileImpl }),
        });
        const answer = checkPrimaryChange(evidence, headSha, { strictNonBlockingRemediation });
        if (stop.refusal?.reasons.includes('primary-change-reverted')) {
          // Deploying a new verifier or publishing guard evidence can resolve
          // the missing authority without a new SHA or verdict. Read it, but
          // retain the hold when the same deterministic refusal remains.
          if (answer.ok || (answer.reason === 'primary-change-reverted' && answer.missingEvidence
            && JSON.stringify(stable(answer.missingEvidence)) !== JSON.stringify(stop.refusal.missingEvidence))) changed.push('primary-change-evidence');
        } else if (!HAMMER_EVIDENCE_FAILURES.has(answer.reason)) changed.push('primary-change-evidence');
        else if (stop.predicate === 'history-read-failed' && !holdReleased) { changed.splice(0); inputsReadable = false; }
      } catch (err) {
        if (stop.predicate === 'history-read-failed' && !holdReleased) { changed.splice(0); inputsReadable = false; }
        logger?.warn?.(`[ama-closer] hammer evidence probe failed for ${repo}#${prNumber}: ${err?.message || err}`);
      }
    }
    if (changed.length === 0 && !stop.refusal && stop.predicate !== 'history-read-failed' && hammerStopPrIsConflicting(prMetadata)) changed.push('conflicting');
    evaluation = evaluateHoldRecord(entry, { now, namespace: rootDir, gateRevision, inputs: holdReleased || !inputsReadable ? stopBaseline(stop, entry.inputs) : inputs,
      events: Object.fromEntries(changed.map(name => [name, true])) });
    changed = evaluation.changed;
    if (changed.length > 0) {
      entry = { ...entry, releasedAt: now, releasedBy: changed, releasedInputs: inputs,
        ...(changed.includes('gate-revision-change') ? { releasedGateRevision: gateRevision } : {}) };
      dirty = true;
      logger?.log?.(JSON.stringify({
        event: 'ama_closer.hammer_stop_hold_released',
        repo, prNumber, headSha, stopKey: stop.stopKey, predicate: stop.predicate,
        reasons: classifiedStopReasons(stop), changed,
        ...(changed.includes('gate-revision-change') ? { decidedGateRevision: entry.gateRevision, observedGateRevision: gateRevision } : {}),
      }));
    }
  }
  const hammerStop = {
    headSha,
    stopKey: stop.stopKey,
    deterministic: Boolean(stop.refusal),
    ...(entry.gateRevision ? { gateRevision: entry.gateRevision } : {}),
    ...(entry.retryAfter ? { retryAfter: entry.retryAfter } : {}),
    predicate: stop.predicate,
    ...(stop.refusal ? { refusal: stop.refusal } : {}),
    closingStatus: stop.closingStatus || null,
    ...(stop.historyReadError ? { historyReadError: stop.historyReadError } : {}),
    since: entry.firstObservedAt,
    owner: entry.owner, awaits: entry.awaits, deadline: entry.deadline, onDeadline: entry.onDeadline,
  };
  if (entry.releasedAt) {
    if (dirty) persist();
    return { action: 'release', hammerStop, changed: entry.releasedBy || [] };
  }
  const nextActionShared = observeClosureResult(sharedNextAction, { hammerStop });
  const recovery = nextActionShared?.decision;
  const ownerSummary = `action=${recovery?.action || 'hammer'} actor=${recovery?.actor || 'closure-recovery'} `
    + `reason=${recovery?.reason || 'automated-stop'} head=${headSha} `
    + `ageMs=${Math.max(0, Date.parse(now) - Date.parse(entry.firstObservedAt))}. `;
  const debounceKey = `${rootDir}\0${repo}\0${prNumber}\0${headSha}${stop.refusal ? `\0${stop.refusal.key}\0${entry.refusalGeneration}` : ''}`;
  const pageDue = evaluation?.escalate;
  if (pageDue && !entry.pagedAt && !PAGED_IN_PROCESS.has(debounceKey) && typeof deliverAlertImpl === 'function') {
    const text = `Adversarial-review hammer stopped without merging ${repo}#${prNumber} on head `
      + `${String(headSha).slice(0, 12)}: ${stop.predicate}. `
      + (stop.historyReadError ? `Read error: ${stop.historyReadError}. ` : '')
      + ownerSummary
      + (stop.closingStatus ? `Hammer said: ${stop.closingStatus} ` : '')
      + (stop.refusal ? `Reasons: ${stop.refusal.reasons.join(', ')}. Missing evidence: ${JSON.stringify(stop.refusal.missingEvidence)}. Action: ${stop.refusal.next} `
        : 'Closure recovery rechecks the stopped workflow on the scheduled cadence. ')
      + (stop.refusal
        ? 'No further hammer run on this head until its head, base, mergeability, checks, review or gate revision changes, or missing evidence becomes computable; the watcher re-checks on its scheduled cadence and re-dispatches once when one does.'
        : `Transient stop; retry eligible at ${entry.retryAfter}, or sooner on changed inputs, within existing retry and lifetime caps.`);
    try {
      await deliverAlertImpl(text, {
        event: HAMMER_STOP_HOLD_PAGE_EVENT,
        payload: {
          repo, prNumber, headSha, predicate: stop.predicate, closingStatus: stop.closingStatus || null,
          next: stop.next || null, inputs,
          ...(recovery ? { nextAction: recovery } : {}),
          ...(stop.refusal ? { refusal: stop.refusal, next: stop.refusal.next } : {}),
          ...(stop.historyReadError ? { historyReadError: stop.historyReadError } : {}),
        },
      });
      markHoldEscalated(entry, rootDir);
      entry.pagedAt = now;
      dirty = true;
      PAGED_IN_PROCESS.add(debounceKey);
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: `${HAMMER_STOP_HOLD_PAGE_EVENT}_page_failed`,
        repo, prNumber, headSha, error: err?.message || String(err),
      }));
    }
  }
  if (dirty) persist();
  return { action: 'hold', hammerStop: { ...hammerStop, paged: Boolean(entry.pagedAt) || PAGED_IN_PROCESS.has(debounceKey) },
    ...(nextActionShared ? { nextActionShared } : {}) };

  function persist(holdEntry = entry) {
    try {
      let record = normalizeHammerStopHold(holdEntry, { repo, prNumber, headSha, now });
      const named = new Set(record.awaits.map(predicate => predicate.name || predicate.changed));
      const releaseEvents = (holdEntry.releasedBy || []).filter(name => !named.has(name)
        && !record.awaits.some(predicate => predicate.kind === name || predicate.kind === `${name}-change`));
      if (releaseEvents.length) record = createHoldRecord({ ...record,
        awaits: [...record.awaits, ...releaseEvents.map(name => ({ kind: 'event', name, ...(name === 'conflicting' ? { fallback: true } : {}) }))] });
      writeHoldState(rootDir, repo, prNumber, { ...state, currentHead: headSha, heads: { ...state.heads, [headSha]: record } });
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: 'ama_closer.hammer_stop_hold_persist_failed',
        repo, prNumber, headSha, error: err?.message || String(err),
      }));
    }
  }
}
