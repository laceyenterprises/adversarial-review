// A child process that dies in the dynamic loader never ran: the host's
// runtime is missing a shared library, so no reviewer or remediation logic
// failed. On macOS the loader prints, before any JS executes:
//
//   dyld[38288]: Library not loaded: /opt/homebrew/opt/ada-url/lib/libada.3.dylib
//     Referenced from: <UUID> /opt/homebrew/Cellar/node/26.3.0/bin/node
//
// Observed on agent-os 2026-09-28 (SEV1, NODEPIN-01): a Homebrew upgrade moved
// the opt/ links out from under long-running daemons, every reviewer spawn died
// like this, and each was logged `failure-class=unknown`, spent review_attempts,
// and stranded 5 PRs at `review_status=failed`. This is a host fault: it is
// retried on the infra auto-recovery path and never charged to review_attempts.
export const INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS = 'infra-runtime-missing-library';

const MISSING_LIBRARY_RE = /\bdyld(?:\[\d+\])?:\s*library not loaded\b/i;

export function hasMissingRuntimeLibrarySignal(text) {
  return MISSING_LIBRARY_RE.test(String(text || ''));
}
