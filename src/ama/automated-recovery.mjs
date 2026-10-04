// AMAFIND-01: recovery owns no merge authority. Every hammer retry re-enters
// the ordinary closer gates and lease; a rereview uses the review-state CAS.
import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { reconcileRecoveryLaunches } from './recovery-launch-reconciliation.mjs';

const FINDING_REASONS = new Set([
  'blocking-findings-unknown',
  'non-blocking-findings-present', 'non-blocking-findings-unknown',
  'verdict-not-settled-success',
  'ci-not-green', 'pr-not-mergeable',
]);

const FOLLOW_UP_REASONS = new Set([
  'blocking-findings-present', 'remediation-pending', 'remediation-state-unknown',
]);

// This authorizes remediation DISPATCH only, never a merge or a gate waiver.
export function automatedHammerReasonsCovered(reasons) {
  return Array.isArray(reasons) && reasons.length > 0
    && reasons.every((reason) => FINDING_REASONS.has(reason));
}

export function isSafetyRecoveryHold(result) {
  const reasons = [result?.reason, result?.operatorReason, ...(result?.reasons || []),
    ...(result?.daemonCleanMerge?.reasons || [])].filter(Boolean);
  return reasons.some((reason) => /^(?:not-eligible:)?label-/.test(reason)
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
  dispatchHammer, reclaimLaunch = () => reconcileRecoveryLaunches({ rootDir, logger }),
  requestRereviewImpl = requestRereview, pageImpl = page,
  logger = console, maxAttempts = 3, now = () => Date.now(), rereviewDeadlineMs = 30 * 60 * 1000,
}) {
  const reason = result?.reason || 'unknown';
  const reasons = result?.reasons || result?.daemonCleanMerge?.reasons || [];
  // A completed merge and the kill switch must never redrive automation.
  if (reason === 'daemon-merged') return { outcome: 'pr-terminal', terminalReason: 'merged', amaClosureResult: result };
  if (isSafetyRecoveryHold(result)) return { outcome: 'await-operator', amaClosureResult: result };
  if (/autonomous-merge.*disabled|ama-disabled/.test(reason)) return { outcome: 'ama-pending', amaClosureResult: result };
  // The ordinary closer already admits exhausted cycles after follow-up
  // ownership is released. Recovery cannot mint that authority or charge the
  // recovery budget while the Codex-first lane still owns findings/the head.
  if (reasons.some((item) => FOLLOW_UP_REASONS.has(item))) {
    return { outcome: 'ama-pending', amaClosureResult: result,
      recovery: { action: 'await-remediation' } };
  }
  const key = createHash('sha256').update(`${repo}#${prNumber}@${headSha || 'unknown'}`).digest('hex');
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'ama-automated-recovery');
  const path = join(dir, `${key}.json`);
  mkdirSync(dir, { recursive: true });
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  state ||= { repo, pr: prNumber, head: headSha, attempts: 0, rereviewRequested: false, paged: false };
  const save = () => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
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
  if (reason === 'ama-closer-launch-in-progress') {
    let launch;
    try { launch = await reclaimLaunch(); }
    catch (err) { logger.warn?.(`[ama-recovery] launch reconciliation failed: ${err?.message || err}`); }
    if (launch?.active > 0) return { outcome: 'ama-pending', amaClosureResult: result,
      recovery: { ...state, action: 'active-launch', launch } };
    if (launch?.reclaimed > 0) return { outcome: 'ama-pending', amaClosureResult: result,
      recovery: { ...state, action: 'reclaim-launch', launch } };
  }
  const stale = reasons.includes('stale-review-head') || reasons.includes('stale-head');
  const malformed = reasons.some((item) => /findings-unknown$/.test(item));
  // While a requested pass owns the row, don't consume retries or start HAM.
  const reviewStamp = String(reviewStateRow?.posted_at || reviewStateRow?.reviewer_session_uuid || 'unobserved');
  if (state.rereviewPending && (['pending', 'reviewing', 'pending-upstream'].includes(reviewStateRow?.review_status)
    || reviewStamp === state.rereviewBaseline)) {
    if (now() - state.rereviewRequestedAt >= rereviewDeadlineMs) return exhausted();
    return { outcome: 'ama-pending', amaClosureResult: result, recovery: state };
  }
  if (state.attempts >= maxAttempts || /(?:retry-cap|lifetime-cap).*exhausted/.test(reason)) return exhausted();
  state.attempts += 1;
  state.lastReason = reason;
  save();
  try {
    if (stale || (malformed && !state.rereviewRequested)) {
      state.rereviewRequested = true;
      state.rereviewBaseline = reviewStamp;
      state.rereviewRequestedAt = now();
      save();
      const rereview = await requestRereviewImpl({ rootDir, repo, prNumber,
        targetRevisionRef: headSha, reason: `AMA automated recovery: ${stale ? 'stale-review-head' : 'malformed-findings'}`,
        automaticMalformedRecovery: malformed, logger });
      state.rereviewPending = rereview?.triggered === true || rereview?.reason === 'already-pending';
      save();
      return { outcome: 'ama-pending', amaClosureResult: result, recovery: { ...state, action: 'rereview', rereview } };
    }
    if (automatedHammerReasonsCovered(reasons)) {
      const retry = await dispatchHammer();
      return { outcome: retry?.dispatched ? 'ama-dispatched' : 'ama-pending',
        amaClosureResult: retry, recovery: { ...state, action: 'hammer' } };
    }
    // Unavailable safety/identity evidence stays fail-closed, with bounded
    // automated retries and a loud exhaustion event instead of an operator park.
    return { outcome: 'ama-pending', amaClosureResult: result, recovery: { ...state, action: 'retry' } };
  } catch (err) {
    logger.warn?.(`[ama-recovery] ${repo}#${prNumber}: ${err?.message || err}`);
    return state.attempts >= maxAttempts ? exhausted()
      : { outcome: 'ama-pending', amaClosureResult: result, recovery: { ...state, error: String(err?.message || err) } };
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
