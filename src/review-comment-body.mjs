// Posted-review comment body assembly.
//
// ARC-10: extracted from `reviewer.mjs`. This module owns the shape of what
// lands on GitHub — the canonical `## Adversarial Review` marker heading, the
// advisory-only variant, and the audit blocks that sit between the heading and
// the model's own text. `reviewer.mjs` re-exports every symbol here through its
// `__test__` handle, so its public surface is unchanged.
//
// The marker heading is load-bearing in both directions: downstream code
// locates an adversarial review by matching it, and the verdict and
// blocking-finding parsers key on the `## Verdict` / `## Blocking issues`
// headings that follow. Anything inserted between them must therefore be a
// blockquote, never a heading — heading-level drift in review bodies has
// already broken those parsers once (adversarial-review#521).

const VERDICT_MODE_ENFORCE = 'enforce';
const VERDICT_MODE_ADVISORY_ONLY = 'advisory-only';
const ENFORCE_REVIEW_HEADER_RE = /^## Adversarial Review — .+ \(.+\)$/;
const ADVISORY_ONLY_REVIEW_HEADER_RE = /^## Adversarial Review \(advisory-only\) — .+ \(.+\)$/;
const ANY_ADVERSARIAL_REVIEW_HEADER_RE = /^##\s+Adversarial Review\b.*$/;

function normalizeVerdictMode(mode) {
  return String(mode || '').trim() === VERDICT_MODE_ADVISORY_ONLY
    ? VERDICT_MODE_ADVISORY_ONLY
    : VERDICT_MODE_ENFORCE;
}

function buildReviewCommentHeader({ reviewerMetadata, verdictMode }) {
  const mode = normalizeVerdictMode(verdictMode);
  if (mode === VERDICT_MODE_ADVISORY_ONLY) {
    // Keep the canonical `## Adversarial Review` marker heading and displayName in
    // advisory mode so the same heuristic used to locate enforce reviews still finds
    // advisory-only reviews; append the advisory disclaimer beneath it.
    return `## Adversarial Review (advisory-only) — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n` +
      `**Advisory-only review** — findings below are informational; no automated remediation will run.\n\n`;
  }
  return `## Adversarial Review — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n`;
}

function classifyReviewCommentHeader(reviewBody) {
  const [firstLine = ''] = String(reviewBody || '').split(/\r?\n/, 1);
  if (ADVISORY_ONLY_REVIEW_HEADER_RE.test(firstLine)) {
    return {
      isAdversarialReview: true,
      verdictMode: VERDICT_MODE_ADVISORY_ONLY,
      advisoryOnly: true,
    };
  }
  if (ENFORCE_REVIEW_HEADER_RE.test(firstLine)) {
    return {
      isAdversarialReview: true,
      verdictMode: VERDICT_MODE_ENFORCE,
      advisoryOnly: false,
    };
  }
  return {
    isAdversarialReview: false,
    verdictMode: null,
    advisoryOnly: false,
  };
}

function startsWithReviewCommentHeader(reviewBody) {
  const [firstLine = ''] = String(reviewBody || '').trimStart().split(/\r?\n/, 1);
  return ANY_ADVERSARIAL_REVIEW_HEADER_RE.test(firstLine.trim());
}

function insertAfterExistingReviewHeader(reviewBody, insertText) {
  const text = String(reviewBody || '').trimStart();
  const block = String(insertText || '');
  if (!block) return text;

  const lineBreakMatch = text.match(/\r?\n/);
  if (!lineBreakMatch) {
    return `${text}\n\n${block}`;
  }

  const headerLine = text.slice(0, lineBreakMatch.index);
  const rest = text
    .slice(lineBreakMatch.index + lineBreakMatch[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/, '');
  return `${headerLine}\n\n${block}${rest}`;
}

function buildReviewCommentBody({
  reviewerMetadata,
  verdictMode,
  waiverAuditBlock = '',
  reviewModeAuditBlock = '',
  reviewText,
}) {
  const text = String(reviewText || '');
  // Blockquote lines only, never headings: the verdict and blocking-finding
  // parsers key on `## Verdict` / `## Blocking issues`, and a heading inserted
  // above them has broken parsing before (adversarial-review#521).
  const auditBlocks = `${String(waiverAuditBlock || '')}${String(reviewModeAuditBlock || '')}`;
  if (startsWithReviewCommentHeader(text)) {
    return insertAfterExistingReviewHeader(text, auditBlocks);
  }

  const header = buildReviewCommentHeader({ reviewerMetadata, verdictMode });
  return header + auditBlocks + text;
}

export {
  ADVISORY_ONLY_REVIEW_HEADER_RE,
  ANY_ADVERSARIAL_REVIEW_HEADER_RE,
  ENFORCE_REVIEW_HEADER_RE,
  VERDICT_MODE_ADVISORY_ONLY,
  VERDICT_MODE_ENFORCE,
  buildReviewCommentBody,
  buildReviewCommentHeader,
  classifyReviewCommentHeader,
  insertAfterExistingReviewHeader,
  normalizeVerdictMode,
  startsWithReviewCommentHeader,
};
