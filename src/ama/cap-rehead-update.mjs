import { fetchPrimaryChange } from './primary-change.mjs';

// Scan the whole PR range, not just its tip: a builder may already have pushed
// after the closer. This selects branch maintenance, never merge authority.
export async function capReheadUpdateMode(args, options) {
  // Reuse primary-change's isHammerCommit and bounded complete-history reader.
  // The differing-merge-base refusal itself proves a hammer was found; this is
  // precisely the already-stranded history that the squash must recover.
  const evidence = await fetchPrimaryChange(args, options);
  if (evidence.hasHammerCommits === false) return 'merge-main';
  if (evidence.hasHammerCommits === true
    || evidence.reason === 'primary and final merge bases are missing or differ') return 'squash';
  throw new Error(`Cannot classify PR commit history: ${evidence.reason || 'unavailable'}`);
}
