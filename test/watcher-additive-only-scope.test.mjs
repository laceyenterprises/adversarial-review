import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { handlePostedReviewRow } from '../src/watcher.mjs';

test('posted scope-violation finding suppresses automated merge-agent dispatch without follow-up job', async () => {
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
        'laceyenterprises/adversarial-review',
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
    } finally {
      db.close();
    }

    await handlePostedReviewRow({
      rootDir,
      repoPath: 'laceyenterprises/adversarial-review',
      prNumber: 57,
      existing: { repo: 'laceyenterprises/adversarial-review', pr_number: 57, review_status: 'posted' },
      currentRevisionRef: 'head-57',
      labelNames: [],
      projectGateStatusSafe: async () => {
        projected = true;
      },
      latestFollowUpJobFinder: () => null,
      fetchMergeAgentCandidateImpl: async () => {
        fetchedCandidate = true;
        return null;
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
    assert.equal(fetchedCandidate, false);
    assert.equal(dispatched, false);
    assert.match(logs.join('\n'), /scope-violation finding present/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
