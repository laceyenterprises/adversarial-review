// AMAFIND-01: recovery owns no merge authority. Every hammer retry re-enters
// the ordinary closer gates and lease; a rereview uses the review-state CAS.
import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { amaRetainLoopCapFor } from '../kernel/convergence-budget.mjs';
import { reconcileRecoveryLaunches } from './recovery-launch-reconciliation.mjs';
import { readClosureNextAction } from './closure-next-action.mjs';
import { deriveNextActionSnapshot, nextAction } from '../pr-next-action.mjs';

// Physical refusals are explicit evidence, never a reason-string allowlist.
export function isSafetyRecoveryHold(result) {
  return result?.safetyRefusal === true || result?.nextAction?.action === 'operator-hold'
    || (result?.nextAction?.row === 'R05-structural' && result.nextAction.actor === 'closure-recovery')
    || (result?.needsOperator === true && !result?.primaryChangeRepair);
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
  // Migrate the legacy receipt before a resolved UNKNOWN can clear its event.
  // A legacy paged head without an event could only have cleared UNKNOWN.
  state.pagedReasons ??= state.paged ? [state.event?.reason || 'background-pr-mergeable-unknown'] : [];
  const save = () => writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  const clearStall = () => {
    if (state.blockedSince != null) {
      delete state.blockedSince;
      save();
    }
  };
  const waiting = (action, amaClosureResult = result) => {
    clearStall();
    return { outcome: 'ama-pending', amaClosureResult, recovery: { ...state, action },
      urgent: selected.queue?.intent === 'owned' || Boolean(selected.queue?.deferredBy) };
  };
  const selected = result?.nextAction?.head === headSha ? result.nextAction
    : nextAction(deriveNextActionSnapshot({ subjectKey: `${repo}#${prNumber}`, head: headSha,
      observedAt: new Date(now()).toISOString(),
      anchors: { firstActionableAt: state.firstActionableAt || new Date(now()).toISOString() },
      observations: { pr: { state: 'OPEN', headSha } } }));
  state.firstActionableAt ||= selected.deadline?.anchoredAt;
  state.nextAction = selected;
  if (selected.action === 'done') return { outcome: 'pr-terminal', terminalReason: selected.reason, amaClosureResult: result };
  if (selected.action === 'operator-hold') return { outcome: 'await-operator', amaClosureResult: result };
  const ordinaryWait = value => Boolean(value?.nextAction && (value.nextAction.queue?.intent !== 'dispatch'
    || value.nextAction.queue?.deferredBy));
  async function exhausted() {
    const event = state.event || { event: 'ama.automated_recovery.exhausted', severity: 'SEV1',
      reason, reasons, repo, pr: prNumber, head: headSha, attempts: state.attempts, nextAction: selected };
    if (!state.event) {
      state.event = event;
      save();
      logger.error?.(JSON.stringify(event));
    }
    if (!state.pagedReasons.includes(event.reason)) {
      try {
        const observedAt = now();
        const anchoredAt = [Date.parse(selected.deadline?.anchoredAt), Date.parse(state.firstActionableAt),
          state.blockedSince, observedAt].find(Number.isFinite);
        await pageImpl(`SEV1 AMA automated recovery exhausted: ${repo}#${prNumber}@${headSha}: ${event.reason}; `
          + `action=${selected.action} actor=${selected.actor} reason=${selected.reason} head=${headSha} `
          + `ageMs=${Math.max(0, observedAt - anchoredAt)}`,  {
          event: event.event, payload: event,
        });
        state.paged = true;
        state.pagedReasons.push(event.reason);
        save();
      } catch (err) {
        state.pageError = String(err?.message || err);
        save();
        logger.error?.(JSON.stringify({ event: 'ama.automated_recovery.page_failed', reason: state.pageError,
          repo, pr: prNumber, head: headSha }));
      }
    }
    return { outcome: 'recovery-exhausted', amaClosureResult: result, recovery: state, nextAction: selected };
  }
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
  async function stalled(action, amaClosureResult = result) {
    state.blockedSince ??= now();
    state.lastReason = amaClosureResult?.reason || reason;
    save();
    if (state.event || now() - state.blockedSince >= stuckDeadlineMs) return exhausted();
    return { outcome: 'ama-pending', amaClosureResult, recovery: { ...state, action } };
  }
  const charge = () => {
    state.attempts += 1;
    state.lastReason = reason;
    clearStall();
    save();
  };
  const launch = readClosureNextAction(result)?.snapshot.observations.launches?.value?.closer;
  if (selected.actor === 'closure-recovery' && launch?.launchRequestId) {
    try { await reclaimLaunch(); }
    catch (error) { logger.warn?.(`[ama-recovery] launch reconciliation failed: ${error.message}`); }
    // A changed receipt invalidates this generation; the next pass re-decides.
  }
  if (selected.queue?.intent !== 'dispatch' || selected.queue?.deferredBy) {
    return selected.queue?.intent === 'owned' ? waiting('in-progress') : stalled('observe');
  }
  if (state.attempts >= maxAttempts) return stalled('attempt-cap');
  try {
    if (selected.action === 'review' && selected.actor === 'reviewer') {
      state.rereviewBaseline = reviewStamp;
      state.rereviewRequestedAt = now();
      save();
      const rereview = await requestRereviewImpl({ rootDir, repo, prNumber,
        targetRevisionRef: headSha, reason: `AMA automated recovery: ${selected.reason}`, logger });
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
    if (selected.action === 'hammer' && selected.actor === 'hammer') {
      const retry = await dispatchHammer();
      if (retry?.dispatched) {
        charge();
        return { outcome: 'ama-dispatched', amaClosureResult: retry, recovery: { ...state, action: 'hammer' } };
      }
      if (ordinaryWait(retry)) return waiting('in-progress', retry);
      if (isSafetyRecoveryHold(retry)) {
        clearStall();
        return { outcome: retry.nextAction?.action === 'operator-hold' ? 'await-operator' : 'ama-pending',
          amaClosureResult: retry, recovery: state };
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
