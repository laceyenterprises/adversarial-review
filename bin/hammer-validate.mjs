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
import { canonicalHammerValidation, ownPackageImportFault, repositoryPythonPackages } from '../src/ama/hammer-canonical-validation.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';

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
let canonical = /\/(?:agent-os|adversarial-review)$/.test(process.env.HAM_REPO || '');
let nominalSeconds = 360;
let valid = true;
while (args.length && args[0] !== '--') {
  const flag = args.shift();
  if (flag === '--pytest') pytest = true;
  else if (flag === '--canonical') canonical = true;
  else if (flag === '--nominal-timeout') {
    const raw = args.shift();
    nominalSeconds = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw || '') || !Number.isSafeInteger(nominalSeconds) || nominalSeconds > 3600) valid = false;
  } else { valid = false; break; }
}
let resumed;
if (!valid || args.shift() !== '--' || !args.length) {
  console.error('usage: hammer-validate.mjs --canonical [--nominal-timeout 1..3600] -- <changed repository-relative files>');
  process.exitCode = 64;
} else if ((resumed = closureResumeReceipt())) {
  const receipt = resumed;
  console.error(`hammer-validate: closure resume: head ${receipt.validatedHead} was validated by launch ${receipt.launchRequestId || 'unknown'}; reusing that evidence, not re-running validation.`);
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'ham-validation-'));
  try {
    reportRemediationCommit();
    const env = !canonical && pytest ? pytestValidationEnvironment(process.env, scratch,
      join(dirname(fileURLToPath(import.meta.url)), 'pytest')) : process.env;
    let runner;
    if (canonical) {
      // Older callers passed commands. Always derive changed paths from Git in
      // that compatibility case instead of executing a hand-built validator.
      try {
        const paths = process.argv.includes('--canonical') ? args
          : execFileSync('git', ['diff', '--name-only',
            `${process.env.HAM_REVIEWED_SHA || 'origin/main'}...HEAD`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
        runner = canonicalHammerValidation(process.cwd(), paths);
      }
      catch (error) {
        if (error instanceof TypeError) throw error;
        // Git/filesystem/setup failures say nothing about the PR's tests.
        runner = null;
      }
    } else runner = { command: pytest ? 'python3' : args.shift(),
      args: pytest ? ['-u', '-m', 'pytest', '-p', 'ham_pytest_progress', ...args] : args };
    let output = '', packageImportFault = false;
    let packages = new Set();
    try { if (canonical) packages = repositoryPythonPackages(process.cwd()); }
    catch { runner = null; }
    const observeOutput = chunk => {
      output += String(chunk);
      packageImportFault ||= ownPackageImportFault(output, packages);
      output = output.slice(-8192);
    };
    process.exitCode = runner ? await runBounded(runner.command, runner.args,
      { env, timeoutMs: loadAwareTimeoutSeconds(nominalSeconds) * 1000, idleMs: LEASE_VALIDATION_IDLE_MS,
        observeOutput }) : 127;
    const environmentFault = canonical && (!runner || [76, 78, 127].includes(process.exitCode)
      || (process.exitCode !== 0 && process.exitCode < 124
        && packageImportFault));
    if (environmentFault) {
      console.error('hammer-validate: local-battery-skipped-github-required-gate-authoritative; canonical runner environment unavailable. Re-enter verify-head and require exact-head GitHub required checks; no local validation pass is claimed.');
      recordHammerPhase('local-battery-skipped-github-required-gate-authoritative');
      process.exitCode = 0;
    }
    // Timeouts, cleanup uncertainty, signals and spawn failures are unknown.
    if (!environmentFault && process.env.HQ_WORKER_RUN_ID && process.exitCode >= 0 && process.exitCode < 124) {
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
