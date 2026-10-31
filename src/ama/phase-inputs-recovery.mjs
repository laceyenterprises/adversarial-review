import { isTerminalLaunchRequestStatus, launchRequestQuotaResumePending } from './launch-request-status.mjs';

export const PHASE_INPUTS_MISSING = 'dispatch-phase-scripts-missing';
export const QUOTA_PHASE_INPUTS_MISSING = 'quota-resume-phase-inputs-missing';

// Execution success is not merge evidence. Only a named producer refusal or a
// launch-bound terminal audit can authorize this one dispatch repair.
export function missingPhaseInputsOutcome(probe, record, audit) {
  if (audit?.status === 'succeeded') return null;
  if (!probe?.ok || probe.retryChainUnreadable
    || launchRequestQuotaResumePending(probe)) return null;
  const rows = [probe.row, ...(Array.isArray(probe.retryChain) ? probe.retryChain : [])].filter(Boolean);
  if (!rows.length || rows.some(row => !isTerminalLaunchRequestStatus(row))) return null;
  if (!rows.some(row => row.launch_request_id === record.launchRequestId)) return null;
  const refused = rows.find(row => row.failure_class === QUOTA_PHASE_INPUTS_MISSING);
  if (refused) return QUOTA_PHASE_INPUTS_MISSING;
  return audit?.attempts?.some(attempt => attempt.outcome === 'failed-without-merge'
    && attempt.reason === PHASE_INPUTS_MISSING
    && rows.some(row => row.launch_request_id === attempt.launchRequestId)) ? PHASE_INPUTS_MISSING : null;
}
