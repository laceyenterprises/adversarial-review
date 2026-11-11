import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildFollowUpJob, writeFollowUpJob, readFollowUpJob, claimNextFollowUpJob } from '../src/follow-up-jobs.mjs';
import { recoverEndedRemediationRound } from '../src/remediation-ended-round-recovery.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';
import { publishRemediation } from '../src/remediation-publication.mjs';
import { completeWorkerPublishedHead } from '../src/remediation-published-head.mjs';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { recoveryDigest } from '../src/comment-only-recovery-record.mjs';
import { remediationBudgetHandoffAllowed } from '../src/remediation-round-recovery.mjs';

const HEAD = 'a'.repeat(40), AT = '2026-01-01T00:00:00.000Z', NOW = '2026-01-01T00:10:00.000Z';
const BODY = '## Blocking issues\n- **Incorrect result**\n  - **Problem:** incorrect result.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes\n';
const quiet = { log() {}, warn() {} };
test('absent job cannot authorize budget handoff', () => {
  assert.equal(remediationBudgetHandoffAllowed(null), false);
});
function fixture(t, overrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediateexec-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const job = { ...buildFollowUpJob({ repo: 'fixture/repo', prNumber: 42, branch: 'topic',
    revisionRef: HEAD, reviewerModel: 'codex', reviewBody: BODY, reviewPostedAt: AT }),
  status: 'stopped', stoppedAt: AT, remediationWorker: { state: 'completed' }, ...overrides };
  job.remediationPlan = { ...job.remediationPlan, currentRound: 1, maxRounds: 3,
    rounds: [{ round: 1, state: 'stopped' }], stop: { code: 'committed-unpublished' },
    ...overrides.remediationPlan };
  const jobPath = join(rootDir, 'data/follow-up-jobs', job.status, `${job.jobId}.json`);
  writeFollowUpJob(jobPath, job);
  const options = { rootDir, repo: job.repo, prNumber: job.prNumber, headSha: job.revisionRef, now: NOW };
  return { rootDir, job, jobPath, options };
}

for (const [status, code] of [['stopped', 'committed-unpublished'], ['stopped', 'no-progress'],
  ['stopped', 'stale-heartbeat'], ['stopped', 'worker-timeout'], ['failed', 'worker-failure'],
  ['failed', 'artifact-empty-completion'], ['failed', 'artifact-missing-completion'],
  ['failed', 'invalid-remediation-reply'], ['failed', 'hq-dispatch-failed'],
  ['failed', 'hq-dispatch-transient-budget-exhausted']]) {
  test(`ended ${status}:${code} queues the next bounded round exactly once`, async t => {
    const f = fixture(t, { status, failure: { code }, remediationPlan: { stop: { code } } });
    const first = await recoverEndedRemediationRound(f.options);
    assert.equal(first.recreated, true, JSON.stringify(first));
    const pending = readFollowUpJob(first.jobPath);
    assert.equal(pending.remediationPlan.currentRound, 1);
    assert.equal(pending.remediationPlan.maxRounds, 3);
    assert.equal(pending.remediationPlan.nextAction.round, 2);
    assert.equal(pending.remediationPlan.nextAction.operatorOverride, false);
    assert.equal(pending.remediationPlan.retryAfter, '2026-01-01T00:05:00.000Z');
    assert.equal((await recoverEndedRemediationRound(f.options)).recreated, false);
    const claim = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: NOW, claimedBy: 'fixture',
      requiredModel: 'codex', routingResolver: () => ({ workerClass: 'codex' }) });
    assert.ok(claim, 'normal consumer claims the recovered job');
    assert.equal(claim.job.remediationPlan.currentRound, 2);
  });
}

test('a future backoff, moved head, exhausted round and explicit stop never redrive', async t => {
  for (const overrides of [
    { remediationPlan: { retryAfter: '2026-01-01T01:00:00.000Z' } },
    { remediationPlan: { currentRound: 3 } },
    { remediationPlan: { stop: { code: 'operator-stop' } } },
    { status: 'failed', failure: { code: 'branch-contamination' } },
    { status: 'failed', failure: { code: 'worker-failure', needsOperator: true } },
  ]) {
    const f = fixture(t, overrides);
    assert.equal((await recoverEndedRemediationRound(f.options)).recreated, false);
    assert.equal(readFollowUpJob(f.jobPath).status, f.job.status);
  }
  const f = fixture(t);
  assert.equal((await recoverEndedRemediationRound({ ...f.options, headSha: 'b'.repeat(40) })).recreated, false);
});

test('an older queued owner wins over the latest terminal record', async t => {
  const f = fixture(t);
  const active = { ...f.job, jobId: `${f.job.jobId}-older`, status: 'pending', stoppedAt: null,
    createdAt: '2025-12-31T23:00:00.000Z' };
  writeFollowUpJob(join(f.rootDir, 'data/follow-up-jobs/pending', `${active.jobId}.json`), active);
  assert.equal((await recoverEndedRemediationRound(f.options)).recreated, false);
  assert.equal(readFollowUpJob(f.jobPath).status, 'stopped');
});

test('missing initial follow-up is left to the reviewer reaper with its budget evidence', async t => {
  const f = fixture(t);
  rmSync(f.jobPath);
  const options = { ...f.options, missingJobInput: { repo: f.job.repo, prNumber: 42,
    branch: 'topic', baseBranch: 'main', revisionRef: HEAD, reviewerModel: 'codex',
    reviewPostedAt: AT, reviewBody: BODY, singleReview: { applied: true, basis: 'super-small' } } };
  const result = await recoverEndedRemediationRound(options);
  assert.equal(result.recreated, false);
  assert.equal(result.reason, 'no-prior-job');
  assert.equal(existsSync(f.jobPath), false);
});

test('a live closer lease prevents round recovery', async t => {
  const f = fixture(t);
  assert.equal(acquireAmaCloserLease({ rootDir: f.rootDir, repo: f.job.repo,
    prNumber: 42, headSha: HEAD, watcherPid: process.pid }).acquired, true);
  const result = await recoverEndedRemediationRound(f.options);
  assert.equal(result.recreated, false);
  assert.equal(result.reason, 'closer-owned');
});

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
function retainedFixture(t) {
  const f = fixture(t);
  const work = join(f.rootDir, 'worker'), remote = join(f.rootDir, 'remote.git');
  mkdirSync(work);
  const git = (...args) => execFileSync('git', ['-C', work, ...args],
    { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--bare', '-b', 'main', remote);
  git('init', '-q', '-b', 'main');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(work, 'base.txt'), 'base\n');
  git('add', 'base.txt'); git('commit', '-qm', 'base');
  git('remote', 'add', 'origin', remote); git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'topic');
  writeFileSync(join(work, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt'); git('commit', '-qm', 'feature');
  const head = git('rev-parse', 'HEAD'); git('push', '-q', 'origin', 'topic');
  writeFileSync(join(work, 'fix.txt'), 'fix\n');
  git('add', 'fix.txt'); git('commit', '-qm', `repair\n\nWorker-Job-Id: ${f.job.jobId}`);
  const local = git('rev-parse', 'HEAD');
  f.job.revisionRef = head;
  f.job.remediationWorker = { state: 'completed', workspaceDir: work, spawnedAt: AT };
  f.job.remediationPlan.rounds[0].spawnedAt = AT;
  f.job.remediationPlan.rounds[0].startHeadSha = head;
  f.job.unpublishedWork = { commitSha: local, workspaceDir: work };
  writeFollowUpJob(f.jobPath, f.job);
  const execFileImpl = async (cmd, args, opts) => ({ stdout: cmd === 'gh'
    ? `${git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0]}\n`
    : execFileSync(cmd, args, { ...opts, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) });
  return { ...f, work, git, local, head, options: { ...f.options, headSha: head, execFileImpl } };
}

test('verified retained work publishes and requests re-review without another worker round', async t => {
  const f = retainedFixture(t);
  let pushes = 0;
  let reviews = 0;
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#42', head: f.local, observedAt: NOW,
    observations: { policy: { strictMode: true, autonomousMergeExecutionEnabled: true },
      leases: { closer: null }, launches: { closer: null }, controls: {}, progress: {} } });
  const result = await recoverEndedRemediationRound({ ...f.options, publishImpl: args => {
    pushes++;
    return publishRemediation({ ...args, pushCommand: 'git', env: gitEnv });
  }, completeImpl: args => completeWorkerPublishedHead({ ...args, snapshot,
    requestReviewRereviewImpl: () => { reviews++; return { triggered: true, status: 'pending' }; },
    requestRereviewWakeImpl: () => ({ requested: true }),
    requestWatcherWakeImpl: () => ({ requested: true }) }) });
  assert.equal(pushes, 1);
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.recreated, false);
  assert.equal(reviews, 1);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/topic').split('\t')[0], f.local);
  const completed = readFollowUpJob(result.jobPath);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.completion.workerPushedHeadSha, f.local);
  assert.equal(completed.unpublishedWork, null);
  assert.equal(completed.reReview.requested, true);
  assert.equal(completed.remediationPlan.currentRound, 1);
  assert.equal(completed.remediationPlan.maxRounds, 3);
  assert.equal((await recoverEndedRemediationRound(f.options)).recreated, false);
  assert.equal(reviews, 1);
});

test('publication recovery cannot complete a changed source or an unvalidated final-round reply', t => {
  const f = retainedFixture(t);
  for (const changed of [false, true]) {
    const job = { ...f.job, ...(changed ? {} : { finalRound: 'comment-only' }) };
    writeFollowUpJob(f.jobPath, job);
    const source = readFollowUpJob(f.jobPath);
    const proof = { sourceDigest: recoveryDigest(source), headSha: f.local,
      proof: { method: 'git-cherry-replay' }, completedFinalRound: false };
    if (changed) writeFollowUpJob(f.jobPath, { ...source, reviewBody: 'changed review evidence' });
    assert.equal(completeWorkerPublishedHead({ rootDir: f.rootDir, jobPath: f.jobPath,
      headSha: f.local, publicationRecovery: proof }), null);
    assert.equal(readFollowUpJob(f.jobPath).status, 'stopped');
  }
});

test('a source changed during retained-work verification prevents publication', async t => {
  const f = retainedFixture(t);
  let changed = false;
  const result = await recoverEndedRemediationRound({ ...f.options,
    execFileImpl: async (...args) => {
      if (!changed) {
        changed = true;
        writeFollowUpJob(f.jobPath, { ...f.job, reviewBody: 'concurrently replaced review' });
      }
      return f.options.execFileImpl(...args);
    },
    publishImpl: () => assert.fail('changed evidence cannot authorize publication') });
  assert.equal(result.reason, 'job-evidence-changed');
});

test('concurrent recoveries reserve one publisher; refusal keeps retained evidence and the ordinary budget', async t => {
  const f = retainedFixture(t);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const first = recoverEndedRemediationRound({ ...f.options, publishImpl: async () => {
    entered(); await wait; throw new Error('synthetic publication refusal');
  } });
  await started;
  const second = await recoverEndedRemediationRound(f.options);
  assert.equal(second.reason, 'round-recovery-owned');
  release();
  const result = await first;
  assert.equal(result.recreated, true);
  const pending = readFollowUpJob(result.jobPath);
  assert.equal(pending.unpublishedWork.commitSha, f.local);
  assert.equal(pending.remediationPlan.maxRounds, 3);
});

test('shared watcher, wake and rescue agree across findings, remaining budgets and live owners', t => {
  const f = fixture(t);
  for (const previousAction of ['remediate', 'hammer', 'wait-for-CI'])
    for (const count of [0, 1]) for (const left of [false, true]) for (const live of [false, true]) {
    const reviewState = { headSha: HEAD, verdict: count ? 'request-changes' : 'approved',
      attestation: 'valid', blockingFindingState: 'known', blockingFindingCount: count,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 };
    const evidence = closureOwnerShadowEvidence({ currentHead: HEAD, reviewState, roundsLeft: true,
      followUpJob: { ...f.job, status: live ? 'in_progress' : 'stopped',
        reReview: { nextAction: { action: previousAction, head: HEAD } },
        lastHeartbeatAt: new Date().toISOString(), remediationWorker: { state: 'running' },
        remediationPlan: { currentRound: left ? 1 : 2, maxRounds: 2,
          stop: { code: 'committed-unpublished' } } },
      strictMode: true, lease: null, launchRecord: null },
    { autonomousMergeExecutionEnabled: true, candidate: { state: 'OPEN', headSha: HEAD } });
    const snapshot = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#42', head: HEAD, observedAt: NOW,
      anchors: { firstActionableAt: AT },
      observations: { ...evidence.observations, pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE' },
        checks: { conclusion: 'SUCCESS' }, controls: {}, progress: {} } });
    const decision = nextAction(snapshot);
    const expected = live ? 'remediate' : count ? left ? 'remediate' : 'hammer' : 'daemon-merge';
    assert.equal(decision.action, expected, JSON.stringify({ count, left, live, decision }));
    const rescue = classifyClosureOwnership(decision, HEAD);
    assert.equal(rescue.closureOwner.action, expected);
    const wake = requestEligibleHammerWake({ rootDir: f.rootDir, repo: f.job.repo, prNumber: 42,
      headSha: HEAD, shared: { snapshot, decision }, log: quiet, observedAt: NOW, nowMs: Date.parse(NOW),
      requestWatcherWakeImpl: () => ({ requested: true }) });
    assert.equal(wake.outcome === 'skipped', expected === 'remediate');
    const broaderLedger = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#42', head: HEAD, observedAt: NOW,
      anchors: { firstActionableAt: AT },
      observations: { ...evidence.observations,
        remediation: { ...evidence.observations.remediation,
          value: { ...evidence.observations.remediation.value, completedRounds: 0, maxRounds: 6 } },
        pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE' },
        checks: { conclusion: 'SUCCESS' }, controls: {}, progress: {} } });
    assert.equal(nextAction(broaderLedger).action, expected, 'a broader ledger cannot re-arm a spent job ceiling');
  }
});

test('a terminal budget does not grant automatic handoff over explicit operator stops', t => {
  const f = fixture(t);
  for (const hold of [
    { status: 'stopped', remediationPlan: { currentRound: 2, maxRounds: 2, stop: { code: 'operator-stop' } } },
    { status: 'stopped', remediationPlan: { currentRound: 2, maxRounds: 2, stop: { code: 'subject-refused' } } },
    { status: 'stopped', remediationPlan: { currentRound: 2, maxRounds: 2,
      stop: { code: 'builder-cannot-remediate-own-pr' } } },
    { status: 'failed', failure: { code: 'branch-contamination' },
      remediationPlan: { currentRound: 2, maxRounds: 2 } },
    { status: 'failed', failure: { code: 'worker-failure', needsOperator: true },
      remediationPlan: { currentRound: 2, maxRounds: 2 } },
    { status: 'stopped', closureHandoff: { reason: 'final-fix-all', headSha: HEAD },
      remediationPlan: { currentRound: 2, maxRounds: 2, stop: { code: 'no-progress' } } },
  ]) {
    const evidence = closureOwnerShadowEvidence({ currentHead: HEAD, roundsLeft: true,
      reviewState: { headSha: HEAD, verdict: 'request-changes', attestation: 'valid',
        blockingFindingState: 'known', blockingFindingCount: 1, nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      followUpJob: { ...f.job, ...hold }, strictMode: true, lease: null, launchRecord: null },
    { autonomousMergeExecutionEnabled: true, candidate: { state: 'OPEN', headSha: HEAD } });
    const snapshot = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#42', head: HEAD, observedAt: NOW,
      observations: { ...evidence.observations, pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE' },
        checks: { conclusion: 'SUCCESS' }, controls: {}, progress: {} } });
    assert.equal(nextAction(snapshot).action, 'remediate', 'the new budget proof cannot bypass a deliberate hold');
  }
});
