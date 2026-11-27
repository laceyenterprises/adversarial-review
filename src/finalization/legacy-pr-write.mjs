import { readLivePullRequestIdentity } from '../github-pr-identity.mjs';
import { githubOwnerTokens } from '../github-owner-token.mjs';
import { runLegacyLaneWrite } from './legacy-lane-write.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

// Agent OS callers retain their original command. MGQ-08 remains the only
// route/issuance authority, using a live whole repository/base identity.
export async function runLegacyPrWrite({ rootDir, repository, prNumber, head, command, argv,
  readCandidate = readLivePullRequestIdentity, run = runLegacyLaneWrite, env = process.env, ...options }) {
  let writeEnv = env;
  const candidate = await readQueueEvidence({
    read: async ({ signal, timeoutMs }) => {
      const target = `repos/${repository}`;
      if (githubOwnerTokens.routedOwner(target)) {
        const started = performance.now();
        // Rescue and legacy dispatch have merge-agent authority. The generic
        // metered reader cannot infer that role from a default-owner token.
        const token = await githubOwnerTokens.select({ target, role: 'merge-agent', env,
          token: env.MERGE_AGENT_GH_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN });
        writeEnv = { ...env, GH_TOKEN: token, GITHUB_TOKEN: token };
        timeoutMs -= Math.ceil(performance.now() - started);
      }
      signal.throwIfAborted();
      return readCandidate(repository, prNumber, { rootDir, env: writeEnv, signal, timeoutMs });
    },
  }, {},
    loadAwareTimeoutMs(5000, { maxMs: 30000 }));
  if (!candidate || !candidate.baseBranch || !candidate.headSha) {
    return { ok: false, reason: 'malformed-or-mismatched-identity' };
  }
  if (candidate.prState !== 'open' || (head && candidate.headSha !== head)) {
    return { ok: false, reason: 'terminal-pr-or-head-changed' };
  }
  return run({ ...options, rootDir, repository, base: candidate.baseBranch, command, argv, env: writeEnv,
    subject: { prNumber, head: candidate.headSha } });
}
