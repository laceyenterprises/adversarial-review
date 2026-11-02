import { fetchPrimaryChangeHistoryClassification } from './primary-change.mjs';

// Scan the whole PR range, not just its tip: a builder may already have pushed
// after the closer. This selects branch maintenance, never merge authority.
export async function capReheadUpdateMode(args) {
  if (!args.rootDir) throw new Error('Canonical runtime root is required for history classification');
  const evidence = await fetchPrimaryChangeHistoryClassification(args);
  if (evidence.hasHammerCommits === false) return 'merge-main';
  if (evidence.hasHammerCommits === true) return 'squash';
  throw new Error(`Cannot classify PR commit history: ${evidence.reason || 'unavailable'}`);
}
