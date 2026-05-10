// Shared subprocess timeout for both reviewer paths (claude + codex). Raised
// from 10 minutes → 20 minutes on 2026-05-10 after PR #331's first review
// attempt hit the 10-minute wall on a substantive spec diff and got
// classified as `reviewer-timeout`. Under PR #62's relaxed gate that
// reports `success` to GitHub (so it doesn't block the merge button), but
// still costs an 8-minute backoff before the watcher retries — wall-clock
// loss for the operator. Substantive specs + large diffs are the dominant
// failure mode for the 10-minute default; the simple fix is "give the spawn
// more headroom by default; operators can tune further via the existing
// ADVERSARIAL_REVIEWER_TIMEOUT_MS env override."
const DEFAULT_REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;

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
