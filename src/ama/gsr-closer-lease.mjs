// GSR-07: hand the closer leases a graceful restart held back to their work.
//
// GSR-03 keeps a suspended closer's dispatched lease exactly as it was (the
// launch reads as live). Boot-time resume then settles each suspended launch:
//
// - resumed from its own session (same launch): the lease is re-adopted in
//   place, refreshing `updatedAt` so the restart window is not charged
//   against the dispatched-lease reclaim age;
// - re-dispatched as a successor launch: the lease, and the closer dispatch
//   record that names the source launch, are re-bound to the successor, so
//   no second closer is dispatched while the successor carries the work;
// - ended before it could resume: the lease is released (`superseded`), but
//   only once the ledger proves the launch no longer owns the PR.
//
// Leases in any other state are left alone: a terminal or handed-to-review
// lease already settled its closer. Every mutation is a CAS on the observed
// lease, so a concurrent owner wins and is reported as `busy`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AMA_CLOSER_LEASE_STATUS,
  listAmaCloserLeaseNames,
  updateAmaCloserLease,
} from './closer-lease.mjs';
import { updateAmaCloserDispatchRecord } from './dispatch-closer.mjs';
import { readAmaCloserDispatchRecord } from './dispatch-record-read.mjs';
import { launchRequestOwned } from './launch-request-status.mjs';
import { readLaunchRequestStatusFromLedger } from '../session-ledger-read-adapter.mjs';

const LEASE_DIR_SEGMENTS = ['data', 'ama-closer-leases'];

function leasesFor(rootDir, launchRequestId) {
  const dir = join(rootDir, ...LEASE_DIR_SEGMENTS);
  const leases = [];
  for (const name of listAmaCloserLeaseNames(rootDir)) {
    if (!name.endsWith('.json')) continue;
    let lease;
    try { lease = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (lease?.lrqId === launchRequestId) leases.push(lease);
  }
  return leases;
}

function identity(lease) {
  return { repo: lease.repo, prNumber: lease.prNumber, headSha: lease.headSha };
}

function mutate(lease, change) {
  try {
    return { ...identity(lease), outcome: change() };
  } catch (error) {
    if (['EBUSY', 'ESTALE'].includes(error.code)) return { ...identity(lease), outcome: 'busy' };
    throw error;
  }
}

function summary(launchRequestId, leases, extra = {}) {
  const changed = leases.filter(lease => ['re-adopted', 'released'].includes(lease.outcome));
  const outcome = changed[0]?.outcome || (leases.some(lease => lease.outcome === 'busy') ? 'busy' : 'none');
  return { launchRequestId, ...extra, outcome, leases };
}

export function readoptSuspendedAmaCloserLeases(rootDir, {
  launchRequestId, successorLaunchRequestId = null, now = new Date().toISOString(),
} = {}) {
  if (!launchRequestId) throw new Error('readoptSuspendedAmaCloserLeases: launchRequestId is required');
  const lrqId = successorLaunchRequestId || launchRequestId;
  const results = leasesFor(rootDir, launchRequestId).map((lease) => {
    if (lease.status !== AMA_CLOSER_LEASE_STATUS.DISPATCHED) {
      return { ...identity(lease), outcome: 'unchanged', status: lease.status };
    }
    return mutate(lease, () => {
      if (lrqId !== launchRequestId) {
        // Record first: a retry still finds the lease under the source launch,
        // and an already re-bound record is left as it is. The record keys on
        // the launch head, which may precede several lease rekeys.
        const heads = [...new Set([lease.headSha, lease.rekeyedFromHeadSha,
          ...(lease.supersededHeads || [])].filter(Boolean))];
        for (const headSha of heads) {
          const recordIdentity = { ...identity(lease), headSha };
          if (readAmaCloserDispatchRecord(rootDir, recordIdentity)?.launchRequestId !== launchRequestId) continue;
          updateAmaCloserDispatchRecord(rootDir, recordIdentity, current => (
            current?.launchRequestId === launchRequestId ? {
              ...current,
              launchRequestId: lrqId,
              dispatchId: current.dispatchId === launchRequestId ? lrqId : current.dispatchId,
              gsrRedispatchedFrom: launchRequestId,
            } : null));
          break;
        }
      }
      updateAmaCloserLease({ rootDir, ...identity(lease), expectedLease: lease,
        status: AMA_CLOSER_LEASE_STATUS.DISPATCHED, lrqId, now });
      return 're-adopted';
    });
  });
  return summary(launchRequestId, results, { successorLaunchRequestId });
}

export function releaseSuspendedAmaCloserLeases(rootDir, {
  launchRequestId, now = new Date().toISOString(),
  readLaunchRequestStatusImpl = readLaunchRequestStatusFromLedger, ...readOptions
} = {}) {
  if (!launchRequestId) throw new Error('releaseSuspendedAmaCloserLeases: launchRequestId is required');
  const leases = leasesFor(rootDir, launchRequestId)
    .filter(lease => lease.status === AMA_CLOSER_LEASE_STATUS.DISPATCHED);
  if (!leases.length) return summary(launchRequestId, []);
  let probe = null;
  try {
    probe = readLaunchRequestStatusImpl({ ...readOptions, launchRequestId, includeRetryChain: true });
  } catch { /* An unreadable launch keeps its lease. */ }
  if (launchRequestOwned(probe) !== false) {
    // Live, parked or unknown launches retain ownership; the reapers decide later.
    return summary(launchRequestId,
      leases.map(lease => ({ ...identity(lease), outcome: 'retained', reason: 'launch-not-proven-ended' })));
  }
  return summary(launchRequestId, leases.map(lease => mutate(lease, () => {
    updateAmaCloserLease({ rootDir, ...identity(lease), expectedLease: lease,
      status: AMA_CLOSER_LEASE_STATUS.TERMINAL, terminalOutcome: 'superseded', now });
    return 'released';
  })));
}
