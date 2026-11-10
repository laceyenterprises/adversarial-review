import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendCloserOutcome, closerOutcomeObservation } from '../src/ama/closer-outcomes.mjs';
import {
  amaCloserDispatchDir, readAmaCloserDispatchRecord, reconcileAmaCloserDispatches, updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';

const identity = { repo: 'example/project', prNumber: 42, headSha: 'a'.repeat(40) };
const now = '2026-01-02T03:04:05.000Z';
const receipt = {
  ...identity, launchRequestId: 'launch-one', state: 'launch-terminal',
  terminalLaunchStatus: 'succeeded', lastObservedStatus: 'succeeded', reconciledAt: now,
};
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'closer-outcomes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function rows(root) {
  const dir = join(root, 'data/ama-closer-outcomes');
  return readdirSync(dir).flatMap(name => readFileSync(join(dir, name), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line)));
}

test('terminal process success records no inferred merge; lease success is separate', t => {
  const root = scratch(t);
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal'), true);
  assert.equal(appendCloserOutcome(root, { ...identity, lrqId: 'launch-one',
    status: 'terminal', terminalOutcome: 'succeeded', updatedAt: now }, 'lease-terminal'), true);
  assert.deepEqual(rows(root).map(row => [row.kind, row.launchStatus, row.outcome]), [
    ['launch-terminal', 'succeeded', null], ['lease-terminal', null, 'succeeded'],
  ]);
});

test('parked, provisional, unlaunched, malformed and missing-time records are excluded', () => {
  for (const record of [
    { ...receipt, state: 'dispatched' },
    { ...receipt, state: 'dispatching' },
    { ...receipt, terminalLaunchStatus: null },
    { ...receipt, terminalLaunchStatus: 'running' },
    { ...receipt, terminalLaunchStatus: 'waiting_input' },
    { ...receipt, terminalLaunchStatus: 'not-found' },
    { ...receipt, launchRequestId: null },
    { ...receipt, reconciledAt: null },
    { ...receipt, reconciledAt: 'invalid' },
  ]) assert.equal(closerOutcomeObservation(record, 'launch-terminal'), null);
  assert.equal(closerOutcomeObservation({ ...identity, status: 'terminal',
    terminalOutcome: 'abandoned-timeout', updatedAt: now }, 'lease-terminal'), null);
});

test('operator-hold terminal statuses survive journal serialization', t => {
  const root = scratch(t);
  const statuses = ['operator_triage_required', 'reaped_stuck_requested'];
  for (const terminalLaunchStatus of statuses) {
    assert.equal(appendCloserOutcome(root, {
      ...receipt, launchRequestId: terminalLaunchStatus, terminalLaunchStatus,
    }, 'launch-terminal'), true);
  }
  assert.deepEqual(rows(root).map(row => row.launchStatus), statuses);
  assert.ok(rows(root).every(row => row.kind === 'launch-terminal' && row.outcome === null));
});

test('legacy string PR numbers are serialized as numbers for both observation kinds', t => {
  const root = scratch(t);
  assert.equal(appendCloserOutcome(root, { ...receipt, prNumber: '42' }, 'launch-terminal'), true);
  assert.equal(appendCloserOutcome(root, { ...identity, prNumber: '42', lrqId: 'launch-one',
    status: 'terminal', terminalOutcome: 'succeeded', updatedAt: now }, 'lease-terminal'), true);
  assert.deepEqual(rows(root).map(row => row.prNumber), [42, 42]);
});

test('blank repository and head identities are rejected for both terminal kinds', t => {
  const root = scratch(t);
  const warnings = [];
  for (const [kind, record] of [
    ['launch-terminal', receipt],
    ['lease-terminal', { ...identity, lrqId: 'launch-one',
      status: 'terminal', terminalOutcome: 'succeeded', updatedAt: now }],
  ]) {
    for (const field of ['repo', 'headSha']) {
      for (const value of ['', ' \t\n']) {
        const invalid = { ...record, [field]: value };
        assert.equal(closerOutcomeObservation(invalid, kind), null);
        assert.equal(appendCloserOutcome(root, invalid, kind, {
          warn(message) { warnings.push(message); },
        }), false);
      }
    }
  }
  assert.deepEqual(warnings, Array(8).fill('ama_closer.outcome_record_unavailable'));
  assert.deepEqual(readdirSync(root), [], 'invalid evidence creates no journal');
});

test('directory creation is lazy and recovers after directory removal', t => {
  const root = scratch(t);
  const directories = [];
  const options = { mkdir(dir, flags) {
    directories.push(dir);
    return mkdirSync(dir, flags);
  } };
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', options), true);
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', options), true);
  const dir = join(root, 'data/ama-closer-outcomes');
  assert.deepEqual(directories, [dir]);
  assert.equal(rows(root).length, 2);
  rmSync(dir, { recursive: true });
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', options), true);
  assert.deepEqual(directories, [dir, dir]);
  assert.equal(rows(root).length, 1);
});

test('only missing-directory failures retry, and retry failures remain non-fatal', t => {
  const root = scratch(t);
  for (const code of ['ENOENT', 'EACCES']) {
    let attempts = 0;
    let mkdirs = 0;
    const warnings = [];
    assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', {
      append() { attempts += 1; throw Object.assign(Error('private'), { code }); },
      mkdir() { mkdirs += 1; },
      warn(message) { warnings.push(message); },
    }), false);
    assert.equal(attempts, code === 'ENOENT' ? 2 : 1);
    assert.equal(mkdirs, code === 'ENOENT' ? 1 : 0);
    assert.deepEqual(warnings, ['ama_closer.outcome_record_unavailable']);
  }
});

test('rejected terminal evidence emits only the fixed diagnostic', t => {
  const root = scratch(t);
  const warnings = [];
  const options = { warn(message) { warnings.push(message); } };
  for (const prNumber of ['invalid', '0', '1.5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(appendCloserOutcome(root, { ...receipt, prNumber }, 'launch-terminal', options), false);
  }
  assert.equal(appendCloserOutcome(root, { ...identity, lrqId: 'launch-one', status: 'terminal',
    terminalOutcome: 'synthetic-private-text!', updatedAt: now }, 'lease-terminal', options), false);
  assert.equal(appendCloserOutcome(root, { ...receipt, reconciledAt: null }, 'launch-terminal', options), false);
  assert.deepEqual(warnings, Array(6).fill('ama_closer.outcome_record_unavailable'));
  assert.equal(appendCloserOutcome(root, { ...receipt, state: 'dispatched' }, 'launch-terminal', options), false);
  assert.equal(warnings.length, 6, 'ordinary active records need no diagnostic');
});

test('observation builder exceptions cannot block predecessor replacement or terminal dispatch writes', t => {
  const root = scratch(t);
  const hook = join(root, 'throwing-classifier.mjs');
  writeFileSync(hook, `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/ama/closer-outcomes.mjs')
        && specifier === './launch-request-status.mjs') {
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
          "export function launchRequestMeaning() { throw Error('synthetic-private-text'); }") };
      }
      return nextResolve(specifier, context);
    } });
  `);
  updateAmaCloserDispatchRecord(root, identity, () => receipt, { cleanupScratchImpl() {} });
  const replacement = { ...receipt, launchRequestId: 'launch-two' };
  const script = `
    import assert from 'node:assert/strict';
    import { updateAmaCloserDispatchRecord, readAmaCloserDispatchRecord } from ${JSON.stringify(
      new URL('../src/ama/dispatch-closer.mjs', import.meta.url).href)};
    const warnings = [];
    console.warn = message => warnings.push(message);
    const result = updateAmaCloserDispatchRecord(${JSON.stringify(root)}, ${JSON.stringify(identity)},
      () => (${JSON.stringify(replacement)}), { cleanupScratchImpl() {} });
    assert.deepEqual(result, ${JSON.stringify(replacement)});
    assert.deepEqual(readAmaCloserDispatchRecord(${JSON.stringify(root)}, ${JSON.stringify(identity)}), result);
    assert.deepEqual(warnings, Array(2).fill('ama_closer.outcome_record_unavailable'));
  `;
  const result = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readAmaCloserDispatchRecord(root, identity), replacement);
});

test('unchanged terminal rewrites append once while changed observations preserve the predecessor', t => {
  const root = scratch(t);
  const options = { cleanupScratchImpl() {} };
  updateAmaCloserDispatchRecord(root, identity, () => receipt, options);
  updateAmaCloserDispatchRecord(root, identity, live => ({ ...live, outcome: 'succeeded' }), options);
  assert.equal(rows(root).length, 2, 'one row per write, without an identical predecessor/doc pair');
  const later = { ...receipt, reconciledAt: '2026-01-03T03:04:05.000Z' };
  updateAmaCloserDispatchRecord(root, identity, () => later, options);
  assert.deepEqual(rows(root).map(row => row.terminalAt), [now, now, now, later.reconciledAt]);
  updateAmaCloserDispatchRecord(root, identity, () => ({
    ...later, terminalLaunchStatus: 'failed',
  }), options);
  assert.deepEqual(rows(root).slice(-2).map(row => row.launchStatus), ['succeeded', 'failed']);
});

test('only fixed fields are serialized, without arbitrary output or credentials', t => {
  const root = scratch(t);
  appendCloserOutcome(root, { ...receipt, prompt: 'synthetic-private-text',
    lastError: 'synthetic-private-text', secret: 'synthetic-private-text' }, 'launch-terminal');
  assert.equal(JSON.stringify(rows(root)).includes('synthetic-private-text'), false);
});

test('replacement on the same head retains the terminal predecessor and both launches', t => {
  const root = scratch(t);
  const options = { cleanupScratchImpl() {} };
  updateAmaCloserDispatchRecord(root, identity, () => receipt, options);
  updateAmaCloserDispatchRecord(root, identity, () => ({
    ...receipt, launchRequestId: 'launch-two', terminalLaunchStatus: 'failed',
  }), options);
  const ids = new Set(rows(root).map(row => row.launchRequestId));
  assert.deepEqual([...ids].sort(), ['launch-one', 'launch-two']);
  assert.equal(rows(root)[0].launchStatus, 'succeeded', 'history is never rewritten');
});

test('lease writer records deferred outcomes without declaring launch exit', t => {
  const rootDir = scratch(t);
  acquireAmaCloserLease({ rootDir, ...identity, holderPid: process.pid, now });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'launch-one', now });
  updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'deferred', now });
  assert.deepEqual(rows(rootDir).map(row => [row.kind, row.outcome]), [['lease-terminal', 'deferred']]);
});

test('dispatch and cleanup equivalence when the telemetry store is unavailable', t => {
  const root = scratch(t);
  const healthy = scratch(t);
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data/ama-closer-outcomes'), 'unavailable');
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const cleanups = [];
  const options = { cleanupScratchImpl(record) { cleanups.push(record.launchRequestId); } };
  const expected = updateAmaCloserDispatchRecord(healthy, identity, () => receipt, options);
  const actual = updateAmaCloserDispatchRecord(root, identity, () => receipt, options);
  assert.deepEqual(actual, expected);
  assert.deepEqual(cleanups, ['launch-one', 'launch-one']);
  assert.deepEqual(warnings, ['ama_closer.outcome_record_unavailable']);
  // This existing seam has no paging effect. Failure adds only a local warning.
});

test('reconcile updates the scanned file in place and retains behavior when telemetry is unavailable', async t => {
  const warnings = [];
  t.mock.method(console, 'warn', message => warnings.push(message));
  const results = [];
  for (const unavailable of [false, true]) {
    const root = scratch(t);
    const dir = amaCloserDispatchDir(root);
    mkdirSync(dir, { recursive: true });
    // Legacy filename deliberately disagrees with the record's stored identity.
    const dispatchPath = join(dir, 'legacy-dispatch.json');
    const dispatched = { ...identity, launchRequestId: 'launch-one', state: 'dispatched',
      lastObservedStatus: 'running', lastObservedAt: '2026-01-02T03:00:00.000Z' };
    writeFileSync(dispatchPath, JSON.stringify(dispatched));
    if (unavailable) writeFileSync(join(root, 'data/ama-closer-outcomes'), 'unavailable');
    const cleanups = [];
    const logs = [];
    const options = {
      now, nowMs: () => Date.parse(now),
      scanBudgetMs: 30000, snapshotTimeoutMs: 10000, launchReadTimeoutMs: 8000,
      readLaunchRequestStatusImpl: async ({ launchRequestId }) => {
        assert.equal(launchRequestId, dispatched.launchRequestId);
        return { ok: true, row: { status: 'failed' } };
      },
      cleanupScratchImpl(record) { cleanups.push(record); },
      log: { info(message) { logs.push(JSON.parse(message)); } },
    };
    const result = await reconcileAmaCloserDispatches(root, options);
    assert.equal(result.changed, 1);
    assert.equal(result.terminal, 1);
    assert.deepEqual(result.active, []);
    const terminal = JSON.parse(readFileSync(dispatchPath, 'utf8'));
    assert.deepEqual(terminal, { ...dispatched, state: 'launch-terminal',
      lastObservedStatus: 'failed', terminalLaunchStatus: 'failed',
      lastObservedAt: now, reconciledAt: now });
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')), ['legacy-dispatch.json']);
    assert.deepEqual(cleanups, [dispatched]);
    assert.equal(logs.filter(row => row.event === 'ama_closer.launch_capacity_reconciled').length, 1);
    if (!unavailable) assert.deepEqual(rows(root), [closerOutcomeObservation(terminal, 'launch-terminal')]);
    results.push({ result, terminal, cleanups, logs });
    const repeated = await reconcileAmaCloserDispatches(root, options);
    assert.equal(repeated.changed, 0, 'terminal projection must not be reconciled again');
    assert.equal(cleanups.length, 1);
    if (!unavailable) assert.equal(rows(root).length, 1);
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(warnings, ['ama_closer.outcome_record_unavailable']);
});

test('append failure is non-fatal and diagnostic text excludes transport errors', t => {
  const root = scratch(t);
  const warnings = [];
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', {
    append() { throw Error('synthetic-private-text'); },
    warn(message) { warnings.push(message); },
  }), false);
  assert.deepEqual(warnings, ['ama_closer.outcome_record_unavailable']);
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', {
    append() { throw Error('synthetic-private-text'); },
    warn() { throw Error('diagnostic sink unavailable'); },
  }), false, 'a failed diagnostic sink cannot escape the telemetry guard');
});
