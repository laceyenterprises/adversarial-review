#!/usr/bin/env node
import { runBounded } from '../src/ama/bounded-command.mjs';

const args = process.argv.slice(2);
const options = { timeoutMs: 900_000, tailBytes: 4096 };
const keys = { '--timeout': 'timeoutMs', '--idle-timeout': 'idleMs', '--tail-bytes': 'tailBytes' };
let valid = true;
while (args.length && args[0] !== '--') {
  const key = keys[args.shift()];
  const raw = args.shift();
  if (!key || !/^[1-9][0-9]*$/.test(raw || '')) { valid = false; break; }
  options[key] = Number(raw) * (key === 'tailBytes' ? 1 : 1000);
}
// Generic builds may be silent. The lease validator explicitly fixes idle at 120s.
options.idleMs ??= options.timeoutMs;
if (args.shift() !== '--' || !args.length || !valid || options.tailBytes > 8192
  || Object.values(options).some(value => !Number.isSafeInteger(value) || value > 2 ** 31 - 1)) {
  console.error('usage: run-bounded.sh [--timeout seconds] [--idle-timeout seconds] [--tail-bytes 1..8192] -- command [args...]');
  process.exitCode = 64;
} else {
  process.exitCode = await runBounded(args.shift(), args, options);
}
