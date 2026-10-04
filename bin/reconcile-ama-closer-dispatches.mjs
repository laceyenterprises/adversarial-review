#!/usr/bin/env node
import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSessionLedgerReadTarget } from '../src/session-ledger-read-adapter.mjs';
import { amaCloserDispatchDir, reconcileAmaCloserDispatches } from '../src/ama/dispatch-closer.mjs';

export async function main(args = process.argv.slice(2), options = {}) {
  let rootDir = process.cwd();
  let dryRun = false;
  let hqRoot = options.hqRoot;
  let ledgerTarget = options.ledgerTarget;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--root-dir' && args[i + 1]) rootDir = resolve(args[++i]);
    else if (args[i] === '--hq-root' && args[i + 1]) hqRoot = resolve(args[++i]);
    else if (args[i] === '--ledger-target' && args[i + 1]) ledgerTarget = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const dir = amaCloserDispatchDir(rootDir);
  if (!dryRun && existsSync(dir) && typeof process.getuid === 'function') {
    const owner = (options.statSyncImpl || statSync)(dir).uid;
    if (owner !== process.getuid()) throw new Error(`Apply requires dispatch directory owner uid ${owner}`);
  }
  const resolution = resolveSessionLedgerReadTarget({
    rootDir, hqRoot, ledgerTarget, ledgerDbPath: options.ledgerDbPath,
    env: options.env || process.env,
  });
  if (!resolution.ok) throw new Error(`Cannot resolve session ledger: ${resolution.reason}`);
  const { active, ...counts } = await reconcileAmaCloserDispatches(rootDir, {
    ...options, dryRun, hqRoot, ledgerTarget: resolution.target, capacityOnly: false,
  });
  // Do not expose a Postgres DSN, which may contain credentials.
  const ledger = { backend: resolution.target.backend, source: resolution.target.source };
  const result = { dryRun, ledger, ...counts, active: active.length };
  (options.print || console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
