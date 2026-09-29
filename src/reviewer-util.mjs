// Shared reviewer utilities used by BOTH the model-execution harness
// (`reviewer-harness.mjs`) and `reviewer.mjs` (posting/orchestration/spec-touch).
//
// ARC-10: these small helpers were previously top-level in the reviewer
// monolith and are referenced from both the exec-retry paths (harness) and the
// GitHub-post-retry / diff-scope paths (reviewer). Extracting them here lets
// neither module import the other — which would form an ESM cycle.

const REVIEW_POST_RETRY_DELAYS_MS = [0];
const WAKE_HOOK_RETRY_DELAYS_MS = [250, 1_000];

const REVIEW_FAMILY_BY_BUILDER_CLASS = Object.freeze({
  codex: 'codex',
  'claude-code': 'claude',
  'clio-agent': 'codex',
  gemini: 'gemini',
  pi: 'pi',
  opencode: 'opencode',
  hermes: 'hermes',
});

function normalizeBuilderTag(builderTag) {
  const normalized = String(builderTag || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return Object.prototype.hasOwnProperty.call(REVIEW_FAMILY_BY_BUILDER_CLASS, normalized)
    ? normalized
    : null;
}

const GIT_QUOTE_ESCAPES = Object.freeze({
  a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c,
});

// Git C-quotes a path holding a quote, backslash, control or (by default)
// non-ASCII byte: `"a/caf\303\251.md"`. Returns the decoded path and the index
// just past the closing quote, or null when the quoting is malformed.
function readQuotedGitPath(text, start) {
  if (text[start] !== '"') return null;
  const bytes = [];
  const encoder = new TextEncoder();
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: i + 1 };
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = text[i + 1];
    if (next in GIT_QUOTE_ESCAPES) {
      bytes.push(GIT_QUOTE_ESCAPES[next]);
      i += 1;
    } else if (/^[0-3][0-7]{2}$/.test(text.slice(i + 1, i + 4))) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      return null;
    }
  }
  return null;
}

// The two paths of a `diff --git <a> <b>` header, either side optionally
// quoted. Returns null for a header this parser cannot read unambiguously.
function parseDiffHeaderPaths(rest) {
  let rawOld;
  let rawNew;
  if (rest.startsWith('"')) {
    const first = readQuotedGitPath(rest, 0);
    if (!first || rest[first.end] !== ' ') return null;
    const tail = rest.slice(first.end + 1);
    const second = tail.startsWith('"') ? readQuotedGitPath(tail, 0) : { value: tail, end: tail.length };
    if (!second || second.end !== tail.length) return null;
    rawOld = first.value;
    rawNew = second.value;
  } else if (rest.includes('"')) {
    // An unquoted path never contains `"`, so the quote opens the second path.
    const split = rest.indexOf(' "');
    if (split === -1) return null;
    const second = readQuotedGitPath(rest, split + 1);
    if (!second || second.end !== rest.length) return null;
    rawOld = rest.slice(0, split);
    rawNew = second.value;
  } else {
    // Same path on both sides (the common case): split in the middle, which is
    // unambiguous even when the path itself contains " b/".
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) {
      rawOld = rest.slice(0, half);
      rawNew = rest.slice(half + 1);
    } else {
      const match = rest.match(/^(a\/.+?) (b\/.+)$/);
      if (!match) return null;
      [, rawOld, rawNew] = match;
    }
  }
  if (!rawOld.startsWith('a/') || !rawNew.startsWith('b/')) return null;
  return { oldPath: rawOld.slice(2), newPath: rawNew.slice(2) };
}

/**
 * Every `diff --git` entry of a unified diff, including entries whose header
 * could not be parsed (`parsed: false`, null paths). Each entry's patch runs to
 * the next header of any kind, so an unreadable entry never bleeds into its
 * neighbour. Callers that gate on the file list must refuse on `parsed: false`.
 */
function parseDiffEntries(diffText) {
  const diff = String(diffText ?? '').replace(/\r\n/g, '\n');
  const matches = [...diff.matchAll(/^diff --git (.*)$/gm)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? diff.length) : diff.length;
    const paths = parseDiffHeaderPaths(match[1]);
    return {
      parsed: Boolean(paths),
      oldPath: paths?.oldPath ?? null,
      newPath: paths?.newPath ?? null,
      path: paths ? (paths.newPath === '/dev/null' ? paths.oldPath : paths.newPath) : null,
      patch: diff.slice(start, end),
    };
  });
}

// The parsed files of a diff. An unreadable entry's patch stays attached to the
// preceding file, as before quoted headers were recognised, so content
// consumers (AGY chunking) still carry every byte after the first header.
function parseDiffFiles(diffText) {
  const files = [];
  for (const { parsed, oldPath, newPath, path, patch } of parseDiffEntries(diffText)) {
    if (parsed) files.push({ oldPath, newPath, path, patch });
    else if (files.length > 0) files[files.length - 1].patch += patch;
  }
  return files;
}

function buildGhErrorDetail(err) {
  return [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n').toLowerCase();
}

export {
  REVIEW_POST_RETRY_DELAYS_MS,
  WAKE_HOOK_RETRY_DELAYS_MS,
  REVIEW_FAMILY_BY_BUILDER_CLASS,
  normalizeBuilderTag,
  parseDiffEntries,
  parseDiffFiles,
  buildGhErrorDetail,
};
