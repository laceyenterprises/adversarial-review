#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded } from '../src/ama/bounded-command.mjs';
import { LEASE_VALIDATION_IDLE_MS, pytestValidationEnvironment } from '../src/ama/lease-validation.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';

const args = process.argv.slice(2);
let pytest = false;
let nominalSeconds = 360;
let valid = true;
while (args.length && args[0] !== '--') {
  const flag = args.shift();
  if (flag === '--pytest') pytest = true;
  else if (flag === '--nominal-timeout') {
    const raw = args.shift();
    nominalSeconds = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw || '') || !Number.isSafeInteger(nominalSeconds) || nominalSeconds > 3600) valid = false;
  } else { valid = false; break; }
}
if (!valid || args.shift() !== '--' || !args.length) {
  console.error('usage: hammer-validate.mjs [--pytest] [--nominal-timeout 1..3600] -- <test paths/pytest args OR command args>');
  process.exitCode = 64;
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'ham-validation-'));
  try {
    const env = pytest ? pytestValidationEnvironment(process.env, scratch,
      join(dirname(fileURLToPath(import.meta.url)), 'pytest')) : process.env;
    process.exitCode = await runBounded(pytest ? 'python3' : args.shift(),
      pytest ? ['-u', '-m', 'pytest', '-p', 'ham_pytest_progress', ...args] : args,
      { env, timeoutMs: loadAwareTimeoutSeconds(nominalSeconds) * 1000, idleMs: LEASE_VALIDATION_IDLE_MS });
  } finally {
    if (process.exitCode === undefined || process.exitCode === 125) {
      console.error(`hammer-validate: scratch retained for canonical cleanup: ${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
