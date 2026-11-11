import test from 'node:test';
import assert from 'node:assert/strict';
import { isZeroOutputRefusal, escalateZeroOutputRefusal } from '../src/ama/zero-output-refusal.mjs';

const refusal = '[hq] dispatch refused: ticket AMA-PR-123 already produced zero output twice (lrq-a, lrq-b)';

test('only the explicit zero-output refusal transfers custody', () => {
  assert.equal(isZeroOutputRefusal({ stderr: refusal }), true);
  assert.equal(isZeroOutputRefusal(`stderr: ${refusal}`), true);
  assert.equal(isZeroOutputRefusal('provision timeout'), false);
  assert.equal(isZeroOutputRefusal('[hq] dispatch refused: repo_unregistered'), false);
});

test('failed escalation retries delivery while retaining terminal operator custody', async () => {
  let record = { lastError: refusal, state: 'dispatch-failed',
    prelaunchRefusalSlowRetry: { kind: 'dispatch-refused' } };
  let calls = 0;
  const options = {
    repo: 'example/zero-output-delivery', prNumber: 123, headSha: 'a'.repeat(40),
    persistImpl: next => (record = next),
    deliverAlertImpl: async () => { if (++calls === 1) throw new Error('offline'); },
    logger: { warn() {} }, now: '2026-11-11T09:00:00Z',
  };
  await escalateZeroOutputRefusal({ ...options, record });
  assert.equal(record.owner, 'operator-escalated');
  assert.equal(record.prelaunchRefusalSlowRetry, null);
  assert.equal(record.zeroOutputEscalatedAt, undefined);
  await escalateZeroOutputRefusal({ ...options, record });
  assert.equal(record.zeroOutputEscalatedAt, options.now);
  await escalateZeroOutputRefusal({ ...options, record });
  assert.equal(calls, 2);
});

test('unconfigured alert delivery preserves custody without warnings or marking delivery', async () => {
  for (const deliverAlertImpl of [undefined, null, false, {}]) {
    let record = { lastError: refusal, state: 'dispatch-failed' };
    const warnings = [];
    const options = {
      repo: 'example/zero-output-unconfigured', prNumber: 123, headSha: 'c'.repeat(40),
      persistImpl: next => (record = next),
      logger: { warn: message => warnings.push(message) }, now: '2026-11-11T09:00:00Z',
    };
    const result = await escalateZeroOutputRefusal({ ...options, record, deliverAlertImpl });
    assert.equal(result.needsOperator, true);
    assert.equal(record.owner, 'operator-escalated');
    assert.equal(record.zeroOutputEscalatedAt, undefined);
    assert.deepEqual(warnings, []);
  }

  let record = { lastError: refusal, state: 'dispatch-failed' };
  const options = {
    repo: 'example/zero-output-unconfigured', prNumber: 123, headSha: 'c'.repeat(40),
    persistImpl: next => (record = next),
    now: '2026-11-11T09:00:00Z',
  };
  await escalateZeroOutputRefusal({ ...options, record });
  let calls = 0;
  await escalateZeroOutputRefusal({ ...options, record, deliverAlertImpl: async () => calls++ });
  assert.equal(calls, 1);
  assert.equal(record.zeroOutputEscalatedAt, options.now);
});

test('operator alerts include readable diagnostics for string, Error and structured refusals', async () => {
  const cases = [
    [refusal, refusal],
    [new Error(refusal), refusal],
    [{ stderr: refusal, message: 'dispatch failed' }, refusal],
    [{ message: refusal }, refusal],
    [{ stdout: refusal }, refusal],
    [{ detail: refusal }, JSON.stringify({ detail: refusal })],
  ];
  for (const [index, [lastError, diagnostic]] of cases.entries()) {
    let record = { lastError, state: 'dispatch-failed' };
    let alert;
    const repo = `example/zero-output-diagnostic-${index}`;
    const headSha = 'd'.repeat(40);
    await escalateZeroOutputRefusal({
      record, repo, prNumber: 123, headSha,
      persistImpl: next => (record = next),
      deliverAlertImpl: async message => { alert = message; },
    });
    assert.equal(alert,
      `AMA closure for ${repo}#123@${headSha} requires operator action: ${diagnostic}. Automated dispatch stopped.`);
    assert.ok(record.zeroOutputEscalatedAt);
  }
});

test('a receipt that wins the record fence retains ownership without an operator page', async () => {
  let calls = 0;
  const result = await escalateZeroOutputRefusal({
    record: { lastError: refusal, state: 'dispatch-failed' },
    repo: 'example/zero-output-receipt', prNumber: 123, headSha: 'b'.repeat(40),
    persistImpl: () => ({ state: 'dispatched', launchRequestId: 'lrq-admitted' }),
    deliverAlertImpl: async () => calls++,
  });
  assert.equal(result.reason, 'closure-owner-changed');
  assert.equal(calls, 0);
});
