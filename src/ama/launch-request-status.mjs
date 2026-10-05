// Shared launch terminality; releasing ownership is not retry/re-arm authority.
export const AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES = new Set([
  'succeeded',
  'failed',
  'operator_triage_required',
  'canceled',
  'superseded',
  'reaped_stuck_requested',
]);
// Capacity-only terminal evidence must not widen per-PR retry/re-arm authority.
export const AMA_CLOSER_CAPACITY_TERMINAL_LAUNCH_REQUEST_STATUSES = new Set([
  ...AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES, 'reaped', 'cancelled', 'completed', 'rejected',
]);

export function isTerminalLaunchRequestStatus(status) {
  return AMA_CLOSER_CAPACITY_TERMINAL_LAUNCH_REQUEST_STATUSES.has(String(status || '').trim().toLowerCase());
}
