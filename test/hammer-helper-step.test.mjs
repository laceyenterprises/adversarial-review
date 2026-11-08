import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runHelperStep, helperBudget } from '../bin/hammer-helper-step.mjs';
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';

async function fixture(t, script, { mode = 'read', scaled = false } = {}) {
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

test('a mandatory semantic stop is not retried even when stderr mentions a timeout', async t => {
  const result = await fixture(t, `console.error('CI infrastructure timeout evidence'); process.exitCode = 20;`);
  assert.equal(result.code, 20);
  assert.equal(result.calls, 1);
});

test('a timed-out mutation executes once and preserves its partial receipt', async t => {
  const result = await fixture(t, `console.log('{"pushedHead":"synthetic-receipt"}'); setInterval(() => {}, 100);`,
    { mode: 'mutation' });
  assert.equal(result.code, 124);
  assert.equal(result.calls, 1);
  assert.equal(result.output, '{"pushedHead":"synthetic-receipt"}\n');
  assert.deepEqual(result.reports, ['base-head-timeout:budget-1s:load-1000-milli:attempts-1']);
});

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

test('production sizing invokes the load-aware CLI with an explicit ceiling', () => {
  assert.equal(helperBudget(1, 1), 1);
});
