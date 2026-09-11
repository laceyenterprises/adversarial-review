import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRereviewCiRegressionReason,
  guardRereviewCiBeforeReviewer,
} from '../src/reviewer-ci-admission.mjs';

function silentLog() {
  return {
    log() {},
    warn() {},
  };
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
