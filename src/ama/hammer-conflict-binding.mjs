// HAMCONFLICTCUSTODY-01: the conflict repair's publication binding.
//
// bin/hammer-conflict-repair.sh rebases on a detached HEAD, so the PR branch is
// never checked out (a builder worktree sharing the git directory may hold it).
// On success it writes `<run-dir>/conflict-repair-publish.env`:
//
//   source=<40-hex PR head the rebase replayed>
//   head=<40-hex rebased head>
//   branch=<PR head branch>
//
// bin/hammer-api-publish.mjs uses the binding only while the local HEAD is
// still that rebased head. The git fallback then pushes
// HEAD:refs/heads/<branch> with `source` as the exact-head lease, so a branch
// that moved after the repair captured its source refuses the push.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFLICT_PUBLISH_FILE = 'conflict-repair-publish.env';
const SHA = /^[0-9a-f]{40}$/;

// Fail closed: a present but malformed binding throws rather than reading as
// "no binding", which would fall back to the live head as the lease.
export function parseConflictPublishBinding(text) {
  const fields = new Map();
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const at = line.indexOf('=');
    const key = at > 0 ? line.slice(0, at) : '';
    if (!['source', 'head', 'branch'].includes(key) || fields.has(key)) {
      throw new Error('conflict-repair publication binding is malformed');
    }
    fields.set(key, line.slice(at + 1));
  }
  const binding = { source: fields.get('source'), head: fields.get('head'), branch: fields.get('branch') };
  if (!SHA.test(binding.source || '') || !SHA.test(binding.head || '') || !binding.branch
    || binding.branch.startsWith('-') || /[\s\0]/.test(binding.branch)) {
    throw new Error('conflict-repair publication binding is malformed');
  }
  return binding;
}

// The binding for this exact local head, or null when there is none.
export function conflictPublishBinding(runDir, localHead, { exists = existsSync, read = readFileSync } = {}) {
  if (!runDir) return null;
  const path = join(runDir, CONFLICT_PUBLISH_FILE);
  if (!exists(path)) return null;
  const binding = parseConflictPublishBinding(read(path, 'utf8'));
  return binding.head === String(localHead()).trim() ? binding : null;
}
