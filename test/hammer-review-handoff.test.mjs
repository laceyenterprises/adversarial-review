import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffHammerReview } from '../bin/hammer-review-handoff.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';

const oldHead = 'a'.repeat(40), headSha = 'b'.repeat(40);
function fixture(t, dispatchHead = headSha) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-handoff-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: 'fixture/repo', prNumber: 42, headSha };
  acquireAmaCloserLease({ ...identity, headSha: dispatchHead });
  updateAmaCloserLease({ ...identity, headSha: dispatchHead, status: 'dispatched', lrqId: 'hammer-run' });
  return identity;
}

for (const dispatchHead of [headSha, oldHead]) {
  test(`failed handoff request leaves ${dispatchHead === headSha ? 'current' : 'rekeyed'} lease recoverable`, async t => {
    const identity = fixture(t, dispatchHead);
    await assert.rejects(handoffHammerReview({ ...identity, requestBoundedReviewImpl: async () => {
      assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'dispatched');
      throw new Error('review request failed');
    } }), /review request failed/);
    const lease = readAmaCloserLease(identity.rootDir, identity);
    assert.equal(lease.status, 'dispatched');
    assert.equal(lease.lrqId, 'hammer-run');
    updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
    assert.equal(readAmaCloserLease(identity.rootDir, identity).terminalOutcome, 'failed-without-merge');
  });
}

test('handoff awaits the bounded request before releasing closer ownership', async t => {
  const identity = fixture(t);
  let complete;
  const requested = new Promise(resolve => { complete = resolve; });
  const request = { triggered: true, status: 'pending' };
  const result = handoffHammerReview({ ...identity, requestBoundedReviewImpl: async args => {
    assert.equal(args.headSha, headSha);
    assert.equal(args.repo, identity.repo);
    assert.equal(args.prNumber, identity.prNumber);
    await requested;
    return request;
  } });
  assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'dispatched');
  complete();
  assert.deepEqual(await result, { outcome: 'handed-to-review', headSha, request });
  assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
  updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
});
