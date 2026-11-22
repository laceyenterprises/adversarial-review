#!/usr/bin/env node
// ONS-07: vendor the CFG outputs that agent-os generates (ONS-02) into
// src/generated/: config.schema.json (the JSON Schema) and config.env.json
// (the env alias table). Usage:
//   node scripts/sync-cfg-schema.mjs <agent-os-root> [--check]
// Files are copied verbatim; --check compares them by parsed equality and exits
// 1 on drift.
import { copyFileSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['config.schema.json', 'config.env.json'];
const args = process.argv.slice(2);
const roots = args.filter(arg => !arg.startsWith('--'));
const [root] = roots;
const check = args.includes('--check');
if (roots.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--check')) {
  process.stderr.write('usage: sync-cfg-schema.mjs <agent-os-root> [--check]\n');
  process.exit(2);
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));
let drift = false;
for (const name of FILES) {
  const source = join(root, 'platform/contracts/generated', name);
  const target = new URL(`../src/generated/${name}`, import.meta.url);
  if (check) {
    const same = isDeepStrictEqual(read(source), read(target));
    drift ||= !same;
    process.stdout.write(`${name}: ${same ? 'in sync' : 'DRIFT'}\n`);
  } else {
    copyFileSync(source, target);
    process.stdout.write(`wrote ${fileURLToPath(target)}\n`);
  }
}
process.exit(drift ? 1 : 0);
