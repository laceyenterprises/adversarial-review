// The pinned SDK owns interpretation of its public statusVocabulary snapshot.
// Callers own scheduling, retry, publication and merge authority.
export {
  LAUNCH_REQUEST_STATUSES,
  TERMINAL_LAUNCH_REQUEST_STATUSES,
  assertTerminalLaunchPolicy,
  readLaunchRequestStatus,
  readDispatchStatus,
} from '@agent-os/app-sdk';
