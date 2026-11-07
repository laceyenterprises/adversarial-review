#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded } from '../src/ama/bounded-command.mjs';
import { LEASE_VALIDATION_IDLE_MS, pytestValidationEnvironment } from '../src/ama/lease-validation.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';

import { reportHammerProgress, reportRemediationCommit } from '../src/ama/hammer-progress.mjs';
import { execFileSync } from 'node:child_process';
import { readRunClosureResume } from '../src/ama/closure-resume.mjs';

// CLOSERGATES-01: a closure-resume launch validated nothing new. While the
// checkout is still the receipt's validated head, that launch's evidence
// stands and the suite is not re-run. Any other head validates normally.
function closureResumeReceipt() {
  if (!process.env.HAM_RUN_DIR) return null;
  let head;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
  return readRunClosureResume(process.env.HAM_RUN_DIR, head);
}

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
let resumed;
if (!valid || args.shift() !== '--' || !args.length) {
  console.error('usage: hammer-validate.mjs [--pytest] [--nominal-timeout 1..3600] -- <test paths/pytest args OR command args>');
  process.exitCode = 64;
} else if ((resumed = closureResumeReceipt())) {
  const receipt = resumed;
  console.error(`hammer-validate: closure resume: head ${receipt.validatedHead} was validated by launch ${receipt.launchRequestId || 'unknown'}; reusing that evidence, not re-running validation.`);
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'ham-validation-'));
  try {
    reportRemediationCommit();
    const env = pytest ? pytestValidationEnvironment(process.env, scratch,
      join(dirname(fileURLToPath(import.meta.url)), 'pytest')) : process.env;
    process.exitCode = await runBounded(pytest ? 'python3' : args.shift(),
      pytest ? ['-u', '-m', 'pytest', '-p', 'ham_pytest_progress', ...args] : args,
      { env, timeoutMs: loadAwareTimeoutSeconds(nominalSeconds) * 1000, idleMs: LEASE_VALIDATION_IDLE_MS });
    // Timeouts, cleanup uncertainty, signals and spawn failures are unknown.
    if (process.env.HQ_WORKER_RUN_ID && process.exitCode >= 0 && process.exitCode < 124) {
      reportHammerProgress(process.exitCode === 0 ? 'validation-passed' : 'validation-failed');
    }
  } finally {
    if (process.exitCode === undefined || process.exitCode === 125) {
      console.error(`hammer-validate: scratch retained for canonical cleanup: ${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
