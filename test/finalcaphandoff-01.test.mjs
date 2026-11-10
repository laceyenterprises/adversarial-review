import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFollowUpJob, claimNextFollowUpJob, readFollowUpJob, writeFollowUpJob,
  requeueFollowUpJobForNextRound, markFollowUpJobStopped, markFollowUpJobFailed, releaseInfrastructureCiStop,
} from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { acquireAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { nextAction } from '../src/pr-next-action.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const NOW = '2026-11-10T04:31:52.670Z';
const BODY = '## Summary\nOne finding.\n\n## Blocking issues\n- None.\n\n'
  + '## Non-blocking issues\n- **Missing timezone**\n  - **Problem:** timestamp is ambiguous.\n\n'
  + '## Verdict\nComment only';
const quiet = { log() {}, warn() {}, error() {} };

function fixture(t, changes = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'finalcaphandoff-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const created = createFollowUpJob({ rootDir, repo: 'fixture/project', prNumber: 42,
    branch: 'fixture/remediation', reviewerModel: 'gemini', revisionRef: HEAD,
    reviewPostedAt: '2026-11-10T04:30:59Z', reviewBody: BODY, riskClass: 'medium' });
  const job = { ...created.job, nonBlockingRoundsBefore: 1, nonBlockingMaxRounds: 1,
    remediationPlan: { ...created.job.remediationPlan, currentRound: 1, maxRounds: 3 },
    ...changes };
  writeFollowUpJob(created.jobPath, job);
  return { rootDir, ...created, job };
}

test('FINALCAPHANDOFF-01: 1/1 before claim returns and persists actionable terminal custody, once', async t => {
  const { rootDir, job } = fixture(t);
  const notices = [];
  const result = await consumeNextFollowUpJob({ rootDir, now: () => NOW,
    log: { ...quiet, warn: line => notices.push(JSON.parse(line)) },
    promptTemplate: 'Offline fixture; no worker is admitted.',
    ensureWorkerRegistryReadyImpl: async () => {},
    requestWatcherWakeImpl: () => { throw new Error('cap stop must not claim a clean verdict'); },
    execFileImpl: () => { throw new Error('cap stop must not launch or read live state'); } });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'max-rounds-reached');
  const terminal = result.finalCapResult;
  assert.deepEqual(notices, [{ event: 'remediation.final_cap_operator_action_required', ...terminal }]);
  assert.equal(terminal.status, 'operator-action-required');
  assert.equal(terminal.actor, 'operator');
  assert.equal(terminal.action, 'canonical-rescue');
  assert.equal(terminal.successorDispatched, false);
  assert.equal(terminal.reviewedHeadSha, HEAD);
  assert.deepEqual(terminal.blockingFindings, { state: 'known', count: 0 });
  assert.deepEqual(terminal.nonBlockingFindings, { state: 'known', count: 1 });
  assert.match(terminal.nextAction, /live head.*ownership.*conflict.*hammer/i);
  const durable = readFollowUpJob(result.jobPath);
  assert.deepEqual(durable.finalCapResult, terminal, 'survives normalized reads');
  assert.equal(durable.status, 'stopped');
  assert.equal(durable.remediationPlan.currentRound, 1, 'no new round charged');
  assert.equal(durable.remediationPlan.maxRounds, 3, 'risk budget is not widened');
  assert.deepEqual(durable.remediationPlan.rounds, job.remediationPlan.rounds);
  assert.equal(durable.reReview, job.reReview ?? null, 'no extra re-review');
  assert.equal(durable.closureHandoff, undefined, 'does not invent a dispatch receipt');
  assert.match(durable.remediationPlan.stop.reason, /No successor dispatched.*Operator:/);
  const bytes = readFileSync(result.jobPath, 'utf8');
  const nextJob = createFollowUpJob({ rootDir, repo: 'fixture/project', prNumber: 43,
    branch: 'fixture/next', reviewerModel: 'gemini', revisionRef: HEAD,
    reviewPostedAt: '2026-11-10T04:30:59Z',
    reviewBody: BODY.replace('- **Missing timezone**\n  - **Problem:** timestamp is ambiguous.', '- None.'),
    riskClass: 'medium' });
  assert.equal(existsSync(nextJob.jobPath), true, 'the next poll has pending work');
  const nextClaim = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(nextClaim.job.jobId, nextJob.job.jobId);
  assert.equal(readFileSync(result.jobPath, 'utf8'), bytes, 'later polling leaves the terminal result byte-identical');
});

test('final-cap result is durable even when the caller does not request stopped results', t => {
  const { rootDir, jobPath } = fixture(t);
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: NOW }), null);
  const stopped = readFollowUpJob(jobPath.replace('/pending/', '/stopped/'));
  assert.equal(stopped.finalCapResult.recordedAt, NOW);
});

test('settled comment-only review stays clean and does not acquire a cap rescue result', t => {
  const { rootDir } = fixture(t, { reviewBody: BODY.replace('- **Missing timezone**\n  - **Problem:** timestamp is ambiguous.', '- None.') });
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(stopped.reason, 'no-remediation-required');
  assert.equal(stopped.job.finalCapResult, undefined);
});

test('unknown finding accounting remains unknown and is not a clean or merge authorization', t => {
  const { rootDir } = fixture(t, { reviewBody: '## Verdict\nComment only' });
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(stopped.job.finalCapResult.nonBlockingFindings.state, 'unknown');
  assert.equal(stopped.job.finalCapResult.successorDispatched, false);
});

test('missing review head remains missing evidence for the operator', t => {
  const { rootDir } = fixture(t, { revisionRef: null });
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(stopped.job.finalCapResult.reviewedHeadSha, null);
  assert.equal(stopped.job.finalCapResult.action, 'canonical-rescue');
});

test('ordinary risk-budget exhaustion does not acquire the nonblocking terminal result', t => {
  const { rootDir } = fixture(t, { nonBlockingOnly: false,
    remediationPlan: { currentRound: 3, maxRounds: 3, rounds: [] } });
  const stopped = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(stopped.reason, 'max-rounds-reached');
  assert.equal(stopped.job.finalCapResult, null);
  assert.equal(stopped.finalCapResult, undefined);
});

test('remaining nonblocking budget claims normally without a terminal rescue result', t => {
  const { rootDir } = fixture(t, { nonBlockingRoundsBefore: 0 });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(claimed.stopped, undefined);
  assert.equal(claimed.job.remediationPlan.currentRound, 2);
  assert.equal(claimed.job.finalCapResult, undefined);
});

test('explicit operator override retains the existing round admission instead of adding terminal custody', t => {
  const { rootDir, jobPath, job } = fixture(t);
  writeFollowUpJob(jobPath, { ...job, remediationPlan: { ...job.remediationPlan,
    nextAction: { operatorOverride: true } } });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(claimed.stopped, undefined);
  assert.equal(claimed.job.finalCapResult, undefined);
});

test('live closer lease wins before the cap stop and retains custody unchanged', t => {
  const { rootDir, jobPath } = fixture(t);
  const identity = { rootDir, repo: 'fixture/project', prNumber: 42, headSha: HEAD };
  assert.equal(acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: NOW }).acquired, true);
  const before = readAmaCloserLease(rootDir, identity);
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true }), null);
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
  assert.equal(readFollowUpJob(jobPath).finalCapResult, undefined);
});

function snapshot({ conflict = false, stale = false, owned = false } = {}) {
  const values = {
    pr: { headSha: HEAD, state: 'OPEN', isDraft: false,
      mergeable: conflict ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: conflict ? 'DIRTY' : 'CLEAN', labels: [] },
    checks: { conclusion: 'SUCCESS' },
    reviews: { verdict: 'comment-only', headSha: stale ? OTHER : HEAD,
      blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 1 },
    remediation: { roundsLeft: false, completedRounds: 1 },
    launches: { closer: owned ? { headSha: HEAD, launchRequestId: 'fixture-owner',
      probe: { ok: true, row: { status: 'running' }, retryChain: [] } } : null },
    leases: { closer: null }, controls: {},
    policy: { strictMode: true, autonomousMergeExecutionEnabled: true }, progress: {},
  };
  return { subjectKey: 'fixture/project#42', head: HEAD, requestedHead: HEAD,
    passId: 'fixture', generation: 1, observedAt: NOW,
    anchors: { firstActionableAt: '2026-11-10T04:30:59Z' },
    observations: Object.fromEntries(Object.entries(values).map(([key, value]) =>
      [key, { state: 'complete', value, provenance: { sourceRef: 'offline' } }])) };
}

test('canonical rescue distinguishes the conflict route, final-cap route, stale head and live owner', () => {
  const conflict = nextAction(snapshot({ conflict: true }));
  assert.equal(conflict.row, 'R10-conflict');
  assert.equal(conflict.actor, 'hammer');
  const final = nextAction(snapshot());
  assert.equal(final.row, 'R14-findings');
  assert.equal(final.reason, 'review-findings-final');
  assert.equal(final.actor, 'hammer');
  assert.equal(nextAction(snapshot({ stale: true })).action, 'review', 'a terminal result cannot carry findings to an unrelated head');
  assert.equal(nextAction(snapshot({ owned: true })).reason, 'live-owner');
});

test('cap evidence is cleared through operator retrigger, admission and later ordinary stop', t => {
  const { rootDir } = fixture(t);
  const capped = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.ok(capped.finalCapResult);
  const pending = requeueFollowUpJobForNextRound({ rootDir, jobPath: capped.jobPath,
    requestedAt: NOW, requestedBy: 'operator', revisionRef: OTHER });
  assert.equal(readFollowUpJob(pending.jobPath).finalCapResult, undefined);
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(claimed.job.status, 'in_progress');
  assert.equal(claimed.job.remediationPlan.currentRound, 2);
  assert.equal(claimed.job.finalCapResult, undefined);
  // Legacy active records may still carry predecessor evidence.
  writeFollowUpJob(claimed.jobPath, { ...claimed.job, finalCapResult: capped.finalCapResult });
  const stopped = markFollowUpJobStopped({ rootDir, jobPath: claimed.jobPath,
    stoppedAt: NOW, stopCode: 'stale-review-head', stopReason: 'Fixture stop.',
    commentDeliveryExemption: 'operator-stop' });
  assert.equal(readFollowUpJob(stopped.jobPath).finalCapResult, undefined);
  requeueFollowUpJobForNextRound({ rootDir, jobPath: stopped.jobPath, requestedAt: NOW });
  const lastClaim = claimNextFollowUpJob({ rootDir, claimedAt: NOW });
  assert.equal(lastClaim.job.remediationPlan.currentRound, 3);
  const failed = markFollowUpJobFailed({ rootDir, jobPath: lastClaim.jobPath,
    failedAt: NOW, failure: { code: 'fixture-failure' } });
  writeFollowUpJob(failed.jobPath, { ...failed.job, finalCapResult: capped.finalCapResult });
  const exhausted = requeueFollowUpJobForNextRound({ rootDir, jobPath: failed.jobPath, requestedAt: NOW });
  assert.equal(exhausted.job.remediationPlan.stop.code, 'max-rounds-reached');
  assert.equal(readFollowUpJob(exhausted.jobPath).finalCapResult, undefined);
});

test('legacy cap evidence cannot leak through override admission', t => {
  const { rootDir, jobPath, job } = fixture(t);
  const stale = { status: 'operator-action-required', successorDispatched: false };
  writeFollowUpJob(jobPath, { ...job, finalCapResult: stale,
    remediationPlan: { ...job.remediationPlan, nextAction: { operatorOverride: true } } });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
  assert.equal(readFollowUpJob(claimed.jobPath).finalCapResult, undefined);
});

for (const singleReview of [false, true]) {
  test(`legacy cap evidence is cleared by ${singleReview ? 'single-review' : 'ordinary'} cap refusal`, t => {
    const { rootDir } = fixture(t, { nonBlockingOnly: false,
      finalCapResult: { status: 'operator-action-required', successorDispatched: false },
      ...(singleReview ? { singleReview: { applied: true, basis: 'super-small' } } : {}),
      remediationPlan: { currentRound: 3, maxRounds: 3, rounds: [] } });
    const stopped = claimNextFollowUpJob({ rootDir, claimedAt: NOW, returnStopped: true });
    assert.equal(stopped.finalCapResult, undefined);
    assert.equal(readFollowUpJob(stopped.jobPath).finalCapResult, null);
  });
}

test('infrastructure release clears legacy cap evidence before returning to pending', t => {
  const { rootDir, jobPath, job } = fixture(t);
  const failure = { name: 'unit', conclusion: 'FAILURE', steps: [] };
  const stopped = markFollowUpJobStopped({ rootDir, jobPath, stoppedAt: NOW,
    stopCode: 'ci-not-green', stopReason: 'Fixture infrastructure stop.',
    commentDeliveryExemption: 'no-remediation-started',
    failure: { code: 'ci-not-green', ciGate: { headSha: HEAD, failedChecks: [failure] } } });
  writeFollowUpJob(stopped.jobPath, { ...stopped.job,
    finalCapResult: { status: 'operator-action-required', successorDispatched: false } });
  const released = releaseInfrastructureCiStop({ rootDir, jobPath: stopped.jobPath,
    repo: job.repo, prNumber: job.prNumber, headSha: HEAD, now: NOW,
    recordedFailures: [failure], failedChecks: [failure] });
  assert.equal(released.job.status, 'pending');
  assert.equal(readFollowUpJob(released.jobPath).finalCapResult, undefined);
});
