#!/usr/bin/env node
// Run the versioned HAM shell procedures with dispatch values supplied as HAM_* env.
// Keep the transcript small even if a GitHub or git command is noisy.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const phases = new Set(['hammer-verify-head', 'hammer-publish', 'hammer-merge']);
const phase = process.argv[2];
if (!phases.has(phase) || process.argv[3] !== '--render' || process.argv.length !== 4) {
  process.stderr.write('usage: hammer-procedure.mjs <hammer-verify-head|hammer-publish|hammer-merge> --render\n');
  process.exit(64);
}
const path = join(dirname(fileURLToPath(import.meta.url)), `${phase}.sh`);
let source = readFileSync(path, 'utf8');
const missing = new Set();
source = source.replace(/<<([A-Z_]+)>>/g, (_match, key) => {
  const value = process.env[`HAM_${key}`];
  if (value === undefined || value === '') {
    missing.add(key);
    return '';
  }
  return value;
});
if (missing.size) {
  process.stderr.write(`missing dispatch values: ${[...missing].join(', ')}\n`);
  process.exit(64);
}
process.stdout.write(source);
