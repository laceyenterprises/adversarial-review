import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { claimNextFollowUpJob, createFollowUpJob, markFollowUpJobCompleted } from '../src/follow-up-jobs.mjs';
import { evaluateRoundBudgetForReview } from '../src/watcher.mjs';

function setupDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

test('posted PRs remain terminal and are skipped', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    5,
    '2026-04-22T05:22:42.212Z',
    'claude',
    'open',
    'LAC-207',
    'posted',
    1,
    '2026-04-22T05:24:00.000Z'
  );

  const row = db.prepare('SELECT review_status, review_attempts, posted_at FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    5
  );

  assert.equal(row.review_status, 'posted');
  assert.equal(row.review_attempts, 1);
  assert.equal(row.posted_at, '2026-04-22T05:24:00.000Z');
});

test('failed delivery remains visible and retryable', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    5,
    '2026-04-22T05:22:42.212Z',
    'claude',
    'open',
    'LAC-207',
    'failed',
    1,
    '2026-04-22T05:23:00.000Z',
    'gh config permission denied'
  );

  const row = db.prepare('SELECT review_status, review_attempts, failed_at, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    5
  );

  assert.equal(row.review_status, 'failed');
  assert.equal(row.review_attempts, 1);
  assert.match(row.failure_message, /permission denied/);
});

test('malformed titles are terminal but explicitly marked malformed', () => {
  const db = setupDb();
  db.prepare(
    'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'laceyenterprises/adversarial-review',
    9,
    '2026-04-22T06:00:00.000Z',
    'malformed-title',
    'open',
    'malformed',
    1,
    '2026-04-22T06:00:00.000Z',
    'Malformed PR title: fix bug'
  );

  const row = db.prepare('SELECT reviewer, review_status, failure_message FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(
    'laceyenterprises/adversarial-review',
    9
  );

  assert.equal(row.reviewer, 'malformed-title');
  assert.equal(row.review_status, 'malformed');
  assert.match(row.failure_message, /Malformed PR title/);
});

test('evaluateRoundBudgetForReview skips rereview spawn when completed rounds exhaust the budget', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const projectsDir = path.join(rootDir, 'projects', 'fixture-project');
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(
    path.join(projectsDir, 'PLAN-track-a.json'),
    `${JSON.stringify({
      planSchemaVersion: 1,
      tickets: [{ id: 'PMO-A1', riskClass: 'medium' }],
    }, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    path.join(projectsDir, 'PLAN-track-a.json.linear-mapping.json'),
    `${JSON.stringify({ 'PMO-A1': 'LAC-207' }, null, 2)}\n`,
    'utf8'
  );

  const created = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 5,
    reviewerModel: 'claude',
    linearTicketId: 'LAC-207',
    reviewBody: '## Summary\nHandle token refresh before retrying.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-22T05:22:42.212Z',
    critical: false,
  });
  const claimed = claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-04-22T05:25:00.000Z',
  });
  const completed = markFollowUpJobCompleted({
    rootDir,
    jobPath: claimed.jobPath,
    completedAt: '2026-04-22T05:30:00.000Z',
    completion: { source: 'test-fixture' },
    reReview: {
      requested: true,
      status: 'pending',
      reason: 'Please re-review.',
      triggered: true,
      requestedAt: '2026-04-22T05:30:00.000Z',
    },
  });

  const logLines = [];
  const decision = evaluateRoundBudgetForReview({
    rootDir,
    repo: completed.job.repo,
    prNumber: completed.job.prNumber,
    linearTicketId: completed.job.linearTicketId,
    reviewStatus: 'pending',
    reviewAttempts: 1,
    log: (line) => logLines.push(line),
  });

  assert.equal(decision.skip, true);
  assert.equal(decision.reason, 'round-budget-exhausted');
  assert.equal(decision.roundBudget, 1);
  assert.equal(decision.riskClass, 'medium');
  assert.equal(logLines.length, 1);
  assert.match(logLines[0], /completed remediation rounds 1\/1/);
  assert.match(logLines[0], /medium risk-class budget/);
});
