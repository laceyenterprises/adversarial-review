import { readLaunchRequestStatus, assertTerminalLaunchPolicy } from '../producer-contracts/launch-status.mjs';
// Retry/re-arm policy subset, deliberately separate from scheduling terminality.
// Retry/re-arm authority keeps its existing policy subset; the owner also
// reports blocked decisions terminal. Capacity and retry remain separate policies.
export const AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES = new Set(
  ['succeeded', 'failed', 'operator_triage_required', 'canceled', 'superseded', 'reaped_stuck_requested']
    .filter(status => {
      assertTerminalLaunchPolicy([status]);
      return readLaunchRequestStatus(status).terminal;
    }),
);
// Stored pre-contract records remain readable through producer-defined meanings.
const LEGACY_STATUS_ALIASES = { completed: 'succeeded', cancelled: 'canceled',
  reaped: 'reaped_stuck_requested', rejected: 'failed' };

export function launchRequestMeaning(value) {
  const row = typeof value === 'string' ? { status: value } : value || {};
  const status = String(row.status || '').trim().toLowerCase();
  const meaning = readLaunchRequestStatus(LEGACY_STATUS_ALIASES[status] || status);
  return { ...meaning,
    terminal: typeof row.terminal === 'boolean' ? row.terminal : meaning.terminal,
    succeeded: typeof row.succeeded === 'boolean' ? row.succeeded : meaning.succeeded,
    // Parking is scheduling/ownership policy over the published vocabulary.
    parked: meaning.status !== null && /^(blocked_|waiting_)/.test(meaning.status),
  };
}

export function isTerminalLaunchRequestStatus(value) {
  return launchRequestMeaning(value).terminal;
}

export function launchRequestParked(probe) {
  return probe?.ok === true && launchRequestMeaning(withLiveLaunchRetry(probe).row).parked;
}

// A fleet retry reuses its ancestor's prompt and scratch. Leave the
// ancestor record unchanged; any non-terminal descendant supplies its liveness.
export function withLiveLaunchRetry(probe) {
  if (probe?.liveRetryLaunchRequestId) return probe;
  const live = probe?.ok && probe.retryChain?.find(row => launchRequestMeaning(row).parked || !isTerminalLaunchRequestStatus(row));
  return live ? { ...probe, row: { ...live, ticket_ref: live.ticket_ref ?? probe.row?.ticket_ref },
    liveRetryLaunchRequestId: live.launch_request_id } : probe;
}

// Tri-state scheduling liveness. Parked workers retain ownership separately;
// unknown evidence cannot prove that a launch has stopped.
export function launchRequestInFlight(probe) {
  const effective = withLiveLaunchRetry(probe);
  if (!effective?.ok || !effective.row) return null;
  const meaning = launchRequestMeaning(effective.row);
  if (meaning.parked) return false;
  if (!meaning.status && typeof effective.row.terminal !== 'boolean') return null;
  if (!meaning.terminal) return true;
  return effective.retryChainUnreadable ? null : false;
}

// A parked worker retains its PR while releasing scheduling capacity.
export function launchRequestOwned(probe) {
  if (launchRequestParked(probe)) return true;
  return launchRequestInFlight(probe);
}
