import { createHistoryReader } from './history-reader.mjs';
import { refundOperatorHeldHammerStop } from './operator-hold-refund.mjs';
import { readLatestHoldRelease } from '../operator-hold-release.mjs';
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
// not complete check rollups and cannot stand in for them. STOPHOLDREVIEW-01
// additionally checks review-required predicates against the stop timestamp:
// first observation must not absorb the exact-head review the hammer requested.
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
export const HAMMER_STOP_HOLD_PAGE_EVENT = 'ama_closer.hammer_stop_hold';

export const HAMMER_EVIDENCE_FAILURES = new Set(['primary-change-unknown', 'primary-change-read-failed', 'history-read-failed']);
export const HAMMER_GITHUB_READ_FAILURES = new Set(['github-gate-not-green', 'pr-mergeability-unknown']);
const REVIEW_REQUIRED_STOPS = new Set(['exact-head-review-required', 'stale-review-head']);
export const HAMMER_EVIDENCE_RECHECK_INTERVAL_MS = 5 * 60_000;
// Two ordinary five-minute polling intervals let a transport fault recover
// before paging. Start at the first failed probe, not the old hammer timestamp.
export const HISTORY_READ_FAILURE_PAGE_GRACE_MS = 10 * 60_000;
const execFileAsync = promisify(execFile);

const STOP_OUTCOMES = new Set(['failed-without-merge', 'no-merge']);
const DETERMINISTIC_STOP_REASONS = new Set([
  'primary-change-reverted', 'primary-change-unknown', 'stale-review-head',
  'verdict-not-eligible', 'verdict-not-settled-success', 'permanent-merge-rejection',
  'protective-predecessor-open', 'protective-predecessor-malformed-trailer',
  'builder-token-merge-refused', 'base-changed-file-overlap',
]);
// Process-local page debounce for a state file that cannot be written.
const PAGED_IN_PROCESS = new Set();

export function _resetHammerStopHoldPageDebounceForTests() {
  PAGED_IN_PROCESS.clear();
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
  const reasons = stopReasons(attempt);
  if (!reasons.length && DETERMINISTIC_STOP_REASONS.has(attempt.reason)) reasons.push(attempt.reason);
  if (!reasons.length || reasons.some(reason => /read-failed|unavailable|timeout|pending|mergeability-unknown/.test(reason))) return null;
  const missingEvidence = stable(attempt.missingEvidence || attempt.eligibilityTrace?.trace?.primaryChange?.missingEvidence
    || attempt.githubGate?.primaryChangeMissingEvidence || null);
  const key = createHash('sha256').update(JSON.stringify({ repo, prNumber: Number(prNumber), headSha, reasons, missingEvidence })).digest('hex');
  const next = attempt.next || (reasons.includes('primary-change-reverted')
    ? 'Restore the uncited reverted regions, then push the repaired head.'
    : reasons.includes('stale-review-head') ? 'Obtain an approving review on the current head.'
      : reasons.includes('ci-not-green') ? 'Repair the named required check and rerun it on the current head.'
        : `Supply the missing evidence for ${reasons[0]}.`);
  return { key, reasons, missingEvidence, next };
}

function stopReasons(attempt) {
  return [...new Set([
    ...(attempt?.eligibilityTrace?.reasons || []), ...(attempt?.githubGate?.reasons || []),
    ...(attempt?.reasons || []),
  ])].sort();
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

export function readHammerStopHoldForHead({ rootDir, repo, prNumber, headSha, stopKey } = {}) {
  const entry = readHoldState(rootDir, repo, prNumber).heads[headSha];
  return entry?.stopKey === stopKey ? entry : null;
}

function writeHoldState(rootDir, repo, prNumber, state) {
  const path = holdStatePath(rootDir, repo, prNumber);
  mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold'), { recursive: true });
  const heads = Object.entries(state.heads || {})
    .sort(([, a], [, b]) => String(b?.firstObservedAt || '').localeCompare(String(a?.firstObservedAt || '')))
    .slice(0, HEADS_KEPT);
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
  if (phase === 'hammer-lease-admission') return false;
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
 * opaque stops, but preserves deterministic refusals; `succeeded` clears both.
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
  if (!STOP_OUTCOMES.has(latest.outcome)) {
    // A later wait/read deferral is not new predicate evidence. It cannot
    // erase a deterministic refusal and re-arm dispatch on unchanged inputs.
    if (latest.outcome !== 'deferred') return null;
    latest = [...terminal].reverse().find(item => STOP_OUTCOMES.has(item.outcome)
      && deterministicRefusal(item.attempt, { repo, prNumber, headSha }));
    if (!latest) return null;
  }
  const { attempt } = latest;
  return {
    headSha,
    // Auditable stops in this review series let release refund multiple
    // hold-only runs without handing back any genuine code-work attempt.
    refundStops: terminal.filter(item => STOP_OUTCOMES.has(item.outcome)).map(item => ({
      auditHead: item.fileHead,
      launchRequestId: item.launchRequestId,
      noExecution: item.attempt?.noExecution === true || item.attempt?.workerState === 'never-spawned'
        || item.attempt?.executionStarted === false,
      predicate: oneLine(item.attempt?.reason, 120),
      recordedAt: item.attempt?.startedAt || item.attempt?.timestamp || item.attempt?.recordedAt || null,
      stopKey: `${item.fileHead}:${item.attempt?.attemptNumber ?? item.order}:${item.attempt?.startedAt || item.attempt?.timestamp || item.attempt?.recordedAt || ''}`,
    })),
    predicate: oneLine(attempt?.reason, 120) || 'reason-not-recorded',
    reasons: stopReasons(attempt),
    refusal: deterministicRefusal(attempt, { repo, prNumber, headSha }),
    closingStatus: oneLine(attempt?.closingStatus),
    ...(attempt?.historyReadError || attempt?.githubGate?.primaryChangeReason
      ? { historyReadError: oneLine(attempt.historyReadError || attempt.githubGate.primaryChangeReason) } : {}),
    next: oneLine(attempt?.next),
    recordedAt: attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || null,
    stopKey: `${latest.fileHead}:${attempt?.attemptNumber ?? latest.order}:${attempt?.startedAt || attempt?.timestamp || attempt?.recordedAt || ''}`,
    inputEvidence: recordedStopInputs(attempt),
  };
}

// Only compare readings actually present in the terminal attempt. In particular,
// checksConclusion/badChecks cannot reconstruct the full external check rollup.
function recordedStopInputs(attempt) {
  const trace = attempt.eligibilityTrace?.trace;
  const inputs = {};
  const head = attempt.githubGate?.liveHead || trace?.headMatch?.current;
  if (head) inputs.headSha = head;
  if (attempt.rebasedOntoBase) inputs.baseSha = attempt.rebasedOntoBase;
  const mergeability = attempt.githubGate?.mergeable || trace?.mergeability?.mergeableState;
  if (mergeability) inputs.mergeability = ['MERGEABLE', 'CONFLICTING'].includes(mergeability) ? mergeability : null;
  const review = {};
  if (trace?.headMatch?.reviewed) review.headSha = trace.headMatch.reviewed;
  const verdict = trace?.verdict;
  if (typeof verdict?.normalized === 'string') review.verdict = verdict.normalized;
  if (typeof verdict?.remediationPending === 'boolean') review.remediationPending = verdict.remediationPending;
  for (const [field, evidence] of [['blocking', verdict?.originalBlockingFindings || verdict?.blockingFindings],
    ['nonBlocking', verdict?.nonBlockingFindings]]) {
    if (!evidence) continue;
    if (typeof evidence.state === 'string') review[`${field}FindingState`] = evidence.state;
    if (Number.isFinite(evidence.count)) review[`${field}FindingCount`] = evidence.count;
  }
  return { inputs, review };
}

function stopBaseline(stop, fallback) {
  const { inputs, review } = stop.inputEvidence;
  let observedReview;
  try { observedReview = JSON.parse(fallback.review || 'null'); } catch { /* Legacy/unreadable fingerprint. */ }
  return { ...fallback, ...inputs,
    ...(Object.keys(review).length
      ? { review: JSON.stringify(stable({ ...observedReview, ...review })) } : {}) };
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
  const changed = [];
  if (!previous || !current) return changed;
  if (current.headSha && previous.headSha !== current.headSha) changed.push('head');
  if (current.baseSha && previous.baseSha !== current.baseSha) changed.push('base');
  if (current.mergeability && previous.mergeability !== current.mergeability) {
    changed.push('mergeability');
  }
  if (typeof previous.checks === 'string' && typeof current.checks === 'string' && previous.checks !== current.checks) {
    changed.push('checks');
  }
  if (typeof previous.review === 'string' && typeof current.review === 'string' && previous.review !== current.review) changed.push('review');
  return changed;
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
  excludeContexts = [],
  requiredCheckContexts = [],
  deliverAlertImpl = null,
  logger = console,
  now = new Date().toISOString(),
  readAuditImpl = readAmaAuditEntry,
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
  const stop = readHammerStopForHead({ hqRoot, repo, prNumber, headSha, reviewedSha, readAuditImpl, logger });
  if (!stop) return { action: 'none' };
  // FINALCLOSE-01: transport evidence cannot become an input-change hold. The
  // launched hammer owns a fresh read; ordinary series/lifetime caps own retries.
  if (stop.predicate === 'history-read-failed' && !stop.refusal) {
    const changed = ['history-read-retry'];
    writeHoldState(rootDir, repo, prNumber, { ...state, currentHead: headSha,
      heads: { ...state.heads, [headSha]: { stopKey: stop.stopKey, releasedAt: now,
        releasedBy: changed, paged: false } } });
    return { action: 'release', hammerStop: stop, changed };
  }

  const inputs = hammerStopInputs(prMetadata, { excludeContexts, reviewState });
  const prior = state.heads[headSha];
  const sameRefusal = stop.refusal && prior?.refusal?.key === stop.refusal.key;
  const reuseEntry = prior && (stop.refusal ? sameRefusal : prior.stopKey === stop.stopKey)
    && !(prior.releasedAt && prior.stopKey !== stop.stopKey);
  if (!reuseEntry) state.refusalGeneration = (Number(state.refusalGeneration) || 0) + 1;
  let entry = reuseEntry
    ? { ...prior, stopKey: stop.stopKey, ...(stop.refusal ? { refusal: stop.refusal } : {}) }
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
  let dirty = !reuseEntry || prior.stopKey !== stop.stopKey;
  if (!entry.releasedAt) {
    const release = readLatestHoldRelease(rootDir, repo, prNumber, headSha);
    const holdReleased = release && Date.parse(release.released_at) > Date.parse(stop.recordedAt || entry.firstObservedAt);
    const changed = holdReleased ? ['hold-released'] : changedHammerStopInputs(stopBaseline(stop, entry.inputs), inputs);
    // A review can arrive before the first closer observation. Its posting
    // time must strictly follow this terminal attempt, never a previous hold.
    const stoppedAt = Date.parse(stop.recordedAt || '');
    const reviewedAt = Date.parse(reviewState?.postedAt || '');
    if (REVIEW_REQUIRED_STOPS.has(stop.predicate)
      && reviewState?.headSha === headSha && reviewState?.verdict
      && Number.isFinite(stoppedAt) && reviewedAt > stoppedAt
      && !changed.includes('review')) changed.push('review');
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
        else if (stop.predicate === 'history-read-failed' && !holdReleased) changed.splice(0);
      } catch (err) {
        if (stop.predicate === 'history-read-failed' && !holdReleased) changed.splice(0);
        logger?.warn?.(`[ama-closer] hammer evidence probe failed for ${repo}#${prNumber}: ${err?.message || err}`);
      }
    }
    if (changed.length === 0 && !stop.refusal && stop.predicate !== 'history-read-failed' && hammerStopPrIsConflicting(prMetadata)) changed.push('conflicting');
    if (changed.length > 0) {
      entry = { ...entry, releasedAt: now, releasedBy: changed, releasedInputs: inputs };
      dirty = true;
      logger?.log?.(JSON.stringify({
        event: 'ama_closer.hammer_stop_hold_released',
        repo, prNumber, headSha, predicate: stop.predicate, changed,
      }));
    }
  }
  const hammerStop = {
    headSha,
    predicate: stop.predicate,
    ...(stop.refusal ? { refusal: stop.refusal } : {}),
    closingStatus: stop.closingStatus || null,
    ...(stop.historyReadError ? { historyReadError: stop.historyReadError } : {}),
    since: entry.firstObservedAt,
  };
  if (entry.releasedAt) {
    if (dirty) persist();
    return { action: 'release', hammerStop, changed: entry.releasedBy || [] };
  }
  const debounceKey = `${rootDir}\0${repo}\0${prNumber}\0${headSha}${stop.refusal ? `\0${stop.refusal.key}\0${entry.refusalGeneration}` : ''}`;
  const pageDue = stop.predicate !== 'history-read-failed'
    || Date.parse(now) - Date.parse(entry.firstObservedAt) >= HISTORY_READ_FAILURE_PAGE_GRACE_MS;
  if (pageDue && !entry.pagedAt && !PAGED_IN_PROCESS.has(debounceKey) && typeof deliverAlertImpl === 'function') {
    const text = `Adversarial-review hammer stopped without merging ${repo}#${prNumber} on head `
      + `${String(headSha).slice(0, 12)}: ${stop.predicate}. `
      + (stop.historyReadError ? `Read error: ${stop.historyReadError}. ` : '')
      + (stop.closingStatus ? `Hammer said: ${stop.closingStatus} ` : '')
      + (stop.refusal ? `Reasons: ${stop.refusal.reasons.join(', ')}. Missing evidence: ${JSON.stringify(stop.refusal.missingEvidence)}. Action: ${stop.refusal.next} `
        : 'The PR has neither a reviewer nor a hammer. Operator overrides: operator-approved, merge-agent-requested, paused-for-redesign. ')
      + 'No further hammer run on this head until its head, base, mergeability or checks change, or missing evidence becomes computable; '
      + 'the watcher re-checks on its scheduled cadence and re-dispatches once when one does.';
    try {
      await deliverAlertImpl(text, {
        event: HAMMER_STOP_HOLD_PAGE_EVENT,
        payload: {
          repo, prNumber, headSha, predicate: stop.predicate, closingStatus: stop.closingStatus || null,
          next: stop.next || null, inputs,
          ...(stop.refusal ? { refusal: stop.refusal, next: stop.refusal.next } : {}),
          ...(stop.historyReadError ? { historyReadError: stop.historyReadError } : {}),
        },
      });
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
  return { action: 'hold', hammerStop: { ...hammerStop, paged: Boolean(entry.pagedAt) || PAGED_IN_PROCESS.has(debounceKey) } };

  function persist() {
    try {
      writeHoldState(rootDir, repo, prNumber, { ...state, currentHead: headSha, heads: { ...state.heads, [headSha]: entry } });
    } catch (err) {
      logger?.error?.(JSON.stringify({
        event: 'ama_closer.hammer_stop_hold_persist_failed',
        repo, prNumber, headSha, error: err?.message || String(err),
      }));
    }
  }
}
