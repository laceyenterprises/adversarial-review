import { readDispatchStatus, assertTerminalLaunchPolicy } from '../producer-contracts/launch-status.mjs';
// Retry/re-arm policy subset, deliberately separate from scheduling terminality.
// Retry/re-arm authority keeps its existing policy subset; the owner also
// reports blocked decisions terminal. Capacity and retry remain separate policies.
export const AMA_CLOSER_TERMINAL_LAUNCH_REQUEST_STATUSES = new Set(
  ['succeeded', 'failed', 'operator_triage_required', 'canceled', 'superseded', 'reaped_stuck_requested']
    .filter(status => {
      assertTerminalLaunchPolicy([status]);
      return readDispatchStatus({ status }).terminal;
    }),
);
// GSR-03: a graceful restart holds a launch `suspended` until it resumes from
// its own session, an operator abandons it or its age bound expires. The status
// postdates the pinned SDK vocabulary, so name it here: it is non-terminal and
// not parked, so its closer lease stays dispatched and held like a live one.
const SUSPENDED = 'suspended';
function withSuspendedStatus(row, meaning) {
  if (meaning.status !== null || typeof row?.status !== 'string'
    || row.status.trim().toLowerCase() !== SUSPENDED) return meaning;
  return { ...meaning, status: SUSPENDED,
    terminal: typeof row.terminal === 'boolean' ? row.terminal : false,
    diagnostics: meaning.diagnostics.filter(note => !note.includes('$.status')) };
}

export function launchRequestMeaning(value) {
  const row = typeof value === 'string' ? { status: value } : value;
  const meaning = withSuspendedStatus(row, readDispatchStatus(row));
  return { ...meaning,
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
