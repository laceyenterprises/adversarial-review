// Scheduling classification only. Every new attempt still proves the live
// exact-head merge contract and acquires its lease. Unknown reasons fail closed.
const TRANSIENT_REASONS = new Set([
  'lease-contended', 'lease-acquire-error', 'audit-init-failed', 'findings-capture-pending',
  'pending-required-checks', 'pending-mergeability', 'gate-read-failed',
  'live-head-refresh-failed', 'live-head-unresolved',
]);
const TRANSIENT_DETAILS = new Set([
  'ci-not-green', 'pr-mergeability-unknown', 'labels-unavailable',
  'primary-change-read-failed', 'history-read-failed', 'ci-cost-read-failed',
  'ci-cost-check-failed', 'ci-cost-unauthorized',
  'head-attestation-chain-read-failed', 'build-completion-read-failed',
]);

export function isTransientDaemonDecline(execution) {
  if (!execution || execution.permanent === true) return false;
  const details = execution.reasons || [];
  if (!Array.isArray(details)) return false;
  if (TRANSIENT_REASONS.has(execution.reason)) {
    return details.every(reason => TRANSIENT_REASONS.has(reason) || TRANSIENT_DETAILS.has(reason));
  }
  if (execution.reason === 'worker-identity-unresolved') {
    return details.length > 0 && details.every(reason => ['head-attestation-chain-read-failed',
      'build-completion-read-failed'].includes(reason));
  }
  return ['not-eligible', 'gate-not-eligible'].includes(execution.reason)
    && details.length > 0 && details.every(reason => TRANSIENT_DETAILS.has(reason));
}
