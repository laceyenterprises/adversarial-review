import { loadAwareTimeoutMs, timerDelayMs } from './load-aware-timeout.mjs';

// Nominal patience on an idle host. Scale once at invocation, bounded by the
// existing call ceiling; neither deadline replaces the outer wall backstop.
const FIRST_OUTPUT_NOMINAL_MS = 120_000;
const NO_PROGRESS_NOMINAL_MS = 180_000;

export function reviewerStallOptions(ceilingMs, reviewer, {
  loadAwareTimeoutMsImpl = loadAwareTimeoutMs,
} = {}) {
  const ceiling = timerDelayMs(ceilingMs);
  const budget = nominal => Math.min(ceiling,
    loadAwareTimeoutMsImpl(nominal, { maxMs: ceiling }));
  return {
    firstOutputTimeout: budget(FIRST_OUTPUT_NOMINAL_MS),
    progressTimeout: budget(NO_PROGRESS_NOMINAL_MS),
    stallReviewer: reviewer,
  };
}

export function isReviewerStall(error) {
  return error?.reviewerStalled === true
    || /\[reviewer-stalled\]/.test(String(error?.message || error || ''));
}
