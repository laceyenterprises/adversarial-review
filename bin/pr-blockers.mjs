#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfigCached } from '../src/config-loader.mjs';
import { collectPrBlockers, validateRepo } from '../src/pr-blockers-read.mjs';
import { formatPrBlockers } from '../src/pr-blockers.mjs';

export function parsePrBlockersArgs(argv) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: 'string', multiple: true },
    root: { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
    checkout: { type: 'string', multiple: true },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (!values.help && !values.repo?.length) throw new Error('at least one --repo owner/name is required');
  const checkouts = {};
  for (const entry of values.checkout || []) {
    const split = entry.indexOf('=');
    if (split < 1 || !entry.slice(split + 1)) throw new Error('--checkout requires owner/name=directory');
    checkouts[validateRepo(entry.slice(0, split))] = entry.slice(split + 1);
  }
  return { ...values, repos: (values.repo || []).map(validateRepo), checkouts };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parsePrBlockersArgs(argv);
  if (options.help) {
    process.stdout.write('Usage: node bin/pr-blockers.mjs --repo owner/name [--repo owner/other] [--json] [--root directory] [--checkout owner/name=directory]\n');
    return;
  }
  const report = await collectPrBlockers({ ...options, cfg: loadConfigCached() });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatPrBlockers(report));
  if (report.errors.length || report.rows.some(row => row.errors.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('pr-blockers: report unavailable; verify arguments, configuration, GitHub access and the review store\n');
    process.exitCode = 1;
  });
}
