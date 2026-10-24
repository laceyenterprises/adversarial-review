import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCheckRollup } from '../src/checks-summary.mjs';

const run = (conclusion, startedAt, completedAt) => ({
  __typename: 'CheckRun', name: 'fixture-check', status: 'COMPLETED',
  conclusion, startedAt, completedAt,
});

test('FINALROUND-01: run start orders reruns even when superseded cancellation completes last', () => {
  const old = run('CANCELLED', '2026-10-12T01:40:00Z', '2026-10-12T01:50:00Z');
  const current = run('SUCCESS', '2026-10-12T01:41:00Z', '2026-10-12T01:43:00Z');
  for (const items of [[old, current], [current, old]]) {
    assert.equal(classifyCheckRollup(items), 'SUCCESS');
  }
});

test('FINALROUND-01: a newer cancelled or pending run still wins over old success', () => {
  const old = run('SUCCESS', '2026-10-12T01:40:00Z', '2026-10-12T01:50:00Z');
  const current = run('CANCELLED', '2026-10-12T01:41:00Z', '2026-10-12T01:43:00Z');
  assert.equal(classifyCheckRollup([current, old]), 'CANCELLED');
  assert.equal(classifyCheckRollup([{ ...current, status: 'IN_PROGRESS', completedAt: null, conclusion: null }, old]), 'PENDING');
  assert.equal(classifyCheckRollup([old], { requiredContexts: ['missing-context'] }), 'PENDING');
});

test('numeric IDs break equal creation timestamps across newest-first pages', () => {
  const createdAt = '2026-01-01T00:00:00Z';
  const newer = { id: 20, name: 'unit', createdAt, conclusion: 'FAILURE' };
  const older = { id: 10, name: 'unit', createdAt, conclusion: 'SUCCESS' };
  assert.equal(classifyCheckRollup([newer, older]), 'FAILURE');
  assert.equal(classifyCheckRollup([older, newer]), 'FAILURE');
});

test('green statuses and other Apps cannot replace a failed check-run producer with the same name', () => {
  const failed = { __typename: 'CheckRun', name: 'unit', app: { id: 1 }, createdAt: '2026-01-01T00:00:00Z', conclusion: 'FAILURE' };
  const status = { __typename: 'StatusContext', context: 'unit', createdAt: '2026-01-01T00:01:00Z', state: 'SUCCESS' };
  const otherApp = { ...failed, app: { id: 2 }, createdAt: '2026-01-01T00:02:00Z', conclusion: 'SUCCESS' };
  for (const values of [[failed, status, otherApp], [otherApp, status, failed]]) {
    assert.equal(classifyCheckRollup(values, { requiredContexts: ['unit'] }), 'FAILURE');
  }
});
