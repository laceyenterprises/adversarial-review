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
export const ELIGIBLE_MERGE_VERDICTS = Object.freeze([
  'settled-success',
  'ham_terminal_remediation_validated',
]);

/**
 * Stable, ordered reason vocabulary. `evaluateMergeEligibility` emits reasons in
 * exactly this order so operator audit JSON groups consistently and callers can
 * do a stable `reasons[0]` "primary blocker" read.
 */
export const MERGE_ELIGIBILITY_REASONS = Object.freeze([
  'verdict-not-eligible',
  'ci-not-green',
  'pr-not-mergeable',
  'branch-protection-missing-gate',
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
 *                                      rebased onto base) → `pr-not-mergeable`
 *                                      ONLY when `requiresUpToDateBranch` is not
 *                                      resolved to `false` (see that field).
 * @property {boolean=} requiresUpToDateBranch
 *                                      Whether the target branch's protection
 *                                      requires the PR to be up to date before
 *                                      merge (GitHub
 *                                      `required_status_checks.strict`). Fail
 *                                      closed: `undefined`/`true` treats a
 *                                      `BEHIND` head as a merge blocker (the
 *                                      branch must be rebased). Only when the
 *                                      caller has resolved branch protection and
 *                                      found NO strict up-to-date rule may it
 *                                      pass `false` — then a `BEHIND`-but-
 *                                      `MERGEABLE` PR is not blocked here, since
 *                                      GitHub merges it with a merge commit and
 *                                      repeatedly rebasing to chase a moving
 *                                      base just re-runs required CI on identical
 *                                      code.
 * @property {string=}  prState         GitHub PR `state`. When supplied it must be
 *                                      `OPEN`; a closed/merged PR → `pr-not-mergeable`.
 *                                      Omit to skip the open check.
 * @property {boolean=} branchProtectionRequired
 *                                      Whether the domain policy requires branch
 *                                      protection to enforce the adversarial-gate
 *                                      context. Defaults to `true`.
 * @property {string=}  requiredGateContext
 *                                      The resolved adversarial-gate status
 *                                      context that branch protection must require
 *                                      when `branchProtectionRequired !== false`.
 * @property {string[]=} branchProtectionRequiredContexts
 *                                      Observed required status-check contexts from
 *                                      GitHub branch protection for the target
 *                                      branch. Missing/empty fails closed when the
 *                                      policy requires branch protection.
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
  return ELIGIBLE_MERGE_VERDICTS.includes(String(verdict ?? '').trim().toLowerCase());
}

/**
 * Classify required checks as green. Mirrors the hammer inline gate's rules
 * exactly (StatusContext must be `SUCCESS`; check-runs must be `COMPLETED` with a
 * `SUCCESS`/`NEUTRAL`/`SKIPPED` conclusion) and requires at least one check —
 * an empty rollup fails closed. A boolean short-circuits to itself for callers
 * that already derived greenness.
 *
 * INVARIANT — empty rollup is NOT green here. At the point of an actual merge
 * decision, "no checks have reported on this head" must read NOT green: a rollup
 * fetched before GitHub registers the head's checks would otherwise authorize a
 * premature merge. As of LAC-1559, `summarizeChecksConclusion()`
 * (`src/checks-summary.mjs`) also fails closed on an empty rollup (returns
 * `null`, or `PENDING` when explicit required contexts are configured), so this
 * predicate and that classifier now AGREE on the empty case — a zero-external-
 * check PR classifies green on neither surface.
 *
 * @param {Array|boolean|undefined} requiredChecks
 * @returns {boolean}
 */
function requiredChecksGreen(requiredChecks, requiredCheckContexts = []) {
  if (typeof requiredChecks === 'boolean') return requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) return false;

  const reportedContexts = new Set(
    requiredChecks
      .map(check => String(check?.context || check?.name || '').trim().toLowerCase())
      .filter(Boolean)
  );

  const normalizedRequiredCheckContexts = (requiredCheckContexts || [])
    .map(ctx => String(ctx).trim().toLowerCase())
    .filter(Boolean);

  for (const ctx of normalizedRequiredCheckContexts) {
    if (!reportedContexts.has(ctx)) {
      return false;
    }
  }

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
  // cleared). An explicit BEHIND (the base advanced under the PR) blocks ONLY
  // when the target branch's protection requires the PR to be up to date first
  // (`required_status_checks.strict`). Absent that rule GitHub merges a
  // BEHIND-but-MERGEABLE PR with a merge commit, so chasing a moving base with
  // repeated rebases just re-runs required CI on identical code. Fail closed: an
  // unresolved flag (undefined) is treated as "required", preserving the
  // historical block; only an explicit `false` (caller checked branch
  // protection and found no strict rule) lets a BEHIND head through.
  const requiresUpToDate = state?.requiresUpToDateBranch !== false;
  if (requiresUpToDate && String(state?.mergeStateStatus ?? '').toUpperCase() === 'BEHIND') {
    return false;
  }
  return true;
}

function branchProtectionRequiresGate(state) {
  if (state?.branchProtectionRequired === false) return true;
  const requiredContext = String(state?.requiredGateContext ?? '').trim().toLowerCase();
  if (!requiredContext) return false;
  const requiredContexts = Array.isArray(state?.branchProtectionRequiredContexts)
    ? state.branchProtectionRequiredContexts
    : [];
  const normalized = new Set(
    requiredContexts
      .map((context) => String(context ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  return normalized.has(requiredContext);
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
  if (!requiredChecksGreen(state?.requiredChecks, state?.requiredCheckContexts)) reasons.push('ci-not-green');
  if (!prMergeable(state)) reasons.push('pr-not-mergeable');
  if (!branchProtectionRequiresGate(state)) reasons.push('branch-protection-missing-gate');
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
  branchProtectionRequiresGate,
  headMatches,
});
