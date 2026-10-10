// REVIEWCHUNK-01: chunk prompts that keep the reviewer on the PR head.
//
// A chunked review of agent-os PR 7981 quoted two lines that existed only on
// the removed side of the diff and blocked on them. Line-split chunks start
// mid-hunk under a re-emitted hunk header, so a reviewer reading one chunk sees
// `-` lines without the head version of the function around them. This module
// supplies the three prompt-side fixes the oversized-chunk path applies:
//   - removed hunk lines carry an explicit `-[REMOVED] ` marker;
//   - a legend says `-[REMOVED]` lines are not at the head and findings must be
//     about code present at the head;
//   - when a chunk splits a hunk, the head post-image of that hunk (context and
//     added lines with head line numbers) is appended to the chunk's context,
//     trimmed to the chunk's byte budget.

const REMOVED_LINE_MARKER = '[REMOVED] ';
const POST_IMAGE_MAX_LINE_BYTES = 2048;

const CHUNK_HEAD_LEGEND = [
  '',
  '',
  'Diff legend for this chunk: lines prefixed `-[REMOVED] ` (and any other `-` line inside a hunk) exist only at the',
  'PR base and are NOT present at the PR head. Lines prefixed `+` and unprefixed context lines are the head.',
  'Every finding, and every Blocking finding without exception, must be about code present at the PR head. Never',
  'quote or block on code that appears only on removed lines; a fix the head already contains is not a finding.',
].join('\n');

// Mark removed hunk lines. Lines longer than `maxLineBytes` are left untouched
// so long-line elision hashes the exact diff bytes (the legend still covers a
// plain `-` line). The marker changes no line count, so diff-line offsets hold.
function annotateRemovedDiffLines(diff, { maxLineBytes = Infinity } = {}) {
  const lines = String(diff || '').split('\n');
  let inHunk = false;
  return lines.map((line, index) => {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      return line;
    }
    if (line.startsWith('--- ') && String(lines[index + 1] || '').startsWith('+++ ')) {
      inHunk = false;
      return line;
    }
    if (/^@@\s/.test(line)) {
      inHunk = true;
      return line;
    }
    if (!inHunk || !line.startsWith('-') || line.startsWith(`-${REMOVED_LINE_MARKER}`)) return line;
    if (Buffer.byteLength(line) + REMOVED_LINE_MARKER.length > maxLineBytes) return line;
    return `-${REMOVED_LINE_MARKER}${line.slice(1)}`;
  }).join('\n');
}

function patchPath(headerLines) {
  for (const line of headerLines) {
    const match = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (match && match[1] !== '/dev/null') return match[1];
  }
  for (const line of headerLines) {
    const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (match) return match[1];
  }
  return '<unknown>';
}

// The hunks of `bodyLines` that the chunk covering [start, end) splits, with
// each hunk's head-side lines before and after the chunk's portion.
function splitHunkPostImages({ headerLines = [], bodyLines = [], start = 0, end = 0 } = {}) {
  const path = patchPath(headerLines);
  const hunks = [];
  let current = null;
  bodyLines.forEach((line, index) => {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        headerIndex: index, endIndex: index + 1, newLine: Number(header[1]),
        newEndLine: Number(header[1]) + Number(header[2] ?? 1), lines: [],
      };
      hunks.push(current);
      return;
    }
    if (!current) return;
    current.endIndex = index + 1;
    // Git may suppress the space prefix on empty context lines. The declared
    // head range distinguishes those from a trailing split('\n') terminator.
    if (line.startsWith('+') || line.startsWith(' ') || (line === '' && current.newLine < current.newEndLine)) {
      current.lines.push({ index, lineNo: current.newLine, text: line.length > 0 ? line.slice(1) : line });
      current.newLine += 1;
    }
  });
  return hunks
    .filter((hunk) => hunk.headerIndex < end && hunk.endIndex > start
      && (hunk.headerIndex < start || hunk.endIndex > end))
    .map((hunk) => ({
      path,
      before: hunk.lines.filter((entry) => entry.index < start),
      after: hunk.lines.filter((entry) => entry.index >= end),
    }))
    .filter((hunk) => hunk.before.length > 0 || hunk.after.length > 0);
}

function formatPostImageLine({ lineNo, text }) {
  const value = Buffer.byteLength(text) > POST_IMAGE_MAX_LINE_BYTES ? '[long line omitted]' : text;
  return `${lineNo}| ${value}`;
}

function renderPostImages(selections) {
  const blocks = selections
    .filter((selection) => selection.before.length > 0 || selection.after.length > 0)
    .map((selection) => {
      const parts = [`Head post-image of the hunk this chunk splits in ${selection.path} (head line numbers; context only, not part of the diff):`];
      if (selection.before.length > 0) {
        parts.push('Head lines just before this chunk:', ...selection.before.map(formatPostImageLine));
      }
      if (selection.after.length > 0) {
        parts.push('Head lines just after this chunk:', ...selection.after.map(formatPostImageLine));
      }
      return parts.join('\n');
    });
  return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : '';
}

// Largest post-image context that `fits`, taking head lines nearest the chunk's
// boundary first. Returns '' when not even one line fits.
function buildPostImageContext(postImages, { fits = () => true } = {}) {
  if (!Array.isArray(postImages) || postImages.length === 0) return '';
  const order = [];
  postImages.forEach((image, imageIndex) => {
    const before = [...image.before].reverse();
    const longest = Math.max(before.length, image.after.length);
    for (let distance = 0; distance < longest; distance += 1) {
      if (distance < before.length) order.push({ imageIndex, side: 'before', entry: before[distance] });
      if (distance < image.after.length) order.push({ imageIndex, side: 'after', entry: image.after[distance] });
    }
  });
  const render = (count) => {
    const selections = postImages.map((image) => ({ path: image.path, before: [], after: [] }));
    for (const item of order.slice(0, count)) selections[item.imageIndex][item.side].push(item.entry);
    for (const selection of selections) selection.before.sort((left, right) => left.lineNo - right.lineNo);
    return renderPostImages(selections);
  };
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(render(mid))) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? render(low) : '';
}

export {
  CHUNK_HEAD_LEGEND,
  REMOVED_LINE_MARKER,
  annotateRemovedDiffLines,
  buildPostImageContext,
  splitHunkPostImages,
};
