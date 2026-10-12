import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const EMPTY_PR_CLOSE_TIMEOUT_MS = 15_000;
export const EMPTY_PR_COMMENT = 'Closing this pull request because its diff against the current base is empty; there is no change left to review or merge.';

// Read live PR metadata, prove an empty base/head diff, and recheck the head
// before closing. A missing/unreadable response leaves normal admission alone.
export async function closeEmptyPullRequest({ repo, prNumber, headSha,
  execFileImpl = execFileAsync, logger = console, env = process.env }) {
  if (!/^[a-f0-9]{40}$/.test(headSha || '')) return { closed: false };
  const requestedTimeout = Number(env.ADVERSARIAL_EMPTY_PR_CLOSE_TIMEOUT_MS);
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? requestedTimeout : EMPTY_PR_CLOSE_TIMEOUT_MS;
  const api = async path => JSON.parse((await execFileImpl('gh', ['api', path], {
    encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
  })).stdout);
  try {
    const path = `repos/${repo}/pulls/${prNumber}`;
    const pr = await api(path);
    if (pr.state === 'closed') return { closed: false, terminal: true };
    if (pr.state !== 'open' || pr.head?.sha !== headSha || pr.changed_files !== 0
      || !/^[a-f0-9]{40}$/.test(pr.base?.sha || '')) return { closed: false };
    const diff = await api(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    if (!Array.isArray(diff.files) || diff.files.length !== 0) return { closed: false };
    const fresh = await api(path);
    if (fresh.state !== 'open' || fresh.head?.sha !== headSha || fresh.base?.sha !== pr.base.sha) return { closed: false };
    await execFileImpl('gh', ['pr', 'close', String(prNumber), '--repo', repo, '--comment', EMPTY_PR_COMMENT], {
      encoding: 'utf8', timeout,
    });
    return { closed: true, reason: 'empty-diff' };
  } catch (error) {
    logger.warn?.(`[watcher] empty-diff close deferred for ${repo} PR ${prNumber}: ${error.message}`);
    return { closed: false, reason: 'read-or-close-failed' };
  }
}
