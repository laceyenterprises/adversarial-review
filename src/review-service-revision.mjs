import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function canonicalPath(path) {
  try { return realpathSync(path); }
  catch { return resolve(path); }
}

// Resolve the service checkout, never the subject PR or the Agent OS host root.
// Capture once when this process loads: a checkout update alone does not change
// the code already executing in a long-lived watcher.
export function readReviewServiceRevision({
  serviceRoot = fileURLToPath(new URL('../', import.meta.url)),
  execFileSyncImpl = execFileSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  try {
    const env = { ...process.env };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    const [top, sha] = execFileSyncImpl('git', ['--no-optional-locks', '-C', serviceRoot,
      'rev-parse', '--show-toplevel', '--verify', 'HEAD^{commit}'], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/);
    if (canonicalPath(top) === canonicalPath(serviceRoot) && /^[a-f0-9]{40}$/i.test(sha)) return `git:${sha.toLowerCase()}`;
  } catch { /* Packaged deployments need not include Git metadata. */ }
  try {
    const pkg = JSON.parse(readFileSyncImpl(join(serviceRoot, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version.trim()) return `package:${pkg.version.trim()}`;
  } catch { /* Missing provenance cannot prove a deployment change. */ }
  return null;
}

export const REVIEW_SERVICE_REVISION = readReviewServiceRevision();
