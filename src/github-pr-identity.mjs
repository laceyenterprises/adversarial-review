import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeLaneRoutes } from './config-lane-routes.mjs';
import { meteredExecFile } from './metered-gh.mjs';
import { currentGitHubBudgetScope, withGitHubBudgetScope } from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);

// One live, repository-scoped REST read. This supplies routing identity only.
export async function readLivePullRequestIdentity(repository, prNumber, {
  signal, timeoutMs, env = process.env, execFileImpl = execFileAsync,
} = {}) {
  signal?.throwIfAborted();
  if (typeof repository !== 'string' || !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository)
    || ['.', '..'].includes(repository.split('/')[1])
    || !Number.isSafeInteger(prNumber) || prNumber < 1) throw new TypeError('invalid GitHub PR reference');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('queue evidence deadline expired');
  const deadline = performance.now() + timeoutMs;
  // Owner selection and admission can await before reaching execFile. Check
  // cancellation and spend only the remaining evidence budget at launch.
  const exec = (command, args, options) => {
    signal?.throwIfAborted();
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error('queue evidence deadline expired');
    return execFileImpl(command, args, { ...options, timeout: remaining });
  };
  const read = () => meteredExecFile(exec, 'gh', [
    'api', `repos/${repository}/pulls/${prNumber}`, '--jq',
    '{number, state, merged_at, headSha: .head.sha, baseBranch: .base.ref, repository: .base.repo.full_name}',
  ], { env, signal, credentialDeadlineMs: Date.now() + timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  // This arbitrary-command wrapper cannot attest closure eligibility. Default
  // to normal admission; a closure caller can establish its own urgent scope.
  // Scoped admission avoids sleeping past the evidence deadline.
  const { stdout } = await (currentGitHubBudgetScope() ? read() : withGitHubBudgetScope({}, read));
  signal?.throwIfAborted();
  if (performance.now() >= deadline) throw new Error('queue evidence deadline expired');
  const identity = JSON.parse(stdout);
  if (identity?.number !== prNumber || typeof identity.repository !== 'string'
    || identity.repository.toLowerCase() !== repository.toLowerCase()
    || !['open', 'closed'].includes(identity.state) || !Object.hasOwn(identity, 'merged_at')
    || (identity.merged_at !== null && (identity.state !== 'closed'
      || typeof identity.merged_at !== 'string' || !Number.isFinite(Date.parse(identity.merged_at))))
    || typeof identity.headSha !== 'string' || !/^[a-f\d]{40}$/i.test(identity.headSha)) return null;
  try {
    normalizeLaneRoutes([{ repository, base: identity.baseBranch, executor: 'legacy' }]);
  } catch {
    return null;
  }
  return { prState: identity.merged_at ? 'merged' : identity.state,
    headSha: identity.headSha, baseBranch: identity.baseBranch };
}
