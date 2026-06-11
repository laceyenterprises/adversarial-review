import {
  DEFAULT_ADVERSARIAL_GATE_CONTEXT,
  resolveGateStatusContext,
} from './adversarial-gate-context.mjs';

const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set([
  'PENDING',
  'IN_PROGRESS',
  'QUEUED',
  'EXPECTED',
  'WAITING',
  'REQUESTED',
]);

// Identify status-rollup items that belong to the adversarial-review
// pipeline's own gate. CheckRun names remain external CI surface area even
// when they reuse the configured context string.
function adversarialOwnCheckContexts(env = process.env) {
  const contexts = new Set([DEFAULT_ADVERSARIAL_GATE_CONTEXT.toLowerCase()]);
  try {
    contexts.add(String(resolveGateStatusContext(env)).trim().toLowerCase());
  } catch {
    // A malformed ADV_GATE_STATUS_CONTEXT must not break the merge gate; the
    // default constant is already in the set.
  }
  return contexts;
}

function isAdversarialOwnStatusContext(item, excludeContexts) {
  if (item?.__typename && item.__typename !== 'StatusContext') {
    return false;
  }
  const ctx = String(item?.context || '').trim().toLowerCase();
  if (!ctx) return false;
  return excludeContexts.has(ctx);
}

// The merge-agent and AMA must not gate on the adversarial-review pipeline's
// own convergence check. Real external CI still gates.
function summarizeChecksConclusion(statusCheckRollup, { env = process.env } = {}) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  const excludeContexts = adversarialOwnCheckContexts(env);
  const relevant = statusCheckRollup.filter(
    (item) => !isAdversarialOwnStatusContext(item, excludeContexts)
  );
  if (relevant.length === 0) {
    return 'SUCCESS';
  }

  let sawPending = false;
  for (const item of relevant) {
    const rawState = String(
      item?.conclusion
      || item?.status
      || item?.state
      || item?.statusCheckRollup?.state
      || ''
    ).trim().toUpperCase();
    if (!rawState) {
      sawPending = true;
      continue;
    }
    if (PENDING_CHECK_STATES.has(rawState)) {
      sawPending = true;
      continue;
    }
    if (SUCCESSFUL_CHECK_STATES.has(rawState)) {
      continue;
    }
    return rawState;
  }

  return sawPending ? 'PENDING' : 'SUCCESS';
}

export { summarizeChecksConclusion };
