// Hosted reviewer families used by local shadow eligibility.
const REVIEW_FAMILY_BY_REVIEWER_MODEL = Object.freeze({
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
});

function normalizeReviewerFamily(reviewerModel) {
  const key = String(reviewerModel || '').trim().toLowerCase();
  return REVIEW_FAMILY_BY_REVIEWER_MODEL[key] || null;
}

export { normalizeReviewerFamily };
