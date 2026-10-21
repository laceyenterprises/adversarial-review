import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffHammerReview } from '../bin/hammer-review-handoff.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';

const oldHead = 'a'.repeat(40), headSha = 'b'.repeat(40);
for (const dispatchHead of [headSha, oldHead]) {
  test(`HAMNOREREVIEW-01 old prompt releases ${dispatchHead === headSha ? 'current' : 'rekeyed'} lease for another hammer`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hammer-retry-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { rootDir, repo: 'fixture/repo', prNumber: 42, headSha };
    acquireAmaCloserLease({ ...identity, headSha: dispatchHead });
    updateAmaCloserLease({ ...identity, headSha: dispatchHead, status: 'dispatched', lrqId: 'hammer-run' });
    assert.deepEqual(await handoffHammerReview({ ...identity,
      requestBoundedReviewImpl: () => assert.fail('old prompts cannot request review') }),
    { outcome: 'hammer-retry-required', headSha });
    const lease = readAmaCloserLease(rootDir, identity);
    assert.equal(lease.status, 'terminal');
    assert.equal(lease.terminalOutcome, 'failed-without-merge');
    assert.equal(lease.lrqId, 'hammer-run');
  });
}
