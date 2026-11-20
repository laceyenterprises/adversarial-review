import { withTransientGitRetries } from './reviewer-git-retries.mjs';
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const slug = '[a-z0-9_-][a-z0-9._-]*';
const repoPattern = new RegExp(`^${slug}/${slug}$`, 'i');
const originPattern = /^(?:https:\/\/(?:[^/@\\\s?#]+@)?github\.com\/|ssh:\/\/(?:git@)?github\.com\/|git@github\.com:)([^/]+\/[^/]+)\/*$/i;
const gitRepoOverride = /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CONFIG(_COUNT|_PARAMETERS|_KEY_\d+|_VALUE_\d+)?)$/;

export function reviewerGitEnv(env = process.env) {
  const clean = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  for (const key of Object.keys(clean)) {
    if (gitRepoOverride.test(key)) delete clean[key];
  }
  return clean;
}

// The candidate's name locates it. Its worktree root and origin establish
// identity. This rule applies to every target regardless of visibility.
function githubOriginRepo(origin) {
  const path = originPattern.exec(origin)?.[1].replace(/\.git$/i, '');
  return path && repoPattern.test(path) ? path.toLowerCase() : null;
}

export async function resolveRepoCheckoutDir({
  repo, rootDir, env = process.env, execFileImpl = execFileAsync, onUnavailable,
}) {
  const slugPath = String(repo || '').trim();
  if (!repoPattern.test(slugPath)) return null;
  const target = slugPath.toLowerCase();
  const cloneRoot = env.ADVERSARIAL_REVIEWER_CLONE_ROOT;
  const deployCandidates = [rootDir, join(rootDir, '..', '..')];
  const cloneCandidates = [];
  if (cloneRoot && isAbsolute(cloneRoot)) {
    cloneCandidates.push(join(cloneRoot, slugPath));
    if (slugPath !== target) cloneCandidates.push(join(cloneRoot, target));
  }
  let cause = 'no-checkout';
  for (const candidate of [...deployCandidates, ...cloneCandidates]) {
    try {
      const cwd = realpathSync.native(candidate);
      const git = async (...args) => (await execFileImpl('git', args, {
        cwd, env: reviewerGitEnv(env), timeout: 5_000,
      })).stdout.trim();
      if (realpathSync.native(await git('rev-parse', '--show-toplevel')) !== cwd) continue;
      // Check both the configured origin and Git's effective fetch URL.
      // Neither URL is returned, logged, or used as a fetch argument.
      const configuredOrigin = await git('config', '--get-all', 'remote.origin.url').catch(() => '');
      const effectiveOrigin = await git('remote', 'get-url', 'origin').catch(() => '');
      const configured = githubOriginRepo(configuredOrigin);
      const effective = githubOriginRepo(effectiveOrigin);
      if (configured === target && effective === target) return cwd;
      // Service worktrees without an origin are expected in some installs.
      // A configured clone or a malformed nonempty origin is actionable.
      if (cloneCandidates.includes(candidate) || ((configuredOrigin || effectiveOrigin) && (!configured || !effective))) {
        cause = 'origin-unverified';
      }
    } catch { /* Missing or unverified checkout. */ }
  }
  onUnavailable?.(cause);
  return null;
}

export async function materializeReviewerHead(checkoutDir, headSha, execFileImpl = execFileAsync, env = process.env, log = console) {
  if (!checkoutDir || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(headSha || '')) return false;
  const git = (...args) => execFileImpl('git', ['--no-replace-objects', ...args], {
    cwd: checkoutDir, env: reviewerGitEnv(env), timeout: 30_000,
  });
  const hasCommit = async () => {
    try {
      const { stdout } = await git('rev-parse', '--verify', '--quiet', `${headSha}^{commit}`);
      return stdout.trim() === headSha.toLowerCase();
    } catch { return false; }
  };
  if (await hasCommit()) return true;
  try {
    await withTransientGitRetries(
      () => git('fetch', '--no-auto-maintenance', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', 'origin', headSha),
      'git fetch reviewer head',
    );
  } catch {
    log.warn('[reviewer] diff-only cause=head-fetch-failed (bounded retries exhausted or permanent failure)');
    return false;
  }
  return hasCommit();
}
