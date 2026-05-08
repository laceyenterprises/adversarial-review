function extractReviewVerdict(reviewBody) {
  const match = String(reviewBody ?? '').match(/^##\s+Verdict\s*$\s*([^\n]+)/im);
  return match ? match[1].trim() : null;
}

function normalizeReviewVerdict(verdict) {
  const text = String(verdict ?? '')
    .replace(/[*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text.startsWith('request changes')) return 'request-changes';
  if (text.startsWith('comment only')) return 'comment-only';
  if (text.startsWith('approved')) return 'approved';
  return 'unknown';
}

export {
  extractReviewVerdict,
  normalizeReviewVerdict,
};
