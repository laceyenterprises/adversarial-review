import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const slug = '[a-z0-9_-][a-z0-9._-]*';
const repoPattern = new RegExp(`^${slug}/${slug}$`, 'i');
const originPattern = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i;
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
export async function resolveRepoCheckoutDir({ repo, rootDir, env = process.env, execFileImpl = execFileAsync }) {
  const target = String(repo || '').trim().toLowerCase();
  if (!repoPattern.test(target)) return null;
  const cloneRoot = env.ADVERSARIAL_REVIEWER_CLONE_ROOT;
  const candidates = [rootDir, join(rootDir, '..', '..')];
  if (cloneRoot && isAbsolute(cloneRoot)) candidates.push(join(cloneRoot, target));
  for (const candidate of candidates) {
    try {
      const cwd = realpathSync(candidate);
      const git = async (...args) => (await execFileImpl('git', args, {
        cwd, env: reviewerGitEnv(env), timeout: 5_000,
      })).stdout.trim();
      if (realpathSync(await git('rev-parse', '--show-toplevel')) !== cwd) continue;
      const origin = originPattern.exec(await git('remote', 'get-url', 'origin'));
      if (origin?.[1].replace(/\.git$/i, '').toLowerCase() === target) return cwd;
    } catch { /* Missing or unverified checkout. */ }
  }
  return null;
}

export async function materializeReviewerHead(checkoutDir, headSha, execFileImpl = execFileAsync) {
  if (!checkoutDir || !/^[a-f0-9]{40}$/i.test(headSha || '')) return false;
  const git = (...args) => execFileImpl('git', ['--no-replace-objects', ...args], {
    cwd: checkoutDir, env: reviewerGitEnv(), timeout: 30_000,
  });
  const hasCommit = async () => {
    try {
      const { stdout } = await git('rev-parse', '--verify', '--quiet', `${headSha}^{commit}`);
      return stdout.trim() === headSha.toLowerCase();
    } catch { return false; }
  };
  if (await hasCommit()) return true;
  try {
    await git('fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--refmap=', 'origin', headSha);
  } catch { return false; }
  return hasCommit();
}
