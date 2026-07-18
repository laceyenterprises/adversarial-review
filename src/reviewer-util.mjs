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

function parseDiffFiles(diffText) {
  const diff = String(diffText ?? '').replace(/\r\n/g, '\n');
  const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return matches.map((match, index) => {
    const oldPath = match[1];
    const newPath = match[2];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? diff.length) : diff.length;
    return {
      oldPath,
      newPath,
      path: newPath === '/dev/null' ? oldPath : newPath,
      patch: diff.slice(start, end),
    };
  });
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
  parseDiffFiles,
  buildGhErrorDetail,
};
