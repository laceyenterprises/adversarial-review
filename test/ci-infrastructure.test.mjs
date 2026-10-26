import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { bindClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { recoverAmaAutomation } from '../src/ama/automated-recovery.mjs';
import { checkInfrastructureReason, enrichCiInfrastructureEvidence, infrastructureOnlyFailures } from '../src/ci-infrastructure.mjs';
import { holdRemediationForCiInfrastructure, resumeCiInfrastructureRound, recoverInfrastructureCiStops } from '../src/remediation-ci-infrastructure.mjs';
import { buildFollowUpJob, createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned,
  markFollowUpJobStopped, readFollowUpJob, writeFollowUpJob, summarizePRRemediationLedger } from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { evaluateHammerStopHold, isInfrastructureStop, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';

const repo = 'example/fixture', head = 'a'.repeat(40), prNumber = 42;
const now = '2026-01-01T00:00:00.000Z', later = '2026-01-01T01:10:00.000Z';
const failed = { name: 'unit', conclusion: 'FAILURE', steps: [] };
const green = { name: 'unit', conclusion: 'SUCCESS' };
const redGate = { headSha: head, state: 'infrastructure', failedChecks: [failed], infrastructureOnly: true };
const greenGate = { headSha: head, state: 'green', failedChecks: [], rollup: [green] };
const logger = { log() {}, warn() {}, error() {} };
function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-infrastructure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function active(rootDir) {
  createFollowUpJob({ rootDir, repo, prNumber, branch: 'fixture/topic', revisionRef: head,
    reviewBody: '## Verdict\nRequest changes', critical: true });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: now });
  return markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath,
    worker: { model: 'codex', processId: 999999, spawnedAt: now, state: 'spawned' } });
}

for (const [name, check, expected] of [
  ['empty steps', failed, 'actions-zero-step'],
  ['skipped steps', { ...failed, steps: [{ conclusion: 'skipped' }] }, 'actions-zero-step'],
  ['queued steps', { ...failed, steps: [{ status: 'queued' }] }, 'actions-zero-step'],
  ['executed failure', { ...failed, steps: [{ conclusion: 'failure', status: 'completed' }] }, null],
  ['started step', { ...failed, steps: [{ started_at: now, status: 'in_progress' }] }, null],
  ['missing evidence', { name: 'unit', conclusion: 'FAILURE' }, null],
  ['green with no steps', { ...green, steps: [] }, null],
  ['pending with stale failure', { ...failed, status: 'IN_PROGRESS' }, null],
  ['billing annotation', { name: 'unit', conclusion: 'FAILURE', annotations: [
    { message: 'The job was not started because an Actions budget is preventing further use.' },
  ] }, 'actions-billing-quota'],
  ['unrelated budget test output', { name: 'unit', conclusion: 'FAILURE',
    output: { summary: 'Budget assertion failed.' } }, null],
]) test('CIBLOCKINFRA-01 classifier: ' + name, () => {
  assert.equal(checkInfrastructureReason(check), expected);
});

test('CIBLOCKINFRA-01 missing evidence reads one bounded page and verifies job and head', async () => {
  const rollup = [1, 2].map(id => ({ name: 'unit-' + id, conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/example/fixture/actions/runs/10/job/' + id }));
  let reads = 0;
  const result = await enrichCiInfrastructureEvidence({ rollup, repo, headSha: head,
    execFileImpl: async (bin, args, options) => {
      reads++;
      assert.equal(bin, 'gh');
      assert.deepEqual(args, ['api', 'repos/example/fixture/actions/runs/10/jobs?filter=latest&per_page=100']);
      assert.equal(options.timeout, 3000);
      return { stdout: JSON.stringify({ jobs: [
        { id: 1, head_sha: head, conclusion: 'failure', steps: [] },
        { id: 2, head_sha: 'b'.repeat(40), conclusion: 'failure', steps: [] },
      ] }) };
    } });
  assert.equal(reads, 1);
  assert.equal(checkInfrastructureReason(result[0]), 'actions-zero-step');
  assert.equal(checkInfrastructureReason(result[1]), null);
  assert.equal(infrastructureOnlyFailures(result), false);
  assert.equal(rollup[0].steps, undefined);
});

test('CIBLOCKINFRA-01 known evidence and non-GitHub URLs require no read; errors stay unknown', async () => {
  for (const rollup of [[failed], [{ ...failed, steps: undefined, detailsUrl: 'https://example.invalid/job/1' }]]) {
    await enrichCiInfrastructureEvidence({ rollup, repo, headSha: head,
      execFileImpl: async () => assert.fail('unnecessary read') });
  }
  const rollup = [{ name: 'unit', conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/example/fixture/actions/runs/10/job/1' }];
  let reads = 0;
  assert.deepEqual(await enrichCiInfrastructureEvidence({ rollup, repo, headSha: head,
    execFileImpl: async () => { reads++; throw new Error('offline'); } }), rollup);
  assert.equal(reads, 1);
});

test('CIBLOCKINFRA-01 remediation waits without consuming a round and refunds once after execution', async t => {
  const rootDir = root(t), job = active(rootDir);
  const held = holdRemediationForCiInfrastructure({ rootDir, jobPath: job.jobPath, ciGate: redGate, now });
  assert.equal(held.action, 'active');
  assert.equal(held.job.remediationPlan.currentRound, 1);
  assert.equal(summarizePRRemediationLedger(rootDir, held.job).completedRoundsForPR, 0);
  const quiet = await reconcileFollowUpJob({ rootDir, ...held, now: () => '2026-01-01T00:01:00.000Z',
    execFileImpl: async () => assert.fail('backoff must not read'), log: logger });
  assert.equal(quiet.reason, 'ci-infrastructure');
  const parked = holdRemediationForCiInfrastructure({ rootDir, jobPath: held.jobPath, ciGate: redGate, now: later });
  assert.equal(parked.job.ciInfrastructureWait.parked, true);
  const resumed = await resumeCiInfrastructureRound({ rootDir, jobPath: held.jobPath, ciGate: greenGate, now: later });
  assert.equal(resumed.job.status, 'pending');
  assert.equal(resumed.job.remediationPlan.currentRound, 0);
  assert.equal(resumed.job.remediationPlan.transientRetries, 0);
  assert.equal(resumed.job.remediationPlan.retryHistory.at(-1).retryMetadata.reason, 'checks-executed-again');
  assert.equal(await resumeCiInfrastructureRound({ rootDir, jobPath: resumed.jobPath, ciGate: greenGate, now: later }), null);
  assert.equal(claimNextFollowUpJob({ rootDir, claimedAt: later }).job.remediationPlan.currentRound, 1);
});

test('CIBLOCKINFRA-01 pending, skipped, unrelated and moved-head checks cannot release a wait', async t => {
  const rootDir = root(t), job = active(rootDir);
  holdRemediationForCiInfrastructure({ rootDir, jobPath: job.jobPath, ciGate: redGate, now });
  for (const gate of [redGate, { ...greenGate, state: 'pending' }, { ...greenGate, headSha: 'b'.repeat(40) },
    { ...greenGate, rollup: [{ name: 'unit', conclusion: 'SKIPPED' }] },
    { ...greenGate, rollup: [{ name: 'unrelated', conclusion: 'SUCCESS' }] }]) {
    assert.equal(await resumeCiInfrastructureRound({ rootDir, jobPath: job.jobPath, ciGate: gate, now: later }), null);
  }
});

for (const real of [false, true]) test('CIBLOCKINFRA-01 existing stop recovery, real=' + real, async t => {
  const rootDir = root(t), current = active(rootDir);
  const check = real ? { ...failed, steps: [{ conclusion: 'failure' }] } : failed;
  const stopped = markFollowUpJobStopped({ rootDir, jobPath: current.jobPath, stoppedAt: now,
    stopCode: 'no-progress', stopReason: 'CI failed.', failure: { ciGate: { ...redGate, failedChecks: [check] } },
    commentDeliveryExemption: 'synthetic-fixture' });
  const bytes = readFileSync(stopped.jobPath, 'utf8');
  const args = { rootDir, repo, prNumber, headSha: head, ciGate: greenGate, now: later };
  const recovered = await recoverInfrastructureCiStops(args);
  assert.equal(recovered.length, real ? 0 : 1);
  if (real) assert.equal(readFileSync(stopped.jobPath, 'utf8'), bytes);
  else {
    assert.equal(recovered[0].job.remediationPlan.currentRound, 0);
    assert.equal(recovered[0].job.remediationPlan.stop, null);
    assert.equal(summarizePRRemediationLedger(rootDir, recovered[0].job).completedRoundsForPR, 0);
    assert.equal((await recoverInfrastructureCiStops(args)).length, 0);
  }
});

test('CIBLOCKINFRA-01 PR-scoped recovery releases a legacy failed queue record with zero-step proof', async t => {
  const rootDir = root(t), job = buildFollowUpJob({ repo, prNumber, revisionRef: head,
    reviewBody: '## Verdict\nRequest changes' });
  job.status = 'failed'; job.failedAt = now;
  job.remediationPlan.currentRound = 1;
  job.remediationWorker = { state: 'failed', model: 'codex' };
  job.failure = { code: 'ci-regression', ciGate: redGate };
  const jobPath = join(rootDir, 'data/follow-up-jobs/failed', job.jobId + '.json');
  mkdirSync(join(jobPath, '..'), { recursive: true });
  writeFollowUpJob(jobPath, job);
  await recoverInfrastructureCiStops({ rootDir, repo, prNumber, headSha: head, ciGate: greenGate, now: later });
  const pending = readFollowUpJob(join(rootDir, 'data/follow-up-jobs/pending', job.jobId + '.json'));
  assert.equal(pending.remediationPlan.currentRound, 0);
  assert.equal(pending.failure, null);
});

test('CIBLOCKINFRA-01 closure does not arm a stop; green releases and refunds only infrastructure charges', async t => {
  const rootDir = root(t);
  const identity = { repo, prNumber };
  recordHammerRetryDispatch(rootDir, identity, { jobKey: head, headSha: head, launchRequestId: 'fixture-real', now });
  recordHammerRetryDispatch(rootDir, identity, { jobKey: head, headSha: head, launchRequestId: 'fixture-infra', now });
  writeAmaAuditEntry({ hqRoot: rootDir, ...identity, headSha: head, now,
    attempt: { path: 'hammer', head, outcome: 'failed-without-merge', reason: 'github-gate-not-green',
      githubGate: { reasons: ['ci-not-green'], badChecks: [failed] }, launchRequestId: 'fixture-infra' } });
  const stop = readHammerStopForHead({ hqRoot: rootDir, ...identity, headSha: head });
  assert.equal(isInfrastructureStop(stop), true);
  assert.equal(stop.refusal, null);
  assert.equal(isInfrastructureStop({ ...stop, reasons: ['primary-change-reverted'] }), false);
  const args = { rootDir, hqRoot: rootDir, ...identity, headSha: head, logger,
    prMetadata: { isOpen: true, headSha: head, statusCheckRollup: [failed] },
    deliverAlertImpl: async () => assert.fail('infrastructure must not page'), now: later };
  assert.equal((await evaluateHammerStopHold(args)).action, 'none');
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 2);
  const released = await evaluateHammerStopHold({ ...args,
    prMetadata: { ...args.prMetadata, statusCheckRollup: [green] } });
  assert.equal(released.action, 'release');
  assert.deepEqual(released.changed, ['ci-infrastructure-recovered']);
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.attemptCount, 1);
  assert.equal(ledger.lifetimeAttemptCount, 1);
  assert.equal(ledger.targetAttemptCount, 1);
  assert.equal(ledger.dispatchCharges['fixture-infra'].ciInfrastructureRefund.reason, 'checks-executed-again');
  await evaluateHammerStopHold({ ...args, prMetadata: { ...args.prMetadata, statusCheckRollup: [green] } });
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 1);
});

function closureResult(rollup, conclusion = 'FAILURE') {
  const snapshot = deriveNextActionSnapshot({ subjectKey: repo + '#' + prNumber, head,
    observedAt: now, observations: {
      pr: { headSha: head, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [] },
      checks: { conclusion, rollup }, remediation: { roundsLeft: false },
      reviews: { verdict: 'approved', headSha: head, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      policy: { strictMode: true, autonomousMergeExecutionEnabled: true },
      leases: { closer: null }, launches: { closer: null }, controls: {},
    } });
  const shared = { snapshot, decision: nextAction(snapshot) };
  return bindClosureNextAction({ reason: shared.decision.reason, nextAction: shared.decision }, shared);
}

test('CIBLOCKINFRA-01 automated recovery neither charges nor arms a stop during a long infrastructure block', async t => {
  const rootDir = root(t);
  for (const at of [now, later]) {
    const outcome = await recoverAmaAutomation({ rootDir, repo, prNumber, headSha: head,
      result: closureResult([failed]), reviewStateRow: {}, now: () => Date.parse(at), logger,
      dispatchHammer: async () => assert.fail('infrastructure must not dispatch'),
      pageImpl: async () => assert.fail('infrastructure must not arm an automated stop') });
    assert.equal(outcome.outcome, 'ama-pending');
    assert.equal(outcome.recovery.action, 'ci-infrastructure');
    assert.equal(outcome.recovery.attempts, 0);
    assert.equal(outcome.recovery.event, undefined);
  }
});

test('CIBLOCKINFRA-01 historical automated stop clears only for a wholly evidenced infrastructure series', async t => {
  const rootDir = root(t);
  const oldHqRoot = process.env.HQ_ROOT;
  process.env.HQ_ROOT = rootDir;
  t.after(() => { process.env.HQ_ROOT = oldHqRoot; });
  writeAmaAuditEntry({ hqRoot: rootDir, repo, prNumber, headSha: head, now,
    attempt: { path: 'hammer', head, outcome: 'failed-without-merge', reason: 'github-gate-not-green',
      githubGate: { reasons: ['ci-not-green'], badChecks: [failed] }, launchRequestId: 'fixture-infra' } });
  const dir = join(rootDir, 'data/follow-up-jobs/ama-automated-recovery');
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(repo + '#' + prNumber + '@' + head).digest('hex');
  const statePath = join(dir, key + '.json');
  for (const attempts of [2, 1]) {
    writeFileSync(statePath, JSON.stringify({ attempts, event: { reason: 'automated-stop' },
      pagedReasons: ['automated-stop'], paged: true }));
    await recoverAmaAutomation({ rootDir, repo, prNumber, headSha: head,
      result: closureResult([green], 'SUCCESS'), reviewStateRow: {}, now: () => Date.parse(later), logger,
      dispatchHammer: async () => assert.fail('green clean head does not need a hammer'),
      pageImpl: async () => ({ id: 'fixture-page' }) });
    const state = JSON.parse(readFileSync(statePath));
    assert.equal(state.attempts, attempts === 1 ? 0 : 2);
    assert.equal(Boolean(state.ciInfrastructureRecovery), attempts === 1);
    if (attempts === 1) {
      assert.equal(state.event, undefined);
      assert.equal(state.ciInfrastructureRecovery.reason, 'checks-executed-again');
    }
  }
});

test('CIBLOCKINFRA-01 multiple workflows reuse exact-head evidence with at most one read per observation', async t => {
  const rootDir = root(t), current = active(rootDir);
  const checks = [10, 20].map(id => ({ name: 'unit-' + id, conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/example/fixture/actions/runs/' + id + '/job/' + id }));
  let reads = 0;
  const execFileImpl = async (_bin, args) => {
    reads++;
    const id = args[1].includes('/10/') ? 10 : 20;
    return { stdout: JSON.stringify({ jobs: [{ id, head_sha: head, conclusion: 'failure', steps: [] }] }) };
  };
  const first = await enrichCiInfrastructureEvidence({ rollup: checks, repo, headSha: head, execFileImpl });
  assert.equal(reads, 1);
  const held = holdRemediationForCiInfrastructure({ rootDir, jobPath: current.jobPath, now,
    ciGate: { ...redGate, failedChecks: first, infrastructureOnly: false, infrastructureEvidencePending: true } });
  assert.equal(held.job.ciInfrastructureWait.evidencePending, true);
  const resumed = await resumeCiInfrastructureRound({ rootDir, jobPath: held.jobPath, now: later, execFileImpl,
    ciGate: { ...greenGate, rollup: checks.map(check => ({ ...check, conclusion: 'SUCCESS' })) } });
  assert.equal(reads, 2);
  assert.equal(resumed.job.remediationPlan.currentRound, 0);
  const cached = await enrichCiInfrastructureEvidence({ rollup: checks, repo, headSha: head, execFileImpl });
  assert.equal(infrastructureOnlyFailures(cached), true);
  assert.equal(reads, 2);
});

test('CIBLOCKINFRA-01 unknown lifecycle evidence retains the bounded uncharged wait', async t => {
  const rootDir = root(t), current = active(rootDir);
  const held = holdRemediationForCiInfrastructure({ rootDir, jobPath: current.jobPath, ciGate: redGate, now });
  const result = await reconcileFollowUpJob({ rootDir, ...held, now: () => later,
    resolvePRLifecycleImpl: async () => null,
    inspectRemediationCiRegressionImpl: async () => assert.fail('lifecycle must be authoritative'),
    execFileImpl: async () => assert.fail('unexpected command'), log: logger });
  assert.equal(result.action, 'active');
  assert.equal(result.reason, 'ci-infrastructure-lifecycle-pending');
  assert.equal(summarizePRRemediationLedger(rootDir, result.job).completedRoundsForPR, 0);
});

test('CIBLOCKINFRA-01 an executed historical sibling preserves the remediation charge', async t => {
  const rootDir = root(t), current = active(rootDir);
  const unknown = { name: 'unit-2', conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/example/fixture/actions/runs/20/job/20' };
  holdRemediationForCiInfrastructure({ rootDir, jobPath: current.jobPath, now,
    ciGate: { ...redGate, failedChecks: [failed, unknown], infrastructureEvidencePending: true } });
  const result = await resumeCiInfrastructureRound({ rootDir, jobPath: current.jobPath, now: later,
    ciGate: { ...greenGate, rollup: [green, { name: 'unit-2', conclusion: 'SUCCESS' }] },
    execFileImpl: async () => ({ stdout: JSON.stringify({ jobs: [{ id: 20, head_sha: head,
      conclusion: 'failure', steps: [{ conclusion: 'failure', status: 'completed' }] }] }) }) });
  assert.equal(result.action, 'continue');
  assert.equal(result.job.remediationPlan.currentRound, 1);
  assert.equal(result.job.ciInfrastructureWait, undefined);
});

test('CIBLOCKINFRA-01 missing historical evidence cannot erase an earlier real refusal', async t => {
  const rootDir = root(t);
  const old = { head, path: 'hammer', outcome: 'failed-without-merge',
    reason: 'primary-change-reverted', startedAt: now };
  const blocked = { head, path: 'hammer', outcome: 'failed-without-merge',
    reason: 'github-gate-not-green', startedAt: later, githubGate: { reasons: ['ci-not-green'],
      badChecks: [{ name: 'unit', conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/example/fixture/actions/runs/10/job/10' }] } };
  const result = await evaluateHammerStopHold({ rootDir, hqRoot: rootDir, repo, prNumber, headSha: head,
    prMetadata: { isOpen: true, headSha: head, statusCheckRollup: [green] },
    readAuditImpl: () => ({ attempts: [old, blocked] }), logger, now: later,
    execFileImpl: async () => ({ stdout: JSON.stringify({ jobs: [
      { id: 10, head_sha: head, conclusion: 'failure', steps: [] },
    ] }) }),
    fetchPrimaryChangeImpl: async () => { throw new Error('unavailable fixture proof'); },
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.hammerStop.predicate, 'primary-change-reverted');
});

test('CIBLOCKINFRA-01 historical exact-job evidence releases a CI-only legacy stop without mutation', async t => {
  const rootDir = root(t);
  const audit = { attempts: [{ head, path: 'hammer', outcome: 'failed-without-merge',
    reason: 'github-gate-not-green', startedAt: now, githubGate: { reasons: ['ci-not-green'],
      badChecks: [{ name: 'unit', conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/example/fixture/actions/runs/10/job/10' }] } }] };
  const original = JSON.stringify(audit);
  const result = await evaluateHammerStopHold({ rootDir, hqRoot: rootDir, repo, prNumber, headSha: head,
    prMetadata: { isOpen: true, headSha: head, statusCheckRollup: [green] },
    readAuditImpl: () => audit, logger, now: later,
    execFileImpl: async () => ({ stdout: JSON.stringify({ jobs: [
      { id: 10, head_sha: head, conclusion: 'failure', steps: [] },
    ] }) }) });
  assert.equal(result.action, 'release');
  assert.equal(result.infrastructureStop.failedChecks[0].steps.length, 0);
  assert.equal(JSON.stringify(audit), original);
});
