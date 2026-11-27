import { readLivePullRequestIdentity } from '../github-pr-identity.mjs';
import { githubOwnerTokens } from '../github-owner-token.mjs';
import { runLegacyLaneWrite } from './legacy-lane-write.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { runCommandKeepingOutput } from '../run-command-keeping-output.mjs';
import { REVIEWER_TOKEN_REFRESH_SKEW_MS } from '../reviewer-broker-refresh.mjs';

function ownerCommandEnv(env, token) {
  const child = { ...env };
  // Drop home credentials and their refresh/expiry metadata, including reviewer
  // aliases. Entitled children must not refresh back into the home installation.
  for (const key of Object.keys(child)) {
    if (/^(?:\w*(?:GH|GITHUB)_TOKEN|GH_\w+_TOKEN)(?:_\w+)?$/i.test(key)) delete child[key];
  }
  return { ...child, GH_TOKEN: token, GITHUB_TOKEN: token };
}

// Agent OS callers retain their original command. MGQ-08 remains the only
// route/issuance authority, using a live whole repository/base identity.
export async function runLegacyPrWrite({ rootDir, repository, prNumber, head, command, argv,
  readCandidate = readLivePullRequestIdentity, run = runLegacyLaneWrite, env = process.env, ...options }) {
  let writeEnv = env;
  const identityTimeoutMs = loadAwareTimeoutMs(5000, { maxMs: 30000 });
  const target = `repos/${repository}`;
  const routed = githubOwnerTokens.routedOwner(target);
  let exec = options.exec;
  if (routed) {
    const selection = { target, env,
      token: env.MERGE_AGENT_GH_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN,
      // Only an explicitly entitled source grants merge-agent authority.
      // Recorded service tokens and reviewer tokens use normal role inference.
      role: env.MERGE_AGENT_GH_TOKEN ? 'merge-agent' : undefined };
    // Broker headers/body already have their own bounded timeout. Mint before
    // starting the separate identity-read clock.
    writeEnv = ownerCommandEnv(env, await githubOwnerTokens.select({ ...selection,
      minValidityMs: REVIEWER_TOKEN_REFRESH_SKEW_MS + identityTimeoutMs }));
    const execute = exec ?? runCommandKeepingOutput;
    exec = async (command, argv, child) => {
      // Lane contention can outlive the first token. Check again at launch;
      // include termination grace and two minutes of slack in the handoff floor.
      const token = await githubOwnerTokens.select({ ...selection,
        minValidityMs: Math.ceil(child.timeout + child.killGraceMs + 120_000) });
      return execute(command, argv, { ...child, env: ownerCommandEnv(child.env ?? writeEnv, token) });
    };
  }
  const candidate = await readQueueEvidence({
    read: async ({ signal, timeoutMs }) => {
      signal.throwIfAborted();
      return readCandidate(repository, prNumber, { rootDir, env: writeEnv, signal, timeoutMs });
    },
  }, {},
    identityTimeoutMs);
  if (!candidate || !candidate.baseBranch || !candidate.headSha) {
    return { ok: false, reason: 'malformed-or-mismatched-identity' };
  }
  if (candidate.prState !== 'open' || (head && candidate.headSha !== head)) {
    return { ok: false, reason: 'terminal-pr-or-head-changed' };
  }
  return run({ ...options, ...(exec ? { exec } : {}), rootDir, repository, base: candidate.baseBranch, command, argv, env: writeEnv,
    subject: { prNumber, head: candidate.headSha } });
}
