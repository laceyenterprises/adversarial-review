#!/usr/bin/env node
import { REPAIRABLE_CONFLICT, RepairableConflictError, recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';

// --final marks the run's last command: no retry, remediation or phase follows.
const args = process.argv.slice(2);
const final = args[0] === '--final';
const [reason, headSha] = final ? args.slice(1) : args;
if (!/^[a-z][a-z0-9:-]*$/.test(reason || '')) {
  process.stderr.write('usage: hammer-terminal-audit [--final] <reason-code> [head-sha]\n');
  process.exitCode = 64;
} else {
  try {
    const audit = recordHammerEarlyFailure(reason, { headSha, final });
    if (!audit && !(reason === REPAIRABLE_CONFLICT && !final)) throw new Error('missing audit identity');
  } catch (error) {
    if (error instanceof RepairableConflictError) {
      // CLOSERGATES-01: only the conflict head was recorded; the run is not over.
      process.stderr.write(`HAM: ${error.message}. Do not end the run. Run Appendix D: release the lease, rebase and resolve, publish the commit, revalidate, then re-enter verify-head. If a resolution is unsafe, stop with conflict-semantic-unsafe.\n`);
      process.exitCode = 65;
    } else {
      process.stderr.write('HAM terminal failure audit unavailable\n');
      process.exitCode = 70;
    }
  }
}
