import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeRemediationStopDecision, lifecycleStopDecision, resolveJobPRLifecycleSafe } from '../src/follow-up-lifecycle.mjs';
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

test('only a pending review on a newer head prevents consume; reconcile continues after a worker push', async () => {
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
  assert.equal(lifecycleStopDecision(lifecycle, { ...job, job, site: 'consume' }), null);
  const db2 = openReviewStateDb(rootDir);
  try {
    db2.prepare('UPDATE reviewed_prs SET revision_ref = ? WHERE repo = ? AND pr_number = ?')
      .run('worker-pushed-head', job.repo, job.prNumber);
  } finally {
    db2.close();
  }
  const pushed = await resolveJobPRLifecycleSafe({
    rootDir, job,
    resolvePRLifecycleImpl: async () => ({ prState: 'open', source: 'live', headSha: 'worker-pushed-head' }),
  });
  assert.equal(lifecycleStopDecision(pushed, { ...job, job, site: 'consume' }).stopCode, 'newer-review-pending');
  assert.equal(lifecycleStopDecision(pushed, { ...job, job, site: 'reconcile' }), null);
  assert.equal(lifecycleStopDecision(pushed, { ...job, job, site: 'reconcile-active' }).stopCode, 'stale-review-head');
});

test('review database failure preserves a resolved merged lifecycle', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remwaste-lifecycle-db-'));
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  writeFileSync(join(rootDir, 'data', 'reviews.db'), 'invalid sqlite');
  const lifecycle = await resolveJobPRLifecycleSafe({
    rootDir, job, log: { warn() {}, error() {} },
    resolvePRLifecycleImpl: async () => ({ prState: 'merged', source: 'live' }),
  });
  assert.equal(lifecycleStopDecision(lifecycle, { ...job, job, site: 'consume' }).stopCode, 'operator-merged-pr');
});

test('missing HQ workspace evidence does not cancel an active worker on a moved head', async () => {
  const decision = await activeRemediationStopDecision({
    lifecycle: { prState: 'open', headSha: 'new-head' },
    liveness: { state: 'active', dispatchStatus: { status: 'running' } },
    job: { ...job, remediationWorker: { dispatchMode: 'hq' } },
    rootDir: '/unused',
    execFileImpl: async () => { throw new Error('git must not run without a known workspace'); },
    buildReconciliationPathsImpl: () => { throw new Error('local fallback must not run for HQ'); },
    parseHqWorkerWorkspaceFromPayloadImpl: () => null,
  });
  assert.equal(decision, null);
});
