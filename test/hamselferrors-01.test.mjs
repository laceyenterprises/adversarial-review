import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HAMMER_STOP_ORIGINS, hammerStopOrigin, closerFaultRecovery } from '../src/ama/hammer-stop-origin.mjs';
import { recordHammerEarlyFailure, CloserCorrectionRequired } from '../src/ama/hammer-terminal-audit.mjs';
import { runHelperStep } from '../bin/hammer-helper-step.mjs';
import { recordHammerRetryDispatch, refundCloserSelfError, readHammerRetryCapLedger,
  HAMMER_SELF_ERROR_REFUND_LIMIT } from '../src/ama/hammer-retry-cap.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { projectHammerStopAudit, hammerPhaseAttempt } from '../src/ama/hammer-phase-outcome.mjs';
import { canonicalHammerValidation, ownPackageImportFault } from '../src/ama/hammer-canonical-validation.mjs';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'hamselferrors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const head = 'a'.repeat(40);
const isolatedEnv = root => ({ PATH: process.env.PATH, HOME: root, TMPDIR: root,
  HQ_ROOT: root, HAM_HQ_ROOT: root,
  ...(process.env.NETGUARD_LOG ? { NETGUARD_LOG: process.env.NETGUARD_LOG } : {}) });

test('every registered stop reason has a pinned origin; new reasons require an explicit decision', () => {
  const table = JSON.parse(readFileSync(new URL('./fixtures/hammer-stop-origins.json', import.meta.url)));
  assert.deepEqual(HAMMER_STOP_ORIGINS, table);
  for (const [reason, origin] of Object.entries(table)) {
    assert.equal(hammerStopOrigin(reason), origin);
    assert.equal(hammerStopOrigin(`${reason}:synthetic-detail`), origin);
    assert.equal(hammerPhaseAttempt({ outcome: 'failed-without-merge', reason }).outcome,
      origin === 'world' ? 'failed-without-merge' : 'deferred', reason);
  }
  for (const reason of ['new-stop', '__proto__', 'toString']) assert.throws(() => hammerStopOrigin(reason), /Unregistered/);
  // Pin all concrete stop emissions in the phase/helper entrypoints. Successes
  // are not stops; dynamic predicate reasons retain their predicate wrapper.
  const successes = new Set(['published', 'verified', 'ci-settled', 'ci-wait-not-needed']);
  for (const file of readdirSync(new URL('../bin', import.meta.url)).filter(file => file.startsWith('hammer-'))) {
    const source = readFileSync(new URL(`../bin/${file}`, import.meta.url), 'utf8');
    const emitted = [...source.matchAll(/HAM_PHASE_OUTCOME=["']?([a-z][a-z0-9-]+)|reportHammerEarlyFailure\(['"]([a-z][a-z0-9-]+)/g)];
    for (const match of emitted) if (!successes.has(match[1] || match[2])) {
      assert.doesNotThrow(() => hammerStopOrigin(match[1] || match[2]), file);
    }
  }
  const controller = readFileSync(new URL('../src/ama/hammer-controller.mjs', import.meta.url), 'utf8');
  for (const match of controller.matchAll(/(?:refuseEnvironment|reportHammerEarlyFailure)\(['"]([a-z][a-z0-9-]+)/g)) {
    assert.doesNotThrow(() => hammerStopOrigin(match[1]), match[1]);
  }
});

test('final closer fault requires correction once, then defers without terminal-stop credit', t => {
  const root = scratch(t);
  const env = { HAM_RUN_DIR: root, HAM_HQ_ROOT: root, HAM_REPO: 'synthetic/repo',
    HAM_PR_NUMBER: '1', HAM_REVIEWED_SHA: head, HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic', HQ_WORKER_RUN_ID: 'wrun_synthetic' };
  assert.throws(() => recordHammerEarlyFailure('controller-setup-failed', { env, final: true }), CloserCorrectionRequired);
  recordHammerEarlyFailure('controller-setup-failed', { env, final: true });
  const audit = readAmaAuditEntry(root, env.HAM_REPO, 1, head);
  assert.equal(audit.attempts.at(-1).outcome, 'deferred');
  assert.equal(audit.attempts.at(-1).reason, 'controller-setup-failed');
  assert.equal(closerFaultRecovery('controller-setup-failed', { env }), 'defer');
  recordHammerEarlyFailure('head-changed', { env, final: true });
  const world = readAmaAuditEntry(root, env.HAM_REPO, 1, head);
  assert.equal(world.attempts.at(-1).outcome, 'failed-without-merge', 'head fence overrides provisional harness deferral');
});

test('historical explicit hammer faults project to deferrals without rewriting facts or masking world refusals', () => {
  const attempt = { outcome: 'failed-without-merge', reason: 'controller-setup-failed',
    attemptPhase: 'hammer-early-exit', launchRequestId: 'lrq_synthetic-old' };
  const original = { status: 'failed-without-merge', attempts: [attempt] };
  const projected = projectHammerStopAudit(original);
  assert.equal(projected.status, 'deferred');
  assert.equal(projected.attempts[0].recordedOutcome, 'failed-without-merge');
  assert.equal(original.attempts[0].outcome, 'failed-without-merge');
  const oldPlan = structuredClone(original);
  oldPlan.attempts[0].reason = 'review-evidence-invalid:plan-invalid';
  assert.equal(projectHammerStopAudit(oldPlan).attempts[0].reason, 'plan-invalid');
  assert.equal(projectHammerStopAudit(oldPlan).attempts[0].reasonDetail, 'review-evidence-invalid:plan-invalid');
  for (const mutate of [
    doc => { doc.attempts[0].attemptPhase = 'daemon'; },
    doc => { doc.closureAuthority = 'ham-terminal-remediation'; doc.attempts[0].path = 'daemon'; },
    doc => { doc.attempts[0].reasons = ['blocking-findings-present']; },
    doc => { doc.attempts[0].githubGate = { reasons: ['head-changed'] }; },
    doc => { doc.attempts[0].reason = 'new-unregistered-historical-reason'; },
    doc => { doc.attempts.unshift({ ...attempt, reason: 'head-changed' }); },
    doc => { doc.attempts[0] = null; },
    doc => { doc.status = 'succeeded'; },
  ]) {
    const doc = structuredClone(original);
    mutate(doc);
    assert.equal(projectHammerStopAudit(doc), doc);
  }
});

test('unavailable or corrupt correction receipts defer rather than allowing repeated corrections', t => {
  const root = scratch(t), env = { HAM_RUN_DIR: root };
  for (const value of ['null', '[]', '{"operation":"unknown-reason"}', 'invalid-json']) {
    writeFileSync(join(root, 'self-error-corrections.json'), value);
    assert.equal(closerFaultRecovery('helper-input-invalid', { env }), 'defer');
  }
  writeFileSync(join(root, 'not-a-directory'), '');
  assert.equal(closerFaultRecovery('helper-input-invalid', { env: { HAM_RUN_DIR: join(root, 'not-a-directory') } }), 'defer');
});

test('misused mutation helper requests corrected input, then succeeds without replay or a terminal audit', async t => {
  const root = scratch(t);
  const helper = join(root, 'helper.mjs');
  writeFileSync(helper, `import {writeFileSync} from 'node:fs';
if(process.argv[2] !== 'blocking') {
 writeFileSync(process.env.HAM_HELPER_FAILURE_FILE,'helper-kind-mismatch');
 console.error('usage: blocking-only helper; non-blocking findings use hammer-edit-plan kind=non-blocking');
 process.exitCode=21;
} else console.log('authorized synthetic result');`);
  const reports = [], output = [];
  const options = { mode: 'mutation:report', step: 'dispute-finding', nominal: 1, ceiling: 1,
    command: process.execPath, env: { ...isolatedEnv(root), HAM_RUN_DIR: root } };
  const deps = { budget: () => 1, report: reason => reports.push(reason), stderr: () => {}, stdout: text => output.push(text) };
  assert.equal(await runHelperStep({ ...options, args: [helper, 'non-blocking'] }, deps), 21);
  assert.deepEqual(reports, []);
  assert.equal(await runHelperStep({ ...options, args: [helper, 'blocking'] }, deps), 0);
  assert.deepEqual(reports, []);
  assert.match(output.join(''), /authorized synthetic result/);
  assert.equal(await runHelperStep({ ...options, args: [helper, 'non-blocking'] }, deps), 75);
  assert.deepEqual(reports, ['helper-kind-mismatch']);
});

test('canonical runner replaces ad-hoc validation and own-package import faults use the GitHub gate without claiming a pass', t => {
  const root = scratch(t);
  mkdirSync(join(root, 'scripts/ci-mirror'), { recursive: true });
  mkdirSync(join(root, 'modules/example/src/synthetic_package'), { recursive: true });
  writeFileSync(join(root, 'modules/example/src/synthetic_package/__init__.py'), '');
  writeFileSync(join(root, 'scripts/ci-mirror/run-ci-mirror.py'), `import sys\nprint("ModuleNotFoundError: No module named 'synthetic_package'", flush=True)\nprint('synthetic later output ' * 10000, flush=True)\nsys.exit(1)\n`);
  assert.deepEqual(canonicalHammerValidation(root, ['modules/example/src/example.py']), {
    command: 'python3', args: ['scripts/ci-mirror/run-ci-mirror.py', '--', 'modules/example/src/example.py'] });
  assert.equal(ownPackageImportFault("ModuleNotFoundError: No module named 'third_party'", new Set(['synthetic_package'])), false);
  const validationEnv = { ...isolatedEnv(root), HAM_REPO: 'synthetic/agent-os',
    HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic-validation', HQ_WORKER_RUN_ID: 'wrun_synthetic-validation' };
  const result = spawnSync(process.execPath, [new URL('../bin/hammer-validate.mjs', import.meta.url).pathname,
    '--canonical', '--', 'modules/example/src/example.py'], { cwd: root, env: validationEnv, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /local-battery-skipped-github-required-gate-authoritative/);
  const progress = join(root, 'dispatch', validationEnv.HQ_LAUNCH_REQUEST_ID,
    'hammer-progress', validationEnv.HQ_WORKER_RUN_ID);
  assert.equal(JSON.parse(readFileSync(join(progress, 'last-phase.json'))).reason,
    'local-battery-skipped-github-required-gate-authoritative');
  for (const receipt of ['validation-passed', 'validation-failed', 'terminal-stop']) {
    assert.equal(existsSync(join(progress, `${receipt}.json`)), false, receipt);
  }
  writeFileSync(join(root, 'git'), '#!/bin/sh\nprintf "modules/example/src/example.py\\n"\n', { mode: 0o755 });
  const legacy = spawnSync(process.execPath, [new URL('../bin/hammer-validate.mjs', import.meta.url).pathname,
    '--pytest', '--', 'arbitrary-ad-hoc-test.py'], { cwd: root,
    env: { ...isolatedEnv(root), HAM_REPO: 'synthetic/agent-os', PATH: `${root}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 20000 });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.match(legacy.stderr, /local-battery-skipped-github-required-gate-authoritative/);
  writeFileSync(join(root, 'scripts/ci-mirror/run-ci-mirror.py'), 'import sys\nprint("FAILED synthetic assertion")\nsys.exit(1)\n');
  const failure = spawnSync(process.execPath, [new URL('../bin/hammer-validate.mjs', import.meta.url).pathname,
    '--canonical', '--', 'modules/example/src/example.py'], { cwd: root, env: isolatedEnv(root), encoding: 'utf8', timeout: 20000 });
  assert.equal(failure.status, 1, failure.stderr);
  assert.doesNotMatch(failure.stderr, /local-battery-skipped/);
});

test('review-service canonical selection runs touched and importer tests through its own offline runner', t => {
  const root = scratch(t);
  mkdirSync(join(root, 'test/adapters'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"adversarial-review"}');
  writeFileSync(join(root, 'test/example.test.mjs'), "import '../src/example.mjs';");
  writeFileSync(join(root, 'test/adapters/adapter.test.mjs'), '');
  writeFileSync(join(root, 'test/unrelated.test.mjs'), '');
  const runner = canonicalHammerValidation(root, ['src/example.mjs', 'test/adapters/adapter.test.mjs']);
  assert.equal(runner.command, process.execPath);
  assert.deepEqual(runner.args, ['test/run-tests.mjs', 'test/example.test.mjs', 'test/adapters/adapter.test.mjs']);
  assert.throws(() => canonicalHammerValidation(root, ['../foreign']), /repository-relative/);
});

test('harness refunds preserve all attempt budgets, dedupe, cap per head and page once durably', async t => {
  const root = scratch(t), identity = { repo: 'synthetic/repo', prNumber: 1 };
  let pages = 0;
  for (let index = 0; index < HAMMER_SELF_ERROR_REFUND_LIMIT; index++) {
    const launchRequestId = `lrq_synthetic-${index}`;
    recordHammerRetryDispatch(root, identity, { jobKey: head, headSha: head, launchRequestId });
    const result = refundCloserSelfError(root, identity, { jobKey: head, headSha: head, launchRequestId });
    assert.equal(result.refunded, true);
    assert.equal(result.exhausted, index === HAMMER_SELF_ERROR_REFUND_LIMIT - 1);
    assert.equal(refundCloserSelfError(root, identity, { jobKey: head, headSha: head, launchRequestId }).reason, 'already-refunded');
    const ledger = readHammerRetryCapLedger(root, identity);
    for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) assert.equal(ledger[key], 0, key);
  }
  for (let poll = 0; poll < 3; poll++) {
    const result = refundCloserSelfError(root, identity, { jobKey: head, headSha: head, launchRequestId: 'lrq_synthetic-2' });
    assert.equal(result.exhausted, true);
    await observeClosureWait({ rootDir: root, ...identity, headSha: head, reason: 'synthetic harness faults',
      waitClass: 'closer-self-error', immediate: true, pageImpl: async () => { pages++; } });
  }
  assert.equal(pages, 1);
  assert.equal(refundCloserSelfError(root, identity, { jobKey: head, headSha: head, launchRequestId: 'lrq_extra' }).reason, 'self-error-budget-exhausted');
  assert.equal(refundCloserSelfError(root, identity, { jobKey: 'other', headSha: head, launchRequestId: 'lrq_extra' }).reason, 'identity-mismatch');
  recordHammerRetryDispatch(root, identity, {
    jobKey: 'b'.repeat(40), headSha: 'b'.repeat(40), launchRequestId: 'lrq_synthetic-new-series',
  });
  assert.equal(readHammerRetryCapLedger(root, identity).selfErrorRefunds[head].length,
    HAMMER_SELF_ERROR_REFUND_LIMIT, 'a new review/head cannot erase the old head refund cap');
});
