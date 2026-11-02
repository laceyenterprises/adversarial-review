import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordHammerProgress, HAMMER_PROGRESS_MILESTONES } from '../src/ama/hammer-progress.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger, evaluateHammerRetryCap } from '../src/ama/hammer-retry-cap.mjs';
import { classifyDeadHammerCause } from '../src/ama/dead-hammer-rearm.mjs';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('milestones are fixed, durable, run-bound and do not move on repetition', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-progress-'));
  try {
    const env = { HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture' };
    for (const milestone of HAMMER_PROGRESS_MILESTONES) {
      const first = recordHammerProgress(milestone, { env, reason: 'checks-red', final: true, now: new Date('2026-01-01T00:00:00Z') });
      const repeated = recordHammerProgress(milestone, { env, reason: 'merge-error', final: true, now: new Date('2026-01-02T00:00:00Z') });
      const receipt = JSON.parse(readFileSync(join(root, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture',
        `${milestone}.json`)));
      assert.equal(receipt.at, '2026-01-01T00:00:00.000Z');
      assert.equal(receipt.runId, 'wrun_fixture');
      assert.equal(receipt.launchRequestId, 'lrq_fixture');
      assert.equal(receipt.milestone, milestone);
      assert.deepEqual(first, receipt);
      assert.deepEqual(repeated, receipt);
    }
    assert.throws(() => recordHammerProgress('tool-call', { env }));
    assert.throws(() => recordHammerProgress('terminal-stop', { env, final: true }));
    assert.throws(() => recordHammerProgress('verify-head', { env: { ...env, HQ_WORKER_RUN_ID: '../escape' } }));
    assert.throws(() => recordHammerProgress('verify-head', { env: { ...env, AGENT_OS_WORKER_LRQ_ID: 'lrq_other' } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('terminal-stop is recorded only by the explicit final run exit', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-progress-final-'));
  try {
    const env = { HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture' };
    const path = join(root, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture/terminal-stop.json');
    for (const final of [undefined, false, 'true', 1]) {
      assert.throws(() => recordHammerProgress('terminal-stop', { env, reason: 'checks-red', final }), /final run exit/);
    }
    assert.equal(existsSync(path), false);
    recordHammerProgress('terminal-stop', { env, reason: 'checks-red', final: true });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reason, 'checks-red');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the progress CLI takes --final in any position and rejects malformed calls with usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-progress-cli-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/TOKEN|CREDENTIAL|^HAM_|^HQ_|^AGENT_OS_|^LAUNCH_REQUEST_ID$/.test(key)));
    Object.assign(env, { HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture' });
    const cli = (...args) => spawnSync(process.execPath, [join(repoRoot, 'bin/hammer-progress.mjs'), ...args],
      { env, encoding: 'utf8', timeout: 30_000 });
    const path = join(root, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture/terminal-stop.json');
    for (const args of [[], ['not-a-milestone'], ['terminal-stop', 'checks-red'], ['terminal-stop', '--final']]) {
      const result = cli(...args);
      assert.equal(result.status, 64, args.join(' '));
      assert.match(result.stderr, /^usage: hammer-progress /);
    }
    assert.equal(existsSync(path), false);
    const leading = cli('--final', 'terminal-stop', 'checks-red');
    assert.equal(leading.status, 0, leading.stderr);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reason, 'checks-red');
    assert.equal(cli('terminal-stop', '--final', 'later-reason').status, 0);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).reason, 'checks-red');
    assert.equal(cli('verify-head').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Runs the merge phase's own terminal-audit helper, then the closer exit helper,
// as one closer run would; every host side effect except the receipt is stubbed.
function closerRun(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-progress-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const node = join(dir, 'node-fixture');
  writeFileSync(node, `#!/bin/bash
case "$1" in
  */hammer-progress.mjs|*/hammer-terminal-audit.mjs) exec "$REAL_NODE" "$@" ;;
  *) echo "$1" >> "$FIXTURE_DIR/stubbed"; exit 0 ;;
esac
`, { mode: 0o755 });
  const source = readFileSync(join(repoRoot, 'bin/hammer-merge.sh'), 'utf8');
  const values = Object.fromEntries([...source.matchAll(/<<([A-Z_]+)>>/g)].map(([, key]) => [key, 'fixture']));
  Object.assign(values, { ROOT_DIR: repoRoot, RUN_DIR: dir, HQ_ROOT: dir, REPO: 'fixture/repo', PR_NUMBER: '42',
    REVIEWED_SHA: 'a'.repeat(40), TARGET_REMEDIATION_SHA: 'a'.repeat(40) });
  const rendered = renderHammerProcedure('hammer-merge', values);
  const start = rendered.indexOf('ham_append_terminal_audit() {');
  const helper = rendered.slice(start, rendered.indexOf('\n}\n', start) + 3);
  assert.ok(start > 0 && helper.endsWith('}\n'));
  writeFileSync(join(dir, 'audit-helper.sh'), helper);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|CREDENTIAL|^HAM_|^HQ_|^AGENT_OS_|^LAUNCH_REQUEST_ID$/.test(key)));
  Object.assign(env, { FIXTURE_DIR: dir, REAL_NODE: process.execPath, HAM_NODE_BIN: node,
    HAM_HQ_ROOT: dir, HQ_ROOT: dir, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42',
    HAM_TARGET_REMEDIATION_SHA: 'a'.repeat(40), HQ_LAUNCH_REQUEST_ID: 'lrq_fixture',
    HQ_WORKER_RUN_ID: 'wrun_fixture', HAM_MERGE_TMP_PREFIX: join(dir, 'tmp'),
    HAM_GATE_JSON: join(dir, 'gate.json'), HAM_VERDICT_FILE: join(dir, 'verdict.json'),
    HAM_OWN_MERGE_EXECUTED: '0', POST_REMEDIATION_SHA: 'a'.repeat(40) });
  const receipt = join(dir, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture/terminal-stop.json');
  const step = script => {
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c',
      `source "$FIXTURE_DIR/audit-helper.sh"\n${script}`], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const exit = (...args) => spawnSync(process.execPath, [join(repoRoot, 'bin/hammer-terminal-audit.mjs'), ...args],
    { env, encoding: 'utf8', timeout: 30_000 });
  return { dir, receipt, step, exit };
}

test('a deferred no-merge outcome followed by a later success writes no terminal-stop', t => {
  const run = closerRun(t);
  run.step('ham_append_terminal_audit deferred required-checks-pending');
  run.step('ham_append_terminal_audit deferred pr-mergeability-unknown');
  assert.equal(existsSync(run.receipt), false);
  run.step('HAM_OWN_MERGE_EXECUTED=1; ham_append_terminal_audit succeeded merged');
  assert.equal(existsSync(run.receipt), false);
  // The AMA terminal audit is still appended for every outcome.
  assert.equal(readFileSync(join(run.dir, 'stubbed'), 'utf8').split('\n')
    .filter(line => line.endsWith('/ama-audit.mjs')).length, 3);
});

test('a retried no-merge writes none and the final failing exit writes exactly one with its reason', t => {
  const run = closerRun(t);
  run.step('ham_append_terminal_audit failed-without-merge github-gate-not-green');
  assert.equal(existsSync(run.receipt), false);
  // A named stop that the closer may still act on records only its AMA audit.
  assert.equal(run.exit('targeted-validation-failed').status, 0);
  assert.equal(existsSync(run.receipt), false);
  run.step('ham_append_terminal_audit failed-without-merge merge-retry-budget-exhausted');
  assert.equal(existsSync(run.receipt), false);
  const final = run.exit('--final', 'merge-retry-budget-exhausted');
  assert.equal(final.status, 0, final.stderr);
  assert.equal(run.exit('--final', 'later-wrapper-failure').status, 0);
  const receipts = readdirSync(join(run.dir, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture'));
  assert.deepEqual(receipts, ['terminal-stop.json']);
  const receipt = JSON.parse(readFileSync(run.receipt, 'utf8'));
  assert.equal(receipt.reason, 'merge-retry-budget-exhausted');
  assert.equal(receipt.runId, 'wrun_fixture');
  assert.equal(run.exit('--final').status, 64);
});

test('strict Node schema mirrors the closer budget defaults and overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-config-'));
  const topPath = join(root, 'config.yaml');
  try {
    writeFileSync(topPath, 'version: 1\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('worker_pool.hammer_limits.outcome_seconds'), 3600);
    assert.equal(cfg.get('worker_pool.hammer_limits.wall_seconds'), 10800);
    assert.equal(cfg.get('worker_pool.hammer_limits.tokens'), 40_000_000);
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  hammer_limits:\n    tokens: 42\n');
    assert.equal(loadConfig({ topPath, env: {} }).get('worker_pool.hammer_limits.tokens'), 42);
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  hammer_limits:\n    tokens: 0\n');
    assert.throws(() => loadConfig({ topPath, env: {} }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('supervisor stops remain charged to the per-PR lifetime ceiling across fresh heads', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-lifetime-'));
  const identity = { repo: 'example/project', prNumber: 17 };
  try {
    for (const [index, cause] of ['hammer-no-outcome-progress', 'hammer-wall-clock-exceeded',
      'hammer-token-ceiling-exceeded'].entries()) {
      const head = String(index + 1).repeat(40);
      recordHammerRetryDispatch(root, identity, { jobKey: head, headSha: head,
        launchRequestId: `lrq_fixture-${index}`, lifetimeDispatchCeiling: 3 });
      assert.equal(classifyDeadHammerCause({ failureClass: cause }).infra, false);
    }
    const ledger = readHammerRetryCapLedger(root, identity);
    assert.equal(ledger.lifetimeAttemptCount, 3);
    assert.equal(evaluateHammerRetryCap(ledger, { jobKey: '4'.repeat(40), headSha: '4'.repeat(40),
      lifetimeDispatchCeiling: 3 }).lifetimeCapExhausted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLOSERCIWAIT-01: a failure after publication records its step, not published', async t => {
  const { recordHammerEarlyFailure } = await import('../src/ama/hammer-terminal-audit.mjs');
  const root = mkdtempSync(join(tmpdir(), 'hammer-stop-step-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const env = { HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture',
    HAM_PROCEDURE_STEP: 'claim-build' };
  recordHammerEarlyFailure('published', { env, final: true });
  const receipt = JSON.parse(readFileSync(join(root, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture/terminal-stop.json')));
  assert.equal(receipt.reason, 'claim-build-failed');
});

test('commit receipt requires Git proof above the reviewed head', async t => {
  const { reportRemediationCommit } = await import('../src/ama/hammer-progress.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'hammer-local-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HQ_ROOT: dir, HAM_HQ_ROOT: dir, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture',
    AGENT_OS_WORKER_LRQ_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture', HAM_REVIEWED_SHA: 'a'.repeat(40) };
  const options = { env, cwd: dir };
  assert.equal(reportRemediationCommit({ ...options, execImpl: () => `${env.HAM_REVIEWED_SHA}\n` }), null);
  assert.equal(reportRemediationCommit({ ...options, execImpl: () => { throw new Error('missing reviewed commit'); } }), null);
  let calls = 0;
  const receipt = reportRemediationCommit({ ...options, execImpl(_bin, args) {
    calls++;
    if (args[0] === 'rev-parse') return `${'b'.repeat(40)}\n`;
    assert.deepEqual(args, ['merge-base', '--is-ancestor', env.HAM_REVIEWED_SHA, 'b'.repeat(40)]);
    return '';
  } });
  assert.equal(calls, 2);
  assert.equal(receipt.milestone, 'remediation-committed');
});

for (const code of [0, 1, 124]) {
  test(`validation helper records completed result ${code}, leaving timeout unknown`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-validation-receipt-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/TOKEN|CREDENTIAL|^HAM_|^HQ_|^AGENT_OS_|^LAUNCH_REQUEST_ID$/.test(key)));
    Object.assign(env, { HQ_ROOT: dir, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture' });
    const result = spawnSync(process.execPath, [join(repoRoot, 'bin/hammer-validate.mjs'), '--',
      process.execPath, '-e', `process.exit(${code})`], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, code, result.stderr);
    const path = join(dir, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture');
    assert.equal(existsSync(join(path, 'validation-passed.json')), code === 0);
    assert.equal(existsSync(join(path, 'validation-failed.json')), code === 1);
    const fabricated = spawnSync(process.execPath, [join(repoRoot, 'bin/hammer-progress.mjs'), 'validation-passed'],
      { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(fabricated.status, 64);
  });
}

test('terminal classifications remain charged no-merge attempts', () => {
  for (const reason of ['ci-not-green', 'targeted-validation-failed', 'published', 'controller-owner-lost']) {
    assert.equal(classifyDeadHammerCause({ failureClass: `closer-terminal:${reason}` }).infra, false);
  }
});

test('merge release distinguishes unavailable ownership observation from owner loss', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-release-observation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(join(repoRoot, 'bin/hammer-verify-head.sh'), 'utf8');
  const start = source.indexOf('ham_release_merge_lease() {');
  const helper = source.slice(start, source.indexOf('\n}\n', start) + 3).replaceAll('<<ROOT_DIR>>', dir).replace(/<<[A-Z_]+>>/g, 'fixture');
  assert.ok(start >= 0 && helper.endsWith('}\n'));
  const node = join(dir, 'owner-fixture');
  writeFileSync(node, '#!/bin/sh\nexit "$FIXTURE_OWNER_STATUS"\n', { mode: 0o755 });
  for (const [code, reason] of [[75, 'controller-observation-unavailable'], [125, 'controller-owner-lost']]) {
    const result = spawnSync('/bin/bash', ['-c', `${helper}\nham_release_merge_lease; status=$?; echo "$status $HAM_PHASE_OUTCOME"`],
      { env: { PATH: process.env.PATH, HAM_CONTROLLER_RECORD: '/fixture', HAM_NODE_BIN: node,
        FIXTURE_OWNER_STATUS: String(code) }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `125 ${reason}`);
  }
});
