const DEFAULT_REVIEWER_TIMEOUT_MS = 10 * 60 * 1000;

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

export {
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveReviewerTimeoutMs,
};
