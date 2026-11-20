import { readLivePullRequestIdentity } from '../github-pr-identity.mjs';
import { runLegacyLaneWrite } from './legacy-lane-write.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

// Agent OS callers retain their original command. MGQ-08 remains the only
// route/issuance authority, using a live whole repository/base identity.
export async function runLegacyPrWrite({ rootDir, repository, prNumber, head, command, argv,
  readCandidate = readLivePullRequestIdentity, run = runLegacyLaneWrite, ...options }) {
  const candidate = await readQueueEvidence({
    read: ({ signal, timeoutMs }) => readCandidate(repository, prNumber, { rootDir, signal, timeoutMs }),
  }, {},
    loadAwareTimeoutMs(5000, { maxMs: 30000 }));
  if (!candidate || !candidate.baseBranch || !candidate.headSha) {
    return { ok: false, reason: 'malformed-or-mismatched-identity' };
  }
  if (candidate.prState !== 'open' || (head && candidate.headSha !== head)) {
    return { ok: false, reason: 'terminal-pr-or-head-changed' };
  }
  return run({ ...options, rootDir, repository, base: candidate.baseBranch, command, argv,
    subject: { prNumber, head: candidate.headSha } });
}
