#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded } from '../src/ama/bounded-command.mjs';
import { leaseValidationIdleMs, pytestValidationEnvironment } from '../src/ama/lease-validation.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';

import { reportHammerProgress, reportRemediationCommit } from '../src/ama/hammer-progress.mjs';
import { execFileSync } from 'node:child_process';
import { readRunClosureResume } from '../src/ama/closure-resume.mjs';
import { canonicalHammerValidation, ownPackageImportFault, repositoryPythonPackages } from '../src/ama/hammer-canonical-validation.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { ValidationSelectionError, UnsupportedPnpmWorkflowError } from '../src/ama/pnpm-validation.mjs';
import { writeFileAtomic } from '../src/atomic-write.mjs';

let closeReceipt = process.env.HAM_CLOSE_VALIDATION_RECEIPT;
const expectedHead = process.env.HAM_CLOSE_VALIDATION_HEAD;
const runDir = process.env.HAM_RUN_DIR;
const deferredOutcome = 'canonical-validation-deferred';

function gitOutput(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

const localHead = gitOutput('rev-parse', '--verify', 'HEAD');
const head = /^[a-f0-9]{40}$/.test(localHead || '') ? localHead : undefined;
const deferredPath = runDir && head ? join(runDir, `validation-deferred-${head}.json`) : null;
const receipt = { schemaVersion: 1, head, checks: [] };
let validationUnknown = false;
let ownsDeferral = false;

function validationDeferred() {
  if (!deferredPath || !existsSync(deferredPath)) return false;
  console.error(`hammer-validate: ${deferredOutcome}: ${deferredPath}`);
  process.exitCode = 75;
  return true;
}

function deferValidation(reason, status) {
  if (validationUnknown) return;
  validationUnknown = true;
  if (deferredPath) {
    try {
      writeFileAtomic(deferredPath, JSON.stringify({
        schemaVersion: 1, head, outcome: 'deferred', validation: 'unknown', reason, status,
        ...(closeReceipt ? { localValidationReceipt: closeReceipt } : {}),
        cleanupOwner: process.env.HAM_CONTROLLER_RECORD ? 'controller' : 'bounded-command',
      }), { mode: 0o600, overwrite: false });
    } catch (error) {
      if (error.code === 'EEXIST') return;
      console.error('hammer-validate: deferred validation receipt unavailable');
    }
  }
  ownsDeferral = true;
  console.error(`hammer-validate: ${deferredOutcome}: ${reason}; validation unknown. Check the existing cleanup receipt and hand off without retrying this head.`);
  // The controller can terminate this helper during teardown. Keep the
  // progress reason now and leave the potentially locked audit until after it.
  try { recordHammerPhase(deferredOutcome); } catch { /* The private receipt still records the reason. */ }
}

function writeValidationReceipt(value) {
  try { writeFileAtomic(closeReceipt, JSON.stringify(value), { mode: 0o600 }); return true; }
  catch { console.error('hammer-validate: local validation receipt unavailable'); return false; }
}

async function withMirrorSupport(runner, scratch) {
  const controlledReceipt = Boolean(process.env.HAM_CLOSE_VALIDATION_RECEIPT);
  const enabled = process.env.HAM_LOCAL_VALIDATION_CI_DEDUP !== '0'
    && (controlledReceipt || Boolean(runDir && head && /^[1-9]\d*$/.test(process.env.HAM_PR_NUMBER || '')));
  // A pre-close validation may include uncommitted remediation. Hosted jobs
  // cannot cover that checkout, even if Git HEAD still matches the PR.
  const cleanCheckout = () => gitOutput('status', '--porcelain', '--untracked-files=normal') === '';
  const matchingHead = controlledReceipt ? head === expectedHead
    : enabled && cleanCheckout();
  const planFile = join(scratch, 'ci-coverage.json');
  try {
    const { hammerValidationCoverage } = await import('../src/ama/hammer-validation-coverage.mjs');
    const plan = await hammerValidationCoverage({
      root: process.cwd(), repo: process.env.HAM_REPO, prNumber: process.env.HAM_PR_NUMBER,
      head: matchingHead ? head : undefined, enabled,
      // This optional probe reports unavailable coverage through validation.
      // Keep credential failures provisional, like a managed helper attempt.
      env: { ...process.env, HAM_HELPER_FAILURE_FILE: join(scratch, 'coverage-auth-failure') },
    });
    const checkoutMoved = !controlledReceipt && matchingHead
      && (gitOutput('rev-parse', '--verify', 'HEAD') !== head || !cleanCheckout());
    writeFileAtomic(planFile, JSON.stringify(checkoutMoved
      ? { reason: 'validation-head-unavailable', manifests: {} } : plan), { mode: 0o600 });
  } catch { /* The wrapper runs locally without coverage and still retains diagnostics. */ }
  return { ...runner, args: [fileURLToPath(new URL('./hammer-ci-mirror-validation.py', import.meta.url)),
    planFile, closeReceipt, ...runner.args] };
}

function readValidationReceipt() {
  try { return JSON.parse(readFileSync(closeReceipt, 'utf8')); }
  catch { return receipt; }
}

function finishValidationReceipt(runner, runnerExit, fallbackReason) {
  const observed = readValidationReceipt();
  const status = process.exitCode;
  if (!observed.checks.length && (!observed.perCheck || runnerExit !== 0)) {
    observed.checks.push({
      name: runner?.args[0] === 'scripts/ci-mirror/run-ci-mirror.py' ? 'CI mirror' : 'canonical validator',
      status: runnerExit === 0 ? 'run' : 'failed',
      reason: fallbackReason || (runner ? 'no-per-check-evidence' : 'validation-runner-unavailable'),
      ...(validationUnknown ? { result: 'inconclusive' } : {}),
      ...(runnerExit === undefined ? {} : { exitStatus: runnerExit }),
    });
  }
  delete observed.perCheck;
  // A timeout can kill the mirror before its last check records a result.
  for (const check of observed.checks) {
    if (check.status === 'run' && !check.result && runnerExit !== 0) {
      check.status = 'failed';
      if (validationUnknown) check.result = 'inconclusive';
      check.exitStatus = runnerExit;
      check.localReason = 'validation-interrupted';
    }
  }
  writeValidationReceipt({ ...observed, status });
}

// CLOSERGATES-01: a closure-resume launch validated nothing new. While the
// checkout is still the receipt's validated head, that launch's evidence
// stands and the suite is not re-run. Any other head validates normally.
const closureResumeReceipt = () => runDir && head ? readRunClosureResume(runDir, head) : null;

const args = process.argv.slice(2);
const checkDeferred = args.length === 1 && args[0] === '--check-deferred';
const usage = 'usage: hammer-validate.mjs --canonical [--nominal-timeout 1..3600] -- <changed repository-relative files>';
let pytest = false;
let canonical = /\/(?:agent-os|adversarial-review)$/.test(process.env.HAM_REPO || '');
let nominalSeconds = 360;
let explicitTimeout = false;
let valid = true;
while (!checkDeferred && args.length && args[0] !== '--') {
  const flag = args.shift();
  if (flag === '--pytest') pytest = true;
  else if (flag === '--canonical') canonical = true;
  else if (flag === '--nominal-timeout') {
    explicitTimeout = true;
    const raw = args.shift();
    nominalSeconds = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw || '') || !Number.isSafeInteger(nominalSeconds) || nominalSeconds > 3600) valid = false;
  } else { valid = false; break; }
}
let resumed;
if (checkDeferred) {
  validationDeferred();
} else if (!valid || args.shift() !== '--' || !args.length) {
  console.error(usage);
  process.exitCode = 64;
} else if (canonical && validationDeferred()) {
  // The exact head already has a handoff. Preserve its original evidence.
} else if ((resumed = closureResumeReceipt())) {
  const receipt = resumed;
  console.error(`hammer-validate: closure resume: head ${receipt.validatedHead} was validated by launch ${receipt.launchRequestId || 'unknown'}; reusing that evidence, not re-running validation.`);
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'ham-validation-'));
  let runner, runnerExit, fallbackReason;
  if (closeReceipt) writeValidationReceipt(receipt);
  try {
    reportRemediationCommit();
    const env = !canonical && pytest ? pytestValidationEnvironment(process.env, scratch,
      join(dirname(fileURLToPath(import.meta.url)), 'pytest')) : process.env;
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
        if (error instanceof UnsupportedPnpmWorkflowError) {
          console.error(error.message);
        } else if (error instanceof ValidationSelectionError) {
          console.error(error.message);
          recordHammerPhase('targeted-validation-failed');
          process.exitCode = 1;
          valid = false;
        } else if (error instanceof TypeError) {
          console.error(usage);
          process.exitCode = 64;
          valid = false;
        }
        // Git/filesystem/setup failures say nothing about the PR's tests.
        runner = null;
      }
    } else runner = { command: pytest ? 'python3' : args.shift(),
      args: pytest ? ['-u', '-m', 'pytest', '-p', 'ham_pytest_progress', ...args] : args };
    if (valid) {
      let output = '', packageImportFault = false, stopReason;
      let packages = new Set();
      try { if (canonical && !runner?.required) packages = repositoryPythonPackages(process.cwd()); }
      catch { runner = null; }
      const observeOutput = chunk => {
        output += String(chunk);
        packageImportFault ||= ownPackageImportFault(output, packages);
        output = output.slice(-8192);
      };
      const startedFile = join(scratch, 'pnpm-started');
      const mirror = runner?.args[0] === 'scripts/ci-mirror/run-ci-mirror.py';
      if (mirror && !closeReceipt) {
        // Evidence must survive removal of the validator's disposable scratch.
        const evidenceRoot = process.env.HAM_RUN_DIR || tmpdir();
        closeReceipt = join(await mkdtemp(join(evidenceRoot, 'ham-validation-evidence-')), 'local-validation.json');
        writeValidationReceipt(receipt);
        console.error(`hammer-validate: CI mirror evidence: ${closeReceipt}`);
      }
      const execution = mirror ? await withMirrorSupport(runner, scratch) : runner;
      const timeoutMs = loadAwareTimeoutSeconds(explicitTimeout ? nominalSeconds
        : runner?.nominalSeconds || nominalSeconds) * 1000;
      const deadline = Date.now() + timeoutMs;
      // A missing startup receipt distinguishes npm/tool provisioning from a
      // repository script failure. Retry startup once within the same budget.
      for (let attempt = 0; attempt < 2; attempt++) {
        const remainingMs = Math.max(1, deadline - Date.now());
        process.exitCode = execution ? await runBounded(execution.command, execution.args,
          { env: runner.startupReceipt ? { ...env, HAM_PNPM_VALIDATION_STARTED_FILE: startedFile } : env,
            timeoutMs: remainingMs, idleMs: leaseValidationIdleMs(remainingMs),
            observeOutput, stopOnTimeoutExit: mirror,
            observeStop: (reason, status) => {
              stopReason = reason;
              if (canonical && (status === 124 || status === 125)) deferValidation(reason, status);
            } }) : 127;
        if (!runner?.startupReceipt || existsSync(startedFile) || process.exitCode === 0
          || process.exitCode >= 124 || Date.now() >= deadline) break;
      }
      runnerExit = process.exitCode;
      const inspectionUnavailable = mirror && runnerExit === 75
        && readValidationReceipt().checks.some(check => check.localReason === 'process-inspection-unavailable');
      if (inspectionUnavailable) deferValidation('process-inspection-unavailable', runnerExit);
      if (canonical && runnerExit === 125 && !stopReason?.startsWith('canceled:')) {
        deferValidation('validation-drain-unconfirmed', runnerExit);
      }
      if (ownsDeferral) reportHammerEarlyFailure(deferredOutcome, { headSha: head });
      const startupFault = runner?.startupReceipt && !existsSync(startedFile)
        && ![124, 125, 130, 143].includes(process.exitCode);
      if (startupFault) {
        console.error('hammer-validate: validation-environment-failed; pnpm runner did not start.');
        recordHammerPhase('validation-environment-failed');
        process.exitCode = 78;
      }
      // The mirror's explicit failed-check status remains red if the receipt
      // could not be read. A later inconclusive result can also follow a red check.
      const realMirrorFailure = mirror && (runnerExit === 42
        || readValidationReceipt().checks.some(check => check.result === 'fail'));
      const environmentFault = canonical && !validationUnknown && !runner?.required && !realMirrorFailure
        && (!runner || [76, 78, 127].includes(process.exitCode)
          || (process.exitCode !== 0 && process.exitCode < 124 && packageImportFault));
      if (environmentFault) {
        fallbackReason = 'canonical-runner-environment-unavailable';
        console.error('hammer-validate: local-battery-skipped-github-required-gate-authoritative; canonical runner environment unavailable. Re-enter verify-head and require exact-head GitHub required checks; no local validation pass is claimed.');
        recordHammerPhase('local-battery-skipped-github-required-gate-authoritative');
        process.exitCode = 0;
      }
      // Timeouts, cleanup uncertainty, signals and spawn failures are unknown.
      if (!environmentFault && !startupFault && !validationUnknown && process.env.HQ_WORKER_RUN_ID
        && process.exitCode >= 0 && process.exitCode < 124) {
        reportHammerProgress(process.exitCode === 0 ? 'validation-passed' : 'validation-failed');
      }
    }
  } finally {
    if (closeReceipt) finishValidationReceipt(runner, runnerExit, fallbackReason);
    if (process.exitCode === undefined || process.exitCode === 125) {
      console.error(`hammer-validate: scratch retained for canonical cleanup: ${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
