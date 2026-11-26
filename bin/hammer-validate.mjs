#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runBounded } from '../src/ama/bounded-command.mjs';
import { leaseValidationIdleMs, pytestValidationEnvironment } from '../src/ama/lease-validation.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';
import { nodeTestWorkerLimit } from '../src/node-test-concurrency.mjs';

import { reportHammerProgress, reportRemediationCommit } from '../src/ama/hammer-progress.mjs';
import { execFileSync } from 'node:child_process';
import { readRunClosureResume } from '../src/ama/closure-resume.mjs';
import { canonicalHammerValidation, ownPackageImportFault, repositoryPythonPackages } from '../src/ama/hammer-canonical-validation.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { ValidationSelectionError, UnsupportedPnpmWorkflowError } from '../src/ama/pnpm-validation.mjs';
import { writeFileAtomic } from '../src/atomic-write.mjs';
import { loadEffectiveMergeAuthorityConfig } from '../src/ama/effective-policy.mjs';
import { conflictPublishBinding } from '../src/ama/hammer-conflict-binding.mjs';
import { createValidationScratch, reapValidationScratch, validationScratchEnv } from '../src/ama/hammer-validation-scratch.mjs';
import { isSocketPathFailure, SOCKET_PATH_HARNESS_FAULT } from '../src/harness-fault.mjs';
import { CI_AUTHORITATIVE_UNKNOWN_REASONS, PROCESS_INSPECTION_UNAVAILABLE, declaredRequiredContexts, finalizedUnknownDefersToCi, processInspectionRefused, readDeferredValidationChecks, readUnknownValidationReceipt,
  recordedUnknownDefersToCi, unknownDefersToCi, unknownValidationReceiptPath } from '../src/ama/local-validation-unknown.mjs';
import { assertHammerController, controllerLaunchId } from '../src/ama/hammer-controller.mjs';
import { NODE_PIN_UNAVAILABLE, NODE_PIN_UNDECLARED, NODE_PIN_UNAVAILABLE_EXIT, NODE_PIN_UNDECLARED_EXIT,
  resolveValidationNode, strictNodePinRepository, validationNodeEnvironment } from '../src/ama/hammer-node-pin.mjs';
import { CUSTODY_REDRIVE_FILE } from '../src/ama/custody-redrive.mjs';
import { continueDeferredSourceCustody, deferredSourceIdentity, deferredSourceNotice, findDeferredSourceHold, readDeferredSourceHold, retainDeferredCommit,
  retainDeferredValidation, startDeferredSourceCustody } from '../src/ama/deferred-source-custody.mjs';

let closeReceipt = process.env.HAM_CLOSE_VALIDATION_RECEIPT;
const expectedHead = process.env.HAM_CLOSE_VALIDATION_HEAD;
const runDir = process.env.HAM_RUN_DIR;
const mirrorScript = 'scripts/ci-mirror/run-ci-mirror.py';
const deferredOutcome = 'canonical-validation-deferred';
const ciAuthoritativeOutcome = 'local-validation-unknown-github-required-gate-authoritative';

function gitOutput(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

const localHead = gitOutput('rev-parse', '--verify', 'HEAD');
const head = /^[a-f0-9]{40}$/.test(localHead || '') ? localHead : undefined;
const deferredPath = unknownValidationReceiptPath(runDir, head);
const receipt = { schemaVersion: 1, head, checks: [] };
let validationUnknown = false;
let ownsDeferral = false;
let ownsReceipt = false;
let ciAuthoritative = false;
let deferral;
let localTestFailure = false;
let custodyDir;
let validationCleanup;
let validationRunner;
let validationFiles;
let startedClean = false;
let binding;
const cleanCheckout = () => gitOutput('status', '--porcelain', '--untracked-files=normal') === '';
let launchRequestId;
try { launchRequestId = controllerLaunchId(process.env); } catch { /* Standalone invocation. */ }

// MRQ-20: the exact-head contexts an UNKNOWN result defers to. An unreadable
// configuration declares none, so UNKNOWN keeps its existing deferral.
let requiredContextsCache;
function requiredContexts() {
  if (requiredContextsCache === undefined) {
    try { requiredContextsCache = declaredRequiredContexts(loadEffectiveMergeAuthorityConfig(), process.env.HAM_REPO); }
    catch { requiredContextsCache = []; }
  }
  return requiredContextsCache;
}

function conflictBinding() {
  const binding = conflictPublishBinding(runDir, () => head);
  return binding?.source !== head ? binding : null;
}

function matchingHold(binding) {
  const env = binding ? { ...process.env, HAM_CLOSE_VALIDATION_REMOTE_HEAD: binding.source } : process.env;
  return findDeferredSourceHold(env);
}

function ownsHold(hold) {
  return !hold || (!hold.unreadable && hold.launchRequestId === launchRequestId && hold.sourceHead === head);
}

function controllerDrain(recorded) {
  const name = recorded.controllerRecord;
  if (!name && recorded.cleanupConfirmed === true) return 'finished';
  if (!/^controller-[a-f0-9-]{36}\.json$/.test(name || '')) return 'unconfirmed';
  try {
    const path = join(runDir, name);
    const controller = JSON.parse(readFileSync(path, 'utf8'));
    if (!launchRequestId || controller.launchRequestId !== launchRequestId) return 'unconfirmed';
    if (path === process.env.HAM_CONTROLLER_RECORD && ['running', 'stopping'].includes(controller.state)) {
      return 'draining';
    }
    if (controller.state === 'quiescent' && controller.drained === true
      && (controller.reason === 'validation-stopped'
        || (controller.reason === 'shell-exited'
          && ['validation-killed', 'validation-budget-exceeded', NODE_PIN_UNAVAILABLE].includes(recorded.reason)))
      && (controller.leaseCleanup?.released === true
        || ['already-released', 'no-acquisition-receipt'].includes(controller.leaseCleanup?.reason))) return 'finished';
  } catch { /* An incomplete registration does not certify drain. */ }
  return 'unconfirmed';
}

function completeCoverage(observed) {
  return observed?.head === head && observed.selectedCheckCount > 0
    && observed.selectedCheckCount === observed.checks.length
    && (observed.checks.some(check => check.status === 'ci-covered')
      ? observed.coverage?.head === head && observed.coverage.repo === process.env.HAM_REPO
        && observed.coverage.prNumber === Number(process.env.HAM_PR_NUMBER)
      : true)
    && observed.checks.every(check => check.status === 'ci-covered'
      ? check.reason === 'exact-head-ci-success' && check.result !== 'fail'
      : check.result === 'pass');
}

function conflictRebasePublication(binding = conflictBinding()) {
  if (!binding) return 'none';
  if (!cleanCheckout() || !ownsHold(matchingHold(binding))) return 'blocked';
  const recorded = readUnknownValidationReceipt(runDir, head);
  if (!recorded) return 'validate';
  if (recorded.validation !== 'unknown' || recorded.localFailureObserved !== false || recorded.cleanCheckout !== true
    || !CI_AUTHORITATIVE_UNKNOWN_REASONS.includes(recorded.reason)) return 'blocked';
  const drain = controllerDrain(recorded);
  if (drain !== 'finished') return drain === 'draining' ? drain : 'blocked';
  try {
    // The mirror can report a failure while the group is stopping. Read the
    // final check receipt after drain, before deciding whether source can move.
    const evidence = readDeferredValidationChecks(runDir, head, recorded);
    if (!evidence) return 'blocked';
    const coverageComplete = completeCoverage(evidence);
    // HAMCIAUTH-01: partial coverage with no observed failure defers to CI.
    const decision = unknownDefersToCi({ reason: recorded.reason, requiredContexts: requiredContexts(),
      checks: evidence.checks, cleanCheckout: true });
    if (['local-failure-observed', PROCESS_INSPECTION_UNAVAILABLE].includes(decision.reason)) return 'blocked';
    if (!decision.ciAuthoritative) return 'redrive';
    if (!recordedUnknownDefersToCi(recorded, requiredContexts())) {
      deferral = { ...recorded, ...decision, coverageComplete, cleanup: drain };
      if (!writeDeferral(true)) return 'blocked';
    }
    return 'ci';
  } catch { return 'blocked'; }
}

// The hold a controller-run validator started. Its target can be the live head
// the controller passed in, not this shell's dispatch head.
function recordedControllerHold(recorded) {
  if (!runDir || !/^controller-[a-f0-9-]{36}\.json$/.test(recorded.controllerRecord || '')) return null;
  let headSha;
  try { ({ headSha } = JSON.parse(readFileSync(join(runDir, `deferred-controller-${recorded.controllerRecord}`), 'utf8'))); }
  catch (error) { return error.code === 'ENOENT' ? null : { unreadable: true }; }
  return readDeferredSourceHold(process.env.HAM_HQ_ROOT, { ...deferredSourceIdentity(process.env), headSha });
}

// HAMCIAUTH-01: a validator stopped by its controller cannot record CI
// authority itself. The round's group, including the validator, drains only
// after the stop. Once the controller certifies that drain, re-judge the
// recorded UNKNOWN from the final check receipt. A qualifying head continues
// its source custody instead of parking for an operator, and the close
// publishes it and waits for its exact-head required contexts.
function rejudgeAfterDrain(recorded) {
  if (!recorded || recorded.unreadable || recorded.validation !== 'unknown' || recorded.head !== head
    || gitOutput('rev-parse', '--verify', 'HEAD') !== head) return false;
  if (recorded.controllerRecord ? controllerDrain(recorded) !== 'finished' : recorded.cleanup !== 'finished') return false;
  let evidence;
  try { evidence = readDeferredValidationChecks(runDir, head, recorded); } catch { return false; }
  if (!evidence) return false;
  const decision = unknownDefersToCi({ reason: recorded.reason, requiredContexts: requiredContexts(),
    localFailureObserved: recorded.localFailureObserved !== false, checks: evidence.checks,
    cleanCheckout: recorded.cleanCheckout === true });
  if (!decision.ciAuthoritative) return false;
  const holds = new Map();
  for (const hold of [recordedControllerHold(recorded), findDeferredSourceHold(process.env)]) {
    if (hold && !hold.continuedAt) holds.set(hold.path, hold);
  }
  try {
    for (const hold of holds.values()) {
      if (!ownsHold(hold) || !continueDeferredSourceCustody(hold)) return false;
    }
  } catch { return false; }
  deferral = { ...recorded, ...decision, localFailureObserved: false, cleanup: 'finished',
    coverageComplete: completeCoverage(evidence) };
  return writeDeferral(true);
}

function validationDeferred() {
  const binding = conflictBinding();
  let hold = matchingHold(binding);
  let recorded = readUnknownValidationReceipt(runDir, head);
  if (!hold && !recorded) return false;
  const exactHead = (!expectedHead || expectedHead === head) && cleanCheckout();
  if (exactHead && !binding && !recordedUnknownDefersToCi(recorded, requiredContexts()) && rejudgeAfterDrain(recorded)) {
    hold = matchingHold(binding);
    recorded = readUnknownValidationReceipt(runDir, head);
  }
  if (exactHead && !hold
    && finalizedUnknownDefersToCi(runDir, head, recorded, requiredContexts())
    && (!binding || conflictRebasePublication(binding) === 'ci')) {
    console.error(`hammer-validate: ${ciAuthoritativeOutcome}: ${deferredPath}; no local pass is claimed. Proceed to the close; it merges only when this exact head's declared required GitHub contexts are all green.`);
    process.exitCode = 0;
    return true;
  }
  if (hold) console.error(`hammer-validate: ${deferredSourceNotice(hold)}`);
  console.error(`hammer-validate: ${deferredOutcome}: ${hold?.path || deferredPath}`);
  process.exitCode = 75;
  return true;
}

// A failed mirror check row or a TAP `not ok` line is a genuine local failure.
function localFailureObserved() {
  return localTestFailure || readValidationReceipt().checks?.some(check => check.result === 'fail') === true;
}

function writeDeferral(overwrite) {
  if (!deferredPath) return true;
  try {
    writeFileAtomic(deferredPath, JSON.stringify({
      schemaVersion: 1, head, outcome: 'deferred', validation: 'unknown', ...deferral,
      ...(closeReceipt && !deferral.localValidationReceipt ? { localValidationReceipt: closeReceipt } : {}),
      cleanupOwner: deferral.cleanupOwner || (process.env.HAM_CONTROLLER_RECORD ? 'controller' : 'bounded-command'),
    }), { mode: 0o600, overwrite });
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    console.error('hammer-validate: deferred validation receipt unavailable');
    return false;
  }
  return true;
}

function deferValidation(reason, status) {
  if (validationUnknown) return;
  validationUnknown = true;
  const localFailure = localFailureObserved();
  deferral = { reason, status, ciAuthoritative: false, requiredContexts: requiredContexts(),
    localFailureObserved: localFailure };
  // HAMCIAUTH-01: CI can only judge a committed remediation at this exact head.
  deferral.cleanCheckout = startedClean && cleanCheckout() && gitOutput('rev-parse', '--verify', 'HEAD') === head;
  if (process.env.HAM_CONTROLLER_RECORD) deferral.controllerRecord = basename(process.env.HAM_CONTROLLER_RECORD);
  ownsReceipt = writeDeferral(false);
  const existing = ownsReceipt ? null : readUnknownValidationReceipt(runDir, head);
  if (existing) return;
  ownsDeferral = true;
  console.error(`hammer-validate: ${deferredOutcome}: ${reason}; validation unknown. Check the existing cleanup receipt and hand off without retrying this head.`);
  // The controller can terminate this helper during teardown. Keep the
  // progress reason now and leave the potentially locked audit until after it.
  if (process.env.HAM_CONTROLLER_RECORD) {
    try { recordHammerPhase(deferredOutcome); } catch { /* The private receipt still records the reason. */ }
  }
  if (runDir && existsSync(join(runDir, CUSTODY_REDRIVE_FILE))) return;
  try {
    const env = binding ? {
      ...process.env,
      HAM_CLOSE_VALIDATION_REMOTE_HEAD: binding.source,
      ...(binding.base && { HAM_CLOSE_VALIDATION_BASE: binding.base }),
    } : process.env;
    custodyDir = startDeferredSourceCustody({ env, launchRequestId, sourceHead: head,
      clean: startedClean && cleanCheckout() && gitOutput('rev-parse', '--verify', 'HEAD') === head,
      files: validationFiles, runner: validationRunner });
    if (custodyDir && runDir && process.env.HAM_CONTROLLER_RECORD) {
      writeFileAtomic(join(runDir, `deferred-controller-${basename(process.env.HAM_CONTROLLER_RECORD)}`),
        JSON.stringify({ headSha: deferredSourceIdentity(env).headSha }), { mode: 0o600 });
    }
    retainValidationEvidence();
    if (custodyDir) console.error(`hammer-validate: retained deferred source and evidence: ${custodyDir}`);
  } catch (error) {
    console.error(`hammer-validate: deferred source custody incomplete (${error.code || 'unknown'})`);
  }
}

function retainValidationEvidence() {
  if (!custodyDir) return;
  const evidence = readExactValidationReceipt();
  if (!evidence) return;
  retainDeferredValidation(custodyDir, { head, validation: 'unknown', ...deferral }, evidence, closeReceipt);
  if (validationCleanup) {
    writeFileAtomic(join(custodyDir, 'bounded-cleanup.json'),
      JSON.stringify({ head, launchRequestId, ...validationCleanup }), { mode: 0o600 });
  }
}

function writeValidationReceipt(value) {
  try { writeFileAtomic(closeReceipt, JSON.stringify(value), { mode: 0o600 }); return true; }
  catch { console.error('hammer-validate: local validation receipt unavailable'); return false; }
}

async function withMirrorSupport(runner, scratch, env) {
  const controlledReceipt = Boolean(process.env.HAM_CLOSE_VALIDATION_RECEIPT);
  const enabled = process.env.HAM_LOCAL_VALIDATION_CI_DEDUP !== '0'
    && (controlledReceipt || Boolean(runDir && head && /^[1-9]\d*$/.test(process.env.HAM_PR_NUMBER || '')));
  // A pre-close validation may include uncommitted remediation. Hosted jobs
  // cannot cover that checkout, even if Git HEAD still matches the PR.
  const matchingHead = enabled && startedClean && (!controlledReceipt || head === expectedHead);
  const planFile = join(scratch, 'ci-coverage.json');
  try {
    const { hammerValidationCoverage } = await import('../src/ama/hammer-validation-coverage.mjs');
    const plan = await hammerValidationCoverage({
      root: process.cwd(), repo: process.env.HAM_REPO, prNumber: process.env.HAM_PR_NUMBER,
      head: matchingHead ? head : undefined, enabled,
      // This optional probe reports unavailable coverage through validation.
      // Keep credential failures provisional, like a managed helper attempt.
      env: { ...env, HAM_HELPER_FAILURE_FILE: join(scratch, 'coverage-auth-failure') },
    });
    const checkoutMoved = matchingHead
      && (gitOutput('rev-parse', '--verify', 'HEAD') !== head || !cleanCheckout());
    writeFileAtomic(planFile, JSON.stringify(checkoutMoved
      ? { reason: 'validation-head-unavailable', manifests: {} } : plan), { mode: 0o600 });
  } catch { /* The wrapper runs locally without coverage and still retains diagnostics. */ }
  return { ...runner, args: [fileURLToPath(new URL('./hammer-ci-mirror-validation.py', import.meta.url)),
    planFile, closeReceipt, ...runner.args] };
}

function readCheckReceipt({ requireHead = false } = {}) {
  try {
    const observed = JSON.parse(readFileSync(closeReceipt, 'utf8'));
    if ((observed?.head === head || (!requireHead && observed?.head === undefined))
      && Array.isArray(observed?.checks)
      && observed.checks.every(check => check && typeof check === 'object')) return observed;
  } catch { /* A lost receipt cannot certify the final check state. */ }
  return null;
}

const readExactValidationReceipt = () => readCheckReceipt({ requireHead: true });
const readValidationReceipt = () => readCheckReceipt() ?? receipt;

function finishValidationReceipt(runner, runnerExit, fallbackReason, socketPathDiagnostic) {
  // Preserve diagnostic rows from mirrors that could not carry the initial
  // head forward. They retain their missing identity and cannot certify CI.
  const observed = validationUnknown ? readCheckReceipt() : readValidationReceipt();
  if (!observed) return false;
  const status = process.exitCode;
  if (!observed.checks.length && (!observed.perCheck || runnerExit !== 0)) {
    observed.checks.push({
      name: runner?.args[0] === mirrorScript ? 'CI mirror' : 'canonical validator',
      status: runnerExit === 0 ? 'run' : validationUnknown ? 'interrupted' : 'failed',
      reason: deferral?.reason || fallbackReason || (runner ? 'no-per-check-evidence' : 'validation-runner-unavailable'),
      ...(validationUnknown ? { result: 'inconclusive' } : {}),
      ...(runnerExit === undefined ? {} : { exitStatus: runnerExit }),
    });
  }
  delete observed.perCheck;
  // A timeout can kill the mirror before its last check records a result.
  for (const check of observed.checks) {
    if (socketPathDiagnostic && check.socketPathFault) {
      check.result = 'inconclusive';
      check.localReason = SOCKET_PATH_HARNESS_FAULT;
    }
    if (check.status === 'run' && !check.result && runnerExit !== 0) {
      check.status = validationUnknown ? 'interrupted' : 'failed';
      if (validationUnknown) check.result = 'inconclusive';
      check.exitStatus = runnerExit;
      check.localReason = 'validation-interrupted';
    }
  }
  // Only an owned canonical deferral keeps the raw runner status. Scratch
  // setup and socket faults retain their classified 78/75 exit status.
  return writeValidationReceipt({ ...observed, status: ownsDeferral ? runnerExit : status,
    ...(validationUnknown ? { validation: 'unknown' } : {}),
    ...([NODE_PIN_UNAVAILABLE, NODE_PIN_UNDECLARED].includes(fallbackReason) ? { outcome: fallbackReason } : {}),
    ...(socketPathDiagnostic ? { outcome: SOCKET_PATH_HARNESS_FAULT, socketPathDiagnostic } : {}) });
}

function recordSocketPathFault(detail) {
  console.error(`hammer-validate: ${SOCKET_PATH_HARNESS_FAULT}: ${detail}`);
  process.exitCode = 75;
  validationUnknown = true;
  // A local rebase can have an unpublished HEAD. Count the stop against the
  // dispatch target while the validation receipt keeps the tested head.
  reportHammerEarlyFailure(SOCKET_PATH_HARNESS_FAULT, {
    headSha: process.env.HAM_TARGET_REMEDIATION_SHA || process.env.HAM_REVIEWED_SHA || head,
  });
}

// CLOSERGATES-01: a closure-resume launch validated nothing new. While the
// checkout is still the receipt's validated head, that launch's evidence
// stands and the suite is not re-run. Any other head validates normally.
const closureResumeReceipt = () => runDir && head ? readRunClosureResume(runDir, head) : null;

const args = process.argv.slice(2);
const checkDeferred = args.length === 1 && args[0] === '--check-deferred';
const checkCustody = args.length === 1 && args[0] === '--check-custody';
const checkRebase = args.length === 1 && args[0] === '--check-rebase-publication';
const completeRebase = args.length === 2 && args[0] === '--complete-rebase-publication';
const queueValidation = args.length === 2 && args[0] === '--queue-validation-result';
const usage = 'usage: hammer-validate.mjs --canonical [--nominal-timeout 1..3600] -- <changed repository-relative files>';
let pytest = false;
let canonical = false;
try { canonical = strictNodePinRepository(); } catch { /* The resolver reports unreadable configuration. */ }
let nominalSeconds = 360;
let explicitTimeout = false;
let valid = true;
while (!checkDeferred && !checkCustody && !checkRebase && !completeRebase && !queueValidation && args.length && args[0] !== '--') {
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
if (queueValidation) {
  try {
    if (!runDir || !head || args[1] !== head) throw new Error('validation head mismatch');
    const recorded = readUnknownValidationReceipt(runDir, head);
    if (!recorded) console.log('ordinary');
    else {
      if (!cleanCheckout() || !finalizedUnknownDefersToCi(runDir, head, recorded, requiredContexts())) {
        throw new Error('UNKNOWN validation evidence cannot defer to CI');
      }
      console.log('unknown');
    }
  } catch (error) {
    console.error(`hammer-validate: ${error.message}`);
    process.exitCode = 75;
  }
} else if (checkRebase || completeRebase) {
  try {
    if (expectedHead && expectedHead !== head) throw new Error('validation head mismatch');
    const currentBinding = conflictBinding();
    const state = conflictRebasePublication(currentBinding);
    if (checkRebase) console.log(state);
    else {
      if (args[1] !== head || !['ci', 'redrive'].includes(state)) throw new Error('published head mismatch');
      const hold = matchingHold(currentBinding);
      if (hold) {
        assertHammerController();
        const recorded = readUnknownValidationReceipt(runDir, head);
        const evidence = readDeferredValidationChecks(runDir, head, recorded);
        if (evidence) retainDeferredValidation(hold.evidenceDir, recorded, evidence, recorded.localValidationReceipt);
        if (!continueDeferredSourceCustody(hold, { publishedHead: head })) throw new Error('source custody still active');
      }
      if (state === 'ci') recordHammerPhase(ciAuthoritativeOutcome);
    }
  } catch {
    console.error('hammer-validate: conflict-repair publication binding unavailable');
    process.exitCode = 1;
  }
} else if (checkCustody) {
  const hold = findDeferredSourceHold(process.env);
  if (hold) {
    console.error(`hammer-validate: ${deferredSourceNotice(hold)}`);
    process.exitCode = 75;
  }
} else if (checkDeferred) {
  if (expectedHead && expectedHead !== head) process.exitCode = 75;
  else validationDeferred();
} else if (!valid || args.shift() !== '--' || !args.length) {
  console.error(usage);
  process.exitCode = 64;
} else if (canonical && validationDeferred()) {
  // The exact head already has a handoff. Preserve its original evidence.
} else if ((resumed = closureResumeReceipt())) {
  const receipt = resumed;
  console.error(`hammer-validate: closure resume: head ${receipt.validatedHead} was validated by launch ${receipt.launchRequestId || 'unknown'}; reusing that evidence, not re-running validation.`);
} else {
  await validate();
}

async function validate() {
  let scratch;
  let runner, runnerExit, fallbackReason, socketPathDiagnostic;
  startedClean = cleanCheckout();
  binding = conflictBinding();
  if (closeReceipt) writeValidationReceipt(receipt);
  try {
    const nodePin = !canonical && pytest && !process.env.HAM_CONTROLLER_RECORD ? {} : resolveValidationNode(process.cwd());
    if (nodePin.warning) console.error(`hammer-validate: ${nodePin.warning}`);
    if (nodePin.reason) {
      fallbackReason = nodePin.reason;
      console.error(`hammer-validate: ${fallbackReason}: ${nodePin.detail}`);
      if (fallbackReason === NODE_PIN_UNAVAILABLE && nodePin.runtimeUnavailable && canonical && runDir && head
        && (!expectedHead || expectedHead === head)
        && unknownDefersToCi({ reason: fallbackReason, requiredContexts: requiredContexts(),
          cleanCheckout: startedClean }).ciAuthoritative) {
        // No battery was spawned. Retain UNKNOWN evidence; controller-owned
        // runs still require the ordinary whole-round drain before reuse.
        let evidenceReady = false;
        try {
          if (!closeReceipt) closeReceipt = join(await mkdtemp(join(runDir, 'ham-validation-evidence-')), 'local-validation.json');
          evidenceReady = writeValidationReceipt(receipt);
        } catch { /* A missing evidence directory keeps the classified pin stop. */ }
        if (evidenceReady) {
          validationFiles = args;
          runnerExit = process.exitCode = 75;
          deferValidation(fallbackReason, runnerExit);
          validationCleanup = { cleanup: 'finished' };
          ciAuthoritative = ownsReceipt && !deferral.controllerRecord && deferral.cleanCheckout;
          deferral = { ...deferral, ciAuthoritative, coverageComplete: false,
            cleanup: deferral.controllerRecord ? 'controller-owned' : 'finished' };
          if (!writeDeferral(true)) ciAuthoritative = false;
          return;
        }
      }
      validationUnknown = true;
      process.exitCode = fallbackReason === NODE_PIN_UNDECLARED ? NODE_PIN_UNDECLARED_EXIT : NODE_PIN_UNAVAILABLE_EXIT;
      try { recordHammerPhase(fallbackReason); }
      catch { /* Preserve the infrastructure exit and validation receipt. */ }
      return;
    }
    if (nodePin.node) console.error(`hammer-validate: target Node v${nodePin.version} (${nodePin.node})`);
    try { scratch = await createValidationScratch(); }
    catch (error) {
      const prefix = `${SOCKET_PATH_HARNESS_FAULT}: `;
      if (error.message.startsWith(prefix)) {
        fallbackReason = SOCKET_PATH_HARNESS_FAULT;
        socketPathDiagnostic = error.message.slice(prefix.length);
        recordSocketPathFault(socketPathDiagnostic);
      } else {
        fallbackReason = 'validation-environment-failed';
        validationUnknown = true;
        process.exitCode = 78;
        console.error(`hammer-validate: ${fallbackReason}: unable to prepare validation scratch (${error.code || 'setup failed'})`);
        recordHammerPhase(fallbackReason);
      }
      return;
    }
    try { await reapValidationScratch(dirname(scratch)); }
    catch { /* Missing process evidence retains orphan candidates. */ }
    reportRemediationCommit();
    let scratchEnv;
    try { scratchEnv = validationScratchEnv(validationNodeEnvironment(process.env, nodePin.node, scratch), scratch); }
    catch (error) {
      fallbackReason = 'validation-environment-failed';
      validationUnknown = true;
      process.exitCode = 78;
      console.error(`hammer-validate: ${fallbackReason}: unable to prepare target Node PATH (${error.code || 'setup failed'})`);
      try { recordHammerPhase(fallbackReason); }
      catch { /* Preserve the infrastructure exit and validation receipt. */ }
      return;
    }
    const env = !canonical && pytest ? pytestValidationEnvironment(scratchEnv, scratch,
      join(dirname(fileURLToPath(import.meta.url)), 'pytest')) : scratchEnv;
    if (canonical) {
      // Older callers passed commands. Always derive changed paths from Git in
      // that compatibility case instead of executing a hand-built validator.
      try {
        const paths = process.argv.includes('--canonical') ? args
          : execFileSync('git', ['diff', '--name-only',
            `${process.env.HAM_REVIEWED_SHA || 'origin/main'}...HEAD`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
        validationFiles = paths;
        runner = canonicalHammerValidation(process.cwd(), paths, { node: nodePin.node });
        validationRunner = { command: runner?.command, args: runner?.args };
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
    if (valid && runner && canonical && !startedClean) {
      console.error('hammer-validate: validating an uncommitted checkout. A timeout here cannot defer to exact-head CI'
        + ' and keeps the edits in operator custody; commit the remediation first (HAMCIAUTH-01).');
    }
    if (valid) {
      let output = '', packageImportFault = false, outputKind, stopReason;
      const pending = { stdout: '', stderr: '' };
      const observeLine = (line, stream) => {
        localTestFailure ||= /^[ \t]*not ok \d+\b/.test(line);
        if (/^[ \t]*$/.test(line)) return;
        outputKind = !outputKind && stream === 'stderr' && isSocketPathFailure(line) ? 'socket-only' : 'other';
      };
      let packages = new Set();
      try { if (canonical && !runner?.required) packages = repositoryPythonPackages(process.cwd()); }
      catch { runner = null; }
      const observeOutput = (chunk, stream = 'stdout') => {
        output += String(chunk);
        packageImportFault ||= ownPackageImportFault(output, packages);
        if (!localTestFailure && /(?:^|\n)[ \t]*not ok \d+/.test(output)) {
          localTestFailure = true;
          if (ownsReceipt) {
            deferral.localFailureObserved = true;
            writeDeferral(true);
          }
        }
        output = output.slice(-8192);
        const lines = (pending[stream] + String(chunk)).split(/\r\n?|\n/);
        pending[stream] = lines.pop().slice(0, 8192);
        for (const line of lines) observeLine(line, stream);
      };
      const startedFile = join(scratch, 'pnpm-started');
      const mirror = runner?.args[0] === mirrorScript;
      if ((canonical || mirror) && !closeReceipt) {
        // Evidence must survive removal of the validator's disposable scratch.
        const evidenceRoot = process.env.HAM_RUN_DIR || tmpdir();
        closeReceipt = join(await mkdtemp(join(evidenceRoot, 'ham-validation-evidence-')), 'local-validation.json');
        writeValidationReceipt(receipt);
        console.error(`hammer-validate: ${mirror ? 'CI mirror' : 'local validation'} evidence: ${closeReceipt}`);
      }
      const execution = mirror ? await withMirrorSupport(runner, scratch, env) : runner;
      const timeoutMs = loadAwareTimeoutSeconds(explicitTimeout ? nominalSeconds
        : runner?.nominalSeconds || nominalSeconds) * 1000;
      const deadline = Date.now() + timeoutMs;
      const validationStart = performance.now();
      // A missing startup receipt distinguishes npm/tool provisioning from a
      // repository script failure. Retry startup once within the same budget.
      for (let attempt = 0; attempt < 2; attempt++) {
        const attemptEnv = runner?.startupReceipt ? { ...env, HAM_PNPM_VALIDATION_STARTED_FILE: startedFile } : env;
        const remainingMs = Math.max(1, deadline - Date.now());
        process.exitCode = execution ? await runBounded(execution.command, execution.args,
          { env: attemptEnv,
            timeoutMs: remainingMs, idleMs: leaseValidationIdleMs(remainingMs),
            observeOutput, stopOnTimeoutExit: mirror,
            observeCleanup: result => { validationCleanup = result; },
            observeStop: (reason, status) => {
              for (const stream of ['stdout', 'stderr']) {
                observeLine(pending[stream], stream);
                pending[stream] = '';
              }
              stopReason = reason;
              if (canonical && (status === 124 || status === 125)) deferValidation(reason, status);
            } }) : 127;
        for (const stream of ['stdout', 'stderr']) {
          observeLine(pending[stream], stream);
          pending[stream] = '';
        }
        if (!runner?.startupReceipt || existsSync(startedFile) || process.exitCode === 0
          || process.exitCode >= 124 || Date.now() >= deadline) break;
      }
      runnerExit = process.exitCode;
      // Reserve the pin exits for preflight. Keep the battery's raw status in
      // its check evidence without sending the controller down a pin-stop path.
      if (runnerExit === NODE_PIN_UNAVAILABLE_EXIT || runnerExit === NODE_PIN_UNDECLARED_EXIT) {
        process.exitCode = 1;
      }
      const failedMirrorChecks = mirror ? readValidationReceipt().checks.filter(check => check.result === 'fail') : [];
      // Output from a test reporter or other command makes attribution ambiguous.
      const confirmedSocketPathFault = mirror
        ? runnerExit === 42 && failedMirrorChecks.length > 0 && failedMirrorChecks.every(check => check.socketPathFault)
        : outputKind === 'socket-only';
      if (!stopReason && runnerExit > 0 && runnerExit < 124
        && confirmedSocketPathFault) {
        fallbackReason = SOCKET_PATH_HARNESS_FAULT;
        socketPathDiagnostic = `local validation reported an overlong Unix socket path (validation scratch: ${scratch}).`;
        recordSocketPathFault(socketPathDiagnostic);
        return;
      }
      const inspectionUnavailable = mirror && processInspectionRefused(readValidationReceipt().checks);
      if (inspectionUnavailable) deferValidation(PROCESS_INSPECTION_UNAVAILABLE, runnerExit);
      if (canonical && runnerExit === 125 && !stopReason?.startsWith('canceled:')) {
        deferValidation('validation-drain-unconfirmed', runnerExit);
      }
      // MRQ-20: the mirror's own budget stop, and a battery killed by a signal
      // this validator did not send, are no verdict rather than failed checks.
      if (canonical && mirror && runnerExit === 75 && !inspectionUnavailable && !localFailureObserved()) {
        deferValidation('validation-budget-exceeded', runnerExit);
      }
      if (canonical && !stopReason && [137, 143].includes(runnerExit) && !localFailureObserved()
        && !(runner?.startupReceipt && !existsSync(startedFile))) {
        deferValidation('validation-killed', runnerExit);
      }
      if (runner?.selectedTestFiles) {
        const wallMs = Math.round(performance.now() - validationStart);
        console.error(`hammer-validate: targeted Node validation files=${runner.selectedTestFiles}`
          + ` workerLimit=${nodeTestWorkerLimit(env)} wallMs=${wallMs} budgetMs=${timeoutMs} exitStatus=${runnerExit}`);
      }
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
      if (environmentFault && (mirror || existsSync(mirrorScript))) {
        deferValidation('canonical-mirror-environment-unavailable', runnerExit);
      }
      if (ownsDeferral) {
        const observed = readExactValidationReceipt();
        const localFailure = realMirrorFailure || localFailureObserved();
        const atHead = startedClean && cleanCheckout() && gitOutput('rev-parse', '--verify', 'HEAD') === head;
        const coverageComplete = mirror && atHead && completeCoverage(observed);
        // HAMCIAUTH-01: partial coverage qualifies. Under the controller the
        // cleanup is controller-owned, so the drained re-judgement decides.
        const cleanup = deferral.controllerRecord ? 'controller-owned' : validationCleanup?.cleanup || 'unconfirmed';
        ciAuthoritative = Boolean(observed) && cleanup === 'finished'
          && unknownDefersToCi({ reason: deferral.reason, requiredContexts: deferral.requiredContexts,
            localFailureObserved: localFailure, checks: observed.checks, cleanCheckout: atHead }).ciAuthoritative;
        deferral = { ...deferral, localFailureObserved: localFailure, ciAuthoritative,
          coverageComplete, cleanCheckout: atHead, cleanup,
          ...(binding && { cleanupConfirmed: cleanup === 'finished' }) };
        if (!ownsReceipt || !writeDeferral(true)) ciAuthoritative = false;
      } else if (validationUnknown && validationCleanup?.cleanup === 'finished' && runnerExit !== 125) {
        // A concurrent writer's receipt owns the decision. A failure from
        // this battery must still prevent exact-head reuse.
        const recorded = readUnknownValidationReceipt(runDir, head);
        if (recorded && !recorded.unreadable && (realMirrorFailure || localFailureObserved())) {
          deferral = { ...recorded, ciAuthoritative: false, localFailureObserved: true };
          writeDeferral(true);
        } else if (!realMirrorFailure && !localFailureObserved()) {
          validationDeferred();
        }
      }
      if (environmentFault && !validationUnknown) {
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
    if (closeReceipt && !finishValidationReceipt(runner, runnerExit, fallbackReason, socketPathDiagnostic)) ciAuthoritative = false;
    if (ownsDeferral) {
      try {
        retainValidationEvidence();
        const hold = findDeferredSourceHold(process.env);
        if (custodyDir && hold?.evidenceDir === custodyDir && !hold.controller) {
          await retainDeferredCommit(hold, process.env);
          if (ciAuthoritative) ciAuthoritative = continueDeferredSourceCustody(hold);
        } else if (hold || launchRequestId) {
          ciAuthoritative = false;
        }
      }
      catch {
        ciAuthoritative = false;
        console.error('hammer-validate: deferred validation evidence incomplete');
      }
      if (ciAuthoritative) {
        console.error(`hammer-validate: ${ciAuthoritativeOutcome}; continue to verify-head and the exact-head required GitHub contexts. No local validation pass is claimed.`);
        process.exitCode = 0;
      } else {
        if (deferral.ciAuthoritative) {
          deferral.ciAuthoritative = false;
          if (ownsReceipt) writeDeferral(true);
        }
        // The close controller owns the terminal audit for a publishable
        // conflict repair, and the close command re-judges a controller-owned
        // drain (HAMCIAUTH-01). An early audit would outlive CI continuation.
        const continuable = CI_AUTHORITATIVE_UNKNOWN_REASONS.includes(deferral.reason) && !deferral.localFailureObserved
          && (binding || (process.env.HAM_CONTROLLER_RECORD && deferral.cleanCheckout === true
            && deferral.requiredContexts?.length > 0));
        if (!continuable) {
          reportHammerEarlyFailure(deferredOutcome, { headSha: head });
        }
      }
      if (!process.env.HAM_CONTROLLER_RECORD) {
        try { recordHammerPhase(ciAuthoritative ? ciAuthoritativeOutcome : deferredOutcome); }
        catch { /* The private receipt still records the reason. */ }
      }
    }
    if (scratch) {
      if (process.exitCode === undefined || process.exitCode === 125 || validationCleanup?.cleanup === 'unconfirmed') {
        console.error(`hammer-validate: scratch retained for orphan cleanup: ${scratch}`);
      } else {
        try { await rm(scratch, { recursive: true, force: true }); }
        catch (error) { console.error(`hammer-validate: scratch cleanup deferred (${error.code})`); }
      }
    }
  }
}
