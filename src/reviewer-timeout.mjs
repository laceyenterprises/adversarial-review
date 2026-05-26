// Shared subprocess timeout for both reviewer paths (claude + codex). Raised
// from 10 minutes -> 20 minutes on 2026-05-10 after PR #331's first review
// attempt hit the 10-minute wall on a substantive spec diff and got
// classified as `reviewer-timeout`. The separate no-output progress watchdog
// is intentionally 15 minutes for streaming subprocesses; non-streaming
// cli-direct reviewer commands disable it and rely on the hard deadline.
const DEFAULT_REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000;

function resolveReviewerTimeoutMs(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEWER_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_REVIEWER_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REVIEWER_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function resolveProgressTimeoutMs(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_PROGRESS_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PROGRESS_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

export {
  DEFAULT_PROGRESS_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
};
