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
