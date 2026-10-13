// One outbound text transform. No IO: callers can supply synthetic roots/context.
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decode = (text) => text.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
  try { return decodeURIComponent(part); } catch { return part.replace(/%2f/gi, '/').replace(/%5c/gi, '/'); }
});
const normalize = (text) => decode(text).replace(/\\/g, '/');
function localUrlPath(value) {
  let path = normalize(value);
  if (/^file:\/\//i.test(path)) {
    path = path.replace(/^file:\/\//i, '');
    if (!path.startsWith('/') && !/^[a-z]:\//i.test(path)) path = path.slice(path.indexOf('/') >= 0 ? path.indexOf('/') : path.length);
  }
  return path.replace(/^\/([a-z]:\/)/i, '$1');
}

function rootPattern(root) {
  return [...normalize(root).replace(/\/+$/, '')].map((char) => {
    if (char === '/') return '(?:/|\\\\|%2f|%5c)';
    const encoded = [...new TextEncoder().encode(char)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
    return `(?:${escape(char)}|${encoded})`;
  }).join('');
}

/** Rewrite only runtime roots and file URLs; preserve all other prose verbatim. */
export function filterGitHubBody(input, options = {}) {
  let text = '';
  let roots = [serviceRoot, homedir(), tmpdir(), resolve(serviceRoot, 'data')];
  // Gather usable caller roots independently so a bad option cannot disable fallback.
  for (const key of ['snapshotRoot', 'stateDir', 'rootDir', 'tempDir', 'homeDir']) {
    try { if (typeof options?.[key] === 'string') roots.push(options[key]); } catch { /* odd option */ }
  }
  try {
    const env = options?.env || process.env;
    for (const key of ['ADVERSARIAL_REVIEW_STATE_DIR', 'ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR']) {
      if (typeof env[key] === 'string' && env[key]) roots.push(env[key]);
    }
  } catch { /* preserve collected fallback roots */ }
  try {
    text = typeof input === 'string' ? input : String(input ?? '');
    const rootDir = options.rootDir || serviceRoot;
    const env = options.env || process.env;
    const stateDir = options.stateDir || env.ADVERSARIAL_REVIEW_STATE_DIR || resolve(rootDir, 'data');
    const workspaceDir = env.ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR;
    const snapshotRoot = options.snapshotRoot || resolve(workspaceDir || stateDir, 'reviewer-snapshots');
    const fallbackSnapshotRoot = env.HQ_ROOT
      ? resolve(env.HQ_ROOT, 'adversarial-review', 'reviewer-workspace', 'reviewer-snapshots')
      : resolve(options.homeDir || homedir(), '.agent-os', 'adversarial-review', 'reviewer-workspace', 'reviewer-snapshots');
    roots = [snapshotRoot, fallbackSnapshotRoot, stateDir, rootDir, options.tempDir || tmpdir(), options.homeDir || homedir()];
    roots = roots.filter((root) => typeof root === 'string' && root.replace(/[\\/]/g, '')).sort((a, b) => b.length - a.length);
    const snapshotPath = (value) => {
      const comparable = localUrlPath(value);
      const root = roots.find((candidate) => comparable.toLowerCase().startsWith(`${normalize(candidate).replace(/\/+$/, '').toLowerCase()}/`));
      if (!root) return null;
      const marker = comparable.toLowerCase().indexOf('/reviewer-snapshots/');
      if (marker < 0) return null;
      const parts = comparable.slice(marker + '/reviewer-snapshots/'.length).split('/');
      return parts.length > 2 ? parts.slice(2).join('/') : null;
    };
    const rewriteUrl = (url) => {
      const path = snapshotPath(url);
      if (path && options.repo && options.reviewerHeadSha) {
        const anchor = path.match(/#L\d+(?:-L\d+)?$/)?.[0] || '';
        const name = anchor ? path.slice(0, -anchor.length) : path;
        return `https://github.com/${options.repo}/blob/${options.reviewerHeadSha}/${name.split('/').map(encodeURIComponent).join('/')}${anchor}`;
      }
      if (path) return path;
      let value = localUrlPath(url);
      for (const root of roots) value = value.replace(new RegExp(`${rootPattern(root)}(?:/|\\\\|%2f|%5c)?`, 'gi'), '<local>/');
      if (value.includes('<local>/')) return value;
      return normalize(value).split('/').filter(Boolean).at(-1) || '<local>';
    };
    text = text.replace(/\[([^\]\n]*)\]\((<?)([^)\n]+?)(>?)\)/g, (link, label, _open, target) => {
      if (snapshotPath(target)) return `[${label}](${rewriteUrl(target)})`;
      if (/^file:\/\//i.test(target) && !roots.some((root) => new RegExp(rootPattern(root), 'i').test(target))) return rewriteUrl(target);
      return link;
    });
    text = text.replace(/file:\/\/[^\s<>\)\]"'`]*/gi, rewriteUrl);
    for (const root of roots) {
      text = text.replace(new RegExp(`${rootPattern(root)}(?:[^\\s<>\\)\\]"'\x60]*)`, 'gi'), (value) => {
        const path = snapshotPath(value);
        if (path) return path;
        return `<local>/${normalize(value).slice(normalize(root).replace(/\/+$/, '').length).replace(/^\/+/, '')}`;
      });
    }
    return text;
  } catch {
    // Best effort, fail open for delivery, fail safe for local references.
    text = text.replace(/file:\/\/[^\s<>\)\]"'`]*/gi, '<local>');
    for (const root of roots) {
      try { text = text.replace(new RegExp(rootPattern(root), 'gi'), '<local>'); } catch { /* malformed root */ }
    }
    return text;
  }
}
