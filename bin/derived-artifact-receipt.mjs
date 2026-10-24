#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerArtifactReceipt } from '../src/ama/derived-artifact-receipt.mjs';

const [root, input, ...extra] = process.argv.slice(2);
if (!root || !input || extra.length) {
  process.stderr.write('usage: derived-artifact-receipt.mjs DAEMON_ROOT RECEIPT.json\n');
  process.exit(64);
}
try {
  process.stdout.write(registerArtifactReceipt(resolve(root), JSON.parse(readFileSync(input, 'utf8'))) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
