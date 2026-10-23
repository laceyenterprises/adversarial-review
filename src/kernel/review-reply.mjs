import { maskReviewFences } from './review-markdown.mjs';
// REVIEWVALID-01: the posting contract for a reviewer reply.
//
// A posted review is a claim about the code. A reply that is the
// instructions themselves is not a review and must never be posted, counted
// or acted on. The sanitizers in `verdict.mjs` are deliberately tolerant
// (they trim preamble, keep the first copy of a duplicated section and never
// look at section bodies), so a reply that echoed the output template still
// sanitized into a five-section body whose example verdict was
// `Request changes`. This module is the strict check that runs on the raw
// reply before anything is posted:
//
//   - at least two finding fields may not be whole-value template placeholders
//     (`<Title>`, `<path>`, `<range>`, `<one paragraph>`, ...), derived from the
//     prompts' `Output requirements:` block. A whole Summary or Suggested fixes
//     body of `<text>` is also an echo. Fenced examples and arbitrary prose
//     labels are excluded, so real reviews may discuss markup tags freely;
//   - nothing but blank lines and the optional `## Adversarial Review ...`
//     header (which the Antigravity prompt asks for) may precede the first
//     required heading;
//   - no required heading outside fenced code may appear twice;
//   - `## Verdict` must be the last section, may hold no heading or code
//     fence, and its last line must be a recognised verdict, so nothing
//     follows the verdict.
//
// A rejection throws `ReviewerReplyRejectedError`, whose `[reviewer-output]`
// tag routes the attempt onto the watcher's bounded `reviewer-output` retry.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTemplatePlaceholderFinding,
  parseBlockingFindingsSection,
  parseNonBlockingFindingsSection,
} from './review-findings.mjs';
import {
  normalizeVerdictSectionLine,
  normalizeWhitespace,
  promoteCanonicalReviewSectionHeadings,
} from './verdict.mjs';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
const REVIEWER_STAGE_PROMPT_FILE = /^reviewer\.(?:first|middle|last)(?:\.addendum)?\.md$/;
// Models fill the template's free-text sections (Summary, Suggested fixes)
// with this generic stand-in even though the template leaves them unshaped.
const GENERIC_PLACEHOLDERS = ['<text>'];
const REQUIRED_HEADINGS = ['Summary', 'Blocking issues', 'Non-blocking issues', 'Suggested fixes', 'Verdict'];
const REQUIRED_HEADING_RE = /^##[ \t]+(Summary|Blocking issues|Non-blocking issues|Suggested fixes|Verdict)[ \t]*$/i;
const REVIEW_HEADER_RE = /^##[ \t]+Adversarial Review\b.*$/;
const ANY_HEADING_RE = /^#{1,6}[ \t]+\S/;
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const KNOWN_VERDICTS = new Set(['request-changes', 'comment-only', 'approved']);

class ReviewerReplyRejectedError extends Error {
  constructor(reasons) {
    super(`[reviewer-output] reviewer reply rejected: ${reasons.join('; ')}`);
    this.name = 'ReviewerReplyRejectedError';
    this.failureClass = 'reviewer-output';
    this.reasons = reasons;
  }
}

// The placeholder tokens of one prompt's `Output requirements:` block: the
// block runs until the next flush-left line that is not a bullet.
function extractTemplatePlaceholders(promptText) {
  const lines = String(promptText ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => /^Output requirements:\s*$/.test(line));
  if (start < 0) return [];
  const placeholders = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s-]/.test(line)) break;
    for (const match of line.matchAll(/<[^<>`\n]{1,40}>/g)) placeholders.add(match[0]);
  }
  return [...placeholders];
}

let templatePlaceholders = null;

// Every reviewer stage prompt of every prompt set, so a domain that reviews
// with another set (code-pr-security) is covered too.
function reviewTemplatePlaceholders({ promptsDir = PROMPTS_DIR } = {}) {
  if (promptsDir === PROMPTS_DIR && templatePlaceholders) return templatePlaceholders;
  const placeholders = new Set(GENERIC_PLACEHOLDERS);
  for (const promptSet of readdirSync(promptsDir, { withFileTypes: true })) {
    if (!promptSet.isDirectory()) continue;
    for (const file of readdirSync(join(promptsDir, promptSet.name))) {
      if (!REVIEWER_STAGE_PROMPT_FILE.test(file)) continue;
      const text = readFileSync(join(promptsDir, promptSet.name, file), 'utf8');
      for (const token of extractTemplatePlaceholders(text)) placeholders.add(token);
    }
  }
  const result = Object.freeze([...placeholders]);
  if (promptsDir === PROMPTS_DIR) templatePlaceholders = result;
  return result;
}

function bareValue(value) {
  return String(value ?? '').trim()
    .replace(/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/g, '')
    .trim();
}

function isTemplatePlaceholderValue(value, placeholders) {
  const text = String(value ?? '').trim().toLowerCase();
  return Boolean(text) && placeholders.some((token) => token.toLowerCase() === text);
}

/**
 * Check a raw reviewer reply against the posting contract.
 *
 * @param {string} reviewText
 * @param {{ placeholders?: readonly string[] }} [options]
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function validateReviewerReply(reviewText, { placeholders = reviewTemplatePlaceholders() } = {}) {
  const text = promoteCanonicalReviewSectionHeadings(normalizeWhitespace(reviewText));
  if (!text) return { ok: false, reasons: ['empty reply'] };
  const lines = text.split('\n');
  const reasons = [];

  const headings = [];
  const unfencedLines = maskReviewFences(text).split('\n');
  unfencedLines.forEach((line, index) => {
    const match = line.match(REQUIRED_HEADING_RE);
    if (match) headings.push({ name: REQUIRED_HEADINGS.find((name) => name.toLowerCase() === match[1].toLowerCase()), index });
  });
  // Inspect parsed card fields, never arbitrary prose labels or code examples.
  // Share the corroboration rule with consumers of historical review bodies.
  const unfenced = unfencedLines.join('\n');
  const echoed = new Set();
  for (const finding of [
    ...(parseBlockingFindingsSection(unfenced) ?? []),
    ...(parseNonBlockingFindingsSection(unfenced) ?? []),
  ]) {
    if (!isTemplatePlaceholderFinding(finding, placeholders)) continue;
    for (const value of Object.values(finding).map(bareValue)) {
      if (isTemplatePlaceholderValue(value, placeholders)) echoed.add(value);
    }
  }
  for (const [index, heading] of headings.entries()) {
    if (!['Summary', 'Suggested fixes'].includes(heading.name)) continue;
    const body = bareValue(unfencedLines.slice(heading.index + 1, headings[index + 1]?.index).join('\n'));
    if (isTemplatePlaceholderValue(body, GENERIC_PLACEHOLDERS)) echoed.add(body);
  }
  if (echoed.size > 0) reasons.push(`template placeholders ${[...echoed].join(', ')}`);
  if (headings.length === 0) return { ok: false, reasons: [...reasons, 'no required heading'] };

  const preamble = lines.slice(0, headings[0].index).filter((line) => line.trim());
  if (preamble.length > 1 || (preamble.length === 1 && !REVIEW_HEADER_RE.test(preamble[0]))) {
    reasons.push('text before the first required heading');
  }

  const duplicated = REQUIRED_HEADINGS.filter((name) => headings.filter((heading) => heading.name === name).length > 1);
  if (duplicated.length > 0) reasons.push(`repeated required sections ${duplicated.join(', ')}`);

  const verdictHeading = headings.filter((heading) => heading.name === 'Verdict').at(-1);
  if (!verdictHeading) {
    reasons.push('no Verdict section');
  } else {
    const verdictLines = lines.slice(verdictHeading.index + 1).filter((line) => line.trim());
    if (verdictLines.length === 0) {
      reasons.push('missing verdict line');
    } else if (verdictLines.some((line) => ANY_HEADING_RE.test(line))) {
      reasons.push('Verdict is not the last section');
    } else if (verdictLines.some((line) => FENCE_RE.test(line))
      || !KNOWN_VERDICTS.has(normalizeVerdictSectionLine(verdictLines.at(-1) ?? ''))) {
      reasons.push('text after the Verdict');
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Throw `ReviewerReplyRejectedError` when the raw reply breaks the posting
 * contract. `onRejected` receives the evidence first, for forensic capture.
 */
function assertReviewerReply(reviewText, { onRejected = null, placeholders } = {}) {
  const { ok, reasons } = validateReviewerReply(reviewText, placeholders ? { placeholders } : undefined);
  if (ok) return;
  const error = new ReviewerReplyRejectedError(reasons);
  const warn = (persistError) => console.error(
    `[reviewer] WARN: failed to persist rejected reviewer reply: ${persistError?.message || persistError}`);
  try {
    onRejected?.({ rawReviewText: String(reviewText ?? ''), rejectionReason: error.message })?.catch?.(warn);
  } catch (persistError) {
    warn(persistError);
  }
  throw error;
}

export {
  ReviewerReplyRejectedError,
  assertReviewerReply,
  extractTemplatePlaceholders,
  reviewTemplatePlaceholders,
  validateReviewerReply,
};
