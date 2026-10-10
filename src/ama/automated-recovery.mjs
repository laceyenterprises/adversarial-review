// AMAFIND-01: recovery owns no merge authority. Every hammer retry re-enters
// the ordinary closer gates and lease; a rereview uses the review-state CAS.
import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { amaRetainLoopCapFor } from '../kernel/convergence-budget.mjs';
import { reconcileRecoveryLaunches } from './recovery-launch-reconciliation.mjs';
import { isCloserHeadRereviewDeclined } from '../closer-head-rereview-decline.mjs';

const FINDING_REASONS = new Set([
  'blocking-findings-unknown',
  'non-blocking-findings-present', 'non-blocking-findings-unknown',
  'verdict-not-settled-success', 'verdict-not-eligible',
  'ci-not-green', 'pr-not-mergeable',
]);

const FOLLOW_UP_REASONS = new Set([
  'blocking-findings-present', 'remediation-pending', 'remediation-state-unknown',
]);

const IN_PROGRESS_REASONS = new Set([
  'hammer-closer-in-flight', 'lease-held', 'live-run-in-flight',
  'active-remediation-job', 'ama-closer-dispatch-backgrounded',
  'dispatch-status-unknown', 'closer-lease-held-by-other-process',
  'daemon-deferred', 'deferred',
]);

const CONFIG_HOLD_REASONS = new Set([
  'branch-protection-missing-gate', 'fast-merge-state-unsupported', 'pr-is-draft',
  'current-head-ham-terminal-remediation-needs-operator',
]);

// This authorizes remediation DISPATCH only, never a merge or a gate waiver.
export function automatedHammerReasonsCovered(reasons) {
  return Array.isArray(reasons) && reasons.length > 0
    && reasons.every((reason) => FINDING_REASONS.has(reason));
}

export function isSafetyRecoveryHold(result) {
  const reasons = [result?.reason, result?.operatorReason, ...(result?.reasons || []),
    ...(result?.daemonCleanMerge?.reasons || [])].filter(Boolean);
  return result?.needsOperator === true
    || reasons.some((reason) => CONFIG_HOLD_REASONS.has(String(reason).replace(/^not-eligible:/, ''))
    || /^(?:not-eligible:)?label-/.test(reason)
    || /(?:two-key|security-hold|destructive-migration|risk-class-not-permitted|primary-change-(?:reverted|needs-operator))/.test(reason));
}

async function requestRereview(options) {
  const { requestReviewRereview } = await import('../review-state.mjs');
  return requestReviewRereview(options);
}

async function page(text, options) {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('offline tests must inject pageImpl');
  const { deliverAlert } = await import('../alert-delivery.mjs');
  return deliverAlert(text, options);
}

async function recoverAmaAutomationLocked({
  rootDir, repo, prNumber, headSha, result, reviewStateRow,
  dispatchHammer, reclaimLaunch = () => reconcileRecoveryLaunches({ rootDir, repo, prNumber, headSha, logger }),
  requestRereviewImpl = requestRereview, pageImpl = page,
  logger = console, maxAttempts = amaRetainLoopCapFor(), now = () => Date.now(),
  rereviewDeadlineMs = 30 * 60 * 1000, stuckDeadlineMs = 30 * 60 * 1000, signal = null,
}) {
  const reason = result?.reason || 'unknown';
  const reasons = result?.reasons || result?.daemonCleanMerge?.reasons || [];
  const key = createHash('sha256').update(`${repo}#${prNumber}@${headSha || 'unknown'}`).digest('hex');
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'ama-automated-recovery');
  const path = join(dir, `${key}.json`);
  mkdirSync(dir, { recursive: true });
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  state ||= { repo, pr: prNumber, head: headSha, attempts: 0, rereviewRequested: false, paged: false };
  const save = () => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  const clearStall = () => {
    if (state.blockedSince != null) {
      delete state.blockedSince;
      save();
    }
  };
  const waiting = (action, amaClosureResult = result) => {
    clearStall();
    return { outcome: 'ama-pending', amaClosureResult, recovery: { ...state, action } };
  };
  const ordinaryWait = (value) => IN_PROGRESS_REASONS.has(value?.reason)
    || value?.daemonCleanMerge?.disposition === 'deferred'
    || value?.recoveryWait || value?.commentOnlyFinalRoundAwaitingCi === true
    || FOLLOW_UP_REASONS.has(value?.reason)
    || (value?.reasons || []).some((item) => FOLLOW_UP_REASONS.has(item));
  // Ownership and ordinary time gates are progress, not failed recovery.
  if (reason === 'daemon-merged') return { outcome: 'pr-terminal', terminalReason: 'merged', amaClosureResult: result };
  if (isSafetyRecoveryHold(result)) {
    clearStall();
    return { outcome: 'await-operator', amaClosureResult: result };
  }
  if (/autonomous-merge.*disabled|ama-disabled/.test(reason)) return waiting('disabled');
  if (ordinaryWait(result)) return waiting(
    FOLLOW_UP_REASONS.has(reason) || reasons.some((item) => FOLLOW_UP_REASONS.has(item))
      ? 'await-remediation' : 'in-progress');
  const exhausted = async () => {
    const event = state.event || { event: 'ama.automated_recovery.exhausted', severity: 'SEV1',
      reason, reasons, repo, pr: prNumber, head: headSha, attempts: state.attempts };
    if (!state.event) {
      state.event = event;
      save();
      logger.error?.(JSON.stringify(event));
    }
    if (!state.paged) {
      try {
        await pageImpl(`SEV1 AMA automated recovery exhausted: ${repo}#${prNumber}@${headSha}: ${reason}`, {
          event: event.event, payload: event,
        });
        state.paged = true;
        save();
      } catch (err) {
        state.pageError = String(err?.message || err);
        save();
        logger.error?.(JSON.stringify({ event: 'ama.automated_recovery.page_failed', reason: state.pageError,
          repo, pr: prNumber, head: headSha }));
      }
    }
    return { outcome: 'recovery-exhausted', amaClosureResult: result, recovery: state };
  };
  const stalled = async (action, amaClosureResult = result) => {
    state.blockedSince ??= now();
    state.lastReason = amaClosureResult?.reason || reason;
    save();
    if (state.event || now() - state.blockedSince >= stuckDeadlineMs) return exhausted();
    return { outcome: 'ama-pending', amaClosureResult, recovery: { ...state, action } };
  };
  const charge = () => {
    state.attempts += 1;
    state.lastReason = reason;
    clearStall();
    save();
  };
  if (reason === 'ama-closer-launch-in-progress') {
    let launch;
    try { launch = await reclaimLaunch(); }
    catch (err) { logger.warn?.(`[ama-recovery] launch reconciliation failed: ${err?.message || err}`); }
    if (launch?.active > 0) return waiting('active-launch');
    if (launch?.reclaimed > 0) return waiting('reclaim-launch');
  }
  const stale = reasons.includes('stale-review-head') || reasons.includes('stale-head');
  const malformed = reasons.some((item) => /findings-unknown$/.test(item));
  // While a requested pass owns the row, don't consume retries or start HAM.
  const reviewStamp = String(reviewStateRow?.posted_at || reviewStateRow?.reviewer_session_uuid || 'unobserved');
  if (state.rereviewPending && ['pending', 'reviewing', 'pending-upstream'].includes(reviewStateRow?.review_status)) {
    return waiting('await-review');
  }
  if (state.rereviewPending && reviewStamp === state.rereviewBaseline) {
    if (now() - state.rereviewRequestedAt >= rereviewDeadlineMs) return exhausted();
    return { outcome: 'ama-pending', amaClosureResult: result, recovery: state };
  }
  if (state.rereviewPending) {
    state.rereviewPending = false;
    save();
  }
  if (state.event) return exhausted();
  if (state.attempts >= maxAttempts || /(?:retry-cap|lifetime-cap).*exhausted/.test(reason)) return stalled('attempt-cap');
  // NOOWNER-01: the watcher declined this head's re-review (its tip is a closer
  // commit, which is never re-reviewed). Asking again would only loop; wait out
  // the stall deadline, then page once.
  if (stale && isCloserHeadRereviewDeclined(reviewStateRow, headSha)) return stalled('rereview-declined-closer-head');
  try {
    if (stale || (malformed && !state.rereviewRequested)) {
      state.rereviewBaseline = reviewStamp;
      state.rereviewRequestedAt = now();
      save();
      const rereview = await requestRereviewImpl({ rootDir, repo, prNumber,
        targetRevisionRef: headSha, reason: `AMA automated recovery: ${stale ? 'stale-review-head' : 'malformed-findings'}`,
        automaticMalformedRecovery: malformed, logger });
      state.rereviewPending = rereview?.triggered === true || rereview?.reason === 'already-pending';
      if (state.rereviewPending) {
        state.rereviewRequested = true;
        if (rereview?.triggered === true) charge();
        else clearStall();
      }
      save();
      if (!state.rereviewPending) return stalled('rereview-refused');
      return { outcome: 'ama-pending', amaClosureResult: result, recovery: { ...state, action: 'rereview', rereview } };
    }
    if (automatedHammerReasonsCovered(reasons)) {
      const retry = await dispatchHammer();
      if (retry?.dispatched) {
        charge();
        return { outcome: 'ama-dispatched', amaClosureResult: retry, recovery: { ...state, action: 'hammer' } };
      }
      if (ordinaryWait(retry)) return waiting('in-progress', retry);
      if (isSafetyRecoveryHold(retry)) {
        clearStall();
        return { outcome: 'await-operator', amaClosureResult: retry, recovery: state };
      }
      return stalled('hammer-refused', retry);
    }
    // Unavailable safety/identity evidence stays fail-closed, with bounded
    // automated retries and a loud exhaustion event instead of an operator park.
    return stalled('retry');
  } catch (err) {
    if (signal?.aborted || ['AbortError', 'AmaCoexistenceAbortError'].includes(err?.name)
      || ['ABORT_ERR', 'AMA_COEXISTENCE_ABORTED', 'AMA_COEXISTENCE_OPERATION_TIMEOUT'].includes(err?.code)) throw err;
    charge();
    logger.warn?.(`[ama-recovery] ${repo}#${prNumber}: ${err?.message || err}`);
    return stalled('error');
  }
}

export async function recoverAmaAutomation(options) {
  const key = createHash('sha256').update(`${options.repo}#${options.prNumber}@${options.headSha || 'unknown'}`).digest('hex');
  const dir = join(options.rootDir, 'data', 'follow-up-jobs', 'ama-automated-recovery');
  mkdirSync(dir, { recursive: true });
  // A kernel flock serializes retries/pages across watcher processes, releases
  // on crash, and keeps a stable inode (the lock file is never unlinked).
  const fd = openSync(join(dir, `${key}.lock`), 'a', 0o600);
  try {
    try { fsExt.flockSync(fd, 'exnb'); }
    catch (err) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes(err.code)) {
        return { outcome: 'ama-pending', amaClosureResult: options.result, recovery: { action: 'recovery-in-progress' } };
      }
      throw err;
    }
    return await recoverAmaAutomationLocked(options);
  } finally {
    closeSync(fd);
  }
}
