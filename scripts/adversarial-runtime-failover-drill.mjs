#!/usr/bin/env node
// Failover-drill runner (ARC-09). Exercises the ARC-07 health router through a
// full kill → failover → restore → resume → reconcile cycle inside a SANDBOXED
// in-memory fixture harness, and asserts zero duplicate dispatches on resume.
//
// SAFETY: this drill NEVER contacts a live OS endpoint. The only session is an
// in-memory fake whose connectivity the drill toggles, so it is safe to run in
// CI and on any host. There is deliberately no "live endpoint" mode.
//
// By default it drills into a throwaway temp directory. Pass `--root <dir>` to
// leave the audit trail + status snapshot somewhere durable so you can then run
// `node src/cli.mjs runtime status --root <dir>` and see the failover/resume you
// just rehearsed.
//
// Exit code: 0 if every phase passed, 1 otherwise.

import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFailoverDrill } from '../src/adapters/agent-runtime/failover-drill.mjs';

function parseArgs(argv) {
  const options = { rootDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') options.rootDir = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err?.message || err}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write('Usage: adversarial-runtime-failover-drill [--root <dir>] [--json]\n');
    return 0;
  }

  const rootDir = options.rootDir || mkdtempSync(join(tmpdir(), 'runtime-failover-drill-'));
  const report = await runFailoverDrill({ rootDir });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`Failover drill @ ${rootDir}\n`);
    for (const phase of report.phases) {
      process.stdout.write(`  [${phase.ok ? 'PASS' : 'FAIL'}] ${phase.name}: ${phase.detail}\n`);
    }
    const m = report.metrics;
    process.stdout.write(
      `  metrics: os-dispatches=${m.osDispatchCount} distinct-os-keys=${m.distinctOsKeysDispatched} `
      + `local-runs=${m.localRunCount} adopted=${m.adopted} duplicated=${m.duplicated} `
      + `transitions=[${m.transitions.join(',')}]\n`,
    );
    process.stdout.write(`  result: ${report.ok ? 'PASS — failover, resume, and zero-duplicate all held' : 'FAIL'}\n`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

export { main };
