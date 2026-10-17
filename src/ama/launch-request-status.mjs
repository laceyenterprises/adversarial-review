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

// A fleet retry reuses its ancestor's prompt and scratch. Leave the
// ancestor record unchanged; any non-terminal descendant supplies its liveness.
export function withLiveLaunchRetry(probe) {
  if (probe?.liveRetryLaunchRequestId) return probe;
  const live = probe?.ok && probe.retryChain?.find(row => !isTerminalLaunchRequestStatus(row.status));
  return live ? { ...probe, row: { ...live, ticket_ref: probe.row?.ticket_ref },
    liveRetryLaunchRequestId: live.launch_request_id } : probe;
}
