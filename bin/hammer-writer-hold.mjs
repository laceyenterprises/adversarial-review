#!/usr/bin/env node
import { hammerWriterInputsChanged, readHammerWriterHold } from '../src/ama/hammer-writer-hold.mjs';

const [hqRoot, repo, prNumber, headSha, baseSha, baseRef] = process.argv.slice(2);
try {
  const hold = readHammerWriterHold(hqRoot, repo, Number(prNumber), headSha);
  if (hold && !hammerWriterInputsChanged(hold, { headSha, state: 'OPEN', baseSha, baseRef })) {
    console.error(`HAM writer handoff already recorded for ${repo}#${prNumber}@${headSha}, audit attempt ${hold.attemptNumber}.`);
    process.exitCode = 75;
  }
} catch {
  console.error('HAM writer audit unreadable; cannot establish whether a merge write needs reconciliation.');
  process.exitCode = 75;
}
