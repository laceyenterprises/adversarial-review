#!/usr/bin/env node
import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';

const [reason, headSha] = process.argv.slice(2);
if (!/^[a-z][a-z0-9:-]*$/.test(reason || '')) {
  process.stderr.write('usage: hammer-terminal-audit <reason-code> [head-sha]\n');
  process.exitCode = 64;
} else {
  try {
    if (!recordHammerEarlyFailure(reason, { headSha })) throw new Error('missing audit identity');
  } catch {
    process.stderr.write('HAM terminal failure audit unavailable\n');
    process.exitCode = 70;
  }
}
