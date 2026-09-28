#!/usr/bin/env node
// Run the versioned HAM shell procedures with dispatch values supplied as HAM_* env.
// Keep the transcript small even if a GitHub or git command is noisy.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const phases = new Set(['hammer-verify-head', 'hammer-publish', 'hammer-merge']);
const phase = process.argv[2];
const renderOnly = process.argv[3] === '--render';
if (!phases.has(phase) || (process.argv.length !== 3 && !(process.argv.length === 4 && renderOnly))) {
  process.stderr.write('usage: hammer-procedure.mjs <hammer-verify-head|hammer-publish|hammer-merge> [--render]\n');
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
if (renderOnly) {
  process.stdout.write(source);
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'hammer-procedure-'));
const log = join(dir, `${basename(path)}.log`);
const fd = openSync(log, 'w+', 0o600);
try {
  const result = spawnSync('/bin/bash', ['-s'], {
    input: source,
    stdio: ['pipe', fd, fd],
    env: process.env,
    timeout: 30 * 60 * 1000,
  });
  const size = statSync(log).size;
  const bytes = Math.min(size, 4096);
  const tail = Buffer.alloc(bytes);
  readSync(fd, tail, 0, bytes, size - bytes);
  process.stdout.write(tail);
  if (size > bytes) process.stdout.write(`\n[${size - bytes} earlier bytes omitted]\n`);
  if (result.error?.code === 'ETIMEDOUT') process.exitCode = 124;
  else process.exitCode = result.status ?? 1;
} finally {
  closeSync(fd);
  rmSync(dir, { recursive: true, force: true });
}
