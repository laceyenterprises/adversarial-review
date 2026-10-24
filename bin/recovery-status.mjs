#!/usr/bin/env node
import { recoveryStatus } from '../src/recovery-status.mjs';
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--json') {
  console.error('Usage: node bin/recovery-status.mjs --json');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await recoveryStatus())); }
  catch {
    // Never echo driver/credential diagnostics from a read-only activation probe.
    console.log(JSON.stringify({ verdictSchemaVersion: 1, consumer: { active: false, sourceHealthy: false },
      budgets: {}, waitInventory: { missing: ['status-unavailable'] } }));
    process.exitCode = 2;
  }
}
