import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execGhWithRetry } from '../gh-cli.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';

const execFileAsync = promisify(execFile);
const COMMENT_MARKER = '<!-- ama:stacked-base-merged -->';

export async function inspectStackedBase({ repo, prNumber, execFileImpl = execFileAsync, signal }) {
  const get = async path => {
    const { stdout } = await execGhWithRetry({ execFileImpl,
      args: ['api', path], timeoutMs: 15_000, retries: 0, signal });
    return JSON.parse(stdout);
  };
  try {
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    const baseBranch = pr.base?.ref;
    const defaultBranch = pr.base?.repo?.default_branch;
    if (!baseBranch || !defaultBranch) throw new Error('base/default branch unavailable');
    if (baseBranch === defaultBranch) return { ok: true, baseBranch, defaultBranch };
    // Paginate explicitly: a branch may have several closed, unmerged PRs.
    const query = new URLSearchParams({ state: 'closed', head: `${repo.split('/')[0]}:${baseBranch}`, per_page: '100' });
    for (let page = 1; page <= 10; page++) {
      const pulls = await get(`repos/${repo}/pulls?${query}&page=${page}`);
      if (!Array.isArray(pulls)) throw new Error('merged-base history unavailable');
      if (pulls.some(parent => parent.merged_at && parent.head?.ref === baseBranch
        && parent.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase())) {
        return { ok: false, reason: 'stacked-base-merged', baseBranch, defaultBranch };
      }
      if (pulls.length < 100) return { ok: true, baseBranch, defaultBranch };
    }
    throw new Error('merged-base history exceeded bounded read budget');
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: 'stacked-base-read-failed' };
  }
}

// Repository + PR scope survives head changes and daemon restarts. The lock
// serializes remediation and closure so they cannot both post the same comment.
export async function holdStackedBase({ state, rootDir, repo, prNumber, execFileImpl = execFileAsync, signal }) {
  if (state?.ok) return null;
  const reason = state?.reason || 'stacked-base-read-failed';
  const result = { dispatched: false, skipMergeAgent: true, recoveryWait: true, reason,
    needsOperator: reason === 'stacked-base-merged', retryAfterMs: 60_000 };
  const dir = join(rootDir, 'data', 'stacked-base-holds');
  const path = join(dir, `${createHash('sha256').update(`${repo.toLowerCase()}#${prNumber}`).digest('hex')}.json`);
  mkdirSync(dir, { recursive: true });
  let prior;
  try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first hold */ }
  // Retain the delivered receipt if an intervening API read fails.
  if (reason !== 'stacked-base-merged' || prior?.commentedAt) {
    if (prior?.reason !== reason) writeFileAtomic(path, JSON.stringify({ ...prior, repo, prNumber, reason }));
    return result;
  }
  const lock = `${path}.lock`;
  let claimed = false;
  try {
    try { if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock); } catch { /* no stale claim */ }
    try { closeSync(openSync(lock, 'wx')); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') return result; throw error; }
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first comment */ }
    if (prior?.commentedAt) return result;
    writeFileAtomic(path, JSON.stringify({ repo, prNumber, reason }));
    // GitHub is the receipt after a crash between posting and the local write.
    const { stdout } = await execGhWithRetry({ execFileImpl, args: ['api',
      `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp'],
    timeoutMs: 15_000, retries: 0, signal });
    const comments = JSON.parse(stdout);
    if (!Array.isArray(comments)) throw new Error('comment history unavailable');
    if (!comments.flat().some(comment => String(comment.body || '').includes(COMMENT_MARKER))) {
      const body = `${COMMENT_MARKER}\nClosure held: stacked-base-merged. The base branch \`${state.baseBranch}\` belongs to an already-merged PR. Rebase this PR onto the default branch \`${state.defaultBranch}\` and retarget it there before remediation or merge can continue. No automatic retarget or force-push will be performed.`;
      await execGhWithRetry({ execFileImpl, args: ['api', `repos/${repo}/issues/${prNumber}/comments`,
        '-X', 'POST', '-f', `body=${body}`], timeoutMs: 15_000, retries: 0, signal });
    }
    writeFileAtomic(path, JSON.stringify({ repo, prNumber, reason, commentedAt: new Date().toISOString() }));
  } catch { /* Hold persists; retry comment delivery on the next observation. */ } finally { if (claimed) { try { unlinkSync(lock); } catch { /* expired claim */ } } }
  return result;
}

export async function guardStackedBase(options) {
  const state = await inspectStackedBase(options);
  if (!state.ok) return holdStackedBase({ ...options, state });
  const path = join(options.rootDir, 'data', 'stacked-base-holds',
    `${createHash('sha256').update(`${options.repo.toLowerCase()}#${options.prNumber}`).digest('hex')}.json`);
  try {
    const prior = JSON.parse(readFileSync(path, 'utf8'));
    if (prior.reason) writeFileAtomic(path, JSON.stringify({ ...prior, reason: null,
      clearedAt: new Date().toISOString() }));
  } catch { /* No hold to clear; a delivered comment receipt remains reusable. */ }
  return null;
}
