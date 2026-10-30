import { codexToolHostUnavailable } from './codex-tool-host-failure.mjs';
// REMREFUND-01: only recorded worker outcomes and authoritative heads qualify.
export const MAX_INFRASTRUCTURE_REFUNDS = 2;

export function recordedInfrastructureReason(outcome) {
  // HQ recovery can retain prior-attempt failure fields even after success.
  // Only a failed dispatch proves those fields describe the terminal outcome.
  if (outcome?.status != null && outcome.status !== 'failed') return null;
  const reasons = [outcome?.failureReason, outcome?.failure_reason, outcome?.failureClass, outcome?.failure_class,
    outcome?.failureCode, outcome?.failure_code];
  const reason = codexToolHostUnavailable(outcome) ? 'codex-tool-host-unavailable'
    : reasons.find((value) => ['publish-blocked', 'boot-failed', 'boot-failure'].includes(value));
  // A signal/exit code has no provenance: operators and supervisors use these
  // same signals. Require an independent infrastructure reason even for 137/143.
  // Local children prove infrastructure failure through a spawn error or a
  // complete tool-host log with no command execution. Other reasons need HQ status.
  return outcome?.status === 'failed' || reason === 'boot-failed'
    || (reason === 'codex-tool-host-unavailable' && outcome?.toolHostEvidence) ? reason || null : null;
}

export function infrastructureRefundReason({ outcome, startHead, endHead, refunds = 0, env = process.env }) {
  const rawOverride = String(env.ADV_MAX_REMEDIATION_INFRASTRUCTURE_REFUNDS ?? '').trim();
  const override = Number(rawOverride);
  const cap = /^\d+$/u.test(rawOverride) && Number.isInteger(override) && override >= 0
    ? Math.min(MAX_INFRASTRUCTURE_REFUNDS, override) : MAX_INFRASTRUCTURE_REFUNDS;
  if (!startHead || !endHead || startHead !== endHead || refunds >= cap) return null;
  return recordedInfrastructureReason(outcome);
}

export function localWorkerErrorOutcome(worker, error) {
  const bootFailure = !worker?.processId || /^spawn(?:\s|$)/u.test(String(error?.syscall || ''));
  return { failureReason: bootFailure ? 'boot-failed' : 'worker-error' };
}
