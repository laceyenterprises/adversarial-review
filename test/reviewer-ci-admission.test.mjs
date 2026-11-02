import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFollowUpJob, claimNextFollowUpJob, readFollowUpJob, requeueFollowUpJobForNextRound, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { fetchHammerHeadRange, readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
import { findLatestFollowUpJob } from '../src/operator-retrigger-helpers.mjs';

import {
  buildRereviewCiBlockedFailureMessage,
  buildRereviewCiRegressionReason,
  DEFAULT_CI_BLOCKED_REREVIEW_RECHECK_MS,
  guardRereviewCiBeforeReviewer,
  shouldRecheckCiBlockedRereview,
} from '../src/reviewer-ci-admission.mjs';
import { readFollowUpOperatorLabel } from '../src/follow-up-operator-label.mjs';
import { addCiRegressionFinding } from '../src/ci-regression-finding.mjs';
import { classifyOperatorGatedFindings } from '../src/ama/operator-label-gates.mjs';
import { parseBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from '../src/review-statuses.mjs';

function silentLog() {
  return {
    log() {},
    warn() {},
  };
}

test('LABELSTOPOWNER-01: CI findings ignore quoted headings and preserve prior findings across rounds', () => {
  const body = '```markdown\n## Blocking issues\n- None.\n```\n\n## Blocking issue\n'
    + '- **Original finding**\n  - **File:** fixture.md\n  - **Problem:** Original problem.\n  - **Why it matters:** Preserve this finding.\n'
    + '  - **Recommended fix:** Repair the original issue.\n\n## Verdict\nRequest changes\n';
  const once = addCiRegressionFinding(body, 'link-check=FAILURE');
  const twice = addCiRegressionFinding(once, 'other-check=FAILURE');
  const findings = parseBlockingFindingsSection(twice);
  assert.equal(findings.length, 2);
  assert.ok(findings.some(finding => finding.title === 'Original finding'));
  assert.ok(findings.some(finding => /other-check=FAILURE/.test(finding.problem)));
  assert.doesNotMatch(twice, /link-check=FAILURE/);
});

for (const sentinel of ['- None.', '- None', '  - None.  ', '\t-\tNone\t']) {
  test(`CI finding replaces the blocking empty sentinel (${JSON.stringify(sentinel)}) and comment-only verdict`, () => {
    const quoted = '~~~markdown\n## Blocking issues\n- None.\n## Verdict\nComment only\n~~~';
    const body = `## Blocking issues\n${sentinel}\n${quoted}\n\n## Non-blocking issues\n- None.\n\n## Verdict\nComment only\n`;
    const result = addCiRegressionFinding(body.replace(/\n/g, '\r\n'), 'check=FAILURE');
    const blocking = result.slice(0, result.indexOf(quoted));
    assert.doesNotMatch(blocking, /^[ \t]*-[ \t]+None\.?[ \t]*$/m);
    assert.ok(result.includes(quoted), 'fenced examples must remain byte-equivalent after newline normalization');
    assert.match(result, /## Non-blocking issues\n- None\./);
    assert.equal(parseBlockingFindingsSection(result).length, 1);
    assert.equal(extractReviewVerdict(result), 'Request changes');
    assert.equal(extractReviewVerdict(addCiRegressionFinding(result, 'other=FAILURE')), 'Request changes');
  });
}

test('CI finding adds a missing blocking section and updates the actual verdict without editing quoted verdicts', () => {
  const quoted = '```markdown\n## Verdict\nComment only\n```';
  const result = addCiRegressionFinding(`${quoted}\n## Non-blocking issues\n- None.\n## Verdict\n\nComment only`, 'check=FAILURE');
  assert.ok(result.startsWith('## Blocking issues\n- **[ci-regression]'));
  assert.ok(result.includes(quoted));
  assert.equal(extractReviewVerdict(result), 'Request changes');
});

for (const status of ['in_progress', 'inProgress', 'pending']) {
  test(`failed CI keeps ${status} remediation active without requeueing or warnings`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'active-ci-remediation-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const job = { status };
    const ciGate = { state: 'failed', headSha: 'head-red', failedChecks: [{ name: 'check', state: 'FAILURE' }] };
    const result = await guardRereviewCiBeforeReviewer({
      rootDir, repo: 'fixture/repo', prNumber: 42, passKind: 'rereview', reviewerHeadSha: 'head-red',
      inspectCiImpl: async () => ciGate,
      latestJobFinder: () => ({ jobPath: '/unused/job.json', job }),
      requeueImpl: () => assert.fail('active remediation must bypass requeue'),
      deliverAlertImpl: async () => assert.fail('active remediation must not page'),
      log: { warn: () => assert.fail('active remediation must not emit failure warnings') },
    });
    assert.deepEqual(result, { proceed: false, reason: 'ci-regression-remediation-active', ciGate, jobPath: '/unused/job.json', job });
  });
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
    deliverAlertImpl: async () => {},
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
    assert.match(result.failureMessage, /completed final remediation round/);
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

test('suppression alone does not bypass failed-CI requeue', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'suppression-ci-remediation-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let requeued = false;
  const result = await guardRereviewCiBeforeReviewer({
    rootDir, repo: 'fixture/repo', prNumber: 42, passKind: 'rereview',
    reviewerHeadSha: 'head-red', log: silentLog(),
    inspectCiImpl: async () => ({ state: 'failed', headSha: 'head-red',
      failedChecks: [{ name: 'synthetic-ci', state: 'FAILURE' }] }),
    latestJobFinder: () => ({ jobPath: '/unused/job.json', job: { status: 'completed',
      reReview: { suppressed: 'comment-only-final-round' } } }),
    requeueImpl: () => { requeued = true; return { job: { status: 'pending' } }; },
  });
  assert.equal(requeued, true);
  assert.equal(result.reason, 'ci-regression-requeued');
  assert.notEqual(result.hammerOwner, true);
});

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

test('guardRereviewCiBeforeReviewer creates remediation when there is no job to requeue', async () => {
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
    summarizeLedgerImpl: () => ({ completedRoundsForPR: 1, latestMaxRounds: 3 }),
    createJobImpl: args => {
      assert.equal(args.revisionRef, 'head-red');
      assert.equal(args.priorCompletedRounds, 1);
      assert.equal(args.maxRemediationRounds, 3);
      assert.match(args.reviewBody, /repo-guards=FAILURE/);
      return { job: { status: 'pending' }, jobPath: '/fixture/pending.json' };
    },
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-regression-created');
  assert.equal(result.job.status, 'pending');
});

test('guardRereviewCiBeforeReviewer pages a vanished stopped job instead of waiving its stop', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ci-vanished-job-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  const result = await guardRereviewCiBeforeReviewer({
    rootDir,
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
    createJobImpl: () => assert.fail('a racing deletion cannot waive the observed stop'),
    deliverAlertImpl: async body => pages.push(body),
  });

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-regression-requeue-failed');
  assert.equal(result.needsOperator, true);
  assert.equal(pages.length, 1);
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

test('CIBLOCKINFRA-01 infrastructure red never requeues remediation or routes a hammer', async () => {
  const result = await guardRereviewCiBeforeReviewer({
    repo: 'example/fixture', prNumber: 42, passKind: 'rereview', reviewerHeadSha: 'a'.repeat(40),
    inspectCiImpl: async () => ({ state: 'infrastructure', headSha: 'a'.repeat(40),
      failedChecks: [{ name: 'unit', state: 'FAILURE', steps: [] }] }),
    latestJobFinder: () => assert.fail('infrastructure cannot consume a round'),
    requeueImpl: () => assert.fail('infrastructure cannot consume a round'),
    log: silentLog(),
  });
  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-infrastructure');
  assert.equal(result.hammerOwner, undefined);
});

function labelStopFixture(t, { stopCode = 'operator-label-required:live-pack-edit-approved', round = 1, cap = 3 } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'label-stop-owner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const repo = 'fixture/repo', prNumber = 42, headSha = 'b'.repeat(40);
  const job = buildFollowUpJob({ repo, prNumber, branch: 'fixture/topic', reviewerModel: 'codex', revisionRef: 'a'.repeat(40),
    reviewBody: '## Blocking issues\n- **Guarded change**\n  - **File:** fixture.md\n  - **Problem:** operator-label-required:live-pack-edit-approved\n\n## Verdict\nRequest changes\n' });
  job.status = 'stopped';
  job.remediationPlan.currentRound = round;
  job.remediationPlan.maxRounds = cap;
  job.remediationPlan.stop = { code: stopCode };
  const dir = join(rootDir, 'data/follow-up-jobs/stopped');
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `${job.jobId}.json`);
  writeFollowUpJob(jobPath, job);
  const evidence = { repo, prNumber, label: 'live-pack-edit-approved', headSha, eventId: 'event-label-7', actor: 'fixture-operator',
    appliedAt: '2026-01-01T10:00:00Z', observedAt: '2026-01-01T11:00:00Z' };
  const pages = [], logs = [];
  const args = { rootDir, repo, prNumber, passKind: 'rereview', reviewerHeadSha: headSha,
    inspectCiImpl: async () => ({ state: 'failed', headSha, failedChecks: [{ name: 'link-check', state: 'FAILURE' }] }),
    readOperatorLabelImpl: () => evidence, deliverAlertImpl: async (body, options) => { pages.push({ body, options }); },
    log: { warn: message => logs.push(message) } };
  return { rootDir, jobPath, evidence, pages, logs, args };
}

test('CI requeue persists a consistent blocking review when the stopped round was comment-only', async t => {
  const f = labelStopFixture(t);
  const job = readFollowUpJob(f.jobPath);
  job.reviewBody = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nComment only';
  job.critical = false;
  job.nonBlockingOnly = true;
  job.finalRound = 'comment-only';
  writeFollowUpJob(f.jobPath, job);
  const result = await guardRereviewCiBeforeReviewer(f.args);
  assert.equal(result.reason, 'ci-regression-requeued');
  const queued = readFollowUpJob(result.jobPath);
  assert.equal(extractReviewVerdict(queued.reviewBody), 'Request changes');
  assert.equal(parseBlockingFindingsSection(queued.reviewBody).length, 1);
  assert.doesNotMatch(queued.reviewBody.split('## Non-blocking issues')[0], /- None\./);
  assert.equal(queued.critical, true);
  assert.equal(queued.nonBlockingOnly, false);
  assert.equal(queued.finalRound, null);
  assert.equal(queued.remediationPlan.currentRound, job.remediationPlan.currentRound);
  assert.equal(queued.remediationPlan.maxRounds, job.remediationPlan.maxRounds);
});

test('LABELSTOPOWNER-01: a satisfied label queues CI remediation at the newer head with event evidence', async t => {
  const f = labelStopFixture(t);
  let reads = 0;
  const result = await guardRereviewCiBeforeReviewer({ ...f.args, readOperatorLabelImpl: identity => {
    reads++;
    assert.deepEqual(identity, { repo: 'fixture/repo', prNumber: 42, label: 'live-pack-edit-approved' });
    return f.evidence;
  } });
  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'ci-regression-requeued');
  assert.equal(reads, 1);
  const queued = readFollowUpJob(result.jobPath);
  assert.equal(queued.revisionRef, f.args.reviewerHeadSha);
  assert.equal(queued.remediationPlan.currentRound, 1);
  assert.equal(queued.remediationPlan.maxRounds, 3);
  assert.equal(queued.remediationPlan.nextAction.round, 2);
  assert.deepEqual(queued.remediationPlan.operatorLabelSatisfactions.at(-1), f.evidence);
  assert.equal(queued.remediationPlan.stop, null);
  assert.equal(classifyOperatorGatedFindings(queued.reviewBody).allGated, false, 'consume must reach actionable CI repair instead of immediately stopping again');
  assert.equal(classifyOperatorGatedFindings(queued.reviewBody).gated.length, 1, 'the original guarded finding remains visible');
  assert.ok(parseBlockingFindingsSection(queued.reviewBody).some(finding => /link-check=FAILURE/.test(finding.problem)));
  assert.equal(f.pages.length, 0);
  const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, workerType: 'fixture-remediator', launcherPid: process.pid });
  assert.equal(claimed.job.remediationPlan.currentRound, 2);
  assert.deepEqual(readFollowUpJob(claimed.jobPath).remediationPlan.operatorLabelSatisfactions, [f.evidence],
    'claiming a round must retain the approval event after nextAction changes');
});

for (const scenario of ['absent-label', 'unreadable-label', 'terminal-stop', 'spent-budget', 'moved-head']) {
  test(`LABELSTOPOWNER-01: ${scenario} pages the named ownerless blocker and never admits a reviewer`, async t => {
    const f = labelStopFixture(t, scenario === 'terminal-stop' ? { stopCode: 'abandoned', round: 3, cap: 3 }
      : scenario === 'spent-budget' ? { round: 3, cap: 3 } : {});
    const before = readFileSync(f.jobPath, 'utf8');
    const args = { ...f.args, readOperatorLabelImpl: () => {
      if (scenario === 'unreadable-label') throw new Error('label read unavailable');
      if (scenario === 'absent-label') return null;
      return scenario === 'moved-head' ? { ...f.evidence, headSha: 'c'.repeat(40) } : f.evidence;
    } };
    const result = await guardRereviewCiBeforeReviewer(args);
    assert.equal(result.proceed, false);
    assert.equal(result.needsOperator, true);
    assert.match(result.closureBlocker, /ci-regression-ownerless/);
    if (scenario === 'spent-budget') assert.match(result.closureBlocker, /round-budget-exhausted \(3\/3\)/);
    assert.equal(f.pages.length, 1);
    assert.equal(f.pages[0].options.severity, 'SEV1');
    assert.match(f.pages[0].body, scenario === 'terminal-stop' ? /stopped:abandoned/ : /live-pack-edit-approved/);
    assert.ok(f.logs.some(message => message.includes('ama.closure_blocker')));
    await guardRereviewCiBeforeReviewer(args);
    assert.equal(f.pages.length, 1, 'durable closure wait deduplicates repeat polls');
    if (scenario !== 'spent-budget') assert.equal(readFileSync(f.jobPath, 'utf8'), before);
  });
}

test('LABELSTOPOWNER-01: failed page transport retries the existing closure wait', async t => {
  const f = labelStopFixture(t);
  const failed = await guardRereviewCiBeforeReviewer({ ...f.args, readOperatorLabelImpl: () => null,
    deliverAlertImpl: async () => { throw new Error('fixture transport unavailable'); } });
  assert.match(failed.page.error, /transport unavailable/);
  await guardRereviewCiBeforeReviewer({ ...f.args, readOperatorLabelImpl: () => null });
  assert.equal(f.pages.length, 1);
});

test('LABELSTOPOWNER-01: fresh current-head CI finding carries the existing PR round budget', async t => {
  const f = labelStopFixture(t);
  rmSync(f.jobPath);
  const result = await guardRereviewCiBeforeReviewer({ ...f.args,
    summarizeLedgerImpl: () => ({ completedRoundsForPR: 2, latestMaxRounds: 3, latestRiskClass: 'medium' }),
    readPRHeadImpl: () => ({ branch: 'fixture/topic', builderTag: '[codex]' }) });
  assert.equal(result.reason, 'ci-regression-created');
  assert.equal(result.job.revisionRef, f.args.reviewerHeadSha);
  assert.equal(result.job.remediationPlan.currentRound, 2);
  assert.equal(result.job.remediationPlan.maxRounds, 3);
  assert.ok(parseBlockingFindingsSection(result.job.reviewBody).some(finding => /link-check=FAILURE/.test(finding.problem)));
  assert.equal(f.pages.length, 0);
});

test('LABELSTOPOWNER-01: a missing job cannot reset an exhausted PR-wide budget', async t => {
  const f = labelStopFixture(t);
  rmSync(f.jobPath);
  const result = await guardRereviewCiBeforeReviewer({ ...f.args,
    summarizeLedgerImpl: () => ({ completedRoundsForPR: 3, latestMaxRounds: 3 }),
    createJobImpl: () => assert.fail('budget cannot be reset by a fresh job') });
  assert.equal(result.needsOperator, true);
  assert.match(result.closureBlocker, /round-budget-exhausted \(3\/3\)/);
  assert.equal(f.pages.length, 1);
});

test('LABELSTOPOWNER-01: an archived label stop retains its approval requirement and budget', async t => {
  const f = labelStopFixture(t);
  const archive = join(f.rootDir, 'data/follow-up-jobs/stopped-archived/2026-01');
  mkdirSync(archive, { recursive: true });
  const archivePath = join(archive, f.jobPath.split('/').at(-1));
  renameSync(f.jobPath, archivePath);
  const args = { ...f.args, createJobImpl: () => assert.fail('archive cannot waive a label stop') };
  const absent = await guardRereviewCiBeforeReviewer({ ...args, readOperatorLabelImpl: () => null });
  assert.equal(absent.needsOperator, true);
  assert.match(absent.closureBlocker, /operator-label-required:live-pack-edit-approved/);
  assert.equal(readFollowUpJob(archivePath).status, 'stopped');
  const satisfied = await guardRereviewCiBeforeReviewer(args);
  assert.equal(satisfied.reason, 'ci-regression-requeued');
  assert.equal(satisfied.job.revisionRef, f.args.reviewerHeadSha);
  assert.equal(satisfied.job.remediationPlan.currentRound, 1);
  assert.equal(satisfied.job.remediationPlan.maxRounds, 3);
  assert.equal(existsSync(archivePath), false);
});

for (const present of [true, false]) test(`LABELSTOPOWNER-01: live label reader requires current presence (${present}) and records the latest event`, () => {
  const calls = [];
  const result = readFollowUpOperatorLabel({ repo: 'fixture/repo', prNumber: 42, label: 'live-pack-edit-approved' }, {
    execFileSyncImpl: (_cmd, args) => {
      calls.push(args);
      return JSON.stringify(args[1].includes('/events?') ? [[
        { event: 'labeled', id: 1, label: { name: 'live-pack-edit-approved' }, actor: { login: 'fixture-operator' }, created_at: '2026-01-01T10:00:00Z' },
        { event: 'labeled', id: 7, label: { name: 'live-pack-edit-approved' }, actor: { login: 'fixture-operator' }, created_at: '2026-01-01T11:00:00Z' },
      ]] : { head: { sha: 'current-head' }, labels: present ? [{ name: 'live-pack-edit-approved' }] : [] });
    },
  });
  assert.equal(calls.length, 2);
  if (!present) assert.equal(result, null);
  else { assert.equal(result.eventId, '7'); assert.equal(result.headSha, 'current-head'); }
});

test('LABELREARM-01: stopped-job predicate shares the review wake provenance contract', async () => {
  const { operatorLabelEvidenceSatisfies, operatorLabelSatisfiesStop } = await import('../src/follow-up-operator-label.mjs');
  const scope = { repo: 'fixture/repo', prNumber: 42, label: 'live-pack-edit-approved' };
  const job = { ...scope, status: 'stopped', remediationPlan: { stop: { code: `operator-label-required:${scope.label}` } } };
  const evidence = { ...scope, eventId: 'synthetic-event', actor: 'fixture-operator',
    appliedAt: '2026-01-01T11:00:00Z', observedAt: '2026-01-01T12:00:00Z' };
  for (const observed of [evidence, null, { ...evidence, actor: null }, { ...evidence, appliedAt: 'invalid' }]) {
    assert.equal(operatorLabelSatisfiesStop(job, observed), operatorLabelEvidenceSatisfies(scope, observed));
  }
  assert.equal(operatorLabelSatisfiesStop(job, evidence), true);
});
