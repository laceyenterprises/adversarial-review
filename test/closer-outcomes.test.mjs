import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCloserOutcome, closerOutcomeObservation } from '../src/ama/closer-outcomes.mjs';
import { updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
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

test('paging and dispatch equivalence when the telemetry store is unavailable', t => {
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

test('append failure is non-fatal and diagnostic text excludes transport errors', t => {
  const root = scratch(t);
  const warnings = [];
  assert.equal(appendCloserOutcome(root, receipt, 'launch-terminal', {
    append() { throw Error('synthetic-private-text'); },
    warn(message) { warnings.push(message); },
  }), false);
  assert.deepEqual(warnings, ['ama_closer.outcome_record_unavailable']);
});
