import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { handlePostedReviewRow } from '../src/watcher.mjs';

for (const recovered of [false, true]) {
  test(recovered ? 'new normal review resumes automated dispatch after a prior scope finding' : 'posted scope-violation finding suppresses automated merge-agent dispatch without follow-up job', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-additive-scope-'));
    let projected = false;
    let fetchedCandidate = false;
    let dispatched = false;
    const logs = [];
    const postedReviewBody = [
      '## Scope Violation Finding',
      '```json',
      '{"kind":"scope-violation","severity":"high"}',
      '```',
    ].join('\n');

    try {
      const db = openReviewStateDb(rootDir);
      try {
        ensureReviewStateSchema(db);
        db.prepare(
          `INSERT INTO reviewer_passes (
             repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
             started_at, ended_at, status, metadata_json, verdict, body_md, body_captured_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          'example/review-service',
          57,
          1,
          'claude',
          'claude',
          'first-pass',
          '2026-06-19T10:00:00.000Z',
          '2026-06-19T10:01:00.000Z',
          'completed',
          '{}',
          'comment-only',
          postedReviewBody,
          '2026-06-19T10:01:05.000Z',
        );
        if (recovered) {
          db.prepare(
            `INSERT INTO reviewer_passes (
               repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
               started_at, ended_at, status, metadata_json, verdict, body_md, body_captured_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run('example/review-service', 57, 2, 'claude', 'claude', 'rereview',
            '2026-06-19T10:02:00.000Z', '2026-06-19T10:03:00.000Z', 'completed', '{}',
            'request-changes', '## Verdict\nRequest changes\n', '2026-06-19T10:03:05.000Z');
        }
        db.prepare(
          `INSERT INTO reviewed_prs (
             repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
             reviewer_head_sha, revision_ref
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          'example/review-service',
          57,
          '2026-06-19T10:01:05.000Z',
          'claude',
          'open',
          'posted',
          'head-57',
          'head-57',
        );
      } finally {
        db.close();
      }

      await handlePostedReviewRow({
        rootDir,
        repoPath: 'example/review-service',
        prNumber: 57,
        existing: { repo: 'example/review-service', pr_number: 57, review_status: 'posted' },
        currentRevisionRef: 'head-57',
        labelNames: [],
        projectGateStatusSafe: async () => {
          projected = true;
        },
        latestFollowUpJobFinder: () => null,
        fetchMergeAgentCandidateImpl: async () => {
          fetchedCandidate = true;
          return { merged: false, prState: 'open', headRefOid: 'head-57' };
        },
        buildMergeAgentDispatchJobImpl: () => ({}),
        resolveMergeAgentCoexistenceForWatcherImpl: async () => {
          dispatched = true;
          return { outcome: 'ama-dispatched', amaClosureResult: { dispatchId: 'synthetic-dispatch', workerClass: 'hammer' } };
        },
        dispatchMergeAgentForPRImpl: async () => {
          dispatched = true;
          return { decision: 'dispatch' };
        },
        logger: {
          log: (message) => logs.push(message),
          error: (message) => logs.push(message),
        },
      });

      assert.equal(projected, true);
      assert.equal(fetchedCandidate, recovered);
      assert.equal(dispatched, recovered);
      if (recovered) assert.match(logs.join('\n'), /AMA hammer dispatched/);
      else assert.match(logs.join('\n'), /scope-violation finding present/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}
