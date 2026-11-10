import { fetchMergeAgentCandidate } from '../merge-agent-candidate.mjs';
import { runLegacyLaneWrite } from './legacy-lane-write.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

// Agent OS callers retain their original command. MGQ-08 remains the only
// route/issuance authority, using a live whole repository/base identity.
export async function runLegacyPrWrite({ rootDir, repository, prNumber, head, command, argv,
  readCandidate = fetchMergeAgentCandidate, run = runLegacyLaneWrite, ...options }) {
  const candidate = await readQueueEvidence({ read: () => readCandidate(repository, prNumber, { rootDir }) }, {},
    loadAwareTimeoutMs(5000, { maxMs: 30000 }));
  if (!candidate || candidate.prState !== 'open' || !candidate.baseBranch
    || (head && candidate.headSha !== head)) return { ok: false, reason: 'terminal-pr-or-head-changed' };
  return run({ ...options, rootDir, repository, base: candidate.baseBranch, command, argv,
    subject: { prNumber, head: candidate.headSha } });
}
