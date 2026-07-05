/**
 * MSM-02 — shared merge-eligibility predicate over already-fetched GitHub state.
 *
 * The merge-authority state machine (see
 * `projects/adversarial-merge-authority/SPEC.md`) decides "may this PR merge
 * right now?" in several places: the hammer's inline pre-merge gate (MSM-01)
 * and, later, the merge daemon (MSM-03). Historically each site re-derived the
 * same handful of preconditions inline — green required checks, a mergeable PR,
 * a head that still matches the validated head, a settled verdict, and a held
 * merge lease — under ad-hoc reason strings. This module collapses those checks
 * into ONE pure predicate so the hammer and the daemon cannot drift apart.
 *
 * Design constraints (mirrors `src/ama/eligibility.mjs`):
 *
 * - No network I/O. The caller fetches GitHub state (`statusCheckRollup`,
 *   `mergeable`, `mergeStateStatus`, head SHAs) and passes it in.
 * - No local CI run. The old merge-agent state machine died because "it could
 *   never verify local CI" — the wrong goal. GitHub already ran CI; this gate is
 *   a field read of the fetched `requiredChecks`, never a venv or a subprocess.
 * - No filesystem reads, no `Date.now()`, no randomness. Fully deterministic in
 *   its `state` argument so it is trivially unit-testable and cache-safe.
 *
 * @module ama/merge-eligibility
 */

/**
 * Verdict tokens that clear the verdict gate. `settled-success` is the direct
 * settled-review authority (SPEC §4.2); `ham_terminal_remediation_validated`
 * is the exhausted-round HAM terminal-remediation marker (SPEC §1.1.1) that the
 * closer records only after it verifies the HAM commit + audit provenance.
 * Anything else fails the gate with `verdict-not-eligible`.
 */
export const ELIGIBLE_MERGE_VERDICTS = Object.freeze(
  new Set(['settled-success', 'ham_terminal_remediation_validated']),
);

/**
 * Stable, ordered reason vocabulary. `evaluateMergeEligibility` emits reasons in
 * exactly this order so operator audit JSON groups consistently and callers can
 * do a stable `reasons[0]` "primary blocker" read.
 */
export const MERGE_ELIGIBILITY_REASONS = Object.freeze([
  'verdict-not-eligible',
  'ci-not-green',
  'pr-not-mergeable',
  'stale-head',
  'lease-not-held',
]);

/**
 * @typedef {Object} MergeEligibilityState
 *
 * Plain snapshot of already-fetched values. No field triggers I/O.
 *
 * @property {string=}  verdict         Normalized verdict token. Eligible when it is
 *                                      one of {@link ELIGIBLE_MERGE_VERDICTS}; else
 *                                      `verdict-not-eligible`.
 * @property {(Array|boolean)=} requiredChecks
 *                                      Required-check state derived from GitHub
 *                                      `statusCheckRollup`. Either the raw rollup
 *                                      array (classified here with the same
 *                                      status/conclusion rules the hammer gate used)
 *                                      or a pre-derived boolean (`true` = all green).
 *                                      An empty array is NOT green (fail closed —
 *                                      required checks must have reported).
 * @property {(string|boolean)=} mergeable
 *                                      GitHub `mergeable` enum (`MERGEABLE`) or a
 *                                      boolean. Non-`MERGEABLE`/false → `pr-not-mergeable`.
 * @property {string=}  mergeStateStatus GitHub `mergeStateStatus`. `BEHIND` (branch not
 *                                      rebased onto base) → `pr-not-mergeable`.
 * @property {string=}  prState         GitHub PR `state`. When supplied it must be
 *                                      `OPEN`; a closed/merged PR → `pr-not-mergeable`.
 *                                      Omit to skip the open check.
 * @property {string=}  candidateHead   The live PR head SHA being considered.
 * @property {string=}  validatedHead   The head SHA that was validated (reviewed /
 *                                      post-remediation). Mismatch → `stale-head`.
 * @property {boolean=} leaseHeld       True iff the caller holds the `(repo, base)`
 *                                      merge lease. Else `lease-not-held`.
 */

/**
 * @typedef {Object} MergeEligibilityResult
 * @property {boolean}  eligible  True iff `reasons` is empty.
 * @property {string[]} reasons   Stable, ordered subset of
 *                                {@link MERGE_ELIGIBILITY_REASONS}. Empty when eligible.
 */

function verdictEligible(verdict) {
  return ELIGIBLE_MERGE_VERDICTS.has(String(verdict ?? '').trim().toLowerCase());
}

/**
 * Classify required checks as green. Mirrors the hammer inline gate's rules
 * exactly (StatusContext must be `SUCCESS`; check-runs must be `COMPLETED` with a
 * `SUCCESS`/`NEUTRAL`/`SKIPPED` conclusion) and requires at least one check —
 * an empty rollup fails closed. A boolean short-circuits to itself for callers
 * that already derived greenness.
 *
 * @param {Array|boolean|undefined} requiredChecks
 * @returns {boolean}
 */
function requiredChecksGreen(requiredChecks) {
  if (typeof requiredChecks === 'boolean') return requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) return false;
  const badChecks = requiredChecks.filter((check) => {
    const status = String(check?.status || check?.state || '').toUpperCase();
    const conclusion = String(check?.conclusion || '').toUpperCase();
    if (check?.__typename === 'StatusContext') return status !== 'SUCCESS';
    if (status && status !== 'COMPLETED') return true;
    return !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion);
  });
  return badChecks.length === 0;
}

/**
 * PR is in a mergeable shape: open (when `prState` is supplied), GitHub reports
 * it MERGEABLE, and the branch is not BEHIND its base.
 *
 * @param {MergeEligibilityState} state
 * @returns {boolean}
 */
function prMergeable(state) {
  const prState = state?.prState;
  if (prState != null && String(prState).toUpperCase() !== 'OPEN') return false;
  const mergeable = state?.mergeable;
  const mergeableOk = typeof mergeable === 'boolean'
    ? mergeable
    : String(mergeable ?? '').toUpperCase() === 'MERGEABLE';
  if (!mergeableOk) return false;
  // A missing/unknown mergeStateStatus is permitted (the MERGEABLE flag already
  // cleared); only an explicit BEHIND blocks — the branch must be rebased.
  if (String(state?.mergeStateStatus ?? '').toUpperCase() === 'BEHIND') return false;
  return true;
}

/**
 * The validated head still matches the live candidate head. Fails closed on any
 * empty/missing SHA so a caller that forgot to populate one cannot merge a head
 * it never validated.
 *
 * @param {MergeEligibilityState} state
 * @returns {boolean}
 */
function headMatches(state) {
  const candidate = String(state?.candidateHead ?? '').trim();
  const validated = String(state?.validatedHead ?? '').trim();
  return candidate !== '' && validated !== '' && candidate === validated;
}

/**
 * Pure merge-eligibility predicate over already-fetched GitHub state.
 *
 * Reads only the passed `state`: no `gh`/network call, no local CI run, no
 * clock, no randomness. Both the hammer inline gate (MSM-01) and the merge
 * daemon (MSM-03) call this so the two paths share one definition of "may this
 * PR merge right now?".
 *
 * @param {MergeEligibilityState} [state]
 * @returns {MergeEligibilityResult}
 */
export function evaluateMergeEligibility(state = {}) {
  const reasons = [];

  if (!verdictEligible(state?.verdict)) reasons.push('verdict-not-eligible');
  if (!requiredChecksGreen(state?.requiredChecks)) reasons.push('ci-not-green');
  if (!prMergeable(state)) reasons.push('pr-not-mergeable');
  if (!headMatches(state)) reasons.push('stale-head');
  if (state?.leaseHeld !== true) reasons.push('lease-not-held');

  return { eligible: reasons.length === 0, reasons };
}

// Internal helpers exposed for unit tests so each gate can be probed in
// isolation without rebuilding the full snapshot.
export const __testables__ = Object.freeze({
  verdictEligible,
  requiredChecksGreen,
  prMergeable,
  headMatches,
});
