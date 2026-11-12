#!/usr/bin/env node
import { hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { proveConflictPrimary } from '../src/ama/conflict-primary.mjs';

// Exit 1 only when the proof shows a real primary-line conflict: the replay did
// not preserve the reviewed author commits. A proof without evidence (git or
// input failure) exits 75, inconclusive `conflict-primary-failed`.
const [reviewedHead, sourceHead, base] = process.argv.slice(2);
const decoder = new TextDecoder('utf-8', { fatal: true });
const git = async args => decoder.decode(hammerLocalGit(args));
let proof, refusal = 'unavailable';
try {
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  proof = await proveConflictPrimary({ reviewedHead, sourceHead, head, base, git, onRefusal: kind => { refusal = kind; } });
  if (!proof && refusal !== 'conflict') throw new Error('conflict-primary evidence unavailable');
} catch (error) {
  process.stderr.write('conflict-primary-failed: the preservation proof could not run; retry\n');
  process.stderr.write(`${error?.stderr || error?.message || String(error)}\n`);
  process.exit(75);
}
if (proof) process.stdout.write(`${JSON.stringify(proof)}\n`);
else {
  process.stderr.write('conflict-primary-unproven: retain the reviewed author commits and patches before publication\n'
    + 'conflict-primary-unproven\n');
  process.exitCode = 1;
}
