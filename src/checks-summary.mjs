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
// FAIL-CLOSED CONTRACT (LAC-1559) — read before "restoring" the old empty→SUCCESS
// branch below. This classifier used to fail OPEN: an EXPLICIT empty array —
// including a rollup that became empty after the self-gate exclusion — returned
// 'SUCCESS' so repos with no external CI could still classify green. LAC-1559
// RETIRED that: an empty relevant-checks rollup now returns `null` (unknown),
// exactly like a non-array/missing rollup, so a PR with zero external checks can
// never classify green. The retired behavior carried a premature-merge hazard —
// a rollup read that races GitHub BEFORE any checks register on a fresh head is
// indistinguishable from "no CI exists" and also read 'SUCCESS', authorizing a
// merge on a head whose checks had not yet reported.
//
// Consumers of this classifier — both treat `null` as fail-closed already:
//   - `fetchMergeAgentCandidate()` in `follow-up-merge-agent.mjs`
//     (`checksConclusion` on merge-agent dispatch candidates): `null` →
//     `skip-checks-unknown`, so a zero-external-check PR is not dispatched.
//   - `classifyCiGreen()` in `src/ama/eligibility.mjs` (AMA SPEC §4.2 #5):
//     `green = conclusion === 'SUCCESS'`, so `null` → not green → `ci-not-green`.
// This now CONVERGES with the MSM merge predicate (`requiredChecksGreen` in
// `src/ama/merge-eligibility.mjs`), which already failed closed on an empty
// rollup. `--match-head-commit <reviewedSha>` at merge time remains the head-move
// backstop; the fail-closed empty read is the checks-registration backstop.
// Behavior pinned by test/follow-up-merge-agent.test.mjs
// ('summarizeChecksConclusion distinguishes missing and empty status check
// rollups': undefined→null, {}→null, []→null).
function summarizeChecksConclusion(statusCheckRollup, { env = process.env } = {}) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  const excludeContexts = adversarialOwnCheckContexts(env);
  const relevant = statusCheckRollup.filter(
    (item) => !isAdversarialOwnStatusContext(item, excludeContexts)
  );
  if (relevant.length === 0) {
    // Fail closed (LAC-1559): "no external checks reported" is unknown, not green.
    return null;
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
