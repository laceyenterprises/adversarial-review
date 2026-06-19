const DEFAULT_WINDOW_COMMITS = 5;
const DEFAULT_MIN_REPEATS = 3;
const FINDING_KIND = 'remediation-vocabulary-fatigue';
const FINDING_DETAIL_DOC = 'docs/POSTMORTEM-codex-tui-remediation-runaway-2026-06-03.md §6 and §7';

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function commitSubjectFromEntry(entry) {
  if (typeof entry === 'string') return entry.split('\n')[0] || '';
  return String(entry?.commit?.message || entry?.message || entry?.subject || '').split('\n')[0] || '';
}

function stemFromCommitSubject(subject) {
  const withoutPrefix = String(subject || '').replace(/^\[[^\]]*\]\s+/, '').trim();
  const firstWord = withoutPrefix.split(/\s+/)[0] || '';
  return firstWord
    .toLowerCase()
    .replace(/ing$/, '')
    .replace(/ed$/, '');
}

function buildVocabularyFatigueFinding({ stem, count, window }) {
  return {
    kind: FINDING_KIND,
    severity: 'info',
    blocking: false,
    stem,
    count,
    window,
    detail: `The verb '${stem}' appears in ${count} of the last ${window} commit messages. This often signals that the agent has reached the bottom of its vocabulary for change descriptors — a soft churn indicator. See ${FINDING_DETAIL_DOC}.`,
  };
}

function detectVocabularyFatigue(commitEntries, {
  windowCommits = DEFAULT_WINDOW_COMMITS,
  minRepeats = DEFAULT_MIN_REPEATS,
} = {}) {
  const window = normalizePositiveInt(windowCommits, DEFAULT_WINDOW_COMMITS);
  const repeats = normalizePositiveInt(minRepeats, DEFAULT_MIN_REPEATS);
  const entries = Array.isArray(commitEntries) ? commitEntries : [];
  if (entries.length < window) return null;

  const stems = entries
    .slice(-window)
    .map(commitSubjectFromEntry)
    .map(stemFromCommitSubject)
    .filter(Boolean);
  if (stems.length < window) return null;

  const counts = new Map();
  for (const stem of stems) counts.set(stem, (counts.get(stem) || 0) + 1);
  for (const [stem, count] of counts.entries()) {
    if (count >= repeats) return buildVocabularyFatigueFinding({ stem, count, window });
  }
  return null;
}

function formatVocabularyFatigueFindingMarkdown(finding) {
  if (!finding || finding.kind !== FINDING_KIND) return '';
  return [
    `- **${finding.kind}** (info, non-blocking)`,
    `  - stem: \`${finding.stem}\``,
    `  - count: ${finding.count}`,
    `  - window: ${finding.window}`,
    `  - blocking: false`,
    `  - detail: ${finding.detail}`,
  ].join('\n');
}

function appendVocabularyFatigueFindingToReviewBody(reviewBody, finding) {
  const item = formatVocabularyFatigueFindingMarkdown(finding);
  if (!item) return String(reviewBody || '');
  const body = String(reviewBody || '').trimEnd();
  const nonBlockingMatch = body.match(/##\s+Non[-\s]+blocking\s+Issues?\s*\n/i);
  if (nonBlockingMatch) {
    const insertAt = nonBlockingMatch.index + nonBlockingMatch[0].length;
    const nextSectionMatch = body.slice(insertAt).match(/\n##\s+/);
    const sectionEnd = nextSectionMatch ? insertAt + nextSectionMatch.index : body.length;
    const section = body.slice(insertAt, sectionEnd);
    if (/^\s*-\s*None\.?\s*$/i.test(section.trim())) {
      return `${body.slice(0, insertAt)}${item}\n${body.slice(sectionEnd)}`;
    }
    return `${body.slice(0, insertAt)}${item}\n${body.slice(insertAt)}`;
  }
  const verdictMatch = body.match(/\n##\s+Verdict\b/i);
  const section = `\n\n## Non-blocking issues\n${item}\n`;
  if (verdictMatch) {
    return `${body.slice(0, verdictMatch.index)}${section}${body.slice(verdictMatch.index)}`;
  }
  return `${body}${section}`;
}

export {
  DEFAULT_MIN_REPEATS,
  DEFAULT_WINDOW_COMMITS,
  FINDING_KIND,
  appendVocabularyFatigueFindingToReviewBody,
  detectVocabularyFatigue,
  stemFromCommitSubject,
};
