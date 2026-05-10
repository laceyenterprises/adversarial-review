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

function sanitizeCodexReviewPayload(reviewText) {
  let text = normalizeWhitespace(reviewText)
    .replace(/^#\s+/gm, '## ')
    .replace(/^###\s+/gm, '## ')
    .replace(/^####\s+/gm, '## ')
    .replace(/^##\s+(summary|blocking issues|non-blocking issues|suggested fixes|verdict)\s*:?$/gim, (_, heading) => `## ${titleCaseWords(heading)}`);

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

// normalizeWhitespace and titleCaseWords are intentionally not exported —
// they are private helpers of sanitizeCodexReviewPayload. Re-introduce
// exports only when a real second caller appears.
export {
  extractReviewVerdict,
  looksLikeRuntimeJunk,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
};

