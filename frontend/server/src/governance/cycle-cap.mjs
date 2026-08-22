/**
 * Review-cycle-cap burndown (ARF-04).
 *
 * The cap is a **config** value and the count is a **store** value, and they
 * live in different places on purpose: `review_cycle_counters` records how many
 * rounds a `(pr_url, head_sha)` has consumed, while `review_cycle_cap` /
 * `review_cycle_window_hours` say how many it is allowed and over what window.
 * Pairing them is this module's whole job.
 *
 * Two honesty rules follow from the pipeline's own accounting
 * (`src/review-cycle-cap.mjs`, read as a reference
 * model, never imported):
 *
 *   - **The counter is per HEAD, not per PR.** A new head starts its own row,
 *     which is deliberate — a moved head is owed its own review budget. So a PR
 *     can appear more than once, and the burndown says which head each row is.
 *   - **A lapsed window has already been spent.** `nextCountFromPrevious`
 *     restarts the count at 1 when the last verdict is older than the window,
 *     so a row at `used = 5 / cap = 5` whose window has lapsed is *not*
 *     exhausted; the next verdict resets it. Reporting it as exhausted would
 *     show an operator a wall that is not there.
 */

/** A cap or count ARF could not establish reports null, never a stand-in number. */
function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

/**
 * Pair store counters with the configured cap.
 *
 * @param {object} options
 * @param {object[]} options.cycles rows from `ReviewStore.reviewCycles()`
 * @param {object|null} options.capKey resolved `review_cycle_cap`
 * @param {object|null} options.windowKey resolved `review_cycle_window_hours`
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function buildReviewCycleBurndown({ cycles = [], capKey = null, windowKey = null, now = Date.now } = {}) {
  const cap = capKey?.known ? intOrNull(capKey.value) : null;
  const windowHours = windowKey?.known ? intOrNull(windowKey.value) : null;
  const windowMs = windowHours === null ? null : windowHours * 60 * 60 * 1000;
  const at = now();

  const rows = cycles.map((cycle) => {
    const used = intOrNull(cycle.used);
    const lastVerdictMs = cycle.lastVerdictAt ? Date.parse(cycle.lastVerdictAt) : NaN;
    const ageMs = Number.isFinite(lastVerdictMs) ? Math.max(0, at - lastVerdictMs) : null;
    // Unknown age is not a lapsed window: without a last-verdict timestamp ARF
    // cannot say the budget reset, and claiming it did would show headroom that
    // may not exist.
    const windowExpired = windowMs === null || ageMs === null ? null : ageMs > windowMs;
    const remaining = cap === null || used === null ? null : Math.max(0, cap - used);
    return {
      ...cycle,
      cap,
      used,
      remaining,
      ageMs,
      windowHours,
      windowExpired,
      // Exhausted needs positive evidence on both halves: the budget is spent
      // AND the window has not lapsed. An escalation stamp is direct evidence
      // and stands on its own.
      exhausted: cycle.escalated
        ? true
        : (cap === null || used === null || windowExpired === null
          ? null
          : !windowExpired && used >= cap),
    };
  });

  const counted = (predicate) => rows.filter(predicate).length;
  return {
    cap,
    capSource: capKey?.source ?? null,
    capKnown: Boolean(capKey?.known),
    windowHours,
    windowSource: windowKey?.source ?? null,
    rows,
    total: rows.length,
    exhaustedCount: counted((row) => row.exhausted === true),
    // "One round left" is the operator-actionable band: the next verdict ends
    // the cycle. Rows whose remaining is unknown are counted separately rather
    // than folded into either bucket.
    lastRoundCount: counted((row) => row.exhausted !== true && row.remaining === 1),
    unknownCount: counted((row) => row.exhausted === null),
  };
}
