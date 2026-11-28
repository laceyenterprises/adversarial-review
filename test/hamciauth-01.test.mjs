// HAMCIAUTH-01: a hammer whose local validation is UNKNOWN for a timeout or
// load stop, with no local failure observed, a clean committed head and
// declared required contexts, hands validation authority to the exact-head
// required GitHub checks. That holds under the HAM controller and with partial
// coverage. It publishes instead of parking for an operator. Merge gates are
// unchanged. Synthetic repositories, launches and checks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  UNKNOWN_CONTEXTS_NOT_GREEN, finalizedUnknownDefersToCi, hasCompletedUnknownValidationEvidence, recordedUnknownDefersToCi,
  unknownDefersToCi, unknownValidationCiGate,
} from '../src/ama/local-validation-unknown.mjs';
import {
  DEFERRED_SOURCE_HOLD, deferredSourceNeedsOperator, readDeferredSourceHold,
  retainDeferredControllerCleanup, retainDeferredValidation, startDeferredSourceCustody,
} from '../src/ama/deferred-source-custody.mjs';
import { deferredDecisionFiles } from '../src/ama/deferred-source-decision.mjs';
import { observeDeferredSourceDecision } from '../src/ama/closer-successor.mjs';
import { amaCloserDispatchFilePath, amaCloserPromptDir } from '../src/ama/dispatch-record-read.mjs';

const REPO = 'example/alpha';
const REMOTE = 'b'.repeat(40);
const LAUNCH = 'lrq_fixture-hamciauth';
const CONTEXTS = ['repo-guards'];
const pass = name => ({ name, status: 'run', result: 'pass' });
// Two of five selected checks finished and passed before the absolute timeout.
const PARTIAL = { selectedCheckCount: 5, checks: [pass('first'), pass('second')] };
const run = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });

test('the rule: partial coverage with no failure on a clean head defers to declared CI', () => {
  const base = { reason: 'absolute-timeout', requiredContexts: CONTEXTS, checks: PARTIAL.checks, cleanCheckout: true };
  assert.equal(unknownDefersToCi(base).ciAuthoritative, true);
  for (const reason of ['no-progress-timeout', 'child-check-timeout', 'external-timeout:SIGALRM',
    'validation-budget-exceeded', 'validation-killed', 'node-pin-unavailable']) {
    assert.equal(unknownDefersToCi({ ...base, reason }).ciAuthoritative, true, reason);
  }
  assert.equal(unknownDefersToCi({ ...base, localFailureObserved: true }).reason, 'local-failure-observed');
  assert.equal(unknownDefersToCi({ ...base, checks: [...PARTIAL.checks, { name: 'third', result: 'fail' }] }).reason,
    'local-failure-observed');
  assert.equal(unknownDefersToCi({ ...base, requiredContexts: [] }).ciAuthoritative, false);
  assert.equal(unknownDefersToCi({ ...base, cleanCheckout: false }).reason, 'checkout-not-clean-at-head');
  for (const reason of ['validation-drain-unconfirmed', 'process-inspection-unavailable', 'canceled:SIGTERM', 'node-pin-undeclared']) {
    assert.equal(unknownDefersToCi({ ...base, reason }).ciAuthoritative, false, reason);
  }
  const receipt = { validation: 'unknown', reason: 'absolute-timeout', ciAuthoritative: true, cleanup: 'finished',
    coverageComplete: false, cleanCheckout: true, localFailureObserved: false };
  assert.equal(hasCompletedUnknownValidationEvidence(receipt), true);
  assert.equal(recordedUnknownDefersToCi(receipt, CONTEXTS), true);
  assert.equal(recordedUnknownDefersToCi({ ...receipt, cleanCheckout: undefined }, CONTEXTS), false);
  assert.equal(recordedUnknownDefersToCi({ ...receipt, cleanup: 'controller-owned' }, CONTEXTS), false);
  assert.equal(recordedUnknownDefersToCi({ ...receipt, localFailureObserved: true }, CONTEXTS), false);
});

// ---- bin/hammer-validate.mjs, with only the process boundary replaced ----

const validator = new URL('../bin/hammer-validate.mjs', import.meta.url).pathname;
const validatorHref = new URL('../bin/hammer-validate.mjs', import.meta.url).href;

function fixture(t, { declared = true, clean = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hamciauth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  mkdirSync(join(root, 'scripts/ci-mirror'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci-mirror/run-ci-mirror.py'), '');
  writeFileSync(join(root, 'example.py'), 'value = 1\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '-qm', 'Synthetic remediation');
  // Run artifacts sit in the checkout root; keep them out of `git status`.
  writeFileSync(join(root, '.git/info/exclude'), '/*\n');
  if (!clean) writeFileSync(join(root, 'example.py'), 'value = 2\n');
  mkdirSync(join(root, 'cfg'));
  const config = join(root, 'cfg', 'config.yaml');
  writeFileSync(config, `version: 1\ngithub:\n  org: example\n` + (declared
    ? `roles:\n  adversarial:\n    merge_authority:\n      required_check_contexts_by_repository:\n        - repository: ${REPO}\n          contexts: [repo-guards]\n`
    : ''));
  const controllerRecord = join(root, `controller-${randomUUID()}.json`);
  return { root, head: git('rev-parse', 'HEAD'), config, controllerRecord };
}

function baseEnv({ root, head, config, remoteHead = REMOTE }) {
  const env = { ...process.env, HAM_RUN_DIR: root, HAM_LOCAL_VALIDATION_CI_DEDUP: '0', HAM_CLOSE_VALIDATION_HEAD: head,
    HAM_HQ_ROOT: root, HAM_REPO: REPO, HAM_PR_NUMBER: '42', HAM_TARGET_REMEDIATION_SHA: remoteHead,
    HQ_LAUNCH_REQUEST_ID: LAUNCH, AGENT_OS_CONFIG_PATH: config, TMPDIR: root,
    HAM_HELPER_FAILURE_FILE: join(root, 'early-failure') };
  for (const key of ['LAUNCH_REQUEST_ID', 'AGENT_OS_WORKER_LRQ_ID', 'HQ_WORKER_RUN_ID', 'HAM_CONTROLLER_RECORD',
    'HAM_CLOSE_VALIDATION_REMOTE_HEAD', 'HAM_CLOSE_VALIDATION_RECEIPT']) delete env[key];
  return env;
}

// scenario: { rows?, stop?: [reason, status], exit, cleanup? }
function runValidator(repo, scenario, { args = ['--canonical', '--', 'example.py'], controlled = false, extraEnv = {} } = {}) {
  const env = { ...baseEnv(repo), ...extraEnv };
  if (controlled) {
    env.HAM_CONTROLLER_RECORD = repo.controllerRecord;
    env.HAM_CLOSE_VALIDATION_RECEIPT = join(repo.root, 'validation.json');
  }
  const calls = join(repo.root, 'battery-calls');
  const runner = `
    import { appendFileSync, writeFileSync } from 'node:fs';
    export async function runBounded(_command, _args, options) {
      appendFileSync(${JSON.stringify(calls)}, 'run\\n');
      const scenario = ${JSON.stringify(scenario)};
      // The mirror wrapper's argv: [wrapper, coverage plan, check receipt, ...].
      const receipt = _args[2];
      if (scenario.rows) writeFileSync(receipt, JSON.stringify({ head: ${JSON.stringify(repo.head)},
        selectedCheckCount: scenario.rows.selectedCheckCount, checks: scenario.rows.checks }));
      if (scenario.stop) options.observeStop(...scenario.stop);
      options.observeCleanup?.({ cleanup: scenario.cleanup || 'finished' });
      return scenario.exit;
    }`;
  const loader = join(repo.root, 'loader.mjs');
  writeFileSync(loader, `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(validatorHref)} && specifier === '../src/ama/bounded-command.mjs') {
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(runner)}) };
      }
      return next(specifier, context);
    } });
  `);
  const result = spawnSync(process.execPath, ['--import', loader, validator, ...args], {
    cwd: repo.root, encoding: 'utf8', timeout: 30_000, env });
  assert.ifError(result.error);
  return { ...result, batteries: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
}

const deferralOf = ({ root, head }) => {
  const path = join(root, `validation-deferred-${head}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};
const holdOf = ({ root }) => readDeferredSourceHold(root, { repo: REPO, prNumber: 42, headSha: REMOTE },
  { includeContinued: true });

test('an unavailable Node pin skips the battery and defers only a clean exact canonical head to declared CI', t => {
  for (const options of [{}, { clean: false }, { declared: false }, { mismatch: true }]) {
    const repo = fixture(t, options);
    writeFileSync(repo.config, readFileSync(repo.config, 'utf8').replace(`repository: ${REPO}`, 'repository: example/agent-os'));
    writeFileSync(join(repo.root, '.nvmrc'), '99.99.99\n');
    execFileSync('git', ['add', '-f', '.nvmrc'], { cwd: repo.root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--no-verify', '-qm', 'Synthetic runtime bump'], { cwd: repo.root });
    repo.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim();
    const extraEnv = { HAM_REPO: 'example/agent-os',
      ...(options.mismatch ? { HAM_CLOSE_VALIDATION_HEAD: REMOTE } : {}) };
    const result = runValidator(repo, { exit: 0 }, { extraEnv });
    const eligible = Object.keys(options).length === 0;
    assert.equal(result.status, eligible ? 0 : 80, result.stderr);
    assert.equal(result.batteries, 0);
    const recorded = deferralOf(repo);
    if (eligible) {
      assert.equal(recorded.reason, 'node-pin-unavailable');
      assert.equal(recorded.ciAuthoritative, true);
      assert.equal(recorded.coverageComplete, false);
      assert.equal(recorded.cleanup, 'finished');
      const evidence = JSON.parse(readFileSync(recorded.localValidationReceipt, 'utf8'));
      assert.equal(evidence.validation, 'unknown');
      assert.equal(evidence.checks[0].result, 'inconclusive');
      assert.equal(finalizedUnknownDefersToCi(repo.root, repo.head, recorded, CONTEXTS), true);
    } else assert.equal(recorded, null);
  }
});

test('controller runtime gap retains UNKNOWN until its round drains, then reuses evidence without a battery', async t => {
  const repo = fixture(t);
  writeFileSync(join(repo.root, '.nvmrc'), '99.99.99\n');
  writeFileSync(repo.config, readFileSync(repo.config, 'utf8').replace(`repository: ${REPO}`, 'repository: example/agent-os'));
  execFileSync('git', ['add', '-f', '.nvmrc'], { cwd: repo.root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '-qm', 'Synthetic runtime bump'], { cwd: repo.root });
  repo.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim();
  const extraEnv = { HAM_REPO: 'example/agent-os' };
  const stopped = runValidator(repo, { exit: 0 }, { controlled: true, extraEnv });
  assert.equal(stopped.status, 75, stopped.stderr);
  assert.equal(stopped.batteries, 0);
  assert.equal(deferralOf(repo).ciAuthoritative, false);
  assert.equal(deferralOf(repo).cleanup, 'controller-owned');
  await drainController(repo, { reason: 'shell-exited', extraEnv });
  const resumed = runValidator(repo, { exit: 1 }, { args: ['--check-deferred'], extraEnv });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.batteries, 0);
  assert.equal(finalizedUnknownDefersToCi(repo.root, repo.head, deferralOf(repo), CONTEXTS), true);
});

test('non-canonical pytest skips an unrelated tooling Node declaration', t => {
  const repo = fixture(t);
  writeFileSync(join(repo.root, 'package.json'), '{invalid');
  const result = runValidator(repo, { exit: 0 }, { args: ['--pytest', '--', 'example.py'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.batteries, 1);
  assert.doesNotMatch(result.stderr, /node-pin/);
  const missingIdentity = runValidator(repo, { exit: 0 }, { args: ['--pytest', '--', 'example.py'],
    controlled: true, extraEnv: { HAM_REPO: '' } });
  assert.equal(missingIdentity.status, 80, missingIdentity.stderr);
  assert.equal(missingIdentity.batteries, result.batteries, 'missing controller identity starts no additional battery');
  assert.match(missingIdentity.stderr, /requires HAM_REPO owner\/name/);
});

// The owning controller stops the round, drains its group, then retains the
// source commit and final check receipt, as hammer-controller.mjs does.
async function drainController(repo, { drained = true, reason = 'validation-stopped', extraEnv = {} } = {}) {
  const record = { schemaVersion: 1, launchRequestId: LAUNCH, state: drained ? 'quiescent' : 'cleanup-unconfirmed',
    reason, drained, leaseCleanup: { released: false, reason: 'no-acquisition-receipt' } };
  writeFileSync(repo.controllerRecord, JSON.stringify(record));
  await retainDeferredControllerCleanup({ ...baseEnv(repo), ...extraEnv }, repo.controllerRecord, record);
}

test('controller + absolute timeout after 2 of 5 passing checks => re-judged after drain, publishes to exact-head CI', async t => {
  const repo = fixture(t);
  const stopped = runValidator(repo, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124,
    cleanup: 'controller-owned' }, { controlled: true });
  assert.notEqual(stopped.status, 0, 'the stopped validator itself claims nothing');
  const recorded = deferralOf(repo);
  assert.equal(recorded.reason, 'absolute-timeout');
  assert.equal(recorded.cleanCheckout, true);
  assert.equal(recorded.localFailureObserved, false);
  assert.equal(recorded.ciAuthoritative, false, 'cleanup is still controller-owned');
  assert.equal(existsSync(join(repo.root, 'early-failure')), false,
    'no early terminal audit while the close can still continue to CI');
  // Before drain, the close command does not continue.
  const undrained = runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] });
  assert.equal(undrained.status, 75, undrained.stderr);

  await drainController(repo);
  const check = runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stderr, /local-validation-unknown-github-required-gate-authoritative/);
  assert.equal(check.batteries, 1, 'the UNKNOWN is reused, never re-run');
  const receipt = deferralOf(repo);
  assert.equal(receipt.ciAuthoritative, true);
  assert.equal(receipt.cleanup, 'finished');
  assert.equal(receipt.coverageComplete, false, 'partial coverage is recorded honestly');
  assert.equal(receipt.localValidationReceipt, join(repo.root, 'validation.json'));
  const hold = holdOf(repo);
  assert.ok(hold.continuedAt, 'source custody continues instead of parking for an operator');
  assert.equal(deferredSourceNeedsOperator(hold), false);
  // The next close round reuses the receipt rather than validating again.
  const reused = runValidator(repo, { exit: 1 }, { controlled: true });
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(reused.batteries, 1);

  // Merge gates are unchanged: only green exact-head declared contexts pass.
  assert.equal(recordedUnknownDefersToCi(receipt, CONTEXTS), true);
  assert.deepEqual(unknownValidationCiGate({ checks: [run('repo-guards')], requiredContexts: CONTEXTS }),
    { ok: true, conclusion: 'SUCCESS' });
  assert.equal(unknownValidationCiGate({ checks: [run('repo-guards', 'FAILURE')], requiredContexts: CONTEXTS }).reason,
    UNKNOWN_CONTEXTS_NOT_GREEN);
  assert.equal(unknownValidationCiGate({ checks: [run('lint')], requiredContexts: CONTEXTS }).ok, false,
    'an absent declared context is pending, never green');
});

test('standalone hammer: timeout with partial coverage on a clean committed head continues to CI', t => {
  const repo = fixture(t);
  const result = runValidator(repo, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /local-validation-unknown-github-required-gate-authoritative/);
  const receipt = deferralOf(repo);
  assert.equal(receipt.ciAuthoritative, true);
  assert.equal(receipt.coverageComplete, false);
  assert.ok(holdOf(repo).continuedAt);
  assert.equal(runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] }).status, 0);
});

for (const exit of [75, 137]) {
  test(`controller: runner cleanup after exit ${exit} requires the owning round to drain`, async t => {
    const repo = fixture(t);
    const stopped = runValidator(repo, { rows: PARTIAL, exit, cleanup: 'finished' }, { controlled: true });
    assert.equal(stopped.status, exit, stopped.stderr);
    assert.equal(deferralOf(repo).cleanup, 'controller-owned');
    const check = () => runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] });
    assert.equal(check().status, 75);
    await drainController(repo, { drained: false, reason: 'shell-exited' });
    assert.equal(check().status, 75);
    await drainController(repo, { reason: 'shell-exited' });
    assert.equal(check().status, 0);
  });
}

test('close, queue and merge evidence require the final exact-head check receipt for a new UNKNOWN', async t => {
  const repo = fixture(t);
  runValidator(repo, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124, cleanup: 'controller-owned' },
    { controlled: true });
  await drainController(repo);
  const checkClose = () => runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] });
  const checkQueue = () => runValidator(repo, { exit: 1 }, { args: ['--queue-validation-result', repo.head] });
  assert.equal(checkClose().status, 0);
  assert.equal(checkQueue().stdout.trim(), 'unknown');
  const recorded = deferralOf(repo);
  const receiptPath = recorded.localValidationReceipt;
  const checkMergeEvidence = () => finalizedUnknownDefersToCi(repo.root, repo.head, recorded, CONTEXTS);
  assert.equal(checkMergeEvidence(), true);
  rmSync(receiptPath);
  assert.equal(checkMergeEvidence(), false);
  assert.equal(checkClose().status, 75);
  assert.equal(checkQueue().status, 75);
  writeFileSync(receiptPath, JSON.stringify({ head: REMOTE, checks: PARTIAL.checks }));
  assert.equal(checkClose().status, 75);
  assert.equal(checkQueue().status, 75);
  writeFileSync(receiptPath, JSON.stringify({ head: repo.head, checks: [inspectionRefusal] }));
  assert.equal(checkMergeEvidence(), false);
  assert.equal(checkClose().status, 75);
  assert.equal(checkQueue().status, 75);
});

test('controller: any observed local failure keeps the head blocked', async t => {
  const repo = fixture(t);
  const rows = { selectedCheckCount: 5, checks: [pass('first'), { name: 'second', status: 'failed', result: 'fail' }] };
  const stopped = runValidator(repo, { rows, stop: ['absolute-timeout', 124], exit: 124, cleanup: 'controller-owned' },
    { controlled: true });
  assert.notEqual(stopped.status, 0);
  assert.equal(deferralOf(repo).localFailureObserved, true);
  await drainController(repo);
  assert.equal(runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] }).status, 75);
  assert.equal(deferralOf(repo).ciAuthoritative, false);
  assert.equal(holdOf(repo).continuedAt, undefined);
});

const inspectionRefusal = { name: 'telegram-responder-guard', status: 'failed',
  result: 'inconclusive', localReason: 'process-inspection-unavailable' };
for (const [name, row] of [['failure', { status: 'failed', result: 'fail' }], ['inspection refusal', inspectionRefusal]]) {
  test(`controller: a late ${name} keeps both close and watcher blocked after drain`, async t => {
    const repo = fixture(t);
    repo.remoteHead = repo.head;
    runValidator(repo, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124, cleanup: 'controller-owned' },
      { controlled: true });
    writeFileSync(join(repo.root, 'validation.json'), JSON.stringify({ head: repo.head, checks: [...PARTIAL.checks, row] }));
    await drainController(repo);
    assert.equal(runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] }).status, 75);
    assert.equal(deferralOf(repo).ciAuthoritative, false);
    const { held } = await observe(repo.root, CONTEXTS, repo.head);
    assert.equal(held?.needsOperator, true);
    const hold = readDeferredSourceHold(repo.root, { repo: REPO, prNumber: 42, headSha: repo.head });
    assert.equal(deferredSourceNeedsOperator(hold, { liveHead: repo.head, requiredContexts: CONTEXTS }), true);
    assert.equal(hold.continuedAt, undefined);
  });
}

test('undeclared contexts, a dirty checkout or an unconfirmed drain keep the existing deferral', async t => {
  for (const [options, drained] of [[{ declared: false }, true], [{ clean: false }, true], [{}, false]]) {
    const repo = fixture(t, options);
    runValidator(repo, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124, cleanup: 'controller-owned' },
      { controlled: true });
    await drainController(repo, { drained });
    const check = runValidator(repo, { exit: 1 }, { args: ['--check-deferred'] });
    assert.equal(check.status, 75, JSON.stringify(options) + check.stderr);
    assert.equal(deferralOf(repo).ciAuthoritative, false);
  }
  const dirty = fixture(t, { clean: false });
  const uncommitted = runValidator(dirty, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124 });
  assert.equal(uncommitted.status, 124, uncommitted.stderr);
  assert.match(uncommitted.stderr, /validating an uncommitted checkout.*commit the remediation first/s);
  const standalone = fixture(t, { declared: false });
  const result = runValidator(standalone, { rows: PARTIAL, stop: ['absolute-timeout', 124], exit: 124 });
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /canonical-validation-deferred/);
});

// ---- watcher: existing parked custody on a published head ----

function parkedHold(t, { sourceHead = REMOTE, clean = true, deferred = {}, checks = PARTIAL.checks,
  drained = true, finalized = true, cleanup = true, validationHead = sourceHead, launch = LAUNCH,
  targetHead = REMOTE, hqRoot = mkdtempSync(join(tmpdir(), 'hamciauth-hq-')),
  missingDeferral = false } = {}) {
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  const env = { HAM_HQ_ROOT: hqRoot, HAM_REPO: REPO, HAM_PR_NUMBER: '42', HAM_CLOSE_VALIDATION_REMOTE_HEAD: targetHead,
    HAM_CONTROLLER_RECORD: join(hqRoot, `controller-${randomUUID()}.json`) };
  const evidenceDir = startDeferredSourceCustody({ env, launchRequestId: LAUNCH, sourceHead, clean,
    files: ['example.py'], runner: { command: 'python3' } });
  const controller = env.HAM_CONTROLLER_RECORD.split('/').at(-1);
  retainDeferredValidation(evidenceDir, { head: sourceHead, validation: 'unknown', reason: 'absolute-timeout',
    localFailureObserved: false, cleanCheckout: clean, controllerRecord: controller, ...deferred }, { head: validationHead, checks });
  if (missingDeferral) rmSync(join(evidenceDir, 'deferred.json'));
  if (cleanup) writeFileSync(join(evidenceDir, 'controller-cleanup.json'), JSON.stringify({
    launchRequestId: launch, controller, state: drained ? 'quiescent' : 'cleanup-unconfirmed',
    drained, leaseCleanup: { released: true }, validationFinalized: finalized,
  }));
  return { hqRoot, evidenceDir, controller, read: () => readDeferredSourceHold(hqRoot, { repo: REPO, prNumber: 42, headSha: targetHead },
    { includeContinued: true }) };
}

const probe = status => async () => ({ ok: true, row: { launch_request_id: LAUNCH, status }, retryChain: [] });

async function observe(hqRoot, requiredContexts, headSha = REMOTE, readLaunch = probe('succeeded')) {
  const waits = [];
  const held = await observeDeferredSourceDecision({ rootDir: hqRoot, hqRoot, repo: REPO, prNumber: 42, headSha,
    now: '2026-01-01T00:00:00Z', requiredContexts, readLaunch, observeWaitImpl: async args => { waits.push(args); }, logger: null });
  return { held, waits };
}

function preUpgradeHold(t, { launchRequestId = LAUNCH, drained = true, leaseReleased = true,
  archivedReference = false } = {}) {
  const hold = parkedHold(t, { clean: true, deferred: { cleanCheckout: undefined } });
  const { hqRoot, evidenceDir, controller } = hold;
  const promptDir = amaCloserPromptDir(hqRoot);
  mkdirSync(promptDir, { recursive: true });
  const scratchDir = mkdtempSync(join(promptDir, 'hammer-scratch-'));
  const dispatchPath = amaCloserDispatchFilePath(hqRoot, { repo: REPO, prNumber: 42, headSha: REMOTE });
  mkdirSync(dirname(dispatchPath), { recursive: true });
  if (!archivedReference) writeFileSync(dispatchPath, JSON.stringify({ launchRequestId: LAUNCH, scratchDir, promptDir }));

  const record = { schemaVersion: 1, token: controller.slice('controller-'.length, -'.json'.length),
    launchRequestId: LAUNCH, reason: 'validation-stopped', state: 'quiescent', drained: true,
    finishedAt: '2026-01-01T00:00:00Z', leaseCleanup: { released: true } };
  const cleanupPath = join(evidenceDir, 'controller-cleanup.json');
  // The previous writer archived the raw controller record before copying
  // the final check receipt. It wrote neither controller nor validationFinalized.
  writeFileSync(cleanupPath, JSON.stringify(record));
  writeFileSync(join(scratchDir, controller), JSON.stringify({ ...record, launchRequestId,
    drained, leaseCleanup: { released: leaseReleased } }));
  const receiptPath = join(scratchDir, 'local-validation.fixture');
  const deferral = { schemaVersion: 1, head: REMOTE, validation: 'unknown', reason: 'absolute-timeout',
    localFailureObserved: false, controllerRecord: controller, localValidationReceipt: receiptPath };
  writeFileSync(join(scratchDir, `validation-deferred-${REMOTE}.json`), JSON.stringify(deferral));
  if (archivedReference) retainDeferredValidation(evidenceDir, deferral, { head: REMOTE, checks: PARTIAL.checks }, receiptPath);
  return { ...hold, cleanupPath, receiptPath };
}

test('watcher: a pre-upgrade hold retries until final evidence is available, then persists proof before continuation', async t => {
  const { hqRoot, evidenceDir, read, cleanupPath, receiptPath, controller } = preUpgradeHold(t);
  const { held, waits } = await observe(hqRoot, CONTEXTS);
  assert.equal(held?.needsOperator, true);
  assert.equal(waits.length, 1);
  assert.equal(read().continuedAt, undefined);
  assert.equal(JSON.parse(readFileSync(cleanupPath)).validationFinalized, undefined);

  const finalChecks = [...PARTIAL.checks, pass('third')];
  writeFileSync(receiptPath, JSON.stringify({ head: REMOTE, checks: finalChecks }));
  assert.deepEqual(await observe(hqRoot, CONTEXTS), { held: null, waits: [] });
  const cleanup = JSON.parse(readFileSync(cleanupPath));
  assert.equal(cleanup.controller, controller);
  assert.equal(cleanup.validationFinalized, true);
  assert.deepEqual(JSON.parse(readFileSync(join(evidenceDir, 'validation.json'))).checks, finalChecks);
  assert.equal(read().publishedHead, REMOTE);
});

test('watcher: the archived receipt reference can locate a replaced dispatch’s original run', async t => {
  const { hqRoot, read, receiptPath } = preUpgradeHold(t, { archivedReference: true });
  writeFileSync(receiptPath, JSON.stringify({ head: REMOTE, checks: PARTIAL.checks }));
  assert.deepEqual(await observe(hqRoot, CONTEXTS), { held: null, waits: [] });
  assert.equal(read().publishedHead, REMOTE);
});

test('watcher: unverifiable pre-upgrade custody stays fenced even with an archived passing snapshot', async t => {
  for (const [name, options, evidence, contexts = CONTEXTS] of [
    ['missing final receipt', {}, null],
    ['wrong final head', {}, { head: 'c'.repeat(40), checks: PARTIAL.checks }],
    ['late failure', {}, { head: REMOTE, checks: [{ result: 'fail' }] }],
    ['late process inspection refusal', {}, { head: REMOTE, checks: [inspectionRefusal] }],
    ['unconfirmed original drain', { drained: false }, { head: REMOTE, checks: PARTIAL.checks }],
    ['undisposed original lease', { leaseReleased: false }, { head: REMOTE, checks: PARTIAL.checks }],
    ['foreign original launch', { launchRequestId: 'lrq_foreign' }, { head: REMOTE, checks: PARTIAL.checks }],
    ['undeclared contexts', {}, { head: REMOTE, checks: PARTIAL.checks }, []],
  ]) {
    const { hqRoot, read, receiptPath, cleanupPath } = preUpgradeHold(t, { archivedReference: true, ...options });
    if (evidence) writeFileSync(receiptPath, JSON.stringify(evidence));
    const { held } = await observe(hqRoot, contexts);
    assert.equal(held?.needsOperator, true, name);
    assert.equal(read().continuedAt, undefined, name);
    assert.equal(JSON.parse(readFileSync(cleanupPath)).validationFinalized, undefined, name);
  }
});

test('watcher: parked custody of a published head with declared contexts resumes without an operator', async t => {
  const { hqRoot, read } = parkedHold(t);
  assert.equal(deferredSourceNeedsOperator(read(), { liveHead: REMOTE, requiredContexts: CONTEXTS }), false);
  const { held, waits } = await observe(hqRoot, CONTEXTS);
  assert.equal(held, null, 'the ordinary closer re-drive proceeds');
  assert.equal(waits.length, 0, 'no operator page');
  assert.equal(read().publishedHead, REMOTE);
});

test('watcher: undeclared contexts, unpublished or dirty source, or a local failure still need an operator', async t => {
  for (const [name, options, contexts] of [
    ['undeclared contexts', {}, []],
    ['undeclared and missing cleanup', { cleanup: false }, []],
    ['missing cleanup', { cleanup: false }, CONTEXTS],
    ['unconfirmed drain', { drained: false }, CONTEXTS],
    ['only pre-drain evidence', { finalized: false }, CONTEXTS],
    ['missing deferral after cleanup', { missingDeferral: true }, CONTEXTS],
    ['foreign launch', { launch: 'lrq_foreign' }, CONTEXTS],
    ['foreign check head', { validationHead: 'c'.repeat(40) }, CONTEXTS],
    ['unpublished', { sourceHead: 'c'.repeat(40) }, CONTEXTS],
    ['dirty', { clean: false }, CONTEXTS],
    ['failed flag', { deferred: { localFailureObserved: true } }, CONTEXTS],
    ['failed check', { checks: [{ name: 'x', result: 'fail' }] }, CONTEXTS],
    ['inspection denied in final receipt', { checks: [inspectionRefusal] }, CONTEXTS],
    ['inspection denied', { deferred: { reason: 'process-inspection-unavailable' } }, CONTEXTS],
  ]) {
    const { hqRoot, read } = parkedHold(t, options);
    assert.equal(deferredSourceNeedsOperator(read(), { liveHead: REMOTE, requiredContexts: contexts }), true, name);
    const { held, waits } = await observe(hqRoot, contexts);
    assert.equal(held?.reason, DEFERRED_SOURCE_HOLD, name);
    assert.equal(held.needsOperator, true, name);
    assert.equal(waits.length, 1, name);
    assert.equal(read().continuedAt, undefined, name);
  }
});

// ---- prompt golden ----

test('hammer prompt: a timed-out validation with no local failure publishes and continues to CI', () => {
  const template = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const flat = template.replace(/\s+/g, ' ');
  assert.match(flat, /\*\*UNKNOWN validation defers to CI \(HAMCIAUTH-01\)\.\*\* A timed-out or load-killed validation with no local failure, on a clean committed head, in a repository with declared required contexts prints `local-validation-unknown-github-required-gate-authoritative`, even with partial coverage\. It is neither a pass nor a failure: run the close command\. It publishes that head and merges only on green exact-head required contexts and every unchanged review and merge gate\. A round stopped for validation is re-judged after drain and continues by itself\. Never park such a head\./);
  assert.match(flat, /Any other `canonical-validation-deferred` \(local failure, dirty checkout, undeclared contexts, unconfirmed cleanup\) is UNKNOWN\./);
  assert.match(flat, /commit only changed files with the contiguous HAM provenance trailers in Appendix C, then run targeted tests outside the lease on that clean committed head/);
  // The ordinary deferral rule for every other UNKNOWN is unchanged.
  assert.match(flat, /Do not retry validation, conflict repair, publication or close on that head after this stop, even with green required CI\./);
});


test('expired custody audits the release and a fresh closer reuses finalized exact-head UNKNOWN', async t => {
  const fresh = fixture(t);
  const { hqRoot, read } = parkedHold(t, { targetHead: fresh.head, sourceHead: fresh.head });
  const hold = read();
  const raw = JSON.parse(readFileSync(hold.path));
  writeFileSync(hold.path, JSON.stringify({ ...raw, ownerExpiry: { reason: 'owner-expired', launchRequestId: LAUNCH } }));
  const readLaunch = t.mock.fn(async () => { throw new Error('ledger unavailable'); });
  assert.equal((await observe(hqRoot, CONTEXTS, fresh.head, readLaunch)).held, null);
  assert.equal(readLaunch.mock.callCount(), 0);
  const released = read();
  assert.equal(released.resolution.action, 'continue-to-ci');
  assert.equal(released.resolution.at, released.continuedAt);
  assert.deepEqual(released.resolution.requiredContexts, CONTEXTS);

  const result = runValidator(fresh, { exit: 42 }, { extraEnv: {
    HAM_HQ_ROOT: hqRoot, HAM_CLOSE_VALIDATION_REMOTE_HEAD: fresh.head, HQ_LAUNCH_REQUEST_ID: 'lrq_fresh',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.batteries, 0);
  const receipt = deferralOf(fresh);
  assert.equal(receipt.custodyLaunchRequestId, LAUNCH);
  assert.equal(finalizedUnknownDefersToCi(fresh.root, fresh.head, receipt, CONTEXTS), true);
  assert.equal(finalizedUnknownDefersToCi(fresh.root, fresh.head, receipt, []), false);
});

test('a live owner keeps even safe evidence in custody', async t => {
  const { hqRoot, read } = parkedHold(t);
  const { held } = await observe(hqRoot, CONTEXTS, REMOTE, probe('running'));
  assert.equal(held.needsOperator, true);
  assert.equal(read().continuedAt, undefined);
});

test('unsafe custody offers a durable reply and settles a discard only when its owner stops', async t => {
  const { hqRoot, read, evidenceDir } = parkedHold(t, { clean: false });
  const { held } = await observe(hqRoot, CONTEXTS);
  assert.equal(held.needsOperator, true);
  const files = deferredDecisionFiles(hqRoot, read());
  const decision = JSON.parse(readFileSync(files.decision));
  assert.equal(decision.command, held.decisionCommand);
  assert.match(held.decisionCommand, new RegExp(`^hq decision reply ${LAUNCH} --custody-attempt attempt-`));
  assert.deepEqual(decision.options, ['keep-custody', 'discard-remediation']);
  const save = answer => writeFileSync(files.answer, JSON.stringify({ schemaVersion: 1,
    ...files.identity, answer, answeredAt: '2026-01-01T00:00:00Z' }));
  save('keep-custody');
  assert.equal((await observe(hqRoot, CONTEXTS)).held.custodyDecision, 'kept');
  save('discard-remediation');
  assert.equal((await observe(hqRoot, CONTEXTS, REMOTE, probe('running'))).held.custodyDecision, 'answer-saved');
  assert.equal(read().continuedAt, undefined);
  assert.equal((await observe(hqRoot, CONTEXTS)).held, null);
  assert.equal(read().resolution.action, 'discard-remediation');
  assert.equal(read().publishedHead, undefined);
  assert.ok(existsSync(join(evidenceDir, 'deferred.json')));
  assert.equal((await observe(hqRoot, CONTEXTS)).held, null);
});
