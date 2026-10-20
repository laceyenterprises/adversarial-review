import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { filterGitHubBody } from '../github-outbound-body.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execGhWithRetry } from '../gh-cli.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';

const execFileAsync = promisify(execFile);
const COMMENT_MARKER = '<!-- ama:stacked-base-merged -->';

// Keep defaults briefly, scoped to the transport as well as the repository.
// Injected transports never share evidence with the production client.
const DEFAULT_BRANCH_CACHE_TTL_MS = 60_000;
const defaultBranchCaches = new WeakMap();

export function cachedStackedBaseDefaultBranch(repo, execFileImpl = execFileAsync) {
  const entry = defaultBranchCaches.get(execFileImpl)?.get(repo.toLowerCase());
  return entry && Date.now() - entry.observedAt < DEFAULT_BRANCH_CACHE_TTL_MS ? entry.branch : undefined;
}

function classifyReadError(error) {
  if (error instanceof SyntaxError || error?.readError === 'parse') return 'parse';
  if (error?.authOutage) return 'auth';
  const detail = String(error?.stderr || error?.message || '');
  const status = Number(error?.status || error?.response?.status);
  if (status === 401 || status === 403 || /\bHTTP\s+40[13]\b/i.test(detail)) return 'auth';
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ESOCKETTIMEDOUT'
    || (error?.killed && ['SIGTERM', 'SIGKILL'].includes(error.signal))
    || /timed?\s*out|timeout/i.test(detail)) return 'timeout';
  if ((status >= 500 && status < 600) || /\bHTTP\s+5\d\d\b/i.test(detail)) return '5xx';
  return 'unknown';
}

function invalidRead(message) {
  return Object.assign(new Error(message), { readError: 'parse' });
}

export async function inspectStackedBase({ repo, prNumber, baseBranch, defaultBranch,
  execFileImpl = execFileAsync, signal }) {
  signal?.throwIfAborted();
  defaultBranch ||= cachedStackedBaseDefaultBranch(repo, execFileImpl);
  if (typeof baseBranch === 'string' && baseBranch
    && typeof defaultBranch === 'string' && baseBranch === defaultBranch) {
    return { ok: true, baseBranch, defaultBranch };
  }
  const get = async path => {
    const { stdout } = await execGhWithRetry({ execFileImpl,
      args: ['api', path], timeoutMs: loadAwareTimeoutMs(15_000), retries: 2, backoffMs: 500, signal });
    return JSON.parse(stdout);
  };
  try {
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    baseBranch = pr?.base?.ref;
    defaultBranch = pr?.base?.repo?.default_branch;
    if (typeof baseBranch !== 'string' || !baseBranch
      || typeof defaultBranch !== 'string' || !defaultBranch) throw invalidRead('base/default branch unavailable');
    let cache = defaultBranchCaches.get(execFileImpl);
    if (!cache) { cache = new Map(); defaultBranchCaches.set(execFileImpl, cache); }
    cache.set(repo.toLowerCase(), { branch: defaultBranch, observedAt: Date.now() });
    if (baseBranch === defaultBranch) return { ok: true, baseBranch, defaultBranch };
    // Paginate explicitly: a branch may have several closed, unmerged PRs.
    const query = new URLSearchParams({ state: 'closed', head: `${repo.split('/')[0]}:${baseBranch}`, per_page: '100' });
    for (let page = 1; page <= 10; page++) {
      const pulls = await get(`repos/${repo}/pulls?${query}&page=${page}`);
      if (!Array.isArray(pulls)) throw invalidRead('merged-base history unavailable');
      if (pulls.some(parent => parent.merged_at && parent.head?.ref === baseBranch
        && parent.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase())) {
        return { ok: false, reason: 'stacked-base-merged', baseBranch, defaultBranch };
      }
      if (pulls.length < 100) return { ok: true, baseBranch, defaultBranch };
    }
    throw new Error('merged-base history exceeded bounded read budget');
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: 'stacked-base-read-failed', readError: classifyReadError(error) };
  }
}

// Repository + PR scope survives head changes and daemon restarts. The lock
// serializes remediation and closure so they cannot both post the same comment.
export async function holdStackedBase({ state, rootDir = process.cwd(), repo, prNumber, execFileImpl = execFileAsync, signal, logger = console }) {
  if (state?.ok) return null;
  const reason = state?.reason || 'stacked-base-read-failed';
  const readError = reason === 'stacked-base-read-failed'
    ? (['timeout', 'auth', '5xx', 'parse', 'unknown'].includes(state?.readError) ? state.readError : 'unknown') : null;
  if (readError) logger?.warn?.(`[${new Date().toISOString()}] Stacked base hold ${repo} PR ${prNumber}: ${reason} readError=${readError}`);
  const result = { ...(readError ? { readError } : {}), dispatched: false, skipMergeAgent: true, recoveryWait: true, reason,
    needsOperator: reason === 'stacked-base-merged', retryAfterMs: 60_000 };
  const dir = join(rootDir, 'data', 'stacked-base-holds');
  const path = join(dir, `${createHash('sha256').update(`${repo.toLowerCase()}#${prNumber}`).digest('hex')}.json`);
  let prior;
  try {
    mkdirSync(dir, { recursive: true });
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first hold */ }
    // Retain the delivered receipt if an intervening API read fails.
    if (reason !== 'stacked-base-merged' || prior?.commentedAt) {
      if (prior?.reason !== reason || prior?.readError !== readError) {
        writeFileAtomic(path, JSON.stringify({ ...prior, repo, prNumber, reason, readError }));
      }
      return result;
    }
  } catch (error) {
    logger?.warn?.(`Stacked base hold persistence failed: ${error.message}`);
    return result;
  }
  const lock = `${path}.lock`;
  let claimed = false;
  try {
    // Cover read/post retry budgets, receipt probes and auth refresh.
    try { if (Date.now() - statSync(lock).mtimeMs > 300_000) unlinkSync(lock); } catch { /* no stale claim */ }
    try { closeSync(openSync(lock, 'wx')); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') return result; throw error; }
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first comment */ }
    if (prior?.commentedAt) return result;
    writeFileAtomic(path, JSON.stringify({ repo, prNumber, reason }));
    // GitHub is the receipt after a crash between posting and the local write.
    const { stdout } = await execGhWithRetry({ execFileImpl, args: ['api',
      `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp'],
    timeoutMs: loadAwareTimeoutMs(15_000), retries: 2, backoffMs: 500, signal });
    const comments = JSON.parse(stdout);
    if (!Array.isArray(comments)) throw new Error('comment history unavailable');
    if (!comments.flat().some(comment => String(comment.body || '').includes(COMMENT_MARKER))) {
      const body = `${COMMENT_MARKER}\nClosure held: stacked-base-merged. The base branch \`${state.baseBranch}\` belongs to an already-merged PR. Rebase this PR onto the default branch \`${state.defaultBranch}\` and retarget it there before remediation or merge can continue. No automatic retarget or force-push will be performed.`;
      let postAttempted = false;
      const postWithReceiptProbe = async (command, args, options) => {
        // A failed POST may already have reached GitHub. Probe before retrying;
        // a failed probe consumes an attempt without risking another POST.
        if (postAttempted) {
          const receipt = await execFileImpl(command, ['api',
            `repos/${repo}/issues/${prNumber}/comments`, '--paginate', '--slurp'], options);
          const history = JSON.parse(receipt.stdout);
          if (!Array.isArray(history)) throw new Error('comment history unavailable');
          if (history.flat().some(comment => String(comment.body || '').includes(COMMENT_MARKER))) return receipt;
        }
        postAttempted = true;
        return execFileImpl(command, args, options);
      };
      await execGhWithRetry({ execFileImpl: postWithReceiptProbe, args: ['api', `repos/${repo}/issues/${prNumber}/comments`,
        '-X', 'POST', '-f', `body=${filterGitHubBody(body, { rootDir })}`], timeoutMs: loadAwareTimeoutMs(15_000), retries: 2, backoffMs: 500, signal });
    }
    writeFileAtomic(path, JSON.stringify({ repo, prNumber, reason, commentedAt: new Date().toISOString() }));
  } catch { /* Hold persists; retry comment delivery on the next observation. */ } finally { if (claimed) { try { unlinkSync(lock); } catch { /* expired claim */ } } }
  return result;
}

export async function guardStackedBase(options) {
  options = { ...options, rootDir: options.rootDir || process.cwd() };
  const state = await inspectStackedBase(options);
  if (!state.ok) return holdStackedBase({ ...options, state });
  const path = join(options.rootDir, 'data', 'stacked-base-holds',
    `${createHash('sha256').update(`${options.repo.toLowerCase()}#${options.prNumber}`).digest('hex')}.json`);
  try {
    const prior = JSON.parse(readFileSync(path, 'utf8'));
    if (prior.reason) writeFileAtomic(path, JSON.stringify({ ...prior, reason: null, readError: null,
      clearedAt: new Date().toISOString() }));
  } catch { /* No hold to clear; a delivered comment receipt remains reusable. */ }
  return null;
}
