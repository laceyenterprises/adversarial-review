import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
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
  test(`failed handoff request leaves ${dispatchHead === headSha ? 'current' : 'rekeyed'} lease owned by the bounded review wait`, async t => {
    const identity = fixture(t, dispatchHead);
    await assert.rejects(handoffHammerReview({ ...identity, requestBoundedReviewImpl: async () => {
      assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
      throw new Error('review request failed');
    } }), /review request failed/);
    const lease = readAmaCloserLease(identity.rootDir, identity);
    assert.equal(lease.status, 'handed-to-review');
    assert.equal(lease.lrqId, 'hammer-run');
    updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
    assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
    const pages = [];
    for (const now of [0, 100, 101]) await observeClosureWait({ ...identity, now,
      reason: 'handed-to-review:' + headSha, env: { AMA_CLOSURE_WAIT_BOUND_MS: '100' },
      pageImpl: async text => pages.push(text) });
    assert.equal(pages.length, 1);
  });
}

test('handoff exposes review ownership before awaiting the bounded request', async t => {
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
  assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
  complete();
  assert.deepEqual(await result, { outcome: 'handed-to-review', headSha, request });
  assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
  updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  assert.equal(readAmaCloserLease(identity.rootDir, identity).status, 'handed-to-review');
});
