import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runHelperStep, helperBudget } from '../bin/hammer-helper-step.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';

async function fixture(t, script, { mode = 'read:report', scaled = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const count = join(dir, 'calls');
  const fake = join(dir, 'base-head.mjs');
  writeFileSync(fake, `import {existsSync, readFileSync, writeFileSync} from 'node:fs';
const count = process.env.HAM_TEST_COUNT;
const attempt = existsSync(count) ? Number(readFileSync(count, 'utf8')) + 1 : 1;
writeFileSync(count, String(attempt));
${script}
`);
  const reports = [];
  let output = '', errors = '';
  const code = await runHelperStep({
    mode, step: 'base-head', nominal: 1, ceiling: 6, command: process.execPath, args: [fake],
    env: { ...process.env, TMPDIR: dir, HAM_TEST_COUNT: count },
  }, {
    budget: (nominal, ceiling) => loadAwareTimeoutSeconds(nominal, {
      loadAvg1m: scaled ? 6 : 0, cpuCount: 1, cpuBusyPercent: 100,
      enabled: true, maxMultiplier: 6, maxSeconds: ceiling,
    }),
    report: reason => reports.push(reason),
    stdout: text => { output += text; }, stderr: text => { errors += text; },
  });
  return { code, output, errors, reports, calls: Number(readFileSync(count, 'utf8')) };
}

test('slow base-head read succeeds beyond nominal within its synthetic scaled budget', async t => {
  const result = await fixture(t, `setTimeout(() => console.log('a'.repeat(40)), 1200);`, { scaled: true });
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.calls, 1);
  assert.equal(result.output, `${'a'.repeat(40)}\n`);
  assert.match(result.errors, /budget=6s loadMultiplier=6/);
  assert.deepEqual(result.reports, []);
});

test('first timeout retries once and publishes only successful read output', async t => {
  const audit = new URL('../src/ama/hammer-terminal-audit.mjs', import.meta.url).href;
  const result = await fixture(t, `
if (attempt === 1) {
  console.log('partial');
  const {reportHammerEarlyFailure} = await import(${JSON.stringify(audit)});
  reportHammerEarlyFailure('starting-pr-state-unavailable');
  setInterval(() => {}, 100);
} else console.log('b'.repeat(40));
`);
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.calls, 2);
  assert.equal(result.output, `${'b'.repeat(40)}\n`);
  assert.deepEqual(result.reports, [], 'a recovered first attempt cannot write a terminal audit');
});

test('two timeouts record step, effective seconds, multiplier and attempts', async t => {
  const result = await fixture(t, 'setInterval(() => {}, 100);');
  assert.equal(result.code, 124);
  assert.equal(result.calls, 2);
  assert.deepEqual(result.reports, ['base-head-timeout:budget-1s:load-1000-milli:attempts-2']);
});

test('a transient inner read timeout also gets just one retry', async t => {
  const result = await fixture(t, `if (attempt === 1) { console.error('ETIMEDOUT'); process.exitCode = 1; }
else console.log('recovered');`);
  assert.equal(result.code, 0, result.errors);
  assert.equal(result.calls, 2);
});

test('a permanent refusal is never retried and retains its original reason and exit code', async t => {
  const audit = new URL('../src/ama/hammer-terminal-audit.mjs', import.meta.url).href;
  const result = await fixture(t, `const {reportHammerEarlyFailure} = await import(${JSON.stringify(audit)});
reportHammerEarlyFailure('git-credential-refresh-failed');
console.error('permission denied'); process.exitCode = 76;`);
  assert.equal(result.code, 76);
  assert.equal(result.calls, 1);
  assert.deepEqual(result.reports, ['git-credential-refresh-failed']);
});

for (const code of [20, 21]) {
  test(`semantic exit ${code} is neither retried nor reported even when stderr mentions a timeout`, async t => {
    const result = await fixture(t, `console.error('CI infrastructure timeout evidence'); process.exitCode = ${code};`);
    assert.equal(result.code, code);
    assert.equal(result.calls, 1);
    assert.deepEqual(result.reports, []);
  });
}

test('a timed-out mutation executes once and preserves its partial receipt', async t => {
  const result = await fixture(t, `console.log('{"pushedHead":"synthetic-receipt"}'); setInterval(() => {}, 100);`,
    { mode: 'mutation:report' });
  assert.equal(result.code, 124);
  assert.equal(result.calls, 1);
  assert.equal(result.output, '{"pushedHead":"synthetic-receipt"}\n');
  assert.deepEqual(result.reports, ['base-head-timeout:budget-1s:load-1000-milli:attempts-1']);
});

for (const mode of ['read', 'mutation']) {
  test(`caller-owned ${mode} returns exhausted timeout diagnostics without reporting`, async t => {
    const result = await fixture(t, `console.log('partial receipt'); process.exitCode = 124;`, { mode });
    assert.equal(result.code, 124);
    assert.equal(result.calls, mode === 'read' ? 2 : 1);
    assert.equal(result.output, 'partial receipt\n');
    assert.match(result.errors, /base-head-timeout:budget-1s:load-1000-milli:attempts-/);
    assert.deepEqual(result.reports, []);
  });
}

test('managed child failure is provisional until the runner decides its final outcome', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'reason');
  assert.equal(reportHammerEarlyFailure('starting-pr-state-unavailable',
    { env: { HAM_HELPER_FAILURE_FILE: path } }), null);
  assert.equal(readFileSync(path, 'utf8'), 'starting-pr-state-unavailable');
});

test('durable timeout diagnostics survive a later generic outer-phase failure', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-final-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const env = { HAM_HQ_ROOT: dir, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42',
    HAM_REVIEWED_SHA: head, HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic',
    HQ_WORKER_RUN_ID: 'wrun_synthetic' };
  const reason = 'base-head-timeout:budget-540s:load-6000-milli:attempts-2';
  reportHammerEarlyFailure(reason, { env });
  reportHammerEarlyFailure('procedure-step-failed', { env });
  const audit = readAmaAuditEntry(dir, 'fixture/repo', 42, head);
  assert.equal(audit.attempts.length, 1);
  assert.equal(audit.attempts[0].reason, reason);
});

test('production sizing passes an effective ceiling through the CLI under pinned high load', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-ceiling-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, 'high-load.mjs');
  writeFileSync(preload, `import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
os.loadavg = () => [6, 6, 6];
os.cpus = () => [{}];
const original = childProcess.execFileSync;
childProcess.execFileSync = (file, ...args) => file === '/bin/ps' ? '100\\n' : original(file, ...args);
syncBuiltinESMExports();
`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous || ''} --import=${preload}`;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
  });
  assert.equal(helperBudget(10, 60), 60, 'fixture must apply the full sixfold multiplier');
  assert.equal(helperBudget(10, 25), 25, 'fallback gives 10; ignoring the ceiling cannot give 25');
});

function durableFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-helper-durable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HAM_NODE_BIN: process.execPath, HAM_HQ_ROOT: dir,
    HAM_RUN_DIR: dir, HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42',
    HAM_REVIEWED_SHA: 'a'.repeat(40), HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic',
    HQ_WORKER_RUN_ID: 'wrun_synthetic', TMPDIR: dir };
  const phasePath = join(dir, 'dispatch/lrq_synthetic/hammer-progress/wrun_synthetic/last-phase.json');
  const audit = () => readAmaAuditEntry(dir, env.HAM_REPO, 42, env.HAM_REVIEWED_SHA);
  const render = source => source
    .replaceAll('<<ROOT_DIR>>/bin/hammer-helper-step.mjs', resolve('bin/hammer-helper-step.mjs'))
    .replaceAll('<<ROOT_DIR>>', dir).replaceAll('<<RUN_DIR>>', dir)
    .replaceAll('<<HQ_ROOT>>', dir).replaceAll('<<REPO>>', env.HAM_REPO)
    .replaceAll('<<PR_NUMBER>>', '42');
  const run = script => spawnSync('/bin/bash', ['-c', render(script)],
    { env, encoding: 'utf8', timeout: 15_000 });
  return { dir, env, phasePath, audit, render, run };
}

test('post-merge best-effort receipt failure preserves the merged phase and writes no early-exit audit', t => {
  const f = durableFixture(t);
  recordHammerPhase('merged', { env: f.env });
  const receiptBefore = readFileSync(f.phasePath, 'utf8');
  mkdirSync(join(f.dir, 'bin'));
  const auditModule = new URL('../src/ama/hammer-terminal-audit.mjs', import.meta.url).href;
  writeFileSync(join(f.dir, 'bin/merge-action-receipt.mjs'), `
import {reportHammerEarlyFailure} from ${JSON.stringify(auditModule)};
reportHammerEarlyFailure('merge-action-receipt-failed');
process.exitCode = 1;
`);
  const merge = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
  const block = merge.slice(merge.indexOf('  if [ -n "$ham_receipt_outcome" ]; then'),
    merge.indexOf('  if [ "$ham_audit_outcome" != succeeded ]; then'));
  assert.match(block, /hammer-helper-step/);
  const result = f.run(`ham_receipt_outcome=merged\n${block}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /coverage remains pending/);
  assert.equal(f.audit(), null);
  assert.equal(readFileSync(f.phasePath, 'utf8'), receiptBefore);
});

test('the conflict submodule loop recovers without an early-exit audit or phase receipt', t => {
  const f = durableFixture(t);
  mkdirSync(join(f.dir, 'bin'));
  writeFileSync(join(f.dir, 'bin/git'), `#!/bin/bash
if [ ! -e "$HAM_RUN_DIR/sync-failed" ]; then
  touch "$HAM_RUN_DIR/sync-failed"
  exit 1
fi
touch "$HAM_RUN_DIR/sync-recovered"
`, { mode: 0o755 });
  f.env.PATH = `${join(f.dir, 'bin')}:${process.env.PATH}`;
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const step = prompt.match(/^ham_step\(\).*$/m)[0];
  const loop = prompt.slice(prompt.indexOf('HAM_CONFLICT_SUBMODULE_SYNC_CAP='),
    prompt.indexOf('# Publish; rebased/multi-commit history'));
  const result = f.run(`${step}\nsleep() { :; }\n${loop}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(f.dir, 'sync-recovered')));
  assert.equal(f.audit(), null);
  assert.equal(existsSync(f.phasePath), false);
  reportHammerEarlyFailure('pr-refresh-failed', { env: f.env });
  assert.equal(f.audit().attempts[0].outcome, 'deferred', 'the real final outcome remains authoritative');
});

test('pre-input base capture resolves its runtime in a fresh shell', t => {
  const f = durableFixture(t);
  mkdirSync(join(f.dir, 'bin'));
  writeFileSync(join(f.dir, 'bin/hammer-node-runtime.sh'),
    readFileSync(new URL('../bin/hammer-node-runtime.sh', import.meta.url)));
  writeFileSync(join(f.dir, 'bin/hammer-base-head.mjs'), `console.log('b'.repeat(40));`);
  delete f.env.HAM_NODE_BIN;
  f.env.AGENT_OS_NODE_BIN = process.execPath;
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const block = prompt.slice(prompt.indexOf('umask 077'),
    prompt.indexOf("cat > '<<RUN_DIR>>/inputs.sh'"));
  const result = f.run(block);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.dir, 'base-head'), 'utf8').trim(), 'b'.repeat(40));
});
