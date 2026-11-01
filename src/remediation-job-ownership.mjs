import { hostname } from 'node:os';
import { verifyPgidIdentitySync } from './process-group-identity.mjs';

// A progress heartbeat is a bounded alternative to a local process identity.
// Queue/claim timestamps grant bounded pre-spawn custody, not worker liveness.
// Workspace existence, locks and dispatch IDs alone are not liveness.
export const REMEDIATION_HEARTBEAT_GRACE_MS = 5 * 60 * 1000;
export const REMEDIATION_PRESPAWN_GRACE_MS = 5 * 60 * 1000;

export function remediationJobOwnership(job, {
  now = Date.now(), host = hostname(), verifyIdentityImpl = verifyPgidIdentitySync,
} = {}) {
  const status = String(job?.status || '').toLowerCase().replaceAll('-', '_');
  if (!['pending', 'in_progress'].includes(status)) return { live: false, reason: 'terminal-job' };
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  // Requeues retain creation time and may retain the predecessor's terminal
  // worker. Their new pendingAt, not that finished worker, anchors custody.
  if (status === 'pending' || !job.remediationWorker) {
    const queuedAt = Date.parse(status === 'pending' ? (job.pendingAt || job.createdAt || '') : (job.claimedAt || ''));
    const live = Number.isFinite(queuedAt) && queuedAt <= nowMs
      && nowMs - queuedAt < REMEDIATION_PRESPAWN_GRACE_MS;
    if (live) return { live: true,
      reason: status === 'pending' ? 'fresh-pending-job' : 'fresh-unspawned-claim' };
  }
  const worker = job?.remediationWorker || {};
  if (['completed', 'failed', 'stopped', 'cancelled', 'exited'].includes(worker.state)) {
    return { live: false, reason: 'terminal-worker' };
  }
  const heartbeat = Date.parse(job.lastHeartbeatAt || '');
  if (Number.isFinite(heartbeat) && heartbeat <= nowMs && nowMs - heartbeat < REMEDIATION_HEARTBEAT_GRACE_MS) {
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
