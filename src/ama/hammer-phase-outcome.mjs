// Infrastructure observations spend no adjudication authority. Keep this list
// explicit: a red check, moved head or lost owner must never match by message.
export const HAMMER_RETRYABLE_READ_OUTCOMES = new Set([
  'hammer-command-error',
  'git-credential-refresh-failed',
  // CLOSERGATES-01: an API credential mint that timed out or failed to run,
  // and a closure gate whose transient read failures outlasted the budget.
  'credential-refresh-unavailable',
  'closure-gate-read-unavailable',
  'launch-environment-read-unavailable',
  // HAMMERLAUNCHREAD-01: the same deferral at the closure step, after work.
  'launch-environment-read-unavailable-at-closure',
  'launch-environment-missing-legacy-dispatch',
  'merge-lease-base-read-failed',
  'verify-head-pr-read-failed',
  'missing-pr-state',
  'published-head-timeout',
  'published-head-probe-failed',
  'published-head-probe-invalid',
  'controller-observation-unavailable',
  'ci-infrastructure-evidence-unavailable',
  'merge-lease-probe-failed',
  'merge-lease-response-invalid',
  'pr-refresh-failed',
  'produced-head-read-failed',
  'rebase-head-timeout',
  'rebase-base-unavailable',
  'history-read-failed',
  'predicate-verdict-unavailable',
  'github-gate-read-failed',
  'protective-predecessor-read-failed',
  'commit-title-read-failed',
  'stacked-base-read-failed',
  'ci-wait-pr-refresh-failed',
  'merge-confirmation-read-failed',
  'merge-confirmation-read-failed-after-merge-accepted',
  'publish-head-read-failed',
  'publish-identity-read-failed',
]);

export function hammerPhaseAttempt(attempt) {
  return ['failed-without-merge', 'deferred'].includes(attempt?.outcome)
    && HAMMER_RETRYABLE_READ_OUTCOMES.has(attempt.reason)
    ? { ...attempt, outcome: 'deferred' } : attempt;
}
