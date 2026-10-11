// REMREFUND-01: only recorded worker outcomes and authoritative heads qualify.
export const MAX_INFRASTRUCTURE_REFUNDS = 2;

export function recordedInfrastructureReason(outcome) {
  const reasons = [outcome?.failureReason, outcome?.failure_reason, outcome?.failureClass, outcome?.failure_class,
    outcome?.failureCode, outcome?.failure_code];
  const reason = reasons.find((value) => ['codex-tool-host-unavailable', 'publish-blocked', 'boot-failed', 'boot-failure'].includes(value));
  if (reason) return reason;
  const exit = outcome?.exitCode ?? outcome?.exit_code;
  if ([137, 143].includes(exit)) return `worker-signal-${exit}`;
  return null;
}

export function infrastructureRefundReason({ outcome, startHead, endHead, refunds = 0, env = process.env }) {
  const override = Number(env.ADV_MAX_REMEDIATION_INFRASTRUCTURE_REFUNDS);
  const cap = Number.isInteger(override) && override >= 0
    ? Math.min(MAX_INFRASTRUCTURE_REFUNDS, override) : MAX_INFRASTRUCTURE_REFUNDS;
  if (!startHead || !endHead || startHead !== endHead || refunds >= cap) return null;
  return recordedInfrastructureReason(outcome);
}

export function localWorkerErrorOutcome(worker, error) {
  const bootFailure = !worker?.processId || /^spawn(?:\s|$)/u.test(String(error?.syscall || ''));
  return { failureReason: bootFailure ? 'boot-failed' : 'worker-error' };
}
