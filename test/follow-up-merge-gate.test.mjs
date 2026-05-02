import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
  markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob, reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';

// Small factory so each test has an isolated rootDir + a freshly-
// claimable pending job.
function setupPendingJob(rootDir, overrides = {}) {
  return createFollowUpJob({
    rootDir,
    repo: overrides.repo || 'laceyenterprises/clio',
    prNumber: overrides.prNumber || 42,
    reviewerModel: 'codex',
    linearTicketId: null,
    reviewBody: '## Summary\nNothing useful.\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
    ...overrides,
  });
}

function findStoppedJobOnDisk(rootDir, jobId) {
  // Linear scan across stopped/. Tests run with at most one job, so
  // O(n) is fine and avoids depending on the exact filename mangling.
  const stoppedDir = path.join(rootDir, 'data', 'follow-up-jobs', 'stopped');
  let entries;
  try {
    entries = readdirSync(stoppedDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = path.join(stoppedDir, name);
    const json = JSON.parse(readFileSync(candidate, 'utf8'));
    if (json.jobId === jobId) return { jobPath: candidate, json };
  }
  return null;
}

test('consumeNextFollowUpJob short-circuits to stopped/operator-merged-pr when readPRState reports merged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const created = setupPendingJob(rootDir, { prNumber: 100 });

  // Spawn impl + execFile impl tracking — these MUST NOT fire when the
  // merge gate trips, because the whole point is to skip the spawn.
  let spawnFired = false;
  let cloneFired = false;

  const result = await consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async (command, args) => {
      if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
        cloneFired = true;
      }
      return { stdout: '', stderr: '' };
    },
    spawnImpl: () => {
      spawnFired = true;
      return { pid: 9999, unref() {} };
    },
    now: () => '2026-05-02T11:00:00.000Z',
    readPRStateImpl: () => ({
      prState: 'merged',
      mergedAt: '2026-05-02T10:30:00.000Z',
      closedAt: null,
    }),
  });

  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'pr-merged');
  assert.equal(spawnFired, false, 'must NOT spawn a worker when the PR is already merged');
  assert.equal(cloneFired, false, 'must NOT clone the repo when the PR is already merged');

  const stopped = findStoppedJobOnDisk(rootDir, created.job.jobId);
  assert.ok(stopped, 'job must land in stopped/');
  assert.equal(stopped.json.status, 'stopped');
  assert.equal(stopped.json.remediationPlan.stop.code, 'operator-merged-pr');
  assert.match(stopped.json.remediationPlan.stop.reason, /merged before remediation could run/);
  assert.match(stopped.json.remediationPlan.stop.reason, /mergedAt=2026-05-02T10:30:00\.000Z/);
  assert.equal(stopped.json.remediationWorker.state, 'never-spawned');
});

// Helper for the "merge gate did NOT fire" assertions below. The
// downstream path throws (OAuth or workspace prep), which proves the
// merge gate let the flow through. We capture the thrown error and
// confirm the job landed in failed/, not stopped/operator-merged-pr.
async function expectMergeGateAllowedThrough(promise) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected the downstream path to throw (proving the merge gate did not short-circuit)');
  assert.match(caught.followUpJobPath || '', /\/failed\//, 'job should land in failed/, NOT stopped/operator-merged-pr');
  return caught;
}

test('consumeNextFollowUpJob proceeds normally when readPRState returns null (no review row yet)', async () => {
  // Backward-compat: a missing reviews.db row must NOT block consume.
  // The merge gate is positive opt-in.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 101 });

  await expectMergeGateAllowedThrough(consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => {
      throw new Error('Codex auth file not configured for this test');
    },
    spawnImpl: () => ({ pid: 0, unref() {} }),
    now: () => '2026-05-02T11:00:00.000Z',
    readPRStateImpl: () => null,
  }));
});

test('consumeNextFollowUpJob proceeds normally when readPRState reports open', async () => {
  // Important because an open PR must NEVER be skipped — that would
  // silently halt the queue on every PR.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 102 });

  await expectMergeGateAllowedThrough(consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => {
      throw new Error('Codex auth file not configured for this test');
    },
    spawnImpl: () => ({ pid: 0, unref() {} }),
    now: () => '2026-05-02T11:00:00.000Z',
    readPRStateImpl: () => ({ prState: 'open', mergedAt: null, closedAt: null }),
  }));
});

test('consumeNextFollowUpJob proceeds normally when readPRState throws (DB unreachable)', async () => {
  // Defensive: a DB read error must not block consume. The merge gate
  // is best-effort — when we can't tell, we proceed and let downstream
  // logic handle the (rare) merged-but-spawned race.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 103 });

  await expectMergeGateAllowedThrough(consumeNextFollowUpJob({
    rootDir,
    promptTemplate: 'unused',
    execFileImpl: async () => {
      throw new Error('Codex auth file not configured for this test');
    },
    spawnImpl: () => ({ pid: 0, unref() {} }),
    now: () => '2026-05-02T11:00:00.000Z',
    readPRStateImpl: () => {
      throw new Error('reviews.db unreachable');
    },
  }));
});

test('reconcileFollowUpJob short-circuits to stopped/operator-merged-pr when readPRState reports merged', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 200 });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T11:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });

  // Mark as spawned so the reconciler thinks there's a worker to
  // reconcile. We deliberately do NOT write an output artifact —
  // the merge gate must fire BEFORE the artifact-empty heuristic.
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T11:01:00.000Z',
    worker: {
      processId: 9876,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, path.join(artifactDir, 'codex-last-message.md')),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });

  let postCommentFired = false;
  let rereviewFired = false;

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    job: spawned.job,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T11:05:00.000Z',
    isWorkerRunning: () => false,
    postCommentImpl: () => {
      postCommentFired = true;
      return { posted: true };
    },
    requestReviewRereviewImpl: () => {
      rereviewFired = true;
      return { triggered: false, status: 'blocked', reason: 'pr-not-open' };
    },
    readPRStateImpl: () => ({
      prState: 'merged',
      mergedAt: '2026-05-02T11:03:00.000Z',
      closedAt: null,
    }),
  });

  assert.equal(reconciled.action, 'stopped');
  assert.equal(reconciled.reason, 'pr-merged');
  assert.equal(reconciled.job.status, 'stopped');
  assert.equal(reconciled.job.remediationPlan.stop.code, 'operator-merged-pr');
  assert.match(reconciled.job.remediationPlan.stop.reason, /merged while the remediation worker was running/);
  assert.equal(reconciled.job.remediationWorker.state, 'completed-pr-already-merged');

  // Critical: NEITHER the rereview reset NOR the PR comment fires
  // when we short-circuit on a merged PR. Comments on a merged PR
  // are noise; rereview reset would be refused anyway.
  assert.equal(rereviewFired, false, 'rereview reset must not fire on merged PR');
  assert.equal(postCommentFired, false, 'PR comment must not fire on merged PR');
});

test('reconcileFollowUpJob proceeds normally when readPRState reports open', async () => {
  // Open PR + missing artifacts → falls through to the existing
  // artifact-missing-completion failure path. Confirms the merge gate
  // does not change behavior for the common case.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  setupPendingJob(rootDir, { prNumber: 201 });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-05-02T11:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });

  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-05-02T11:01:00.000Z',
    worker: {
      processId: 9876,
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, path.join(artifactDir, 'codex-last-message.md')),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });

  const reconciled = await reconcileFollowUpJob({
    rootDir,
    job: spawned.job,
    jobPath: spawned.jobPath,
    now: () => '2026-05-02T11:05:00.000Z',
    isWorkerRunning: () => false,
    postCommentImpl: () => ({ posted: false, reason: 'no-token-mapping' }),
    requestReviewRereviewImpl: () => ({ triggered: false, status: 'no-rereview-requested' }),
    readPRStateImpl: () => ({ prState: 'open', mergedAt: null, closedAt: null }),
  });

  assert.notEqual(reconciled.reason, 'pr-merged');
  // Existing failure path still fires for missing artifacts.
  assert.equal(reconciled.action, 'failed');
});
