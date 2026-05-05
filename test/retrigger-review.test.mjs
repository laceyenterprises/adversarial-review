import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main, parseArgs } from '../src/retrigger-review.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { createFollowUpJob, getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';

function makeCaptureStream() {
  const chunks = [];
  return {
    write(chunk) { chunks.push(String(chunk)); return true; },
    text() { return chunks.join(''); },
  };
}

function insertReviewRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, posted_at, failed_at, failure_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      overrides.repo || 'laceyenterprises/agent-os',
      overrides.prNumber || 238,
      '2026-05-05T04:00:00.000Z',
      'codex',
      overrides.prState || 'open',
      overrides.reviewStatus || 'posted',
      1,
      '2026-05-05T04:00:00.000Z',
      overrides.failedAt || null,
      overrides.failureMessage || null,
    );
  } finally {
    db.close();
  }
}

function makeJob(rootDir, overrides = {}) {
  const result = createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 238,
    reviewerModel: 'claude',
    reviewBody: '## Summary\nsummary',
    reviewPostedAt: '2026-05-05T04:00:00.000Z',
    critical: true,
    maxRemediationRounds: 1,
  });
  const job = {
    ...result.job,
    ...overrides,
    remediationPlan: {
      ...result.job.remediationPlan,
      ...(overrides.remediationPlan || {}),
    },
  };
  writeFollowUpJob(result.jobPath, job);
  return { jobPath: result.jobPath, job };
}

test('parseArgs defaults --bump-budget to 1', () => {
  const { values } = parseArgs([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
  ]);
  assert.equal(values.bumpBudget, 1);
});

test('retrigger-review refuses pending review rows', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'pending' });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:not-eligible/);
});

test('retrigger-review bumps the terminal job budget and resets review status', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  const { jobPath } = makeJob(rootDir, {
    status: 'completed',
    completedAt: '2026-05-05T04:05:00.000Z',
    reReview: { requested: true },
  });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'substantially rewritten',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare('SELECT review_status FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get('laceyenterprises/agent-os', 238);
    assert.equal(row.review_status, 'pending');
  } finally {
    db.close();
  }

  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  assert.equal(job.remediationPlan.maxRounds, 2);
  assert.equal(JSON.parse(out.text()).outcome, 'bumped');
});

test('retrigger-review refuses active follow-up jobs when bumping is enabled', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  makeJob(rootDir, { status: 'pending' });

  const err = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: makeCaptureStream(), stderr: err });

  assert.equal(rc, 2);
  assert.match(err.text(), /refused:job-active/);
});

test('retrigger-review skips the budget bump when no follow-up job exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'retrigger-review-'));
  insertReviewRow(rootDir, { reviewStatus: 'posted' });
  mkdirSync(getFollowUpJobDir(rootDir, 'pending'), { recursive: true });

  const out = makeCaptureStream();
  const rc = main([
    '--repo', 'laceyenterprises/agent-os',
    '--pr', '238',
    '--reason', 'retry',
    '--root-dir', rootDir,
    '--hq-root', rootDir,
  ], { stdout: out, stderr: makeCaptureStream() });

  assert.equal(rc, 0);
  const row = JSON.parse(out.text());
  assert.equal(row.priorMaxRounds, null);
  assert.equal(row.newMaxRounds, null);
});
