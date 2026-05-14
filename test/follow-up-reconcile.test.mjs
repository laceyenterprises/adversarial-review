import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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

let previousHqRoot;

beforeEach(() => {
  previousHqRoot = process.env.HQ_ROOT;
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-hq-'));
  process.env.HQ_ROOT = hqRoot;
});

afterEach(() => {
  if (previousHqRoot === undefined) {
    delete process.env.HQ_ROOT;
  } else {
    process.env.HQ_ROOT = previousHqRoot;
  }
});

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

function hqReplyPathForJob(job) {
  const replyPath = path.join(
    process.env.HQ_ROOT,
    'dispatch',
    'remediation-replies',
    job.jobId,
    'remediation-reply.json',
  );
  mkdirSync(path.dirname(replyPath), { recursive: true });
  return replyPath;
}

test('reconcileFollowUpJob stops a finished spawned round for no-progress when no re-review is requested', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    ...makeJobInput(rootDir),
    maxRemediationRounds: 2,
  });
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
    resolvePRLifecycleImpl: async () => null,
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
  const replyPath = hqReplyPathForJob(claimed.job);
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
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
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

test('reconcileFollowUpJob refuses to request rereview when the workspace is contaminated with already-merged commits', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-04-21T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = hqReplyPathForJob(claimed.job);
  writeFileSync(outputPath, 'Validation: npm test\nFiles changed: src/auth.mjs\n', 'utf8');
  // Reply requests rereview — without the contamination gate, this would
  // proceed to a `pending` review_status. With the gate, the audit refuses
  // and the job lands as `failed:branch-contamination`.
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
      replyPath,
    },
  });

  const auditCalls = [];
  const requestReviewCalls = [];
  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
    requestReviewRereviewImpl: (...args) => {
      requestReviewCalls.push(args);
      return { status: 'pending', triggered: true };
    },
    auditWorkspaceForContaminationImpl: async (opts) => {
      auditCalls.push(opts);
      return {
        suspect: [
          { sha: 'deadbeefcafebabe1234567890abcdef00000001', subject: 'PR #420 final-pass followups' },
          { sha: 'deadbeefcafebabe1234567890abcdef00000002', subject: 'PR #422 walker plan-ticket title' },
        ],
        error: null,
      };
    },
  });

  // The audit ran with the right inputs.
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].workspaceDir, workspaceDir);
  assert.equal(auditCalls[0].baseBranch, 'main');

  // The rereview was NOT requested — the gate refused before it fired.
  assert.equal(requestReviewCalls.length, 0);

  // The job transitioned to failed:branch-contamination, not completed.
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.rereview.requested, false);
  assert.equal(reconciled.job.completionMetadata.suspectCommits.length, 2);
  assert.equal(
    reconciled.job.completionMetadata.note,
    'PR branch contains patch-equivalent copies of commits already on the base branch; refused to request rereview to avoid confusing the next reviewer pass.',
  );

  // The watcher review row was NOT bounced back to pending; the previous
  // posted verdict stays so a contaminated branch can't trick the gate
  // into a fresh review.
  const reviewRow = readReviewRow(rootDir);
  assert.equal(reviewRow.review_status, 'posted');
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
  const replyPath = hqReplyPathForJob(claimed.job);
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
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
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
    resolvePRLifecycleImpl: async () => null,
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
  const replyPath = hqReplyPathForJob(claimed.job);
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
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'invalid-remediation-reply');
});

test('reconcileFollowUpJob completes when stdout is empty but the reply.json validates and reReview.requested=true', async () => {
  // Regression for PR #20 incident: a claude-code worker pushed a
  // real fix (commit 839ed9c, 9 files / 557 lines) and wrote a valid
  // remediation-reply.json with reReview.requested=true, but its
  // `--print`-mode stdout (captured to codex-last-message.md) was
  // empty because the response was tool-only. The reconciler used to
  // false-fail this with code `artifact-empty-completion` and post
  // "Human intervention required" on the PR. The fix: when the
  // narrative is empty but the reply.json validates, treat the reply
  // as the durable success signal — `reReview.requested` (per
  // SPEC.md §5.1.2) decides completed vs stopped, NOT `outcome`.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = hqReplyPathForJob(claimed.job);
  // Empty stdout — exactly what claude-code --print produces on a
  // tool-only response.
  writeFileSync(outputPath, '', 'utf8');
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'completed',
    summary: 'Pushed a real fix; reply.json is the durable success signal.',
    validation: ['npm test'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Remediation landed; please run a fresh adversarial pass.',
    },
  }, null, 2)}\n`, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 8124,
      model: 'claude-code',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  const reviewRow = readReviewRow(rootDir);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'completed', 'must NOT route empty-stdout-with-valid-reply to failed/');
  assert.equal(reconciled.job.reReview.requested, true);
  assert.equal(reconciled.job.reReview.triggered, true);
  assert.equal(reconciled.job.reReview.status, 'pending');
  // Watcher row IS reset (the user's PR can be re-reviewed).
  assert.equal(reviewRow.review_status, 'pending');
  assert.equal(reviewRow.rereview_reason, 'Remediation landed; please run a fresh adversarial pass.');
  // Completion metadata reflects that success came from the reply,
  // not the narrative — operators reading the terminal record can
  // tell which path was taken.
  assert.equal(reconciled.job.completion.source, 'claude-code-remediation-reply-only');
  assert.match(reconciled.job.completion.note, /reply contract/i);
  assert.equal(reconciled.job.completion.finalMessageBytes, 0);
});

test('reconcileFollowUpJob honors a valid LEGACY-shape reply (no addressed[]) as the durable success signal when stdout is empty', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = hqReplyPathForJob(claimed.job);
  writeFileSync(outputPath, '', 'utf8');
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'completed',
    summary: 'Legacy reply shape still counts as the durable remediation success signal.',
    validation: ['npm test'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Legacy worker reply is valid and ready for another adversarial pass.',
    },
  }, null, 2)}\n`, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 8124,
      model: 'claude-code',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  const reviewRow = readReviewRow(rootDir);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'completed');
  assert.equal(reconciled.job.reReview.triggered, true);
  assert.equal(reviewRow.review_status, 'pending');
});

test('reconcileFollowUpJob completes when stdout is empty and reply has reReview.requested=true with non-completed outcome', async () => {
  // The durable signal per SPEC.md §5.1.2 is `reReview.requested =
  // true`, NOT `outcome === 'completed'`. A worker may legitimately
  // request another review pass while reporting `outcome: 'partial'`
  // (some findings addressed, some still in flight) or even
  // `outcome: 'blocked'` (worker hit something it could not finish
  // and wants the next adversarial pass to weigh in). The reconciler
  // must enter the success branch and accept the rereview reset
  // regardless of the outcome string. Earlier code keyed the
  // empty-stdout fallback on `outcome === 'completed'` and would
  // have wrongly fallen through to `artifact-empty-completion` here.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = hqReplyPathForJob(claimed.job);
  writeFileSync(outputPath, '', 'utf8');
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'partial',
    summary: 'Addressed two of three blockers; want a fresh pass before continuing.',
    validation: ['npm test'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Two blockers addressed; please re-review before I tackle the third.',
    },
  }, null, 2)}\n`, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 8125,
      model: 'claude-code',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  const reviewRow = readReviewRow(rootDir);
  assert.equal(reconciled.reconciled, true);
  assert.equal(
    reconciled.outcome,
    'completed',
    'durable signal is reReview.requested, not outcome — must NOT fall through to artifact-empty-completion'
  );
  assert.equal(reconciled.job.reReview.requested, true);
  assert.equal(reconciled.job.reReview.triggered, true);
  assert.equal(reviewRow.review_status, 'pending');
  assert.equal(reconciled.job.completion.source, 'claude-code-remediation-reply-only');
});

test('reconcileFollowUpJob fails as invalid-remediation-reply when stdout is empty and reply.json is malformed', async () => {
  // Companion regression: when stdout is empty AND reply.json exists
  // but is malformed/mismatched, the prior probe swallowed the
  // validation error and the reconciler reclassified the job as
  // generic `artifact-empty-completion`. That hid the real cause and
  // made operator recovery harder. The fix uses a tri-state probe
  // (missing | valid | invalid) and routes invalid replies directly
  // to `invalid-remediation-reply` regardless of stdout state.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = hqReplyPathForJob(claimed.job);
  writeFileSync(outputPath, '', 'utf8');
  // Wrong `kind` -> validateRemediationReply throws.
  writeFileSync(replyPath, '{"kind":"wrong"}\n', 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 8125,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(
    reconciled.job.failure.code,
    'invalid-remediation-reply',
    'invalid reply must NOT be hidden behind artifact-empty-completion when stdout is also empty'
  );
});

test('reconcileFollowUpJob still fails when stdout is empty AND no reply.json exists', async () => {
  // The fix only treats empty stdout as success when reply.json is the
  // backup signal. With NEITHER artifact, the worker really did die
  // before producing any durable success record, and we must keep
  // routing to failed/ — the operator needs to inspect the worker log.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  // Empty stdout, NO reply.json — true worker death.
  writeFileSync(outputPath, '', 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 8126,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath: path.relative(rootDir, path.join(artifactDir, 'remediation-reply.json')),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'artifact-empty-completion');
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
    resolvePRLifecycleImpl: async () => null,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'invalid-output-path');
});

test('reconcileFollowUpJob rejects a replyPath that lexically escapes the workspace', async () => {
  // Control-plane integrity guard: a stale or forged job record could
  // record a replyPath like `../outside.json`. With reply.json now a
  // load-bearing success signal (drives completed/stopped + the watcher
  // pending reset), we must refuse to read replies from outside the
  // worker workspace, the same way we already refuse for outputPath.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(outputPath, 'narrative\n', 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 9001,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      // Lexical escape: pretend the worker recorded a reply outside the
      // workspace. Must NOT be trusted as a control-plane success signal.
      replyPath: path.relative(
        rootDir,
        path.join(workspaceDir, '..', 'outside-reply.json'),
      ),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'invalid-output-path');
  assert.match(reconciled.job.failure.message, /(legacyReplyPath|replyPath)/);
});

test('reconcileFollowUpJob rejects a replyPath that resolves through a symlink to outside the workspace', async () => {
  // Defense in depth: even when replyPath stays lexically inside the
  // workspace, an attacker (or a stale workspace) could plant a symlink
  // at .adversarial-follow-up/remediation-reply.json that points at a
  // file outside the workspace (e.g. a forged reply on the operator's
  // disk). The reconciler must refuse to follow that symlink, otherwise
  // the forged reply becomes the durable success signal that drives
  // completed/stopped + the watcher pending reset.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(outputPath, 'narrative\n', 'utf8');

  // Forged reply lives outside the workspace tree but is still a
  // schema-valid remediation-reply with reReview.requested=true. If the
  // symlink were followed, this would wrongly drive `completed/` and
  // reset the watcher row to `pending`.
  const outsideForgedReply = path.join(rootDir, 'forged-reply.json');
  writeFileSync(outsideForgedReply, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'completed',
    summary: 'Forged success signal from outside the workspace.',
    validation: ['nothing'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Should never be honored.',
    },
  }, null, 2)}\n`, 'utf8');

  const replyPath = path.join(artifactDir, 'remediation-reply.json');
  symlinkSync(outsideForgedReply, replyPath);

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 9002,
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
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'failed');
  assert.equal(reconciled.job.failure.code, 'invalid-output-path');
  assert.match(reconciled.job.failure.message, /(legacyReplyPath|replyPath)/);
});

test('reconcileFollowUpJob completes when codex-last-message.md is missing entirely but the reply.json validates and reReview.requested=true', async () => {
  // Locks in the broadened contract from docs/follow-up-runbook.md:
  // "missing OR empty final message artifact, with valid reply
  // artifact". The earlier regression covered the empty-stdout case
  // (file present, zero bytes); this covers the missing-file case
  // (worker never created codex-last-message.md at all). A future
  // refactor of readWorkerFinalMessage / hasNonEmptyNarrative could
  // silently break this branch without any test failing.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  writeReviewRow(rootDir);
  createFollowUpJob(makeJobInput(rootDir));
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T13:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  const replyPath = hqReplyPathForJob(claimed.job);
  // Note: outputPath is configured on the worker record below, but the
  // file is intentionally NOT created — the worker's stdout capture is
  // missing entirely, not just empty.
  writeFileSync(replyPath, `${JSON.stringify({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: claimed.job.jobId,
    repo: claimed.job.repo,
    prNumber: claimed.job.prNumber,
    outcome: 'completed',
    summary: 'Worker pushed code + wrote reply; never wrote codex-last-message.md.',
    validation: ['npm test'],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'Remediation landed; please run a fresh adversarial pass.',
    },
  }, null, 2)}\n`, 'utf8');

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T13:01:00.000Z',
    worker: {
      processId: 9003,
      model: 'claude-code',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
      replyPath,
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T13:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });

  const reviewRow = readReviewRow(rootDir);
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'completed', 'missing final-message + valid reply must route to completed/');
  assert.equal(reconciled.job.reReview.requested, true);
  assert.equal(reconciled.job.reReview.triggered, true);
  assert.equal(reconciled.job.reReview.status, 'pending');
  assert.equal(reviewRow.review_status, 'pending');
  assert.equal(reconciled.job.completion.source, 'claude-code-remediation-reply-only');
  assert.equal(reconciled.job.completion.finalMessageBytes, 0);
});
