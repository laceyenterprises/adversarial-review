// STRICTSETTLED-01: the watcher released a pending remediation job as
// `settled-clean` for any non-critical comment-only review, while merge
// authority's strict mode (default on) still routed that review's non-blocking
// findings to remediation. The closer then waited on `remediation-job-missing`
// with no actor able to recreate the job.
//
// These pin one predicate for "settled clean" across the watcher release and
// merge authority, and the closer's once-per-head job recreation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  createFollowUpJob,
  getFollowUpJobDir,
  markFollowUpJobStopped,
  readFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  isSettledCleanFollowUpJob,
  resolveMergeAuthorityStrictMode,
  shouldDeferReviewForActiveFollowUp,
  stopTerminalPendingFollowUpJob,
} from '../src/follow-up-active-defer.mjs';
import { isDaemonMergeReviewAllowed } from '../src/ama/daemon-merge.mjs';
import { classifyFollowUpCriticality } from '../src/follow-up-jobs.mjs';
import { recreateMissingRemediationJob } from '../src/remediation-job-missing-recovery.mjs';

const REPO = 'example-org/example-repo';
const HEAD = '1'.repeat(40);
const NEXT_HEAD = '2'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';

const NON_BLOCKING_FINDING = `- **Rename a helper for clarity**
  - **File:** \`src/example.mjs\`
  - **Lines:** \`12\`
  - **Problem:** the name hides the side effect.
  - **Why it matters:** readers miss the write.
  - **Recommended fix:** rename it.`;

function reviewBody({ verdict, nonBlocking = '- None.' }) {
  return [
    '## Summary',
    'Synthetic review for the strict settled-clean predicate.',
    '',
    '## Blocking issues',
    '- None.',
    '',
    '## Non-blocking issues',
    nonBlocking,
    '',
    '## Verdict',
    verdict,
  ].join('\n');
}

const COMMENT_ONLY_WITH_FINDING = reviewBody({ verdict: 'Comment only', nonBlocking: NON_BLOCKING_FINDING });
const APPROVED_CLEAN = reviewBody({ verdict: 'Approved' });

function fixture(t, { body, prNumber = 41, maxRemediationRounds = 2 }) {
  const rootDir = mkdtempSync(join(tmpdir(), 'strict-settled-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const created = createFollowUpJob({
    branch: 'fixture/remediation',
    rootDir,
    repo: REPO,
    prNumber,
    reviewerModel: 'claude',
    linearTicketId: null,
    revisionRef: HEAD,
    reviewBody: body,
    reviewPostedAt: AT,
    critical: false,
    maxRemediationRounds,
  });
  return { rootDir, created, prNumber };
}

const policy = strictMode => () => ({ strictMode });

test('watcher settled-clean uses merge authority predicate for every classification', () => {
  for (const body of [COMMENT_ONLY_WITH_FINDING, APPROVED_CLEAN, reviewBody({ verdict: 'Comment only' })]) {
    const classification = classifyFollowUpCriticality(body);
    for (const strictMode of [true, false]) {
      assert.equal(
        isSettledCleanFollowUpJob({ reviewBody: body }, { strictMode }),
        isDaemonMergeReviewAllowed(classification, { strictMode }),
        `strictMode=${strictMode} must agree with merge authority for ${classification.verdict}`,
      );
    }
  }
});

test('strict on: a comment-only review with a non-blocking finding keeps its remediation job pending', t => {
  const { rootDir, created, prNumber } = fixture(t, { body: COMMENT_ONLY_WITH_FINDING });
  const latest = { job: readFollowUpJob(created.jobPath), jobPath: created.jobPath };

  const released = stopTerminalPendingFollowUpJob({
    rootDir, latest, currentRevisionRef: HEAD, stoppedAt: AT, loadPolicyImpl: policy(true),
  });
  assert.equal(released, null, 'strict mode owes remediation; the job must not be released');

  // The production entry point resolves strict mode itself (default on).
  const decision = shouldDeferReviewForActiveFollowUp({
    rootDir, repo: REPO, prNumber, currentRevisionRef: HEAD, nowMs: Date.parse(AT) + 1_000,
    log: { info() {} },
  });
  assert.equal(decision.defer, true);
  assert.equal(decision.latestJobStatus, 'pending');
  assert.equal(existsSync(created.jobPath), true, 'the pending job stays queued for the follow-up daemon');
});

test('strict off: the same comment-only review is released as settled-clean as before', t => {
  const { rootDir, created } = fixture(t, { body: COMMENT_ONLY_WITH_FINDING });
  const latest = { job: readFollowUpJob(created.jobPath), jobPath: created.jobPath };

  const released = stopTerminalPendingFollowUpJob({
    rootDir, latest, currentRevisionRef: HEAD, stoppedAt: AT, loadPolicyImpl: policy(false),
  });
  assert.equal(released?.job?.status, 'stopped');
  assert.equal(released.job.remediationPlan?.stop?.code, 'settled-clean');
});

test('approved with zero findings is released under strict mode', t => {
  const { rootDir, created } = fixture(t, { body: APPROVED_CLEAN });
  const latest = { job: readFollowUpJob(created.jobPath), jobPath: created.jobPath };

  const released = stopTerminalPendingFollowUpJob({
    rootDir, latest, currentRevisionRef: HEAD, stoppedAt: AT, loadPolicyImpl: policy(true),
  });
  assert.equal(released?.job?.status, 'stopped');
  assert.equal(released.job.remediationPlan?.stop?.code, 'settled-clean');
});

test('an unreadable merge-authority policy keeps the strict default', () => {
  assert.equal(resolveMergeAuthorityStrictMode({ rootDir: '/nonexistent',
    loadPolicyImpl: () => { throw new Error('synthetic policy read failure'); } }), true);
  assert.equal(resolveMergeAuthorityStrictMode({ rootDir: '/x', loadPolicyImpl: policy(false) }), false);
});

function releasedAsSettled(t, body = COMMENT_ONLY_WITH_FINDING) {
  const f = fixture(t, { body });
  const stopped = markFollowUpJobStopped({
    rootDir: f.rootDir, jobPath: f.created.jobPath, stoppedAt: AT, stopCode: 'settled-clean',
    sourceStatus: 'pending', commentDeliveryExemption: 'interrupted-without-reconciled-reply',
    stopReason: 'Released pending follow-up job before reviewer defer: settled-clean.',
  });
  assert.equal(stopped.job.status, 'stopped');
  return { ...f, stoppedPath: stopped.jobPath };
}

test('remediation-job-missing recreates exactly one job per head', t => {
  const { rootDir, prNumber, stoppedPath } = releasedAsSettled(t);
  const args = { rootDir, repo: REPO, prNumber, headSha: HEAD, strictMode: true, now: '2026-01-01T00:10:00.000Z' };

  const first = recreateMissingRemediationJob(args);
  assert.equal(first.recreated, true, JSON.stringify(first));
  assert.equal(first.previousStopCode, 'settled-clean');
  const pendingPath = join(getFollowUpJobDir(rootDir, 'pending'), basename(stoppedPath));
  const pending = readFollowUpJob(pendingPath);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.revisionRef, HEAD);
  assert.deepEqual(pending.remediationJobMissingRecovery,
    { headSha: HEAD, recreatedAt: args.now, previousStopCode: 'settled-clean' });
  assert.equal(isSettledCleanFollowUpJob(pending, { strictMode: true }), false);

  // While the recreated job is live, a second report does nothing.
  assert.deepEqual(recreateMissingRemediationJob(args),
    { recreated: false, reason: 'latest-job-pending', jobId: pending.jobId });

  // Released again on the same head: bounded, never recreated twice.
  markFollowUpJobStopped({
    rootDir, jobPath: pendingPath, stoppedAt: '2026-01-01T00:20:00.000Z', stopCode: 'settled-clean',
    sourceStatus: 'pending', commentDeliveryExemption: 'interrupted-without-reconciled-reply',
    stopReason: 'Released pending follow-up job before reviewer defer: settled-clean.',
  });
  const again = recreateMissingRemediationJob({ ...args, now: '2026-01-01T00:30:00.000Z' });
  assert.equal(again.recreated, false);
  assert.equal(again.reason, 'already-recreated-for-head');
  assert.equal(existsSync(pendingPath), false, 'no second job for the same head');

  // A new head is a new bound.
  const nextHead = recreateMissingRemediationJob({ ...args, headSha: NEXT_HEAD, now: '2026-01-01T00:40:00.000Z' });
  assert.equal(nextHead.recreated, true, JSON.stringify(nextHead));
  assert.equal(readFollowUpJob(pendingPath).revisionRef, NEXT_HEAD);
});

test('remediation-job-missing recovery refuses jobs it does not own', t => {
  const clean = releasedAsSettled(t, APPROVED_CLEAN);
  assert.equal(recreateMissingRemediationJob({ rootDir: clean.rootDir, repo: REPO, prNumber: clean.prNumber,
    headSha: HEAD, strictMode: true }).reason, 'review-settled-clean');

  const lenient = releasedAsSettled(t);
  assert.equal(recreateMissingRemediationJob({ rootDir: lenient.rootDir, repo: REPO, prNumber: lenient.prNumber,
    headSha: HEAD, strictMode: false }).reason, 'review-settled-clean');

  const operatorStopped = fixture(t, { body: COMMENT_ONLY_WITH_FINDING });
  markFollowUpJobStopped({
    rootDir: operatorStopped.rootDir, jobPath: operatorStopped.created.jobPath, stoppedAt: AT,
    stopCode: 'operator-stop', sourceStatus: 'pending',
    commentDeliveryExemption: 'interrupted-without-reconciled-reply', stopReason: 'Synthetic operator stop.',
  });
  assert.equal(recreateMissingRemediationJob({ rootDir: operatorStopped.rootDir, repo: REPO,
    prNumber: operatorStopped.prNumber, headSha: HEAD }).reason, 'stop-code-operator-stop');

  const empty = mkdtempSync(join(tmpdir(), 'strict-settled-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.equal(recreateMissingRemediationJob({ rootDir: empty, repo: REPO, prNumber: 7, headSha: HEAD }).reason,
    'no-prior-job');
  assert.equal(recreateMissingRemediationJob({ rootDir: empty, repo: REPO, prNumber: 7, headSha: '' }).reason,
    'recovery-input-incomplete');
});
