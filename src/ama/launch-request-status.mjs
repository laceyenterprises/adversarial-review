import { readLaunchRequestStatus } from '../producer-contracts/launch-status.mjs';
// Shared launch terminality; releasing ownership is not retry/re-arm authority.
// Retry/re-arm authority keeps its existing policy subset; the owner also
// reports blocked decisions terminal. Capacity and retry remain separate policies.
export const AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES = new Set(
  ['succeeded', 'failed', 'operator_triage_required', 'canceled', 'superseded', 'reaped_stuck_requested']
    .filter(status => readLaunchRequestStatus(status).terminal),
);
// Capacity-only terminal evidence must not widen per-PR retry/re-arm authority.
export const AMA_CLOSER_CAPACITY_TERMINAL_LAUNCH_REQUEST_STATUSES = new Set([
  ...AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES, 'reaped', 'cancelled', 'completed', 'rejected',
]);

export function isTerminalLaunchRequestStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  const meaning = readLaunchRequestStatus(normalized);
  return AMA_CLOSER_CAPACITY_TERMINAL_LAUNCH_REQUEST_STATUSES.has(meaning.status || normalized);
}

// A fleet retry reuses its ancestor's prompt and scratch. Leave the
// ancestor record unchanged; any non-terminal descendant supplies its liveness.
export function withLiveLaunchRetry(probe) {
  if (probe?.liveRetryLaunchRequestId) return probe;
  const live = probe?.ok && probe.retryChain?.find(row => !isTerminalLaunchRequestStatus(row.status));
  return live ? { ...probe, row: { ...live, ticket_ref: live.ticket_ref ?? probe.row?.ticket_ref },
    liveRetryLaunchRequestId: live.launch_request_id } : probe;
}

// The same tri-state ownership check is used by closure blockers and lease
// reclamation. Unknown evidence cannot prove that a launch has stopped.
export function launchRequestInFlight(probe) {
  const effective = withLiveLaunchRetry(probe);
  if (!effective?.ok || !effective.row?.status) return null;
  if (!isTerminalLaunchRequestStatus(effective.row.status)) return true;
  return effective.retryChainUnreadable ? null : false;
}
