import { recordWorkspaceRewrite } from './branch-rewrite-receipt.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REMLABEL-01: the remediation publisher owns the final diff check and push.
import { accessSync, constants } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { spawnCapturedProcessGroup } from './process-group-spawn.mjs';
import { fetchPRBranchMetadata, isWorkspaceAccessFailure, isWorkspaceAuthFailure,
  runWorkspaceNetworkCommandWithTransientRetry } from './remediation-git-pr-io.mjs';
import { checkRemediationPublication } from './remediation-publication-checks.mjs';
import { credentialBrokerReady, credentialRefreshUnavailable, credentialRefreshNeedsBrokerEvidence,
  CREDENTIAL_REFRESH_UNAVAILABLE } from './remediation-credential-broker.mjs';
import { OWNER_AUTH_HOLD, ownerAuthHold, remediationOwner, selectRemediationReadRoute, selectRemediationPushRoute } from './remediation-owner-auth.mjs';
import { publicationPushDiagnostic } from './remediation-publication-diagnostics.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const FAST_MIRROR_BUDGET_SECONDS = 45;
export const PUBLICATION_AUTH_REJECTED = 'remediation-publication-auth-rejected';
export const PUBLICATION_STALE_LEASE = 'remediation-publication-stale-lease';

export async function runRemediationPublicationCommand(command, args, { cwd, env, timeout, maxBuffer, signal } = {}) {
  signal?.throwIfAborted();
  const result = await spawnCapturedProcessGroup(command, args, {
    cwd, env, timeout, maxBuffer, signal, progressTimeout: 0, reapGroupOnExit: true,
    // The focused test runner gets five seconds to terminate its own group.
    killGraceMs: 10_000, settleAfterKillMs: 2_000,
  });
  if (result.abandoned) {
    throw Object.assign(new Error('Publication command output did not close after exit.'), { abandoned: true });
  }
  return result;
}

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
  if (error.code === OWNER_AUTH_HOLD || error.budgetDeferred || error.signal || error.killed || !isWorkspaceAuthFailure(error)) return error;
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
  branch, repo, prNumber, expectedRemoteSha = previousHead, signal,
  // Offline fixtures can inject command results. Production callers use the managed runner.
  execFileImpl = (command, args, options) => runRemediationPublicationCommand(command, args, { ...options, signal }),
  pushCommand, pushTimeoutMs, env = process.env, credentialBrokerReadyImpl = credentialBrokerReady,
  workerClass, reviewerRole, reviewerModel, requiresWorkflowPush = false, expectedCandidate,
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
  const ownerReadRoute = routed ? await selectReadRoute({ repo, reviewerRole, reviewerModel, env, tokens: ownerTokens }) : null;
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
  const readRemoteUrl = ownerReadRoute?.url ?? 'origin';
  const gitRead = (args, maxBuffer, boundRetries = false) => {
    const timeout = loadAwareTimeoutMs(30_000);
    const run = () => runWorkspaceNetworkCommandWithTransientRetry({ execFileImpl, command: 'git',
      args: ['--no-replace-objects', '-C', workspaceDir, ...args],
      options: { env: ownerReadRoute?.gitEnv ?? env, timeout, maxBuffer },
      ...(boundRetries && { retryBudgetMs: timeout }),
      // The selected owner and credential are fixed for the publication.
      refreshAuthEnvImpl: null,
    });
    return ownerReadRoute ? ownerReadRoute.run(run) : run();
  };
  // Refresh the actual target branch; never compare against a stale worker base.
  try {
    await gitRead(['fetch', '--no-recurse-submodules', '--no-tags', readRemoteUrl,
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], 16 * 1024 * 1024);
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
  const remoteRef = `refs/heads/${branch}`;
  const unconfirmedPush = (message, cause) => Object.assign(new Error(message, { cause }),
    { code: 'remediation-publication-unproven' });
  const command = pushCommand ?? defaultPushCommand(env);
  const resolvePushRoute = () => selectPushRoute({ repo, workerClass, env, execFileImpl, tokens: ownerTokens,
    requiresWorkflowPush: Boolean(requiresWorkflowPush || outgoingWorkflowPaths.trim()
      || changedPaths.some(path => /^\.github\/workflows\//i.test(path))) });
  let pushRoute = routed ? await resolvePushRoute() : null;
  let diagnostic;
  let pushError;
  let credentialRetried = false;
  const attemptPush = () => {
    const push = async () => {
      const activeEnv = pushRoute?.gitEnv ?? env;
      try {
        await execFileImpl(command, ['-C', workspaceDir, 'push',
          `--force-with-lease=${remoteRef}:${expectedRemoteSha}`, pushRoute?.url ?? 'origin', `${candidate}:${remoteRef}`],
        {
          // Scoped owner routes already carry an installation credential and own its refresh.
          env: { ...activeEnv, ...(pushRoute && { HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND: '' }),
            PPH_SKIP: '0', PPH_WORKER_FAST_ONLY: '1', PPH_STRICT: '1',
            PPH_TOTAL_BUDGET_SECONDS: String(FAST_MIRROR_BUDGET_SECONDS) },
          timeout: pushTimeoutMs ?? loadAwareTimeoutMs(120_000) + FAST_MIRROR_BUDGET_SECONDS * 1000,
          maxBuffer: 4 * 1024 * 1024,
        });
      } catch (error) {
        pushError = error;
        if (error.killed || error.signal || error.abandoned) {
          diagnostic = publicationPushDiagnostic({ exitCode: error.exitCode }, { credentialRetried });
          const reason = error.runnerKillReason ?? (error.signal ? `received ${error.signal}` : 'output was incomplete');
          throw unconfirmedPush(`Guarded push ${reason}; verify the live destination before recovery.`, error);
        }
        const secrets = Object.entries(activeEnv)
          .filter(([key]) => /(?:^|_)(?:(?:GH|GITHUB)(?:_[A-Z0-9]+)*|REMEDIATION_PUSH)_TOKEN$/u.test(key))
          .map(([, value]) => value);
        diagnostic = publicationPushDiagnostic(error, {
          credentialRetried, secrets: [...secrets, pushRoute?.ghEnv?.GH_TOKEN],
        });
        throw error;
      }
    };
    return pushRoute ? pushRoute.run(push) : push();
  };

  const refreshPushCredential = async () => {
    signal?.throwIfAborted();
    // Entitled git-safe refreshes inside the shim. Other ambient routes
    // have no repository-scoped mint here, and must retain their identity.
    if (!pushRoute) return false;
    const nextRoute = await resolvePushRoute();
    const nextToken = nextRoute?.ghEnv?.GH_TOKEN;
    if (!nextToken || nextToken === pushRoute.ghEnv?.GH_TOKEN || nextRoute.url !== pushRoute.url
      || nextRoute.provider !== pushRoute.provider || nextRoute.capability !== pushRoute.capability) return false;
    pushRoute = nextRoute;
    return true;
  };
  const staleLease = () => /\[rejected\][^\n]*\(stale info\)/iu.test(String(pushError?.stderr || ''));

  try {
    try { await attemptPush(); }
    catch (error) {
      const cannotRetry = error.budgetDeferred || error.code === 'remediation-publication-unproven'
        || staleLease()
        || credentialRefreshUnavailable(error) || credentialRefreshNeedsBrokerEvidence(error)
        || diagnostic?.authRefusal !== 'authentication' || diagnostic.credentialRetried;
      if (cannotRetry) throw error;
      const refreshed = await refreshPushCredential().catch(() => false);
      signal?.throwIfAborted();
      if (!refreshed) throw error;
      credentialRetried = true;
      await attemptPush();
    }
  } catch (error) {
    const withDiagnostic = refusal => Object.assign(refusal, { pushDiagnostic: diagnostic });
    if (error.code !== 'remediation-publication-unproven' && staleLease()) {
      throw withDiagnostic(Object.assign(new Error('The guarded publisher lease did not match the remote PR head.'), { code: PUBLICATION_STALE_LEASE }));
    }
    if (!routed && (credentialRefreshUnavailable(error)
      || (credentialRefreshNeedsBrokerEvidence(error) && !(await credentialBrokerReadyImpl({ env })).ready))) {
      throw withDiagnostic(credentialUnavailable());
    }
    // Ambiguous shim refresh diagnostics cannot be promoted to a broker outage.
    if (credentialRefreshNeedsBrokerEvidence(error)) throw withDiagnostic(error);
    if (diagnostic?.authRefusal && !error.budgetDeferred && error.code !== OWNER_AUTH_HOLD
      && error.code !== 'remediation-publication-unproven') {
      const finding = diagnostic.authRefusal === 'permission'
        ? 'GitHub refused the guarded push under its permission or branch rules.'
        : REFUSAL_FINDINGS.get(PUBLICATION_AUTH_REJECTED);
      throw withDiagnostic(Object.assign(new Error(finding), { code: PUBLICATION_AUTH_REJECTED }));
    }
    throw withDiagnostic(publicationAuthError(error));
  }
  // An interrupted push can update the remote before its result is lost. Leave
  // recovery to authoritative observation; never retry the write here. A
  // successful command still needs evidence at the exact destination ref.
  let remoteResult;
  try {
    remoteResult = await gitRead(['ls-remote', '--refs', readRemoteUrl, remoteRef], 1024 * 1024, true);
  } catch (error) {
    // A push may already have landed. Keep the outer unproven code so a
    // verification auth refusal cannot trigger credential recovery's write.
    const refusal = publicationAuthError(error);
    if (refusal.code === PUBLICATION_AUTH_REJECTED) {
      throw unconfirmedPush('Guarded push returned successfully, but its destination credentials were rejected.', refusal);
    }
    if (error.code === OWNER_AUTH_HOLD || isWorkspaceAccessFailure(error)) {
      throw unconfirmedPush('Guarded push returned successfully, but access to its live destination was refused.', error);
    }
    throw unconfirmedPush('Guarded push returned successfully, but its live destination could not be read.', error);
  }
  // ls-remote patterns can also return refs whose tail matches the requested ref.
  const exact = String(remoteResult.stdout ?? '').split(/\r?\n/u)
    .filter(line => line.split('\t')[1] === remoteRef);
  if (exact.length !== 1 || exact[0] !== `${candidate}\t${remoteRef}`) {
    throw unconfirmedPush('Guarded push returned successfully, but its exact commit was not observed at the live destination.');
  }
  const receipt = await recordWorkspaceRewrite({ git, branch,
    oldHead: expectedRemoteSha, newHead: candidate, actor: 'review-service:remediation', env,
    repository: routed ? `github.com/${repo.toLowerCase()}` : null });
  return { published: true, headSha: candidate, previousHead, ...receipt };
}
