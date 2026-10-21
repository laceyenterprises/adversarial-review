import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFollowUpJob, readFollowUpJob, requeueFollowUpJobForNextRound, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { fetchHammerHeadRange, readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';

import {
  buildRereviewCiBlockedFailureMessage,
  buildRereviewCiRegressionReason,
  DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS,
  guardRereviewCiBeforeReviewer,
  shouldRecheckCiBlockedRereview,
} from '../src/reviewer-ci-admission.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from '../src/review-statuses.mjs';

function silentLog() {
  return {
    log() {},
    warn() {},
  };
}

test('consecutive failed-CI admissions retain a persisted no-progress hammer hand-off', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ci-admission-no-progress-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const repo = 'laceyenterprises/agent-os';
  const prNumber = 6593;
  const job = buildFollowUpJob({ repo, prNumber, reviewerModel: 'codex', reviewBody: '## Verdict\nRequest changes' });
  job.status = 'completed';
  job.completedAt = '2026-10-10T17:00:00.000Z';
  job.reReview = { requested: false };
  job.remediationPlan.currentRound = 1;
  job.remediationPlan.maxRounds = 3;
  job.remediationPlan.rounds = [{ round: 1, state: 'completed' }];
  const completedDir = join(rootDir, 'data/follow-up-jobs/completed');
  mkdirSync(completedDir, { recursive: true });
  writeFollowUpJob(join(completedDir, `${job.jobId}.json`), job);
  const args = {
    rootDir, repo, prNumber, passKind: 'rereview', reviewerHeadSha: 'head-red',
    log: silentLog(), now: () => '2026-10-10T18:00:00.000Z',
    inspectCiImpl: async () => ({ state: 'failed', headSha: 'head-red', failedChecks: [{ name: 'repo-guards', state: 'FAILURE' }] }),
  };
  const first = await guardRereviewCiBeforeReviewer(args);
  assert.equal(first.hammerOwner, true);
  assert.equal(first.job.status, 'stopped');
  assert.equal(first.job.remediationPlan.stop.code, 'no-progress');
  const stoppedBytes = JSON.stringify(readFollowUpJob(first.jobPath));
  const second = await guardRereviewCiBeforeReviewer({
    ...args, requeueImpl: () => assert.fail('automatic admission must not reopen the hand-off'),
  });
  assert.equal(second.hammerOwner, true);
  assert.equal(second.reason, 'ci-regression-stopped');
  assert.equal(second.jobPath, first.jobPath);
  assert.equal(JSON.stringify(readFollowUpJob(first.jobPath)), stoppedBytes);
  assert.equal(findLatestFollowUpJob(rootDir, { repo, prNumber }).job.status, 'stopped');
  // This is an automatic-admission restriction; operator recovery still works.
  const operator = requeueFollowUpJobForNextRound({ rootDir, jobPath: first.jobPath, requestedBy: 'operator' });
  assert.equal(operator.job.status, 'pending');
});

for (const finalRound of [true, false]) {
  test(`failed CI ${finalRound ? 'preserves the completed final-round hammer edge' : 'requeues an ordinary completed round'}`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ci-admission-completed-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const repo = 'fixture/repo', prNumber = 42;
    const reviewedHead = 'a'.repeat(40), pushedHead = 'b'.repeat(40), hammerHead = 'c'.repeat(40);
    const job = buildFollowUpJob({ repo, prNumber, reviewerModel: 'codex', revisionRef: reviewedHead,
      reviewBody: '## Verdict\nComment only' });
    job.status = 'completed';
    job.completedAt = '2026-01-01T10:00:00.000Z';
    job.reReview = finalRound
      ? { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round' }
      : { requested: true, status: 'pending' };
    if (finalRound) job.finalRound = 'comment-only';
    job.completion = { workerPushedHeadSha: pushedHead };
    job.remediationPlan.currentRound = 1;
    job.remediationPlan.maxRounds = 3;
    const round = { round: 1, state: 'completed', startHeadSha: reviewedHead, resultingHeadSha: pushedHead };
    job.remediationPlan.rounds = [round];
    const completedDir = join(rootDir, 'data/follow-up-jobs/completed');
    mkdirSync(completedDir, { recursive: true });
    const jobPath = join(completedDir, `${job.jobId}.json`);
    writeFollowUpJob(jobPath, job);
    const before = readFileSync(jobPath, 'utf8');
    const args = { rootDir, repo, prNumber, passKind: 'rereview', reviewerHeadSha: pushedHead,
      log: silentLog(), now: () => '2026-01-01T11:00:00.000Z',
      inspectCiImpl: async () => ({ state: 'failed', headSha: pushedHead,
        failedChecks: [{ name: 'synthetic-ci', state: 'FAILURE' }] }),
    };
    const result = await guardRereviewCiBeforeReviewer({ ...args,
      ...(finalRound ? { requeueImpl: () => assert.fail('final round must bypass requeue') } : {}),
    });
    assert.equal(result.proceed, false);
    if (!finalRound) {
      assert.equal(result.reason, 'ci-regression-requeued');
      assert.equal(result.job.status, 'pending');
      assert.match(result.jobPath, /follow-up-jobs\/pending\//);
      assert.equal(result.job.remediationPlan.nextAction.requestedBy, 'watcher-ci-admission');
      assert.equal(result.job.remediationPlan.nextAction.round, 2);
      assert.equal(existsSync(jobPath), false);
      return;
    }
    assert.equal(result.reason, 'ci-regression-hammer-owned');
    assert.equal(result.hammerOwner, true);
    assert.equal(result.parkReview, true);
    assert.equal(result.parkReviewStatus, REREVIEW_CI_BLOCKED_STATUS);
    assert.match(result.failureMessage, /completed comment-only final round/);
    assert.equal(result.jobPath, jobPath);
    assert.equal(result.job.status, 'completed');
    assert.deepEqual(result.job.remediationPlan.rounds, [round]);
    const repeated = await guardRereviewCiBeforeReviewer(args);
    assert.equal(repeated.reason, 'ci-regression-hammer-owned');
    assert.equal(readFileSync(jobPath, 'utf8'), before);
    assert.equal(existsSync(join(rootDir, 'data/follow-up-jobs/stopped', `${job.jobId}.json`)), false);
    const rounds = await readCompletedRemediationRounds(rootDir, repo, prNumber);
    assert.deepEqual(rounds, [round]);
    const range = await fetchHammerHeadRange({ repo, reviewedHead, currentHead: hammerHead,
      hammerBaseHead: pushedHead, remediationRounds: rounds, env: {},
      get: async (path) => {
        assert.equal(path, `repos/${repo}/compare/${reviewedHead}...${pushedHead}`);
        return { status: 'ahead' };
      },
    });
    assert.equal(range.verified, true);
    assert.equal(range.proof, 'completed-remediation-round-chain');
    assert.deepEqual(range.commits, [pushedHead, hammerHead]);
  });
}

test('guardRereviewCiBeforeReviewer bypasses first-pass review admission', async () => {
  let inspected = false;
  const result = await guardRereviewCiBeforeReviewer({
    passKind: 'first-pass',
    inspectCiImpl: async () => {
      inspected = true;
      return { state: 'failed' };
    },
  });

  assert.equal(result.proceed, true);
  assert.equal(result.reason, 'not-rereview');
  assert.equal(inspected, false);
});

test('guardRereviewCiBeforeReviewer allows rereview when external CI is green', async () => {
  const result = await guardRereviewCiBeforeReviewer({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6592,
    passKind: 'rereview',
    reviewerHeadSha: 'head-green',
    log: silentLog(),
    inspectCiImpl: async () => ({
      state: 'green',
      headSha: 'head-green',
      failedChecks: [],
      pendingChecks: [],
    }),
  });

  assert.equal(result.proceed, true);
  assert.equal(result.reason, 'ci-green');
});

test('guardRereviewCiBeforeReviewer defers rereview while external CI is pending', async () => {
  let requeued = false;
  const result = await guardRereviewCiBeforeReviewer({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6592,
    passKind: 'rereview',
    reviewerHeadSha: 'head-pending',
    log: silentLog(),
    inspectCiImpl: async () => ({
      state: 'pending',
      headSha: 'head-pending',
      pendingChecks: [{ name: 'repo-guards', state: 'IN_PROGRESS' }],
    }),
    requeueImpl: () => {
      requeued = true;
      return {};
    },
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-settlement-pending');
  assert.equal(requeued, false);
});

test('guardRereviewCiBeforeReviewer defers rereview when CI evidence is unavailable', async () => {
  const result = await guardRereviewCiBeforeReviewer({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6592,
    passKind: 'rereview',
    reviewerHeadSha: 'head-unknown',
    log: silentLog(),
    inspectCiImpl: async () => ({
      state: 'unknown',
      headSha: 'head-unknown',
      error: 'status check rollup unavailable',
    }),
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-settlement-unknown');
});

test('guardRereviewCiBeforeReviewer requeues latest follow-up job on failed external CI', async () => {
  let requeueArgs = null;
  const result = await guardRereviewCiBeforeReviewer({
    rootDir: '/tmp/adversarial-review-fixture',
    repo: 'laceyenterprises/agent-os',
    prNumber: 6593,
    passKind: 'rereview',
    reviewerHeadSha: 'head-red',
    log: silentLog(),
    now: () => '2026-09-11T06:50:00.000Z',
    inspectCiImpl: async () => ({
      state: 'failed',
      headSha: 'head-red',
      failedChecks: [
        { name: 'Ruff lint and format baseline', state: 'FAILURE' },
      ],
      pendingChecks: [],
    }),
    latestJobFinder: () => ({
      jobPath: '/tmp/adversarial-review-fixture/data/follow-up-jobs/completed/job.json',
      job: { status: 'completed' },
    }),
    requeueImpl: (args) => {
      requeueArgs = args;
      return {
        jobPath: '/tmp/adversarial-review-fixture/data/follow-up-jobs/pending/job.json',
        job: { status: 'pending' },
      };
    },
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-regression-requeued');
  assert.equal(requeueArgs.requestedAt, '2026-09-11T06:50:00.000Z');
  assert.equal(requeueArgs.requestedBy, 'watcher-ci-admission');
  assert.equal(requeueArgs.revisionRef, 'head-red');
  assert.deepEqual(requeueArgs.stopMetadata, { ciRegression: true });
  assert.match(requeueArgs.reason, /Ruff lint and format baseline=FAILURE/);
});

test('guardRereviewCiBeforeReviewer refuses failed-CI rereview when there is no job to requeue', async () => {
  const result = await guardRereviewCiBeforeReviewer({
    rootDir: '/tmp/adversarial-review-fixture',
    repo: 'laceyenterprises/agent-os',
    prNumber: 6593,
    passKind: 'rereview',
    reviewerHeadSha: 'head-red',
    log: silentLog(),
    inspectCiImpl: async () => ({
      state: 'failed',
      headSha: 'head-red',
      failedChecks: [{ name: 'repo-guards', state: 'FAILURE' }],
    }),
    latestJobFinder: () => null,
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-regression-no-job');
  assert.equal(result.parkReview, true);
  assert.equal(result.parkReviewStatus, REREVIEW_CI_BLOCKED_STATUS);
  assert.match(result.failureMessage, /^\[ci-regression-no-job\]/);
  assert.match(result.failureMessage, /repo-guards=FAILURE/);
});

test('guardRereviewCiBeforeReviewer treats a vanished stopped job as nothing to requeue', async () => {
  const result = await guardRereviewCiBeforeReviewer({
    rootDir: '/tmp/adversarial-review-fixture',
    repo: 'laceyenterprises/agent-os',
    prNumber: 6946,
    passKind: 'rereview',
    reviewerHeadSha: 'head-red',
    log: silentLog(),
    inspectCiImpl: async () => ({
      state: 'failed',
      headSha: 'head-red',
      failedChecks: [{ name: 'repo-guards', state: 'FAILURE' }],
    }),
    latestJobFinder: () => ({
      jobPath: '/fixture/follow-up-jobs/stopped/gone.json',
      job: { status: 'stopped' },
    }),
    requeueImpl: () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); },
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-regression-no-job');
  assert.equal(result.parkReview, true);
  assert.equal(result.error, undefined);
});

test('buildRereviewCiBlockedFailureMessage explains the parked recovery path', () => {
  const message = buildRereviewCiBlockedFailureMessage({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6593,
    ciGate: {
      failedChecks: [{ name: 'public-clone-readiness', state: 'FAILURE' }],
    },
  });

  assert.match(message, /^\[ci-regression-no-job\]/);
  assert.match(message, /public-clone-readiness=FAILURE/);
  assert.match(message, /re-arm once the head changes or CI turns green/);
});

test('shouldRecheckCiBlockedRereview backs off same-head CI probes', () => {
  const lastAttempted = '2026-09-11T13:00:00.000Z';
  const early = shouldRecheckCiBlockedRereview(
    { review_status: REREVIEW_CI_BLOCKED_STATUS, last_attempted_at: lastAttempted },
    { nowMs: Date.parse(lastAttempted) + DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS - 1 }
  );

  assert.equal(early.shouldRecheck, false);
  assert.equal(early.reason, 'ci-blocked-recheck-backoff-active');
  assert.equal(early.nextCheckAt, '2026-09-11T13:05:00.000Z');

  const expired = shouldRecheckCiBlockedRereview(
    { review_status: REREVIEW_CI_BLOCKED_STATUS, last_attempted_at: lastAttempted },
    { nowMs: Date.parse(lastAttempted) + DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS }
  );

  assert.equal(expired.shouldRecheck, true);
  assert.equal(expired.reason, 'ci-blocked-recheck-backoff-expired');
});

test('shouldRecheckCiBlockedRereview honors the explicit recheck interval env', () => {
  const lastAttempted = '2026-09-11T13:00:00.000Z';
  const result = shouldRecheckCiBlockedRereview(
    { review_status: REREVIEW_CI_BLOCKED_STATUS, last_attempted_at: lastAttempted },
    {
      nowMs: Date.parse(lastAttempted) + 999,
      env: { ADVERSARIAL_REREVIEW_CI_BLOCKED_RECHECK_MS: '1000' },
    }
  );

  assert.equal(result.shouldRecheck, false);
  assert.equal(result.nextCheckAt, '2026-09-11T13:00:01.000Z');
});

test('guardRereviewCiBeforeReviewer releases admission when CI observes a newer head', async () => {
  const result = await guardRereviewCiBeforeReviewer({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6593,
    passKind: 'rereview',
    reviewerHeadSha: 'claimed-head',
    log: silentLog(),
    inspectCiImpl: async () => ({
      state: 'green',
      headSha: 'newer-head',
      failedChecks: [],
      pendingChecks: [],
    }),
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-head-moved');
});

test('buildRereviewCiRegressionReason includes failed checks for the next worker', () => {
  const reason = buildRereviewCiRegressionReason({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6593,
    ciGate: {
      failedChecks: [
        { name: 'Ruff lint and format baseline', state: 'FAILURE' },
        { name: 'repo-guards', state: 'CANCELLED' },
      ],
    },
  });

  assert.match(reason, /laceyenterprises\/agent-os#6593/);
  assert.match(reason, /Ruff lint and format baseline=FAILURE/);
  assert.match(reason, /repo-guards=CANCELLED/);
});

test('CIBLOCKHAM-02: completed pending-CI round uses its remaining remediation round', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ci-round-requeue-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const repo = 'example/review-fixture';
  const job = buildFollowUpJob({ repo, prNumber: 42, reviewerModel: 'codex', reviewBody: '## Verdict\nComment only' });
  job.status = 'completed';
  job.completedAt = '2026-10-01T10:00:00Z';
  job.reReview = { requested: false };
  job.completion = { pendingCiOnly: true, workerPushedHeadSha: 'b'.repeat(40) };
  job.remediationPlan.currentRound = 1;
  job.remediationPlan.maxRounds = 2;
  job.remediationPlan.rounds = [{ round: 1, state: 'completed' }];
  const dir = join(rootDir, 'data/follow-up-jobs/completed');
  mkdirSync(dir, { recursive: true });
  writeFollowUpJob(join(dir, `${job.jobId}.json`), job);
  const result = await guardRereviewCiBeforeReviewer({ rootDir, repo, prNumber: 42,
    passKind: 'rereview', reviewerHeadSha: 'b'.repeat(40), log: silentLog(),
    inspectCiImpl: async () => ({ state: 'failed', headSha: 'b'.repeat(40), failedChecks: [{ name: 'unit', state: 'FAILURE' }] }),
  });
  assert.equal(result.reason, 'ci-regression-requeued');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.currentRound, 1, 'claiming the next worker consumes round 2');
  assert.equal(result.job.remediationPlan.maxRounds, 2);
  assert.equal(result.job.remediationPlan.nextAction.round, 2);
  assert.equal(result.job.completion, null, 'the next round must not inherit the completion exception');
});
