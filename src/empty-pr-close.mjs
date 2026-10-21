import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { meteredExecFile } from './metered-gh.mjs';
import { filterGitHubBody } from './github-outbound-body.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isOperatorHeld } from './operator-hold-labels.mjs';
const execFileAsync = promisify(execFile);
const EMPTY_PR_CLOSE_TIMEOUT_MS = 15_000;
export const EMPTY_PR_COMMENT = 'Closing this pull request because its diff against the current base is empty; there is no change left to review or merge.';

// Read live PR metadata, prove an empty base/head diff, and recheck the head
// before closing. A read or close failure defers watcher admission to the next tick.
export async function closeEmptyPullRequest({ repo, prNumber, headSha,
  execFileImpl = execFileAsync, logger = console, env = process.env, withApiTelemetry = (_category, _context, fn) => fn() }) {
  if (!/^[a-f0-9]{40}$/.test(headSha || '')) return { closed: false };
  const requestedTimeout = Number(env.ADVERSARIAL_EMPTY_PR_CLOSE_TIMEOUT_MS);
  const timeout = loadAwareTimeoutMs(Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout : EMPTY_PR_CLOSE_TIMEOUT_MS);
  const call = args => withApiTelemetry(args[0] === 'api' ? (args[1].includes('/compare/') ? 'diff_fetch' : 'pr_view') : 'other', { repo, prNumber }, () => meteredExecFile(execFileImpl, 'gh', args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }));
  const api = async path => JSON.parse((await call(['api', path])).stdout);
  let closed = false;
  try {
    const path = `repos/${repo}/pulls/${prNumber}`;
    const pr = await api(path);
    if (pr.state === 'closed') return { closed: false, terminal: true };
    if (pr.head?.sha === headSha && Number.isInteger(pr.changed_files) && pr.changed_files > 0) return { closed: false, nonempty: true };
    if (pr.state !== 'open' || pr.draft !== false || !Array.isArray(pr.labels) || isOperatorHeld(pr.labels)
      || pr.head?.sha !== headSha || pr.changed_files !== 0
      || !/^[a-f0-9]{40}$/.test(pr.base?.sha || '')) return { closed: false };
    const diff = await api(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    if (!Array.isArray(diff.files) || diff.files.length !== 0) return { closed: false };
    const fresh = await api(path);
    if (fresh.state !== 'open' || fresh.draft !== false || !Array.isArray(fresh.labels) || isOperatorHeld(fresh.labels)
      || fresh.head?.sha !== headSha || fresh.base?.sha !== pr.base.sha || fresh.changed_files !== 0) return { closed: false };
    // Closing first means a retry after transport failure cannot duplicate the comment.
    await call(['pr', 'close', String(prNumber), '--repo', repo]);
    closed = true;
    await call(['pr', 'comment', String(prNumber), '--repo', repo, '--body', filterGitHubBody(EMPTY_PR_COMMENT, { repo })]);
    return { closed: true, reason: 'empty-diff' };
  } catch (error) {
    logger.warn?.(`[watcher] empty-diff close deferred for ${repo} PR ${prNumber}: ${error.message}`);
    return { closed, reason: closed ? 'closed-comment-failed' : 'read-or-close-failed' };
  }
}
