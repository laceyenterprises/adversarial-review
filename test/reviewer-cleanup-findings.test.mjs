import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupFindingPath,
  readReviewerCleanupFindings,
  recheckReviewerCleanupFindings,
  writeReviewerCleanupFinding,
} from '../src/reviewer-cleanup-findings.mjs';

test('posted reviewer cleanup findings persist and clear after a later dead probe', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-cleanup-findings-'));
  const finding = {
    id: 'reviewer:posted_process_group_leak',
    severity: 'warning',
    repo: 'laceyenterprises/agent-os',
    prNumber: 6917,
    reviewerSessionUuid: 'session-6917',
    reviewerPgid: 9182,
    postedAt: '2026-09-20T06:29:34Z',
  };

  const written = writeReviewerCleanupFinding(rootDir, finding, {
    now: new Date('2026-09-20T06:30:00Z'),
  });
  assert.equal(written.firstObservedAt, '2026-09-20T06:30:00.000Z');
  assert.equal(written.checks, 1);
  assert.deepEqual(readReviewerCleanupFindings(rootDir).map((item) => item.reviewerSessionUuid), ['session-6917']);

  const alive = recheckReviewerCleanupFindings({
    rootDir,
    now: new Date('2026-09-20T06:31:00Z'),
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: true, matched: true }),
  });
  assert.deepEqual(alive, { scanned: 1, stillAlive: 1, cleared: 0, unknown: 0 });
  assert.equal(readReviewerCleanupFindings(rootDir)[0].checks, 2);

  const dead = recheckReviewerCleanupFindings({
    rootDir,
    log: { warn() {} },
    probeSessionImpl: () => ({ alive: false, matched: false }),
  });
  assert.deepEqual(dead, { scanned: 1, stillAlive: 0, cleared: 1, unknown: 0 });
  assert.deepEqual(readReviewerCleanupFindings(rootDir), []);
  assert.doesNotThrow(() => cleanupFindingPath(rootDir, 'session-6917'));
});
