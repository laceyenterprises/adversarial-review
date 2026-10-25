#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runLegacyLaneWrite } from '../src/finalization/legacy-lane-write.mjs';

export async function legacyLaneWriteMain(argv, { stdout = process.stdout, stderr = process.stderr, run = runLegacyLaneWrite } = {}) {
  const options = {};
  const keys = { '--root': 'rootDir', '--repo': 'repository', '--base': 'base' };
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1]) return 64;
    options[keys[argv[i]]] = argv[i + 1];
  }
  if (!options.rootDir || !options.repository || !options.base || argv[i] !== '--' || !argv[i + 1]) return 64;
  try {
    const commandArgs = argv.slice(i + 2);
    const headIndex = commandArgs.indexOf('--match-head-commit');
    const result = await run({ ...options, subject: { target: commandArgs.find(arg => /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(arg)) ?? null,
      head: headIndex >= 0 ? commandArgs[headIndex + 1] ?? null : null }, command: argv[i + 1], argv: argv.slice(i + 2) });
    if (result?.ok === false) { stderr.write(`legacy lane write refused: ${result.reason}\n`); return 75; }
    stdout.write(result.stdout || ''); stderr.write(result.stderr || ''); return 0;
  } catch (error) {
    stdout.write(error.stdout || '');
    stderr.write(error.stderr || `${error.message || 'legacy lane write failed; reconciliation may be required'}\n`);
    return Number.isInteger(error.code) ? error.code : Number.isInteger(error.status) ? error.status : 75;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await legacyLaneWriteMain(process.argv.slice(2));
