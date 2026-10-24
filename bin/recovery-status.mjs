#!/usr/bin/env node
import { recoveryStatus } from '../src/recovery-status.mjs';
if (process.argv.slice(2).some(arg => arg !== '--json')) {
  console.error('Usage: node bin/recovery-status.mjs --json');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(await recoveryStatus(), null, process.argv.includes('--json') ? 0 : 2)); }
  catch {
    // Never echo driver/credential diagnostics from a read-only activation probe.
    console.log(JSON.stringify({ verdictSchemaVersion: 1, consumer: { active: false, sourceHealthy: false },
      budgets: {}, waitInventory: { missing: ['status-unavailable'] } }));
    process.exitCode = 2;
  }
}
