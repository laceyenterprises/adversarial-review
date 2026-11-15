import { resolveProgressTimeoutMs } from './reviewer-timeout.mjs';
import { resolveReviewerAbsoluteCeilingMs } from './reviewer-timeout-model.mjs';
import { loadAwareTimeoutMs, timerDelayMs } from './load-aware-timeout.mjs';

// Nominal patience on an idle host. Scale once at invocation, bounded by the
// call ceiling and independent configured silence window. Neither deadline
// replaces the outer wall backstop.
const FIRST_OUTPUT_NOMINAL_MS = 120_000;
const NO_PROGRESS_NOMINAL_MS = 180_000;

export function reviewerStallOptions(ceilingMs, reviewer, {
  loadAwareTimeoutMsImpl = loadAwareTimeoutMs,
  env = process.env,
  progressOnStdoutOnly = true,
} = {}) {
  const ceiling = Math.min(timerDelayMs(ceilingMs), resolveReviewerAbsoluteCeilingMs(env), resolveProgressTimeoutMs(env));
  const budget = nominal => Math.min(ceiling,
    loadAwareTimeoutMsImpl(nominal, { maxMs: ceiling }));
  return {
    firstOutputTimeout: budget(FIRST_OUTPUT_NOMINAL_MS),
    progressTimeout: budget(NO_PROGRESS_NOMINAL_MS),
    stallReviewer: reviewer,
    progressOnStdoutOnly,
  };
}

export function isReviewerStall(error) {
  return error?.reviewerStalled === true
    || /\[reviewer-stalled\]/.test(String(error?.message || error || ''));
}
