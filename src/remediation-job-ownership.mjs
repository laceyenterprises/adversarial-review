import { hostname } from 'node:os';
import { verifyPgidIdentitySync } from './process-group-identity.mjs';
import { readDispatchStatus } from './producer-contracts/launch-status.mjs';

// A progress heartbeat is a bounded alternative to a local process identity.
// Queue/claim timestamps grant bounded pre-spawn custody, not worker liveness.
// Workspace existence, locks and dispatch IDs alone are not liveness.
export const REMEDIATION_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;
export const REMEDIATION_PRESPAWN_GRACE_MS = 5 * 60 * 1000;
// An HQ launch observation is read from HQ by the reconcile pass every tick.
// It stays authoritative for this long if that pass stops observing.
export const REMEDIATION_HQ_LAUNCH_OBSERVATION_GRACE_MS = 10 * 60 * 1000;

export function isHqDispatchedWorker(worker) {
  return worker?.dispatchMode === 'hq'
    && Boolean(String(worker.dispatchId || worker.launchRequestId || '').trim());
}

// CLOSERREVIVE-01: a worker launched through HQ dispatch has no local process
// and writes no local heartbeat. The reconcile pass records what
// `hq dispatch status` last said as `worker.hqLaunch = { status, observedAt }`.
// A running (requested, leased or running) launch is live; a terminal one is not.
export function hqLaunchObservation(status, observedAt) {
  const read = readDispatchStatus(status && typeof status === 'object' ? status : { status });
  return { status: read.status || null, terminal: read.terminal === true, observedAt };
}

function hqLaunchOwnership(worker, nowMs, spawnedAtMs, prespawnGraceMs) {
  const observed = worker.hqLaunch;
  const observedAt = Date.parse(observed?.observedAt || '');
  if (observed && Number.isFinite(observedAt) && observedAt <= nowMs) {
    if (observed.terminal === true) return { live: false, reason: 'hq-launch-terminal' };
    if (observed.status && nowMs - observedAt < REMEDIATION_HQ_LAUNCH_OBSERVATION_GRACE_MS) {
      return { live: true, reason: 'hq-launch-active' };
    }
  }
  // A launch that was just requested has not been observed yet.
  if (Number.isFinite(spawnedAtMs) && spawnedAtMs <= nowMs
    && nowMs - spawnedAtMs < prespawnGraceMs) {
    return { live: true, reason: 'fresh-hq-launch' };
  }
  return null;
}

export function remediationJobOwnership(job, {
  now = Date.now(), host = hostname(), verifyIdentityImpl = verifyPgidIdentitySync,
} = {}) {
  const prespawnGraceMs = REMEDIATION_PRESPAWN_GRACE_MS;
  const heartbeatGraceMs = REMEDIATION_HEARTBEAT_GRACE_MS;
  const status = String(job?.status || '').toLowerCase().replaceAll('-', '_');
  if (!['pending', 'in_progress'].includes(status)) return { live: false, reason: 'terminal-job' };
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  // Requeues retain creation time and may retain the predecessor's terminal
  // worker. Their new pendingAt, not that finished worker, anchors custody.
  if (status === 'pending' || !job.remediationWorker) {
    const queuedAt = Date.parse(status === 'pending' ? (job.pendingAt || job.createdAt || '') : (job.claimedAt || ''));
    const live = Number.isFinite(queuedAt) && queuedAt <= nowMs
      && nowMs - queuedAt < prespawnGraceMs;
    if (live) return { live: true,
      reason: status === 'pending' ? 'fresh-pending-job' : 'fresh-unspawned-claim' };
  }
  const worker = job?.remediationWorker || {};
  if (['completed', 'failed', 'stopped', 'cancelled', 'exited'].includes(worker.state)) {
    return { live: false, reason: 'terminal-worker' };
  }
  if (isHqDispatchedWorker(worker)) {
    // HQ liveness is the HQ launch state, never a local heartbeat or PID.
    return hqLaunchOwnership(worker, nowMs, Date.parse(worker.spawnedAt || ''), prespawnGraceMs)
      || { live: false, reason: 'worker-liveness-expired' };
  }
  const heartbeat = Date.parse(job.lastHeartbeatAt || '');
  if (Number.isFinite(heartbeat) && heartbeat <= nowMs && nowMs - heartbeat < heartbeatGraceMs) {
    return { live: true, reason: 'fresh-worker-heartbeat' };
  }
  const pid = Number(worker.processId);
  const expected = Date.parse(worker.spawnedAt || '');
  // HQ workers have a different PID namespace. Only their progress heartbeat
  // can be used here; a local PID collision must not retain ownership.
  if (worker.dispatchMode !== 'hq' && (!worker.holderHost || worker.holderHost === host)
    && Number.isInteger(pid) && pid > 0 && Number.isFinite(expected)) {
    try {
      if (verifyIdentityImpl(pid, worker.spawnedAt)?.match === true) {
        return { live: true, reason: 'live-worker-identity' };
      }
    } catch { /* Uncertain process evidence cannot renew the heartbeat grace. */ }
  }
  return { live: false, reason: 'worker-liveness-expired' };
}

// The stale-claim sweeps and the closer share this one answer. A sweep judges a
// local worker by artifact and publish progress it reads itself, so a fresh
// local heartbeat or a matching PID never blocks it. What it cannot see is an
// HQ launch, so a launch that is running (or was just requested) is never
// reclaimed: the closer reads the same job as a live owner.
const HQ_LAUNCH_OWNERSHIP_REASONS = new Set(['hq-launch-active', 'fresh-hq-launch']);

export function staleClaimMayBeReclaimed(job, options = {}) {
  const ownership = remediationJobOwnership(job, options);
  return { reclaim: !(ownership.live && HQ_LAUNCH_OWNERSHIP_REASONS.has(ownership.reason)), ownership };
}
