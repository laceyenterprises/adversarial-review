#!/usr/bin/env node
import { hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { proveConflictPrimary } from '../src/ama/conflict-primary.mjs';

const [reviewedHead, sourceHead, base] = process.argv.slice(2);
const decoder = new TextDecoder('utf-8', { fatal: true });
const git = async args => decoder.decode(hammerLocalGit(args));
try {
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const proof = await proveConflictPrimary({ reviewedHead, sourceHead, head, base, git });
  if (!proof) throw new Error('conflict-primary-unproven');
  process.stdout.write(`${JSON.stringify(proof)}\n`);
} catch {
  process.stderr.write('conflict-primary-unproven: retain the reviewed author commits and patches before publication\n');
  process.exitCode = 1;
}
