#!/usr/bin/env node
import { hammerWriterInputsChanged, readHammerWriterHold, reconcileHammerWriterHold,
  writerHoldDrainElapsed } from '../src/ama/hammer-writer-hold.mjs';

const [hqRoot, repo, prNumber, headSha, baseSha, baseRef, rootDir, leaseId] = process.argv.slice(2);
try {
  if (!hqRoot || !repo || !Number.isInteger(Number(prNumber)) || !/^[a-f0-9]{40}$/i.test(headSha || '')) {
    throw new TypeError('invalid writer-hold identity');
  }
  const hold = readHammerWriterHold(hqRoot, repo, Number(prNumber), headSha);
  if (hold && !hammerWriterInputsChanged(hold, { headSha, state: 'OPEN', baseSha, baseRef })) {
    if (writerHoldDrainElapsed(hold, Date.now())) {
      // Before acquisition permit only progress to the shared lease. The
      // post-acquire call below must re-read GitHub and append the fenced audit.
      if (!leaseId) process.exitCode = 0;
      else if (!await reconcileHammerWriterHold({ rootDir, hqRoot, repo, prNumber: Number(prNumber), hold,
        leaseId, now: Date.now(), readIdentityImpl: async () => {
          const { readLivePullRequestIdentity } = await import('../src/github-pr-identity.mjs');
          return readLivePullRequestIdentity(repo, Number(prNumber), { includeBaseSha: true });
        } })) process.exitCode = 75;
    } else process.exitCode = 75;
    if (process.exitCode === 75) console.error(`HAM writer handoff retained for ${repo}#${prNumber}@${headSha}, audit attempt ${hold.attemptNumber}.`);
  }
} catch {
  console.error('HAM writer audit unreadable; writer preflight could not establish merge state.');
  process.exitCode = 74;
}
