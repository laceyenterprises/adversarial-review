import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeLaneRoutes } from './config-lane-routes.mjs';
import { meteredExecFile } from './metered-gh.mjs';
import { currentGitHubBudgetScope, withGitHubBudgetScope } from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);

// Repository-scoped routing identity, with an optional live branch-ref read.
export async function readLivePullRequestIdentity(repository, prNumber, {
  signal, timeoutMs, env = process.env, execFileImpl = execFileAsync, includeBaseSha = false,
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
  const credentialDeadlineMs = Date.now() + timeoutMs;
  const read = args => meteredExecFile(exec, 'gh', ['api', ...args],
    { env, signal, credentialDeadlineMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  // This arbitrary-command wrapper cannot attest closure eligibility. Default
  // to normal admission; a closure caller can establish its own urgent scope.
  // Scoped admission avoids sleeping past the evidence deadline.
  if (currentGitHubBudgetScope()) return lookup();
  return withGitHubBudgetScope({}, lookup);

  async function lookup() {
    const { stdout } = await read([`repos/${repository}/pulls/${prNumber}`, '--jq',
      '{number, state, merged_at, headSha: .head.sha, baseBranch: .base.ref, repository: .base.repo.full_name}']);
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
    const pr = { prState: identity.merged_at ? 'merged' : identity.state,
      headSha: identity.headSha, baseBranch: identity.baseBranch };
    if (!includeBaseSha) return pr;
    if (pr.prState !== 'open') return { ...pr, baseSha: null };
    // PR payloads can report a historical .base.sha even on a fresh response.
    // Only the branch ref can prove base movement relative to the writer.
    let baseSha = null;
    try {
      const refPath = pr.baseBranch.split('/').map(encodeURIComponent).join('/');
      const response = await read([`repos/${repository}/git/ref/heads/${refPath}`]);
      const branch = JSON.parse(response.stdout);
      if (branch.ref === `refs/heads/${pr.baseBranch}` && branch.object?.type === 'commit'
        && /^[a-f\d]{40}$/i.test(branch.object.sha || '') && performance.now() < deadline) baseSha = branch.object.sha;
    } catch { /* PR identity may still be useful without base-change evidence. */ }
    signal?.throwIfAborted();
    return { ...pr, baseSha };
  }
}
