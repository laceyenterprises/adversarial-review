#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runLegacyPrWrite } from '../src/finalization/legacy-pr-write.mjs';

export async function legacyPrWriteMain(argv, { run = runLegacyPrWrite, stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = {};
  const keys = { '--root': 'rootDir', '--repo': 'repository', '--pr': 'prNumber', '--head': 'head' };
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1]) return 64;
    options[keys[argv[i]]] = argv[i + 1];
  }
  options.prNumber = Number(options.prNumber);
  if (!options.rootDir || !options.repository || !Number.isSafeInteger(options.prNumber) || options.prNumber < 1
    || argv[i] !== '--' || !argv[i + 1]) return 64;
  try {
    const result = await run({ ...options, command: argv[i + 1], argv: argv.slice(i + 2) });
    if (result?.ok === false) { stderr.write(`legacy PR write deferred: ${result.reason}\n`); return 75; }
    stdout.write(result.stdout || ''); stderr.write(result.stderr || ''); return 0;
  } catch (error) {
    stdout.write(error.stdout || '');
    stderr.write(error.stderr || 'legacy PR write unavailable; reconcile before retry\n');
    return Number.isInteger(error.code) ? error.code : 75;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await legacyPrWriteMain(process.argv.slice(2));
