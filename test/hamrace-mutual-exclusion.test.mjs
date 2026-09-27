import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAmaCloserLease, isHeldAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { claimNextFollowUpJob } from '../src/follow-up-jobs.mjs';

test('remediation claim defers on current-head lease, and stale lease expires', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrace-claim-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber: 5, headSha: 'head' };
  const old = '2026-09-27T00:00:00.000Z';
  acquireAmaCloserLease({ rootDir, ...identity, now: old });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_5', now: old });
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'pending');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.json'), JSON.stringify({
    jobId: 'job', repo: 'o/r', prNumber: 5, revisionRef: 'head', status: 'pending',
  }));
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-27T00:01:00.000Z' }), null);
  assert.equal(isHeldAmaCloserLease(rootDir, identity, { now: '2026-09-27T00:31:00.000Z' }), false);
  assert.notEqual(claimNextFollowUpJob({ rootDir, claimedAt: '2026-09-27T00:31:00.000Z' }), null);
});
