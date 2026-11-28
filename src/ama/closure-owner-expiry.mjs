import { isAmaCloserPidAlive } from './closer-lease.mjs';
import { launchRequestOwned, launchRequestQuotaResumePending, isTerminalLaunchRequestStatus } from './launch-request-status.mjs';
import { readLatestWorkerRunStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';

export const CLOSURE_OWNER_EXPIRY_GRACE_MS = 10 * 60_000;
export const CLOSURE_RECOVERY_DEADLINE_MS = 5 * 60_000;

export function closureOwnerOverdue(deadlineMs, now) {
  return Number.isFinite(deadlineMs) && now - deadlineMs > CLOSURE_OWNER_EXPIRY_GRACE_MS;
}

// A canonical launch read includes the retry family. A terminal launch is
// sufficient unless the evidence still identifies a live process. A running
// launch can lag terminal worker records with no PID or a confirmed dead PID,
// but queued, parked and retrying launches keep their custody.
export async function closureOwnerStopped(probe, {
  readWorker = readLatestWorkerRunStatusFromLedgerAsync, processKillImpl, ...options
} = {}) {
  if (!probe?.ok || !probe.row || !Array.isArray(probe.retryChain)
    || probe.retryChainUnreadable || launchRequestQuotaResumePending(probe)) return false;
  const rows = [probe.row, ...probe.retryChain];
  if (rows.some(row => isAmaCloserPidAlive(row.pid ?? row.worker_process_pid, processKillImpl) === true)) return false;
  if (launchRequestOwned(probe) === false) return true;
  if (probe.row.status !== 'running' || !probe.retryChain.every(isTerminalLaunchRequestStatus)) return false;
  const worker = await readWorker({ ...options, launchRequestId: probe.row.launch_request_id });
  return worker?.ok === true && Array.isArray(worker.rows) && worker.rows.length > 0 && worker.rows.every(row => {
    if (row?.launch_request_id !== probe.row.launch_request_id
      || !['exited', 'dead', 'failed'].includes(row.process_status)) return false;
    const pid = row.pid ?? row.worker_process_pid;
    return pid == null || isAmaCloserPidAlive(pid, processKillImpl) === false;
  });
}
