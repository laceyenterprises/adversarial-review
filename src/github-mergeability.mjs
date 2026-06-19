function normalizeGithubMergeability({ mergeable, mergeStateStatus } = {}) {
  const mergeableValue = String(mergeable || '').trim().toUpperCase();
  const mergeStateStatusValue = String(mergeStateStatus || '').trim().toUpperCase();

  if (mergeableValue === 'MERGEABLE' || mergeableValue === 'CONFLICTING') {
    return mergeableValue;
  }
  if ((!mergeableValue || mergeableValue === 'UNKNOWN') && mergeStateStatusValue === 'CLEAN') {
    return 'MERGEABLE';
  }
  return mergeableValue || mergeStateStatusValue;
}

/**
 * GitHub reports `mergeable=UNKNOWN` (with `mergeStateStatus=UNKNOWN`/empty) for
 * a short window right after a commit is pushed or the base branch moves, while
 * it recomputes mergeability asynchronously. Treating that transient state as
 * "not mergeable" wrongly parks otherwise-eligible PRs as `pr-not-mergeable` —
 * which, under a steady merge stream that keeps moving `main`, can stall the
 * whole AMA close path. This re-samples mergeability over a bounded window until
 * GitHub resolves it to a terminal value (`MERGEABLE`/`CONFLICTING`) or the
 * window is exhausted. (A `gh pr view --json mergeable` re-fetch also nudges
 * GitHub to finish computing.)
 *
 * @param {{mergeable?: string, mergeStateStatus?: string}} initial first-read mergeability
 * @param {() => Promise<{mergeable?: string, mergeStateStatus?: string}>} refetch single-PR re-fetch
 * @param {{attempts?: number, delayMs?: number, sleepImpl?: (ms:number)=>Promise<void>}} [opts]
 * @returns {Promise<{mergeable: (string|null), mergeStateStatus: (string|null), normalized: string, samples: number, resolved: boolean}>}
 */
async function resolveMergeabilityWithSampling(initial, refetch, opts = {}) {
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 3;
  const delayMs = Number.isFinite(opts.delayMs) && opts.delayMs >= 0 ? opts.delayMs : 2500;
  const sleepImpl =
    typeof opts.sleepImpl === 'function'
      ? opts.sleepImpl
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let current = initial || {};
  for (let sample = 1; ; sample += 1) {
    const normalized = normalizeGithubMergeability(current);
    // Terminal: GitHub has finished computing. CONFLICTING is a real conflict,
    // not the transient limbo, so stop sampling on it too.
    if (normalized === 'MERGEABLE' || normalized === 'CONFLICTING') {
      return {
        mergeable: current?.mergeable ?? null,
        mergeStateStatus: current?.mergeStateStatus ?? null,
        normalized,
        samples: sample,
        resolved: true,
      };
    }
    if (sample >= attempts || typeof refetch !== 'function') {
      return {
        mergeable: current?.mergeable ?? null,
        mergeStateStatus: current?.mergeStateStatus ?? null,
        normalized,
        samples: sample,
        resolved: false,
      };
    }
    await sleepImpl(delayMs);
    try {
      const next = await refetch();
      if (next) current = next;
    } catch {
      // Keep the last reading and try again until attempts are exhausted; a
      // transient fetch failure should not collapse the window early.
    }
  }
}

export { normalizeGithubMergeability, resolveMergeabilityWithSampling };
