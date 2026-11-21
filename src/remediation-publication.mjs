import { recordWorkspaceRewrite } from './branch-rewrite-receipt.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REMLABEL-01: the remediation publisher owns the final diff check and push.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fetchPRBranchMetadata, isWorkspaceAuthFailure, runWorkspaceNetworkCommandWithTransientRetry } from './remediation-git-pr-io.mjs';
import { checkRemediationPublication } from './remediation-publication-checks.mjs';
import { credentialBrokerReady, credentialRefreshUnavailable, credentialRefreshNeedsBrokerEvidence,
  CREDENTIAL_REFRESH_UNAVAILABLE } from './remediation-credential-broker.mjs';
import { OWNER_AUTH_HOLD, ownerAuthHold, remediationOwner, selectRemediationReadRoute, selectRemediationPushRoute } from './remediation-owner-auth.mjs';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/i;
export const PUBLICATION_AUTH_REJECTED = 'remediation-publication-auth-rejected';
export const PUBLICATION_STALE_LEASE = 'remediation-publication-stale-lease';

const REFUSAL_FINDINGS = new Map([
  [PUBLICATION_AUTH_REJECTED, 'GitHub rejected the guarded publisher credentials.'],
  [OWNER_AUTH_HOLD, 'The guarded publisher could not prove an authorized GitHub owner route.'],
  [CREDENTIAL_REFRESH_UNAVAILABLE, 'The guarded publisher could not refresh its GitHub credential through the broker.'],
  [PUBLICATION_STALE_LEASE, 'The guarded publisher lease did not match the remote PR head.'],
  ['remediation-empties-pr-diff', 'The guarded publisher refused to empty the PR diff or restore every originally changed file to base.'],
  ['remediation-publication-head-moved', 'The local head moved during guarded publication validation.'],
]);

export function publicationBlocker({ code, localCommit, expectedRemoteSha }) {
  if (typeof localCommit === 'string') localCommit = localCommit.toLowerCase();
  if (typeof expectedRemoteSha === 'string') expectedRemoteSha = expectedRemoteSha.toLowerCase();
  return {
    title: 'guarded-publication-refused',
    code,
    finding: REFUSAL_FINDINGS.get(code) || 'The guarded publisher could not prove publication.',
    reasoning: 'The guarded publication attempt did not report success.',
    ...(SHA.test(localCommit || '') && { commitSha: localCommit }),
    ...(SHA.test(expectedRemoteSha || '') && { expectedRemoteSha }),
  };
}

function publicationAuthError(error) {
  if (error.code === OWNER_AUTH_HOLD || error.budgetDeferred || error.signal || !isWorkspaceAuthFailure(error)) return error;
  return Object.assign(new Error('GitHub rejected the guarded publisher credentials.'), { code: PUBLICATION_AUTH_REJECTED });
}

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
  pushCommand, env = process.env, credentialBrokerReadyImpl = credentialBrokerReady,
  workerClass, reviewerModel, requiresWorkflowPush = false, expectedCandidate,
  ownerTokens, selectReadRoute = selectRemediationReadRoute, selectPushRoute = selectRemediationPushRoute } = {}) {
  if (typeof previousHead === 'string') previousHead = previousHead.toLowerCase();
  if (typeof expectedRemoteSha === 'string') expectedRemoteSha = expectedRemoteSha.toLowerCase();
  if (typeof expectedCandidate === 'string') expectedCandidate = expectedCandidate.toLowerCase();
  const unproven = () => Object.assign(new Error('Remediation publication requires the previous head, PR branch and exact remote lease.'), { code: 'remediation-publication-unproven' });
  if (typeof baseBranch !== 'string' || !baseBranch.trim()
    || !SHA.test(previousHead || '') || !SHA.test(expectedRemoteSha || '')) throw unproven();
  if (((typeof branch !== 'string' || !branch.trim()) && (!repo || !prNumber))
    || (expectedCandidate && !SHA.test(expectedCandidate))) throw unproven();
  const git = async args => (await execFileImpl('git', ['--no-replace-objects', '-C', workspaceDir, ...args],
    { env, timeout: loadAwareTimeoutMs(30_000), maxBuffer: 16 * 1024 * 1024 })).stdout.replace(/\n$/, '');
  const candidate = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (expectedCandidate && candidate !== expectedCandidate) throw unproven();
  const routed = remediationOwner(repo, ownerTokens);
  const ownerReadRoute = routed ? await selectReadRoute({ repo, reviewerModel, env, tokens: ownerTokens }) : null;
  if (routed || typeof branch !== 'string' || !branch.trim()) {
    if (!repo || !prNumber) throw unproven();
    try {
      const metadata = await fetchPRBranchMetadata({ repo, prNumber, execFileImpl, env, ownerRoute: ownerReadRoute });
      if (routed && (metadata.headRepo?.toLowerCase() !== repo.toLowerCase()
        || (branch?.trim() && branch.trim() !== metadata.branch))) {
        throw ownerAuthHold(repo, 'same-repository PR branch', 'live PR branch identity differs');
      }
      if (routed && metadata.baseBranch !== baseBranch) throw unproven();
      branch = metadata.branch;
    }
    catch (error) {
      const refusal = publicationAuthError(error);
      if (refusal !== error || error.code === OWNER_AUTH_HOLD || error.budgetDeferred) throw refusal;
      throw unproven();
    }
  }
  if (typeof branch !== 'string' || !branch.trim()) throw unproven();
  branch = branch.trim();
  await git(['check-ref-format', `refs/heads/${baseBranch}`]);
  await git(['check-ref-format', `refs/heads/${branch}`]);
  // Refresh the actual target branch; never compare against a stale worker base.
  const fetchBase = () => runWorkspaceNetworkCommandWithTransientRetry({ execFileImpl, command: 'git',
    args: ['--no-replace-objects', '-C', workspaceDir, 'fetch', '--no-recurse-submodules', '--no-tags', ownerReadRoute?.url ?? 'origin',
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
    options: { env: ownerReadRoute?.gitEnv ?? env, timeout: loadAwareTimeoutMs(30_000), maxBuffer: 16 * 1024 * 1024 },
    // Keep the worker's selected credentials; auth failures are not transport retries.
    refreshAuthEnvImpl: async () => ({ refreshed: false, detail: 'publisher retains worker credentials' }),
  });
  try {
    await (ownerReadRoute ? ownerReadRoute.run(fetchBase) : fetchBase());
  } catch (error) { throw publicationAuthError(error); }
  const base = await git(['rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`]);
  const anchor = await git(['merge-base', base, previousHead]);
  const paths = (await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', anchor, previousHead]))
    .split('\0').filter(Boolean);
  const remaining = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', base, candidate]);
  const originalRemaining = paths.length ? await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z',
    base, candidate, '--', ...paths.map(path => `:(literal)${path}`)]) : '';
  // Refuse both an empty endpoint tree and an empty GitHub (merge-base) diff.
  const prAnchor = await git(['merge-base', base, candidate]);
  const prDiff = await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', prAnchor, candidate]);
  if (!remaining || !prDiff || (paths.length && !originalRemaining)) {
    throw Object.assign(new Error('Remediation publication refused: the result empties the PR diff or restores every originally changed file to base. The previous remote head is retained.'),
      { code: 'remediation-empties-pr-diff', previousHead, candidate });
  }
  const changedPaths = prDiff.split('\0').filter(Boolean);
  const outgoingWorkflowPaths = routed ? await git(['log', '--format=', '--name-only', '--no-renames', '-z',
    `${expectedRemoteSha}..${candidate}`, '--', '.github/workflows/']) : '';
  await checkRemediationPublication({ workspaceDir, candidate, paths: changedPaths, git, execFileImpl, env });
  if (await git(['rev-parse', 'HEAD']) !== candidate) {
    throw Object.assign(new Error('Remediation head moved during publication validation.'), { code: 'remediation-publication-head-moved' });
  }
  // Pin the inspected commit as well as the expected old remote head. Neither
  // a concurrent local checkout nor a competing branch push can swap the result.
  const credentialUnavailable = () => Object.assign(
    new Error('Credential broker refresh unavailable; local commit retained for publication recovery.'),
    { code: CREDENTIAL_REFRESH_UNAVAILABLE, candidate, previousHead });
  try {
    const pushRoute = routed ? await selectPushRoute({ repo, workerClass, env, execFileImpl, tokens: ownerTokens,
      requiresWorkflowPush: Boolean(requiresWorkflowPush || outgoingWorkflowPaths.trim()
        || changedPaths.some(path => /^\.github\/workflows\//i.test(path))) }) : null;
    const push = () => execFileImpl(pushCommand ?? defaultPushCommand(env), ['-C', workspaceDir, 'push',
      `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`, pushRoute?.url ?? 'origin', `${candidate}:refs/heads/${branch}`],
    { env: pushRoute?.gitEnv ?? env, timeout: loadAwareTimeoutMs(120_000), maxBuffer: 4 * 1024 * 1024 });
    await (pushRoute ? pushRoute.run(push) : push());
  } catch (error) {
    if (/\[rejected\][^\n]*\(stale info\)/iu.test(String(error.stderr || ''))) {
      throw Object.assign(new Error('The guarded publisher lease did not match the remote PR head.'), { code: PUBLICATION_STALE_LEASE });
    }
    if (!routed && (credentialRefreshUnavailable(error)
      || (credentialRefreshNeedsBrokerEvidence(error) && !(await credentialBrokerReadyImpl({ env })).ready))) {
      throw credentialUnavailable();
    }
    // Ambiguous shim refresh diagnostics cannot be promoted to a broker outage.
    if (credentialRefreshNeedsBrokerEvidence(error)) throw error;
    throw publicationAuthError(error);
  }
  const receipt = await recordWorkspaceRewrite({ git, branch,
    oldHead: expectedRemoteSha, newHead: candidate, actor: 'review-service:remediation', env,
    repository: routed ? `github.com/${repo.toLowerCase()}` : null });
  return { published: true, headSha: candidate, previousHead, ...receipt };
}
