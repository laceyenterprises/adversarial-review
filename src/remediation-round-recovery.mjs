// Terminal execution failures may spend another ordinary round. Human holds,
// safety refusals and lifecycle stops retain their existing owners.
const STOPS = new Set(['committed-unpublished', 'no-progress', 'stale-heartbeat',
  'daemon-bounce-safety', 'worker-failure', 'worker-timeout', 'timed-out', 'stopped']);
const FAILURES = new Set(['worker-failure', 'worker-timeout', 'timed-out',
  'missing-remediation-reply', 'artifact-empty-completion', 'artifact-missing-completion',
  'invalid-remediation-reply', 'hq-dispatch-failed', 'hq-dispatch-transient-budget-exhausted']);

export function isRemediationRoundBudgetSpent(plan) {
  const current = Number(plan?.currentRound);
  const max = Number(plan?.maxRounds);
  return Number.isFinite(current) && Number.isFinite(max) && max > 0 && current >= max;
}

// Exhaustion transfers repair custody; it never supplies operator consent.
export function remediationBudgetHandoffAllowed(job) {
  return Boolean(job) && !job.closureHandoff
    && job.failure?.needsOperator !== true
    && (job.status === 'completed'
      || (job.status === 'stopped'
        && (STOPS.has(job.remediationPlan?.stop?.code)
          || ['max-rounds-reached', 'round-budget-exhausted'].includes(job.remediationPlan?.stop?.code)))
      || (job.status === 'failed' && FAILURES.has(job.failure?.code)))
    && isRemediationRoundBudgetSpent(job.remediationPlan);
}

export function isEndedRemediationRound(job) {
  const round = Number(job?.remediationPlan?.currentRound);
  const max = Number(job?.remediationPlan?.maxRounds);
  return !job?.closureHandoff && job?.failure?.needsOperator !== true
    && Number.isInteger(round) && round > 0 && Number.isInteger(max) && round < max
    && (job.status === 'stopped' ? STOPS.has(job.remediationPlan?.stop?.code)
      : job.status === 'failed' && FAILURES.has(job.failure?.code));
}
