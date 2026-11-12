// DAEMONSUPERSEDE-01: a zero-finding, exact-head clean review supersedes a
// closer launch that has not booted. The shared decision (`nextAction`) names
// the launch; this executor records durable intent, re-reads it, cancels it
// through the audited `hq dispatch cancel` path with a typed reason and
// confirms the launch is terminal, so the daemon merges under the shared
// lease instead of waiting for a workspace that has nothing left to do.
//
// A launch that has booted (leased, starting, running, suspended or parked) is
// never cancelled here: the closer keeps the merge. A closer that boots in the
// race finds the PR merged at its lease admission (`mergeLeaseAdmissionReason`
// returns `pr-merged`, which closes out as `already-merged`) and ends cleanly.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLOSER_SUPERSEDE_REASON } from '../pr-next-action.mjs';
import { execHqDispatchCancel } from '../merge-agent-hq-exec.mjs';
import { resolveHqBin } from '../remediation-hq-dispatch.mjs';
import { readLaunchRequestObservationFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { readAmaCloserLease, updateAmaCloserLease } from './closer-lease.mjs';
import { updateAmaCloserDispatchRecord } from './dispatch-closer.mjs';

const execFileAsync = promisify(execFile);
const HQ_CANCEL_TIMEOUT_MS = 10_000;
export const NOT_BOOTED_CLOSER_STATUSES = Object.freeze(['requested', 'admitted']);

/**
 * Boot state from one complete launch observation.
 * @returns {'not-booted'|'booted'|'ended'|'unknown'}
 */
export function closerBootState(observation) {
  if (observation?.state !== 'complete' || !observation.value) return 'unknown';
  const value = observation.value;
  if (value.retryChainUnreadable === true) return 'unknown';
  if (value.terminal === true) return 'ended';
  const status = String(value.effectiveLaunch?.status || '').trim().toLowerCase();
  if (!status) return 'unknown';
  if (NOT_BOOTED_CLOSER_STATUSES.includes(status) && !value.worker) return 'not-booted';
  return 'booted';
}

function refused(reason, extra = {}) {
  return { superseded: false, reason, ...extra };
}

/**
 * Cancel a not-booted closer launch that a clean exact-head review superseded.
 * Never throws for HQ/ledger failures: an unconfirmed cancel keeps the closer
 * as owner, so the daemon does not merge on that tick.
 */
export async function supersedeNotBootedCloser({ headSha, reviewedHeadSha, launchRequestId, ...options } = {}) {
  if (!launchRequestId || !headSha || reviewedHeadSha !== headSha) return refused('supersede-identity-mismatch');
  return cancelNotBootedCloser({ ...options, headSha, launchRequestId, reason: CLOSER_SUPERSEDE_REASON,
    markerField: 'supersededByReview', markerFacts: { reviewedHeadSha }, terminalOutcome: 'superseded' });
}

/**
 * CLOSERHEADPIN-01: the PR head moved off the head a not-booted closer's
 * inputs are pinned to (`pinnedHeadSha`). Such a closer cannot have authored
 * the new head, so it is ended with the typed `superseded-head-moved` outcome
 * through the same audited cancel, instead of carrying its lease onto a head
 * its inputs would refuse. An unconfirmed cancel keeps the closer as owner.
 */
export async function supersedeHeadMovedCloser({ pinnedHeadSha, liveHeadSha, launchRequestId, ...options } = {}) {
  if (!launchRequestId || !pinnedHeadSha || !liveHeadSha || pinnedHeadSha === liveHeadSha) {
    return refused('supersede-identity-mismatch');
  }
  return cancelNotBootedCloser({ ...options, headSha: pinnedHeadSha, launchRequestId,
    reason: CLOSER_HEAD_MOVED_REASON, markerField: 'supersededByHeadMove',
    markerFacts: { liveHeadSha }, terminalOutcome: CLOSER_HEAD_MOVED_REASON });
}

export const CLOSER_HEAD_MOVED_REASON = 'superseded-head-moved';

async function cancelNotBootedCloser({
  rootDir, repo, prNumber, headSha, launchRequestId, reason, markerField, markerFacts, terminalOutcome,
  recordHeadSha = headSha, hqRoot = process.env.HQ_ROOT, hqPath = resolveHqBin(process.env),
  readLaunchImpl = readLaunchRequestObservationFromLedgerAsync,
  cancelImpl = execHqDispatchCancel, execFileImpl = execFileAsync,
  updateDispatchRecordImpl = updateAmaCloserDispatchRecord,
  readLeaseImpl = readAmaCloserLease, updateLeaseImpl = updateAmaCloserLease,
  retryDelaysMs, signal = null, logger = console, now = () => new Date().toISOString(),
} = {}) {
  const read = async () => {
    try { return await readLaunchImpl({ rootDir, launchRequestId, signal }); }
    catch { return null; }
  };
  // Fresh read before recording intent: the decision's snapshot may be
  // older than a launch that has just leased a workspace.
  const before = closerBootState(await read());
  if (before !== 'not-booted') return refused(`closer-${before}`);
  // Persist the intent before cancellation. A crash or failed terminal-status
  // write after HQ cancels must not turn this launch into a fresh hammer retry.
  // The policy still requires terminal launch evidence before using the marker.
  const at = now();
  const marker = { launchRequestId, headSha, ...markerFacts, reason,
    observedStatus: null, supersededAt: at };
  try {
    const recorded = updateDispatchRecordImpl(rootDir, { repo, prNumber, headSha: recordHeadSha }, record =>
      record?.launchRequestId === launchRequestId ? { ...record, [markerField]: marker } : null);
    if (recorded?.[markerField] !== marker) return refused('supersede-record-mismatch');
  } catch (error) {
    logger?.warn?.(`[ama-closer] supersede marker write failed for ${repo}#${prNumber}: ${error?.message || error}`);
    return refused('supersede-marker-write-failed');
  }
  // Re-read after the durable write, immediately before cancellation.
  const ready = closerBootState(await read());
  if (ready !== 'not-booted') return refused(`closer-${ready}`);
  try {
    await cancelImpl({ hqPath, launchRequestId, reason, retryDelaysMs,
      hqExecFileImpl: (bin, args, options) => execFileImpl(bin, args, {
        ...options, timeout: HQ_CANCEL_TIMEOUT_MS, ...(signal ? { signal } : {}) }),
      env: { ...process.env, ...(hqRoot ? { HQ_ROOT: hqRoot } : {}) } });
  } catch (error) {
    // "already terminal" is confirmed by the re-read below; anything else is
    // reported, and the re-read still decides.
    logger?.warn?.(`[ama-closer] supersede cancel for ${repo}#${prNumber} lrq=${launchRequestId} `
      + `returned an error: ${error?.message || error}`);
  }
  const afterObservation = await read();
  const after = closerBootState(afterObservation);
  if (after !== 'ended') return refused('closer-cancel-unconfirmed', { observed: after });
  const observedStatus = String(afterObservation.value.effectiveLaunch?.status || '').toLowerCase() || null;
  const confirmedMarker = { ...marker, observedStatus };
  try {
    updateDispatchRecordImpl(rootDir, { repo, prNumber, headSha: recordHeadSha }, record => record && ({
      ...record, [markerField]: confirmedMarker, lastObservedStatus: observedStatus, lastObservedAt: at,
    }));
  } catch (error) {
    logger?.warn?.(`[ama-closer] supersede status write failed for ${repo}#${prNumber}: ${error?.message || error}`);
  }
  try {
    // CLR-01 moves the lease, while its dispatch record stays at recordHeadSha.
    const lease = readLeaseImpl(rootDir, { repo, prNumber, headSha });
    if (lease?.lrqId === launchRequestId && ['pending', 'dispatched'].includes(lease.status)) {
      updateLeaseImpl({ rootDir, repo, prNumber, headSha: lease.headSha || headSha,
        status: 'terminal', terminalOutcome, now: at });
    }
  } catch (error) {
    logger?.warn?.(`[ama-closer] supersede lease release failed for ${repo}#${prNumber}: ${error?.message || error}`);
  }
  logger?.log?.(JSON.stringify({ event: 'ama.closer_superseded', repo, pr: prNumber, headSha,
    launchRequestId, reason, observedStatus }));
  return { superseded: true, launchRequestId, observedStatus, marker: confirmedMarker };
}
