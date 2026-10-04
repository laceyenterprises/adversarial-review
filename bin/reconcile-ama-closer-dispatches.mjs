#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconcileAmaCloserDispatches } from '../src/ama/dispatch-closer.mjs';

export async function main(args = process.argv.slice(2), options = {}) {
  let rootDir = process.cwd();
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--root-dir' && args[i + 1]) rootDir = resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  const { active, ...counts } = await reconcileAmaCloserDispatches(rootDir, { ...options, dryRun });
  const result = { dryRun, ...counts, active: active.length };
  (options.print || console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
