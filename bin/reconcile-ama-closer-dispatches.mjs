#!/usr/bin/env node
import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { amaCloserDispatchDir, reconcileAmaCloserDispatches } from '../src/ama/dispatch-closer.mjs';

export async function main(args = process.argv.slice(2), options = {}) {
  let rootDir = process.cwd();
  let dryRun = false;
  let hqRoot = options.hqRoot;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--root-dir' && args[i + 1]) rootDir = resolve(args[++i]);
    else if (args[i] === '--hq-root' && args[i + 1]) hqRoot = resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const dir = amaCloserDispatchDir(rootDir);
  if (!dryRun && existsSync(dir) && typeof process.getuid === 'function') {
    const owner = (options.statSyncImpl || statSync)(dir).uid;
    if (owner !== process.getuid()) throw new Error(`Apply requires dispatch directory owner uid ${owner}`);
  }
  const { active, ...counts } = await reconcileAmaCloserDispatches(rootDir, {
    ...options, dryRun, hqRoot, capacityOnly: false,
  });
  const result = { dryRun, source: 'app-sdk', ...counts, active: active.length };
  (options.print || console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
