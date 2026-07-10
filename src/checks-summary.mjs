import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

const DEFAULT_ADVERSARIAL_GATE_CONTEXT = 'agent-os/adversarial-gate';

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
//
// FAIL-OPEN CONTRACT — read before "fixing" the empty-rollup branch below.
// A non-array rollup returns `null` (unknown; consumers treat it fail-closed),
// but an EXPLICIT empty array — including a rollup that becomes empty after the
// self-gate exclusion — returns 'SUCCESS'. That is deliberate fail-open
// behavior for repos with no external CI configured, and it carries a
// premature-merge hazard: a rollup read that races GitHub BEFORE any checks
// are registered on a fresh head is indistinguishable from "no CI exists" and
// also reads 'SUCCESS' (checks can be ADDED after a rollup looks settled).
// Consumers of this classifier are:
//   - `fetchMergeAgentCandidate()` in `follow-up-merge-agent.mjs`
//     (`checksConclusion` on merge-agent dispatch candidates), and
//   - `classifyCiGreen()` in `src/ama/eligibility.mjs` (AMA SPEC §4.2 #5).
// The MSM merge predicate (`requiredChecksGreen` in
// `src/ama/merge-eligibility.mjs`) deliberately DIVERGES: it fails closed on an
// empty rollup, so the daemon/hammer merge gates require at least one reported
// check. Do not "unify" the two classifiers in either direction — this one
// stays fail-open for the no-CI-repo case, that one stays fail-closed for the
// merge decision, and `--match-head-commit <reviewedSha>` at merge time is the
// backstop that a moved head cannot ride the fail-open read to a merge.
// Behavior pinned by test/follow-up-merge-agent.test.mjs
// ('summarizeChecksConclusion distinguishes missing and empty status check
// rollups': undefined→null, {}→null, []→'SUCCESS').
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
