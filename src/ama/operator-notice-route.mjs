import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { findLiveAmaCloserLease } from './closer-lease.mjs';
import { readAmaCloserDispatchRecordsForPR } from './dispatch-record-read.mjs';
import { launchRequestInFlight } from './launch-request-status.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { readHammerRetryCapLedger, HAMMER_RETRY_CAP_EXHAUSTED_REASON,
  HAMMER_RETRY_CAP_LIFETIME_EXHAUSTED_REASON,
  HAMMER_TARGET_REDRIVE_CAP_EXHAUSTED_REASON } from './hammer-retry-cap.mjs';
import { isHammerWorkerClass } from './hammer-worker-class.mjs';
import { isActiveAmaCloserDispatchRecord } from './dispatch-closer.mjs';

const CAP_REASONS = new Set([
  'dispatch-retry-exhausted', 'hammer-retry-cap', 'hammer-lifetime-cap',
  HAMMER_RETRY_CAP_EXHAUSTED_REASON, HAMMER_RETRY_CAP_LIFETIME_EXHAUSTED_REASON,
  HAMMER_TARGET_REDRIVE_CAP_EXHAUSTED_REASON,
]);

export function operatorNoticeRetryCapReached(rootDir, identity, outcome, reviewedSha) {
  if ([outcome?.reason, outcome?.closureOwner?.reason].some(reason => CAP_REASONS.has(reason))) return true;
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  return Boolean(ledger?.__corrupt || ledger?.lifetimeSuppressed
    || (ledger?.suppressed && ledger.jobKey === (reviewedSha || identity.headSha))
    || (ledger?.targetSuppressed && ledger.targetRemediationSha === identity.headSha));
}

// Use recorded closure outcomes, never process exit status, to justify a page.
// Missing or retryable outcomes retain the route until the idle backstop.
export function operatorNoticeNonRetryableStop(record) {
  if (!record?.launchRequestId || !isHammerWorkerClass(record.workerClass)
    || record.lastFailureTransient === true) return null;
  const outcome = record.outcome || record.terminalOutcome;
  return ['failed-without-merge', 'no-merge', 'operator_triage_required'].includes(outcome)
    ? outcome : null;
}

export function operatorNoticePendingRetry(outcome, record) {
  return Boolean(outcome && !outcome.needsOperator && outcome.closureOwner?.owner !== 'page'
    && (outcome.inFlight || outcome.recoveryWait || outcome.retryAfterMs || outcome.backgroundDispatch
      || (outcome.dispatched && !record?.outcome)
      || outcome.closureOwner?.reason?.startsWith('in-flight:')));
}

export async function operatorNoticeInFlight(rootDir, identity, {
  readLaunchRequestStatusImpl = readLaunchRequestStatusFromLedgerAsync,
  now = Date.now(),
} = {}) {
  if (findLiveAmaCloserLease(rootDir, identity)) return 'live-closer-lease';
  for (const record of readAmaCloserDispatchRecordsForPR(rootDir, identity)) {
    // A replacement can still carry the previous launch ID and terminal status
    // while hq dispatch admits it. Do not probe that old ID as the new launch.
    if (record.state === 'dispatching') {
      if (isActiveAmaCloserDispatchRecord({ ...record, lastObservedStatus: null },
        { now: new Date(now).toISOString() })) return 'closer-in-flight';
      continue;
    }
    if (!record.launchRequestId) {
      if (record.state === 'dispatched') return 'closer-in-flight';
      continue;
    }
    let probe;
    try {
      probe = await readLaunchRequestStatusImpl({ rootDir, hqRoot: record.hqRoot,
        launchRequestId: record.launchRequestId, includeRetryChain: true, timeoutMs: loadAwareTimeoutMs(1000) });
    } catch { /* Unknown liveness cannot retire a recorded active launch. */ }
    // Shared with the in-flight closure blocker and closer lease reclamation;
    // a requested/admitted/leased/running launch has no age escape here.
    const inFlight = launchRequestInFlight(probe);
    const recordedInFlight = launchRequestInFlight({ ok: true,
      row: { status: record.terminalLaunchStatus || record.lastObservedStatus } });
    if (inFlight === true || (inFlight === null && (probe?.retryChainUnreadable || recordedInFlight !== false))) {
      return 'closer-in-flight';
    }
  }
  return null;
}
