import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
