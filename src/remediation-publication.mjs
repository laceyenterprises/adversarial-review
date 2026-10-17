// REMLABEL-01: the remediation publisher owns the final diff check and push.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;

export async function publishRemediation({ workspaceDir = process.cwd(), baseBranch, previousHead,
  branch, expectedRemoteSha = previousHead, execFileImpl = execFileAsync,
  pushCommand = 'git-safe', env = process.env } = {}) {
  if (!SHA.test(previousHead || '') || !SHA.test(expectedRemoteSha || '')) {
    throw Object.assign(new Error('Remediation publication requires the previous head and exact remote lease.'), { code: 'remediation-publication-unproven' });
  }
  const git = async args => (await execFileImpl('git', ['--no-replace-objects', '-C', workspaceDir, ...args],
    { env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout.replace(/\n$/, '');
  await git(['check-ref-format', `refs/heads/${baseBranch}`]);
  await git(['check-ref-format', `refs/heads/${branch}`]);
  // Refresh the actual target branch; never compare against a stale worker base.
  await git(['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`]);
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
  // Pin the inspected commit as well as the expected old remote head. Neither
  // a concurrent local checkout nor a competing branch push can swap the result.
  await execFileImpl(pushCommand, ['-C', workspaceDir, 'push',
    `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`, 'origin', `${candidate}:refs/heads/${branch}`],
  { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return { published: true, headSha: candidate, previousHead };
}
