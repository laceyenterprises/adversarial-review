import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferHammerRetryDispatch, recordHammerRetryDispatch, readHammerRetryCapLedger, evaluateHammerRetryCap } from '../src/ama/hammer-retry-cap.mjs';

test('#7702 two contention parks refund all failure counters, once per launch; a real failure counts', () => {
  const root = mkdtempSync(join(tmpdir(), 'leasepark-'));
  const identity = { repo: 'fixture/repo', prNumber: 7702 };
  const args = { jobKey: 'a'.repeat(40), headSha: 'b'.repeat(40), now: '2026-10-04T21:11:00Z' };
  try {
    for (const launchRequestId of ['first', 'second']) {
      recordHammerRetryDispatch(root, identity, args);
      deferHammerRetryDispatch(root, identity, { ...args, launchRequestId });
      deferHammerRetryDispatch(root, identity, { ...args, launchRequestId });
    }
    const ledger = readHammerRetryCapLedger(root, identity);
    assert.equal(ledger.attemptCount, 0);
    assert.equal(ledger.lifetimeAttemptCount, 0);
    assert.equal(ledger.targetAttemptCount, 0);
    assert.equal(ledger.deferralLaunches.length, 2);
    assert.equal(evaluateHammerRetryCap(ledger, args).capExhausted, false);
    recordHammerRetryDispatch(root, identity, args);
    assert.equal(readHammerRetryCapLedger(root, identity).attemptCount, 1);
    assert.equal(deferHammerRetryDispatch(root, identity, { ...args, jobKey: 'moved', launchRequestId: 'third' }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const order of ['deferral-first', 'ordinary-first']) {
  test(`one parked launch cannot consume two refunds: ${order}`, async t => {
    const { refundHammerRetryDispatch } = await import('../src/ama/hammer-retry-cap.mjs');
    const root = mkdtempSync(join(tmpdir(), 'park-dedupe-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const identity = { repo: 'fixture/repo', prNumber: 7 };
    const args = { jobKey: 'review', headSha: 'target', now: '2026-10-04T21:11:00Z', launchRequestId: 'park' };
    recordHammerRetryDispatch(root, identity, args);
    recordHammerRetryDispatch(root, identity, args); // earlier real failure
    if (order === 'deferral-first') {
      deferHammerRetryDispatch(root, identity, args);
      assert.equal(refundHammerRetryDispatch(root, identity, args).reason, 'already-refunded');
    } else {
      assert.equal(refundHammerRetryDispatch(root, identity, args).refunded, true);
      deferHammerRetryDispatch(root, identity, args);
    }
    const ledger = readHammerRetryCapLedger(root, identity);
    assert.equal(ledger.attemptCount, 1);
    assert.equal(ledger.targetAttemptCount, 1);
    assert.equal(ledger.lifetimeAttemptCount, order === 'deferral-first' ? 1 : 2);
  });
}

test('lifetime deferral refunds are bounded across fresh review series and suppression writes', async t => {
  const { markHammerRetryCapExhausted } = await import('../src/ama/hammer-retry-cap.mjs');
  const root = mkdtempSync(join(tmpdir(), 'park-lifetime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { repo: 'fixture/repo', prNumber: 7 };
  for (let i = 0; i < 14; i++) {
    const args = { jobKey: `review-${i}`, headSha: `target-${i}`, launchRequestId: `launch-${i}`, now: '2026-10-04T21:11:00Z' };
    recordHammerRetryDispatch(root, identity, args);
    const ledger = deferHammerRetryDispatch(root, identity, args);
    assert.equal(ledger.deferralLaunches.length, 1);
    assert.equal(ledger.lifetimeDeferralRefundCount, Math.min(i + 1, 12));
    assert.equal(ledger.lifetimeAttemptCount, Math.max(0, i + 1 - 12));
    const suppressed = markHammerRetryCapExhausted(root, identity, { ...args, attemptCount: ledger.attemptCount });
    assert.deepEqual(suppressed.deferralLaunches, ledger.deferralLaunches);
    assert.equal(suppressed.lifetimeDeferralRefundCount, ledger.lifetimeDeferralRefundCount);
  }
});

test('legacy missing lifetime refund usage fails closed without losing the series queue', async t => {
  const { hammerRetryCapFilePath, markHammerRetryCapExhausted } = await import('../src/ama/hammer-retry-cap.mjs');
  const root = mkdtempSync(join(tmpdir(), 'park-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { repo: 'fixture/repo', prNumber: 7 };
  const args = { jobKey: 'review', headSha: 'target', now: '2026-10-04T21:11:00Z', launchRequestId: 'park' };
  const legacy = recordHammerRetryDispatch(root, identity, args);
  delete legacy.lifetimeDeferralRefundCount;
  writeFileSync(hammerRetryCapFilePath(root, identity), JSON.stringify(legacy));
  const deferred = deferHammerRetryDispatch(root, identity, args);
  assert.equal(deferred.lifetimeAttemptCount, 1);
  assert.equal(deferred.lifetimeDeferralRefundCount, 12);
  assert.equal(deferred.attemptCount, 0);
  const nextSeries = markHammerRetryCapExhausted(root, identity, { ...args, jobKey: 'new-review' });
  assert.deepEqual(nextSeries.deferralLaunches, []);
  assert.equal(nextSeries.deferralStartedAt, null);
  assert.equal(nextSeries.deferralNextAt, null);
  assert.equal(nextSeries.lifetimeDeferralRefundCount, 12);
});
