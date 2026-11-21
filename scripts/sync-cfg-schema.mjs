#!/usr/bin/env node
// ONS-07: vendor the CFG JSON Schema that agent-os generates (ONS-02) into
// src/generated/config.schema.json. Usage:
//   node scripts/sync-cfg-schema.mjs <agent-os-root> [--check]
// The copy is the parsed source re-serialized without indentation; compare it
// with the source by parsed equality, never by bytes. --check exits 1 on drift.
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

const [root, flag] = process.argv.slice(2);
if (!root) {
  process.stderr.write('usage: sync-cfg-schema.mjs <agent-os-root> [--check]\n');
  process.exit(2);
}
const source = JSON.parse(readFileSync(join(root, 'platform/contracts/generated/config.schema.json'), 'utf8'));
const target = new URL('../src/generated/config.schema.json', import.meta.url);
if (flag === '--check') {
  const vendored = JSON.parse(readFileSync(target, 'utf8'));
  const same = isDeepStrictEqual(source, vendored);
  process.stdout.write(`${same ? 'in sync' : 'DRIFT'}\n`);
  process.exit(same ? 0 : 1);
}
writeFileSync(target, `${JSON.stringify(source)}\n`);
process.stdout.write(`wrote ${target.pathname}\n`);
