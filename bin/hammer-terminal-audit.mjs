#!/usr/bin/env node
import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';

// --final marks the run's last command: no retry, remediation or phase follows.
const args = process.argv.slice(2);
const final = args[0] === '--final';
const [reason, headSha] = final ? args.slice(1) : args;
if (!/^[a-z][a-z0-9:-]*$/.test(reason || '')) {
  process.stderr.write('usage: hammer-terminal-audit [--final] <reason-code> [head-sha]\n');
  process.exitCode = 64;
} else {
  try {
    if (!recordHammerEarlyFailure(reason, { headSha, final })) throw new Error('missing audit identity');
  } catch {
    process.stderr.write('HAM terminal failure audit unavailable\n');
    process.exitCode = 70;
  }
}
