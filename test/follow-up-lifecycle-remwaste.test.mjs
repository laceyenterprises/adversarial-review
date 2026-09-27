import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleStopDecision, resolveJobPRLifecycleSafe } from '../src/follow-up-lifecycle.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const job = { repo: 'example/project', prNumber: 7, revisionRef: 'reviewed-head' };

test('lifecycle stops a superseded head during consume and reconcile', () => {
  for (const site of ['consume', 'reconcile-active']) {
    const decision = lifecycleStopDecision({ prState: 'open', headSha: 'new-head', source: 'live' }, { ...job, job, site });
    assert.equal(decision.stopCode, 'stale-review-head');
  }
});

test('lifecycle stops merged and closed PRs before spawn', () => {
  for (const [prState, code] of [['merged', 'operator-merged-pr'], ['closed', 'operator-closed-pr']]) {
    const decision = lifecycleStopDecision({ prState, source: 'live' }, { ...job, job, site: 'consume' });
    assert.equal(decision.stopCode, code);
  }
});

test('a pending newer review prevents remediation even on the same head', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remwaste-lifecycle-'));
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status, revision_ref)
      VALUES (?, ?, ?, ?, ?, ?)`).run(job.repo, job.prNumber, '2026-09-27T00:00:00Z', 'codex', 'pending', job.revisionRef);
  } finally {
    db.close();
  }
  const lifecycle = await resolveJobPRLifecycleSafe({
    rootDir,
    job,
    resolvePRLifecycleImpl: async () => ({ prState: 'open', source: 'live', headSha: job.revisionRef }),
  });
  assert.equal(lifecycleStopDecision(lifecycle, { ...job, job, site: 'consume' }).stopCode, 'newer-review-pending');
});
