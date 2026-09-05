import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import {
  missingRequiredCheckContexts,
  selectRequiredCheckContexts,
} from './required-check-contexts.mjs';

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
// Only the second is a MERGE-authority read, and it is the one that passes
// `requiredCheckContexts` (from `getMergeAuthorityConfig()`). The merge-agent
// DISPATCH candidate deliberately does not: it decides whether to spawn a
// worker, not whether to merge, and the three surfaces that do decide a merge
// — `classifyCiGreen()`, `requiredChecksGreen()` and the hammer's
// `bin/ama-check.mjs` recheck — all apply the list.
// This now CONVERGES with the MSM merge predicate (`requiredChecksGreen` in
// `src/ama/merge-eligibility.mjs`), which already failed closed on an empty
// rollup. `--match-head-commit <reviewedSha>` at merge time remains the head-move
// backstop; the fail-closed empty read is the checks-registration backstop.
// Behavior pinned by test/follow-up-merge-agent.test.mjs
// ('summarizeChecksConclusion distinguishes missing and empty status check
// rollups': undefined→null, {}→null, []→null).
//
// ABSENT-IS-PENDING CONTRACT (TQL-01). The fail-closed empty read above only
// catches a rollup with NOTHING in it. A rollup that still has entries but is
// MISSING an expected one — the shape left behind when a workflow is disabled,
// as `Unit Tests` and the `Operational CI Gauntlet` were on 2026-08-29 — used to
// classify SUCCESS off whatever lint and guards remained. `requiredCheckContexts`
// closes that: any configured context with no check of that name in the head's
// rollup is PENDING ("has not reported yet"), never green, so the AMA gate keeps
// raising `ci-not-green` until it does report. A failing check still wins over a
// missing one — a red rollup returns its failure state, unchanged. An empty /
// unset list is byte-for-byte the pre-TQL-01 behavior.
function summarizeChecksConclusion(statusCheckRollup, {
  env = process.env,
  requiredCheckContexts = null,
  repo = null,
} = {}) {
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
  // Resolved against `relevant`, i.e. AFTER the self-gate exclusion: the
  // required list never contains a self-gate context (dropped by
  // `selectRequiredCheckContexts`), so the exclusion above cannot make a
  // required context look absent.
  const requiredContexts = selectRequiredCheckContexts(requiredCheckContexts, { repo, env });

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

  if (missingRequiredCheckContexts(relevant, requiredContexts).length > 0) {
    // Configured, expected, and not reported for this head → pending, never green.
    return 'PENDING';
  }

  return sawPending ? 'PENDING' : 'SUCCESS';
}

export { summarizeChecksConclusion };
