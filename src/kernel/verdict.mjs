/**
 * @typedef {import('./contracts.js').ReviewVerdictKind} ReviewVerdictKind
 * @typedef {import('./contracts.js').Verdict} Verdict
 */

function looksLikeRuntimeJunk(text) {
  const normalized = String(text ?? '').toLowerCase();
  return /\[client\]|\[agent\]|running|initializ|session|reading additional input|reading prompt from stdin|could not update path|operation not permitted|error:|timed out/.test(normalized);
}

function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleCaseWords(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * @param {string} reviewText
 * @returns {Verdict['body']}
 */
function sanitizeCodexReviewPayload(reviewText) {
  // Promote any heading level whose text matches one of the canonical
  // section names (`Summary` / `Blocking issues` / `Non-blocking issues`
  // / `Suggested fixes` / `Verdict`) to `## `. The earlier "collapse all
  // `### ` / `#### ` to `## `" rule was too aggressive: it shattered the
  // per-finding H3 cards the reviewer prompt now emits under the
  // Blocking/Non-blocking sections. Non-canonical `### ` / `#### `
  // headings are preserved so the card layout survives.
  let text = normalizeWhitespace(reviewText)
    .replace(
      /^#{1,4}\s+(summary|blocking issues|non-blocking issues|suggested fixes|verdict)\s*:?$/gim,
      (_, heading) => `## ${titleCaseWords(heading)}`,
    );

  const sectionRegex = /^##\s+(Summary|Blocking issues|Non-blocking issues|Suggested fixes|Verdict)\s*$/gim;
  const matches = [...text.matchAll(sectionRegex)];
  if (matches.length === 0) {
    if (looksLikeRuntimeJunk(text)) {
      throw new Error('Codex payload did not contain recognizable review sections and still looked like runtime junk');
    }
    throw new Error('Codex payload did not contain recognizable review sections');
  }

  const firstSeen = new Set();
  const kept = [];
  for (const match of matches) {
    const heading = titleCaseWords(match[1]);
    if (firstSeen.has(heading)) break;
    firstSeen.add(heading);
    kept.push({ heading, index: match.index, raw: match[0] });
    if (heading === 'Verdict') break;
  }

  if (!firstSeen.has('Summary') || !firstSeen.has('Verdict')) {
    throw new Error('Codex payload missing required Summary/Verdict sections');
  }

  const trimmedSections = [];
  for (let i = 0; i < kept.length; i += 1) {
    const start = kept[i].index;
    const end = i + 1 < kept.length ? kept[i + 1].index : text.length;
    trimmedSections.push(normalizeWhitespace(text.slice(start, end)));
    if (kept[i].heading === 'Verdict') break;
  }

  const sanitized = trimmedSections.join('\n\n').trim();
  if (!sanitized) {
    throw new Error('Codex payload was empty after sanitation');
  }

  return sanitized;
}

/**
 * Best-effort canonicalization for reviewer output that is *expected* to already
 * be in the canonical shape (claude / gemini, which are posted without the hard
 * codex sanitize step). Runs the same heading-promotion + section-trim as
 * `sanitizeCodexReviewPayload`, but NEVER throws: if the body is not recognizably
 * canonical it is returned whitespace-normalized and otherwise unchanged.
 *
 * Rationale: gemini/agy output frequently emits the canonical `## Summary /
 * ## Blocking issues / ## Verdict` sections at non-`##` heading levels (or with
 * trailing colons), which the downstream verdict/blocking-finding parsers reject.
 * A rejected body makes the review-cycle cap counter skip it AND makes the
 * budget-exhausted final-pass closer refuse (`blockingFindingState='unknown'`),
 * so gemini-reviewed PRs never close and re-enter the review loop unbounded.
 * Promoting the headings here re-arms both the cap and the closer for gemini
 * without changing the codex path (which keeps its throwing sanitize +
 * forensic-dump behavior). A body that still can't be canonicalized is posted
 * as-is and is bounded by the format-independent review-cycle cap.
 */
function sanitizeReviewPayloadBestEffort(reviewText) {
  const text = String(reviewText ?? '');
  try {
    return sanitizeCodexReviewPayload(text);
  } catch {
    const fallback = text.replace(
      /^#{1,4}\s+(summary|blocking issues|non-blocking issues|suggested fixes|verdict)\s*:?$/gim,
      (_, heading) => `## ${titleCaseWords(heading)}`,
    );
    return normalizeWhitespace(fallback);
  }
}

function extractReviewVerdict(reviewBody) {
  const text = String(reviewBody ?? '');
  const heading = text.match(/^##\s+Verdict\s*$/im);
  if (!heading) return null;

  const sectionStart = heading.index + heading[0].length;
  const remainder = text.slice(sectionStart);
  const nextHeading = remainder.search(/^##\s+/m);
  const section = nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const normalizedLines = lines.map((line) => normalizeVerdictSectionLine(line));
  const requestChangesLines = lines
    .filter((_, index) => normalizedLines[index] === 'request-changes');
  const hasRequestChanges = requestChangesLines.length > 0;
  const hasPermissiveVerdict = normalizedLines.includes('comment-only')
    || normalizedLines.includes('approved');

  if (hasRequestChanges && hasPermissiveVerdict) {
    return requestChangesLines.at(-1);
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const lineVerdict = normalizedLines[index];
    if (lineVerdict && lineVerdict !== 'unknown') {
      return lines[index];
    }
  }

  return lines.at(-1);
}

function extractMarkdownSection(markdown, heading) {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const escapedHeading = String(heading ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, 'i');
  const lines = text.split('\n');
  let fenceMarker = null;
  let offset = 0;
  let start = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    fenceMarker = updateMarkdownFenceMarker(fenceMarker, trimmed);
    if (!fenceMarker && pattern.test(line)) {
      start = offset + line.length;
      break;
    }
    offset += line.length + 1;
  }
  if (start == null) return null;

  fenceMarker = null;
  offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    const trimmed = line.trimStart();
    if (lineStart > start && !fenceMarker && /^##\s+/.test(line)) {
      return text.slice(start, lineStart);
    }
    fenceMarker = updateMarkdownFenceMarker(fenceMarker, trimmed);
    offset += line.length + 1;
  }
  return text.slice(start);
}

function updateMarkdownFenceMarker(openMarker, trimmedLine) {
  const match = trimmedLine.match(/^(`{3,}|~{3,})/);
  if (!match) return openMarker;

  const marker = match[1];
  if (!openMarker) return marker;

  if (
    marker[0] === openMarker[0]
    && marker.length >= openMarker.length
  ) {
    return null;
  }

  return openMarker;
}

function sectionIsNone(lines) {
  const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim());
  if (nonEmpty.length === 0) return true;
  if (!/^-\s+none\.?(?:\s+.*)?$/i.test(nonEmpty[0].trim())) return false;
  return nonEmpty.slice(1).every((line) => /^\s+/.test(line));
}

function classifyStructuredBlockingIssues(reviewBody) {
  const section = extractMarkdownSection(reviewBody, 'Blocking issues');
  if (section == null) {
    return { count: 0, state: 'unknown' };
  }

  const lines = section.split('\n');
  if (sectionIsNone(lines)) {
    return { count: 0, state: 'known' };
  }

  const topLevelFindings = lines.filter((line) => /^-\s+/.test(line));
  return {
    count: Math.max(1, topLevelFindings.length),
    state: 'known',
  };
}

function normalizeEffectiveReviewVerdict(reviewBody, { log = null, context = '' } = {}) {
  const statedVerdict = extractReviewVerdict(reviewBody);
  const normalizedVerdict = normalizeReviewVerdict(statedVerdict);

  const blockingIssues = classifyStructuredBlockingIssues(reviewBody);
  if (blockingIssues.state === 'known') {
    if (blockingIssues.count === 0 && normalizedVerdict === 'request-changes') {
      const suffix = context ? ` ${context}` : '';
      log?.warn?.(
        `[review-verdict] Reconciled Request changes to Comment only because structured Blocking issues is empty.${suffix}`,
      );
      return 'comment-only';
    }

    if (
      blockingIssues.count > 0
      && (normalizedVerdict === 'comment-only' || normalizedVerdict === 'approved')
    ) {
      const suffix = context ? ` ${context}` : '';
      log?.warn?.(
        `[review-verdict] Escalated ${normalizedVerdict} to Request changes because structured Blocking issues is non-empty.${suffix}`,
      );
      return 'request-changes';
    }
  }

  return normalizedVerdict;
}

function normalizeVerdictSectionLine(verdict) {
  const normalized = normalizeVerdictText(verdict);
  if (!normalized) return null;
  if (isResolvedRequestChangesProse(normalized)) return 'unknown';
  return normalizeReviewVerdict(normalized);
}

function isResolvedRequestChangesProse(normalized) {
  if (!/^request changes\b/i.test(normalized)) return false;

  const stillBlocking = /\b(?:not|never|still|remain|remains|must|need|needs|required|requires|unresolved|unsafe|broken|failing|fails?|regression|blocker|blocking|before merge)\b/i
    .test(normalized);
  if (stillBlocking) return false;

  return /^request changes\b.{0,160}\b(?:(?:are|is|were|was|have been|has been|have now been|has now been|now|already)\s+(?:resolved|addressed|fixed|closed))\b/i
    .test(normalized);
}

function normalizeVerdictText(verdict) {
  return String(verdict ?? '')
    .replace(/[*_`~]/g, ' ')
    .replace(/^(?:\s*[-*]\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * @param {string | null | undefined} verdict
 * @returns {ReviewVerdictKind | null}
 */
function normalizeReviewVerdict(verdict) {
  const text = normalizeVerdictText(verdict);
  if (!text) return null;
  if (text.startsWith('request changes')) return 'request-changes';
  if (text.startsWith('comment only')) return 'comment-only';
  if (text === 'approve' || /^approved\b/.test(text)) return 'approved';
  return 'unknown';
}

// titleCaseWords is intentionally not exported — it's a private helper of
// sanitizeCodexReviewPayload. normalizeWhitespace is now used directly by
// reviewer.mjs (the second real caller invoked by the prior comment), so
// it is exported here rather than duplicated inline.
export {
  classifyStructuredBlockingIssues,
  extractReviewVerdict,
  looksLikeRuntimeJunk,
  normalizeEffectiveReviewVerdict,
  normalizeReviewVerdict,
  normalizeWhitespace,
  sanitizeCodexReviewPayload,
  sanitizeReviewPayloadBestEffort,
};
