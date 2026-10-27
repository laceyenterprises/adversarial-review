import { recordPublishedRewrite, rewriteRepositoryKey } from './branch-rewrite-receipt.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REMLABEL-01: the remediation publisher owns the final diff check and push.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fetchPRBranchMetadata, runWorkspaceNetworkCommandWithTransientRetry } from './remediation-git-pr-io.mjs';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;

function defaultPushCommand(env) {
  for (const directory of (env.PATH ?? process.env.PATH ?? '').split(delimiter)) {
    try {
      const command = resolve(directory || '.', 'git-safe');
      accessSync(command, constants.X_OK);
      return command;
    } catch { /* Try the next PATH entry; plain git is supported without the shim. */ }
  }
  return 'git';
}

export async function publishRemediation({ workspaceDir = process.cwd(), baseBranch, previousHead,
  branch, repo, prNumber, expectedRemoteSha = previousHead, execFileImpl = execFileAsync,
  pushCommand, env = process.env } = {}) {
  const unproven = () => Object.assign(new Error('Remediation publication requires the previous head, PR branch and exact remote lease.'), { code: 'remediation-publication-unproven' });
  if (typeof baseBranch !== 'string' || !baseBranch.trim()
    || !SHA.test(previousHead || '') || !SHA.test(expectedRemoteSha || '')) throw unproven();
  if (typeof branch !== 'string' || !branch.trim()) {
    if (!repo || !prNumber) throw unproven();
    try { ({ branch } = await fetchPRBranchMetadata({ repo, prNumber, execFileImpl, env })); }
    catch { throw unproven(); }
  }
  if (typeof branch !== 'string' || !branch.trim()) throw unproven();
  branch = branch.trim();
  const git = async args => (await execFileImpl('git', ['--no-replace-objects', '-C', workspaceDir, ...args],
    { env, timeout: loadAwareTimeoutMs(30_000), maxBuffer: 16 * 1024 * 1024 })).stdout.replace(/\n$/, '');
  await git(['check-ref-format', `refs/heads/${baseBranch}`]);
  await git(['check-ref-format', `refs/heads/${branch}`]);
  // Refresh the actual target branch; never compare against a stale worker base.
  await runWorkspaceNetworkCommandWithTransientRetry({ execFileImpl, command: 'git',
    args: ['--no-replace-objects', '-C', workspaceDir, 'fetch', '--no-tags', 'origin',
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
    options: { env, timeout: loadAwareTimeoutMs(30_000), maxBuffer: 16 * 1024 * 1024 },
    // Keep the worker's selected credentials; auth failures are not transport retries.
    refreshAuthEnvImpl: async () => ({ refreshed: false, detail: 'publisher retains worker credentials' }),
  });
  const base = await git(['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`]);
  const candidate = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  const anchor = await git(['merge-base', base, previousHead]);
  const paths = (await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', anchor, previousHead]))
    .split('\0').filter(Boolean);
  const remaining = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', base, candidate]);
  const originalRemaining = paths.length ? await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z',
    base, candidate, '--', ...paths.map(path => `:(literal)${path}`)]) : '';
  // Refuse both an empty endpoint tree and an empty GitHub (merge-base) diff.
  const prAnchor = await git(['merge-base', base, candidate]);
  const prDiff = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', prAnchor, candidate]);
  if (!remaining || !prDiff || (paths.length && !originalRemaining)) {
    throw Object.assign(new Error('Remediation publication refused: the result empties the PR diff or restores every originally changed file to base. The previous remote head is retained.'),
      { code: 'remediation-empties-pr-diff', previousHead, candidate });
  }
  if (await git(['rev-parse', 'HEAD']) !== candidate) {
    throw Object.assign(new Error('Remediation head moved during publication validation.'), { code: 'remediation-publication-head-moved' });
  }
  let rewritten = false;
  try { await git(['merge-base', '--is-ancestor', expectedRemoteSha, candidate]); }
  catch (error) {
    if (error.code !== 1) throw error;
    rewritten = true;
  }
  // Resolve the actual push destination before publication, not the PR base repo
  // (which may differ for forks). Unknown identities refuse before the push.
  const repository = rewritten ? rewriteRepositoryKey(await git(['remote', 'get-url', '--push', 'origin'])) : null;
  // Pin the inspected commit as well as the expected old remote head. Neither
  // a concurrent local checkout nor a competing branch push can swap the result.
  await execFileImpl(pushCommand ?? defaultPushCommand(env), ['-C', workspaceDir, 'push',
    `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`, 'origin', `${candidate}:refs/heads/${branch}`],
  { env, timeout: loadAwareTimeoutMs(120_000), maxBuffer: 4 * 1024 * 1024 });
  const receipt = rewritten ? recordPublishedRewrite({ repository, branch,
    oldHead: expectedRemoteSha, newHead: candidate, actor: 'review-service:remediation', env }) : {};
  return { published: true, headSha: candidate, previousHead, ...receipt };
}
