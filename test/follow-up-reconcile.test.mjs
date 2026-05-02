import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';

function makeJobInput(rootDir) {
  return {
    rootDir,
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nCheck auth expiry handling.',
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    critical: true,
  };
}

function writeReviewRow(rootDir, overrides = {}) {
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      'INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts, posted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      overrides.repo || 'laceyenterprises/clio',
      overrides.prNumber || 7,
      overrides.reviewedAt || '2026-04-21T08:00:00.000Z',
      overrides.reviewer || 'claude',
      overrides.prState || 'open',
      overrides.linearTicketId || 'LAC-210',
      overrides.reviewStatus || 'posted',
      overrides.reviewAttempts || 1,
      overrides.postedAt || '2026-04-21T08:05:00.000Z'
    );
  } finally {
    db.close();
  }
}

function readReviewRow(rootDir, repo = 'laceyenterprises/clio', prNumber = 7) {
  mkdirSync(path.join(rootDir, 'data'), { recursive: true });
  const db = new Database(path.join(rootDir, 'data', 'reviews.db'));
  try {
    return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
  } finally {
    db.close();
  }
}

test('reconcileFollowUpJob stops a finished spawned round for no-progress when no re-review is requested', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(outputPath, 'Validation: npm test\nFiles changed: src/auth.mjs\n', 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'stopped');
  assert.match(reconciled.jobPath, /data\/follow-up-jobs\/stopped\/.+\.json$/);
  assert.equal(reconciled.job.status, 'stopped');
  assert.equal(reconciled.job.remediationPlan.stop.code, 'no-progress');
  assert.equal(reconciled.job.remediationPlan.rounds[0].state, 'stopped');
  assert.match(reconciled.job.completion.preview, /Validation: npm test/);
  assert.equal(reconciled.job.completion.source, 'codex-output-last-message');
  assert.equal(reconciled.job.completion.finalMessagePath, path.relative(rootDir, outputPath));
  assert.equal(reconciled.job.remediationWorker.processId, 8123);
});

test('reconcileFollowUpJob resets watcher review state when remediation reply requests re-review', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = path.join(artifactDir, 'remediation-reply.json');
  writeFileSync(outputPath, 'Validation: npm test\nFiles changed: src/auth.mjs\n', 'utf8');
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'completed',
    summary: 'Applied the remediation changes.',
    validation: ['npm test'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Remediation landed and is ready for another adversarial pass.',
    },
  }, null, 2)}\n`, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath: path.relative(rootDir, replyPath),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  const reviewRow = readReviewRow(rootDir);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'completed');
  assert.equal(reconciled.job.remediationReply.state, 'worker-wrote-reply');
  assert.equal(reconciled.job.reReview.requested, true);
  assert.equal(reconciled.job.reReview.triggered, true);
  assert.equal(reconciled.job.reReview.status, 'pending');
  assert.equal(reviewRow.review_status, 'pending');
  assert.equal(reviewRow.failure_message, null);
  assert.equal(reviewRow.rereview_reason, 'Remediation landed and is ready for another adversarial pass.');
  assert.equal(reviewRow.rereview_requested_at, '2026-04-21T10:05:00.000Z');
  assert.equal(reviewRow.last_attempted_at, null);
  assert.equal(reviewRow.review_attempts, 1);
  assert.equal(reviewRow.posted_at, null);
});

test('reconcileFollowUpJob records a blocked re-review request when the watcher row is terminal malformed', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir, {
    reviewer: 'malformed-title',
    reviewStatus: 'malformed',
  });
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = path.join(artifactDir, 'remediation-reply.json');
  writeFileSync(outputPath, 'Validation: npm test\nFiles changed: src/auth.mjs\n', 'utf8');
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'completed',
    summary: 'Applied the remediation changes.',
    validation: ['npm test'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Needs another adversarial pass.',
    },
  }, null, 2)}\n`, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath: path.relative(rootDir, replyPath),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  const reviewRow = readReviewRow(rootDir);
  assert.equal(reconciled.reconciled, true);
  // The pre-fix behavior here was `completed` — but that was the bug
  // PR #18's review flagged: a blocked rereview reset must not be
  // wrapped as "completed / re-review queued" because the watcher row
  // was never reset. The job moves to `stopped` with code
  // `rereview-blocked` so operators see that human intervention is
  // required to clear the malformed-title state.
  assert.equal(reconciled.outcome, 'stopped');
  assert.equal(reconciled.job.remediationPlan.stop.code, 'rereview-blocked');
  assert.equal(reconciled.job.reReview.requested, true);
  assert.equal(reconciled.job.reReview.triggered, false);
  assert.equal(reconciled.job.reReview.status, 'blocked');
  assert.equal(reconciled.job.reReview.outcomeReason, 'malformed-title-terminal');
  // The malformed review row stays put; we never silently overwrite it.
  assert.equal(reviewRow.review_status, 'malformed');
});

test('reconcileFollowUpJob fails a finished spawned round when output is missing', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, path.join(artifactDir, 'codex-last-message.md')),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.match(reconciled.jobPath, /data\/follow-up-jobs\/failed\/.+\.json$/);
  assert.equal(reconciled.job.status, 'failed');
  assert.equal(reconciled.job.failure.code, 'artifact-missing-completion');
  assert.equal(reconciled.job.remediationWorker.processId, 8123);
});

test('reconcileFollowUpJob fails when the remediation reply artifact is invalid', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });

  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = path.join(artifactDir, 'remediation-reply.json');
  writeFileSync(outputPath, 'Validation: npm test\nFiles changed: src/auth.mjs\n', 'utf8');
  writeFileSync(replyPath, '{"kind":"wrong"}\n', 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath: path.relative(rootDir, replyPath),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'invalid-remediation-reply');
});

test('reconcileFollowUpJob fails a finished spawned round when outputPath escapes the repo root', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-04-21T10:01:00.000Z',
    worker: {
      processId: 8123,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: '../outside.md',
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'invalid-output-path');
});
