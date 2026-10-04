// Parse the `## Blocking Issues` section into structured findings. The
// review contract (`prompts/code-pr/reviewer.*.md`) requires:
//   - one finding card per issue, currently headed by a top-level
//     `- **<Title>**` bullet with the fields rendered as nested
//     bold-labeled sub-bullets (`**File:**`, `**Lines:**`,
//     `**Problem:**`, `**Why it matters:**`, `**Recommended fix:**`)
//   - the literal sentinel `- None.` when the section is empty
// Five render shapes are supported (newest first):
//   1. nested-bullet card-style: `- **<Title>**` per finding, with
//      `  - **File:** value` / `  - **Lines:** value` /
//      `  - **Problem:** value` sub-bullets. The parser accepts
//      harmless trailing text after the closing bold span so minor
//      markdown drift does not silently drop titles. A field label with
//      no text after it (`  - **Problem:**`) takes the more-indented
//      bullets nested under it as its value.
//   2. card-style: `### <Title>` heading per finding, with fields as
//      `**File:** value` / `**Lines:** value` / `**Problem:** value`
//      bold-labeled paragraphs (stored-review back-compat).
//   3. one top-level `- Title:` bullet per finding, with the rest of
//      the fields as 2-space-indented continuation lines (legacy)
//   4. one top-level `- File:` bullet per finding, with the rest of
//      the fields as 2-space-indented continuation lines (legacy back-compat)
//   5. top-level bullets per field (`- Title:`, `- File:`, `- Lines:`,
//      `- Problem:`, `- Why it matters:`, `- Recommended fix:`)
// The finding boundary is either a top-level `- **<Title>**` bullet or
// a `### <Title>` heading that introduces a complete card body; stray
// bold field bullets / H3 subheadings inside a card body are ignored.
// For the legacy bullet shapes it is a top-level `- Title:` field when
// present, otherwise a top-level dash-prefixed `- File:` field. A
// dashless `File:` continuation after `- Title:` attaches only when the
// current finding has no file yet, so prose that happens to begin with
// `File:` cannot split a finding into a phantom boundary.
//
// Returns `null` when the section is absent (caller opts out of
// coverage enforcement). Returns `[]` when the section exists but is
// empty or contains only the `- None.` sentinel. Returns one entry per
// finding otherwise, with extracted `file` / `lines` / `problem` /
// `whyItMatters` / `recommendedFix` fields preserved for diagnostics.

function isNoneFindingsSentinelOnly(linesOrSection) {
  const lines = Array.isArray(linesOrSection)
    ? linesOrSection
    : String(linesOrSection ?? '').split(/\n/);
  const significant = lines.filter((line) => line.trim());
  const sentinelPattern = /^-\s+None(?:\.(?:\s+.*)?|\s*)$/i;
  const fieldMarkerPattern = /\*\*(Category|File|Lines|Problem|Why it matters|Recommended fix)(?::\*\*|\*\*[ \t]*:)/i;
  if (significant.length === 0) return true;
  const firstLine = significant[0];
  const firstTrimmed = firstLine.trim();
  if (!sentinelPattern.test(firstTrimmed)) return false;
  const firstIndent = firstLine.match(/^\s*/)?.[0].length ?? 0;
  return significant.slice(1).every((line) => {
    const trimmed = line.trim();
    if (sentinelPattern.test(trimmed)) return true;
    if (fieldMarkerPattern.test(trimmed)) return false;
    if (/^(?:[-*+]\s+|\d+\.\s+)/.test(trimmed)) return false;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    return indent > firstIndent;
  });
}

function extractReviewSection(body, headingPattern) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  let fence = null;
  let section = null;
  for (const line of lines) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      if (section) section.push(line);
      continue;
    }
    if (!fence && /^##[ \t]+/.test(line)) {
      if (section) break;
      if (headingPattern.test(line)) section = [];
      continue;
    }
    if (section) section.push(line);
  }
  return section === null ? null : section.join('\n');
}

function parseReviewFindingsSection(reviewBody, headingPattern) {
  if (typeof reviewBody !== 'string' || !reviewBody.trim()) return null;
  const rawSection = extractReviewSection(reviewBody, headingPattern);
  if (rawSection === null) return null;
  const section = rawSection.trim();
  if (!section) return [];
  // The review contract mandates `- None.` as the explicit empty
  // sentinel. Recognize it (with or without same-line prose and with
  // indented wrapped continuation lines; tolerate case variation)
  // before the count step so an empty section is not miscounted as a
  // finding, but fail closed when extra prose is flush-left or looks
  // like finding-card content.
  const lines = section.split(/\n/);
  if (isNoneFindingsSentinelOnly(lines)) return [];

  const matchBoldLabel = (raw) => {
    // Allows an optional `-[ \t]+` bullet prefix so nested-bullet card
    // sub-bullets like `  - **File:** path` match as well as flat
    // `**File:** path` paragraphs. The value may be empty here; see
    // `parseBoldLabel` for where an empty value gets its text.
    const match = raw.match(
      /^[ \t]*(?:-[ \t]+)?\*\*(Category|File|Lines|Problem|Why it matters|Recommended fix)(?::\*\*|\*\*[ \t]*:)[ \t]*(.*?)[ \t]*$/i
    );
    if (!match) return null;
    const key = match[1].toLocaleLowerCase('en-US');
    const fields = {
      category: 'category',
      file: 'file',
      lines: 'lines',
      problem: 'problem',
      'why it matters': 'whyItMatters',
      'recommended fix': 'recommendedFix',
    };
    return { field: fields[key], value: match[2].trim() };
  };

  const indentWidth = (raw) => (raw.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length;

  // PARSEBOLD-01 (agent-os#7334): a label with nothing after it on its own
  // line (`  - **Problem:**`) takes the lines nested more deeply under it,
  // joined, as its value. It stops at the first line indented no deeper than
  // the label, at another field label, and at a finding boundary. A label
  // with no nested text stays empty, so the card still fails
  // `cardHasRequiredFields`. Returns `end`, the last line the value used.
  const parseBoldLabel = (startIndex) => {
    const label = matchBoldLabel(lines[startIndex]);
    if (!label) return null;
    const labelIndent = indentWidth(lines[startIndex]);
    const parts = label.value ? [label.value] : [];
    let end = startIndex;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const raw = lines[index];
      if (!raw.trim()) {
        if (label.value) parts.push('');
        continue;
      }
      if (indentWidth(raw) <= labelIndent || matchBoldLabel(raw) || isFindingBoundary(raw)) break;
      parts.push(label.value ? raw.trim() : raw.trim().replace(/^(?:[-*+]|\d+[.)])[ \t]+/, ''));
      end = index;
    }
    const value = parts.join(label.value ? '\n' : ' ').trim();
    return value ? { field: label.field, value, end } : null;
  };

  const parseBulletBoldTitle = (raw) => {
    const match = raw.match(/^-[ \t]+\*\*(.+?)\*\*(.*)$/);
    if (!match) return null;
    const title = match[1].trim();
    const normalized = title
      .toLocaleLowerCase('en-US')
      .replace(/[ \t]*:[ \t]*$/u, '');
    if (['category', 'file', 'lines', 'problem', 'why it matters', 'recommended fix'].includes(normalized)) {
      return null;
    }
    return title;
  };

  const isFindingBoundary = (raw) => {
    return /^[ \t]*###[ \t]+.+?[ \t]*$/.test(raw)
      || Boolean(parseBulletBoldTitle(raw));
  };

  const cardHasRequiredFields = (startIndex) => {
    const seen = new Set();
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const raw = lines[index];
      if (isFindingBoundary(raw)) break;
      const parsed = parseBoldLabel(index);
      if (parsed) seen.add(parsed.field);
    }
    return seen.has('file') && seen.has('problem');
  };

  const findings = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    // Card shape: `### <Title>` heading starts a new finding only when
    // the following block is a real card body. This keeps an incidental
    // H3 like `### Reproduction` inside one card from inflating the
    // expected blocking-issue count.
    const h3Match = raw.match(/^[ \t]*###[ \t]+(.+?)[ \t]*$/);
    if (h3Match && cardHasRequiredFields(index)) {
      if (current) findings.push(current);
      current = { title: h3Match[1].trim() };
      continue;
    }
    // Nested-bullet card shape: `- **<Title>**` boundary, with
    // `  - **File:** value` etc. as nested sub-bullets. Same
    // lookahead guard as the H3 shape so an incidental `- **note**`
    // inside one card doesn't inflate the expected blocking-issue
    // count.
    const bulletBoldTitle = parseBulletBoldTitle(raw);
    if (bulletBoldTitle && (cardHasRequiredFields(index) || !current || !current.problem)) {
      if (current) findings.push(current);
      current = { title: bulletBoldTitle };
      continue;
    }
    // Card shape: bold-labeled inline fields. Each label only fills
    // the field once; later bold mentions of the same label fall
    // through, mirroring the legacy first-wins behavior for File /
    // Lines / Problem continuation lines. The bold marker may render
    // as `**File:**` (canonical, colon inside the bold span) or
    // `**File**:` (colon outside); both are accepted. Nested lines a label
    // took as its value are skipped, so they cannot match a legacy shape.
    const boldLabel = parseBoldLabel(index);
    if (boldLabel && current && current[boldLabel.field] === undefined) {
      current[boldLabel.field] = boldLabel.value;
      index = boldLabel.end;
      continue;
    }
    // Legacy bullet shapes (kept for back-compat with stored review bodies).
    const titleMatch = raw.match(/^[ \t]*-[ \t]+Title[ \t]*:[ \t]*(.*)$/i);
    if (titleMatch) {
      if (current) findings.push(current);
      current = { title: titleMatch[1].trim() };
      continue;
    }
    const fileMatch = raw.match(/^[ \t]*(-[ \t]+)?File[ \t]*:[ \t]*(.*)$/i);
    if (fileMatch) {
      const isDashPrefixed = Boolean(fileMatch[1]);
      if (!isDashPrefixed && current && current.file !== undefined) {
        continue;
      }
      if (!isDashPrefixed && !current) {
        continue;
      }
      if (isDashPrefixed && current && current.file !== undefined) {
        findings.push(current);
        current = {};
      } else if (!current) {
        current = {};
      }
      current.file = fileMatch[2].trim();
      continue;
    }
    if (!current) continue;
    const linesField = raw.match(/^[ \t]*(?:-[ \t]+)?Lines[ \t]*:[ \t]*(.*)$/i);
    if (linesField && current.lines === undefined) {
      current.lines = linesField[1].trim();
      continue;
    }
    const problemField = raw.match(/^[ \t]*(?:-[ \t]+)?Problem[ \t]*:[ \t]*(.*)$/i);
    if (problemField && current.problem === undefined) {
      current.problem = problemField[1].trim();
    }
  }
  if (current) findings.push(current);
  if (findings.length > 0) return findings;

  const compactBoldFindings = lines
    .map((line) => parseBulletBoldTitle(line))
    .filter(Boolean);
  if (compactBoldFindings.length > 0) {
    return compactBoldFindings.map((title) => ({ title }));
  }

  const fallbackLines = lines
    .map((line) => line.trim())
    .filter(Boolean);
  if (fallbackLines.length === 0) return findings;
  const fallbackTitle = (
    fallbackLines.find((line) => !/^-\s+None(?:\.(?:\s+.*)?|\s*)$/i.test(line))
    ?? fallbackLines[0]
  )
    .replace(/^-\s+/, '')
    .trim()
    .replace(/^\*\*(.+?)\*\*[ \t]*:?.*$/, '$1')
    .trim();
  return fallbackTitle ? [{ title: fallbackTitle }] : findings;
}

function parseBlockingFindingsSection(reviewBody) {
  return parseReviewFindingsSection(reviewBody, /^##[ \t]+Blocking[ \t]+Issues?[ \t]*$/i);
}

function parseNonBlockingFindingsSection(reviewBody) {
  return parseReviewFindingsSection(reviewBody, /^##[ \t]+Non[- \t]+blocking[ \t]+Issues?[ \t]*$/i);

}

// One count/identity contract for attestations and merge eligibility. Missing
// sections remain unknown; unrecognized content is conservatively a finding.
function parseReviewFindings(body) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n');
  const classify = (findings) => ({
    count: findings?.length ?? 0,
    state: findings === null ? 'unknown' : 'known',
    findings: findings ?? [],
  });
  const blocking = classify(parseBlockingFindingsSection(normalized));
  const nonBlocking = classify(parseNonBlockingFindingsSection(normalized));
  return {
    blocking,
    nonBlocking,
    findingsCount: blocking.state === 'known' && nonBlocking.state === 'known'
      ? blocking.count + nonBlocking.count : null,
  };
}

export { isNoneFindingsSentinelOnly, parseBlockingFindingsSection, parseNonBlockingFindingsSection, parseReviewFindings };
