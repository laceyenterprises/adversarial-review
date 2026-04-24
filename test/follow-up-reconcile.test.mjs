import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';

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

test('reconcileFollowUpJob completes a finished spawned round when output exists', () => {
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

  const reconciled = reconcileFollowUpJob({
    rootDir,
    jobPath: spawned.jobPath,
    now: () => '2026-04-21T10:05:00.000Z',
    isProcessAliveImpl: () => false,
  });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.outcome, 'completed');
  assert.match(reconciled.jobPath, /data\/follow-up-jobs\/completed\/.+\.json$/);
  assert.equal(reconciled.job.status, 'completed');
  assert.equal(reconciled.job.remediationPlan.rounds[0].state, 'completed');
  assert.match(reconciled.job.completion.preview, /Validation: npm test/);
});

test('reconcileFollowUpJob fails a finished spawned round when output is missing', () => {
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

  const reconciled = reconcileFollowUpJob({
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
});
