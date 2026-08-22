/**
 * Findings extraction from a reviewer pass body.
 *
 * `reviews.db` has **no findings table** — a review pass stores its posted
 * markdown in `reviewer_passes.body_md`, and the findings live inside it as
 * `## Blocking issues` / `## Non-blocking issues` sections. So a findings
 * projection is necessarily a parse of that body.
 *
 * The grammar mirrors what the pipeline's own classifier emits and reads
 * (`src/merge-agent-rescue-classifier.mjs`), which is a
 * **reference model only** — this is an independent implementation, because
 * `frontend` imports nothing outside itself (SPEC §9). If the pipeline's review
 * template changes, this parser degrades to zero findings for the changed
 * section rather than throwing.
 *
 *   ## Blocking issues
 *   - **Title of the finding**
 *     - **Category:** correctness
 *     - **File:** src/thing.mjs
 *     - **Lines:** 10-20
 *     - **Problem:** ...
 *     - **Why it matters:** ...
 *     - **Recommended fix:** ...
 *
 * A section whose only bullet is `- None.` is an explicit zero, distinct from a
 * section that is missing entirely (an off-template body).
 */

const NESTED_FIELDS = [
  ['category', 'Category'],
  ['file', 'File'],
  ['lines', 'Lines'],
  ['problem', 'Problem'],
  ['whyItMatters', 'Why it matters'],
  ['recommendedFix', 'Recommended fix'],
];
const NESTED_LABEL_ALTERNATION = NESTED_FIELDS.map(([, label]) => label).join('|');

export const BLOCKING_HEADING = 'Blocking issues';
export const NON_BLOCKING_HEADING = 'Non-blocking issues';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Slice out the body of a `## <heading>` section, stopping at the next `##`.
 * Fenced code blocks are skipped so a `## Blocking issues` line quoted inside a
 * diff can neither open nor close a section.
 */
export function extractSection(body, heading) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'i');
  const lines = text.split('\n');

  let inFence = false;
  let offset = 0;
  let start = null;
  for (const line of lines) {
    if (/^(?:```|~~~)/.test(line.trimStart())) inFence = !inFence;
    if (!inFence && headingPattern.test(line)) {
      start = offset + line.length;
      break;
    }
    offset += line.length + 1;
  }
  if (start === null) return null;

  inFence = false;
  offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    if (lineStart > start && !inFence && /^##\s+/.test(line)) return text.slice(start, lineStart);
    if (/^(?:```|~~~)/.test(line.trimStart())) inFence = !inFence;
    offset += line.length + 1;
  }
  return text.slice(start);
}

function topLevelBulletIndexes(lines) {
  const indexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-\s+/.test(lines[i])) indexes.push(i);
  }
  return indexes;
}

/** `- None.` (with optional indented commentary under it) means an explicit zero. */
function sectionIsNone(lines) {
  const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim());
  if (nonEmpty.length === 0) return true;
  if (!/^-\s+none\.?(?:\s+.*)?$/i.test(nonEmpty[0].trim())) return false;
  return nonEmpty.slice(1).every((line) => /^\s+/.test(line));
}

function parseNestedField(blockLines, label) {
  const pattern = new RegExp(`^\\s+-\\s+\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(.*)$`, 'i');
  const anyFieldPattern = new RegExp(`^\\s+-\\s+\\*\\*(?:${NESTED_LABEL_ALTERNATION}):\\*\\*`, 'i');
  for (let index = 0; index < blockLines.length; index += 1) {
    const match = blockLines[index].match(pattern);
    if (!match) continue;
    // A field value may wrap onto following indented lines; it ends at the next
    // top-level bullet, the next nested field, or an unindented line.
    const parts = [match[1].trim()];
    for (let next = index + 1; next < blockLines.length; next += 1) {
      const nextLine = blockLines[next];
      if (/^-\s+/.test(nextLine) || anyFieldPattern.test(nextLine)) break;
      if (!nextLine.trim()) {
        parts.push('');
        continue;
      }
      if (!/^\s+/.test(nextLine)) break;
      parts.push(nextLine.trim());
    }
    return optionalString(parts.join('\n'));
  }
  return null;
}

function parseFindingBlock(blockLines, kind) {
  const titleMatch = (blockLines[0] || '').match(/^-\s+\*\*(.+?)\*\*(.*)$/);
  const finding = {
    kind,
    title: titleMatch ? optionalString(titleMatch[1].replace(/[ \t]*:[ \t]*$/u, '')) : null,
  };
  for (const [key, label] of NESTED_FIELDS) {
    const value = parseNestedField(blockLines, label);
    finding[key] = key === 'category' && value ? value.toLowerCase() : value;
  }
  return finding;
}

/**
 * Parse one issue section.
 * @returns {{missing: boolean, count: number, findings: object[]}}
 */
export function parseIssueSection(body, heading, kind) {
  const section = extractSection(body, heading);
  if (section === null) return { missing: true, count: 0, findings: [] };

  const lines = section.replace(/\r\n/g, '\n').split('\n');
  if (sectionIsNone(lines)) return { missing: false, count: 0, findings: [] };

  const indexes = topLevelBulletIndexes(lines);
  // Prose where bullets were expected: honestly one unstructured finding, not
  // zero. A blank section cannot reach here — `sectionIsNone` already returned
  // above for one, since it treats "no non-empty lines" as an explicit zero.
  if (indexes.length === 0) {
    return { missing: false, count: 1, findings: [parseFindingBlock([], kind)] };
  }

  const findings = indexes.map((start, i) => {
    const end = i + 1 < indexes.length ? indexes[i + 1] : lines.length;
    return parseFindingBlock(lines.slice(start, end), kind);
  });
  return { missing: false, count: findings.length, findings };
}

/**
 * All findings in a review body, blocking first.
 *
 * @param {string|null} body the pass's `body_md`
 * @returns {{
 *   findings: object[], blockingCount: number, nonBlockingCount: number,
 *   blockingSectionMissing: boolean, nonBlockingSectionMissing: boolean
 * }}
 */
export function parseFindings(body) {
  const blocking = parseIssueSection(body, BLOCKING_HEADING, 'blocking');
  const nonBlocking = parseIssueSection(body, NON_BLOCKING_HEADING, 'non-blocking');
  return {
    findings: [...blocking.findings, ...nonBlocking.findings],
    blockingCount: blocking.count,
    nonBlockingCount: nonBlocking.count,
    // A missing section is NOT zero findings — the caller must be able to tell
    // "the reviewer said none" from "this body is off-template".
    blockingSectionMissing: blocking.missing,
    nonBlockingSectionMissing: nonBlocking.missing,
  };
}
