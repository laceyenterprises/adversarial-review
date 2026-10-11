import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { recordLocalRemediationOutcome } from '../src/remediation-round-accounting.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { infrastructureRefundReason, localWorkerErrorOutcome } from '../src/remediation-infrastructure-refund.mjs';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned, summarizePRRemediationLedger, buildFollowUpJob, getFollowUpJobDir, readFollowUpJob } from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { buildRemediationOutcomeCommentBody } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';
import { assessWorkerLivenessDetailed } from '../src/remediation-worker-liveness.mjs';
import { resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { cancelFollowUpWorker } from '../src/follow-up-worker-cancel.mjs';

let previousHqRoot;
let fixtureHqRoot;
beforeEach(() => {
  previousHqRoot = process.env.HQ_ROOT;
  fixtureHqRoot = mkdtempSync(join(tmpdir(), 'remrefund-hq-'));
  process.env.HQ_ROOT = fixtureHqRoot;
});
afterEach(() => {
  if (previousHqRoot === undefined) delete process.env.HQ_ROOT;
  else process.env.HQ_ROOT = previousHqRoot;
  rmSync(fixtureHqRoot, { recursive: true, force: true });
});

for (const outcome of [
  { failureReason: 'codex-tool-host-unavailable' }, { failureClass: 'publish-blocked' },
  { failure_class: 'boot-failed' },
]) {
  test(`recorded infrastructure outcome ${JSON.stringify(outcome)} needs unchanged known heads and bounded refunds`, () => {
    const args = { outcome, startHead: 'a', endHead: 'a', env: {} };
    assert.ok(infrastructureRefundReason(args));
    assert.equal(infrastructureRefundReason({ ...args, endHead: 'b' }), null);
    assert.equal(infrastructureRefundReason({ ...args, endHead: null }), null);
    assert.equal(infrastructureRefundReason({ ...args, refunds: 2 }), null);
    assert.equal(infrastructureRefundReason({ ...args, refunds: 2, env: { ADV_MAX_REMEDIATION_INFRASTRUCTURE_REFUNDS: '99' } }), null);
  });
}
test('narrative and generic worker failures cannot earn a refund', () => {
  for (const outcome of [{ failureDetail: 'publish-blocked' }, { exitCode: 1 },
    { exitCode: 143 }, { exit_code: 137 }, { signal: 'SIGTERM' },
    { status: 'cancelled', failureReason: 'publish-blocked', exitCode: 143 }, null]) {
    assert.equal(infrastructureRefundReason({ outcome, startHead: 'a', endHead: 'a' }), null);
  }
});

for (const reason of ['codex-tool-host-unavailable', 'publish-blocked', 'boot-failed']) {
  test(`reconcile refunds ${reason} once and publishes its marker`, async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'remrefund-'));
    try {
      createFollowUpJob({ rootDir, repo: 'fixture/repo', prNumber: 1, revisionRef: 'a'.repeat(40),
        reviewerModel: 'claude', reviewBody: 'Fix the bug.', reviewPostedAt: '2026-10-11T00:00:00Z', critical: true });
      let claimed = claimNextFollowUpJob({ rootDir });
      const spawn = () => markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, worker: {
        workerClass: 'codex', model: 'codex', processId: reason === 'boot-failed' ? null : 1234,
        workspaceDir: 'data/workspace', outputPath: 'data/workspace/output.md', logPath: 'data/workspace/log.md',
        recordedOutcome: { failureReason: reason },
      } });
      let spawned = spawn();
      const comments = [];
      const reconcile = () => reconcileFollowUpJob({ rootDir, jobPath: spawned.jobPath, job: spawned.job,
        isWorkerRunning: () => false,
        resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: 'a'.repeat(40) }),
        postCommentImpl: async ({ body }) => { comments.push(body); return { posted: false, error: 'offline fixture' }; },
        log: { log() {}, warn() {}, error() {} },
      });
      const result = await reconcile();
      assert.equal(result.action, 'requeued');
      assert.equal(result.job.remediationPlan.currentRound, 0);
      assert.equal(result.job.remediationPlan.transientRetries, 0);
      assert.ok(comments[0].includes(`not charged: ${reason}`));
      assert.match(comments[0], /round 1/);
      assert.equal(summarizePRRemediationLedger(rootDir, result.job).infrastructureRefundsForPR, 1);
      claimed = claimNextFollowUpJob({ rootDir });
      spawned = spawn();
      const second = await reconcile();
      assert.notEqual(second.action, 'requeued');
      assert.equal(second.job.remediationPlan.currentRound, 1);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });

}

test('harness-specific refund selects the configured fallback and preserves reviewer diversity', async () => {
  const job = { remediationPlan: { currentRound: 1, retryHistory: [{ round: 1, retryMetadata: {
    code: 'infrastructure-refund', harnessSpecific: true, workerClass: 'codex',
  } }] } };
  const args = { primary: 'codex', fallbackWorkerClasses: ['claude-code'], job, execFileImpl: null, env: {} };
  const routing = await resolveRemediationWorkerClassWithFallback(args);
  assert.equal(routing.workerClass, 'claude-code');
  assert.equal(routing.fellBack, true);
  const refused = await resolveRemediationWorkerClassWithFallback({ ...args, reviewerModels: ['claude'] });
  assert.equal(refused.workerClass, 'codex');
  assert.equal(refused.hold, false);
  assert.equal(refused.fellBack, false);
  assert.equal(refused.skipped[0].reason, 'reviews-next-round:claude');
  const empty = await resolveRemediationWorkerClassWithFallback({ ...args, fallbackWorkerClasses: [] });
  assert.equal(empty.workerClass, 'codex');
  assert.equal(empty.hold, false);
  assert.equal(empty.fellBack, false);
});

test('PR ledger retains the two refunds across jobs and counts published rounds separately', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remrefund-ledger-'));
  try {
    const dir = getFollowUpJobDir(rootDir, 'failed');
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const job = buildFollowUpJob({ repo: 'fixture/repo', prNumber: 1, critical: true,
        reviewerModel: 'claude', revisionRef: 'a', reviewBody: 'Fix.', reviewPostedAt: `2026-10-11T00:00:0${i}Z` });
      job.status = 'failed';
      job.failedAt = `2026-10-11T00:01:0${i}Z`;
      job.remediationWorker = { model: 'codex', state: 'failed' };
      job.remediationPlan.currentRound = i;
      job.remediationPlan.retryHistory = i <= 2 ? [{ round: i, requeuedAt: job.failedAt,
        retryMetadata: { code: 'infrastructure-refund' } }] : [];
      job.remediationPlan.rounds = [{ round: i, state: 'failed', startHeadSha: 'a',
        publishedHeadSha: i === 3 ? 'b' : null }];
      writeFileSync(join(dir, `${job.jobId}.json`), JSON.stringify(job));
    }
    const ledger = summarizePRRemediationLedger(rootDir, { repo: 'fixture/repo', prNumber: 1 });
    assert.equal(ledger.infrastructureRefundsForPR, 2);
    assert.equal(ledger.publishedRoundsForPR, 1);
    assert.equal(ledger.completedRoundsForPR, 3);
    assert.equal(infrastructureRefundReason({ outcome: { failureReason: 'publish-blocked' },
      startHead: 'a', endHead: 'a', refunds: ledger.infrastructureRefundsForPR }), null);
    assert.equal(summarizePRRemediationLedger(rootDir, { repo: 'fixture/repo', prNumber: 2 }).infrastructureRefundsForPR, 0);
    const body = buildRemediationOutcomeCommentBody({ action: 'stopped', workerClass: 'codex', job: {
      jobId: 'fixture', remediationPlan: { currentRound: 3, maxRounds: 3, publishedRoundsForPR: ledger.publishedRoundsForPR,
        stop: { code: 'max-rounds-reached' } },
    } });
    assert.match(body, /1 round published a commit/);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('failed infrastructure terminal events confirm HQ status before settling, including recovery', async () => {
  for (const outcome of [{ failureReason: 'publish-blocked' }, { exitCode: 137 }, { failureClass: 'boot-failure' }]) {
    const job = { remediationWorker: {
      dispatchMode: 'hq', dispatchId: 'fixture', launchRequestId: 'lrq_fixture', state: 'spawned',
    } };
    for (const status of ['running', 'failed']) {
      let polls = 0;
      const result = await assessWorkerLivenessDetailed(job, {
        workerTerminalEvent: { lrq: 'lrq_fixture', status: 'failed', recoveryAttempt: 1, ...outcome },
        execFileImpl: async () => {
          polls += 1;
          return { stdout: JSON.stringify({ status, ...outcome }) };
        },
      });
      assert.equal(polls, 1);
      assert.equal(result.state, status === 'running' ? 'active' : 'exited');
      assert.deepEqual(result.dispatchStatus, { status, health: null, ...outcome });
    }
  }
});

test('operator SIGTERM cancellation receipt and recorded 143 do not refund or requeue', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remrefund-cancel-'));
  try {
    createFollowUpJob({ rootDir, repo: 'fixture/repo', prNumber: 1, revisionRef: 'a'.repeat(40),
      reviewerModel: 'claude', reviewBody: 'Fix.', critical: true });
    const claimed = claimNextFollowUpJob({ rootDir });
    const child = new EventEmitter();
    const worker = { workerClass: 'codex', model: 'codex', processId: 1234, child };
    const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, worker });
    recordLocalRemediationOutcome({ rootDir, jobPath: spawned.jobPath, worker, log: { warn() {} } });
    const cancellation = await cancelFollowUpWorker({ rootDir, jobPath: spawned.jobPath,
      processKill: (_target, signal) => { if (signal === 'SIGTERM') child.emit('exit', null, signal); },
      execFileImpl: async () => { throw Object.assign(new Error('sandbox forbids ps'), { code: 'EPERM' }); },
    });
    assert.equal(cancellation.signalled, true);
    assert.equal(existsSync(cancellation.receiptPath), true);
    assert.equal(readFollowUpJob(spawned.jobPath).remediationWorker.recordedOutcome.exitCode, 143);
    const result = await reconcileFollowUpJob({ rootDir, jobPath: spawned.jobPath,
      job: readFollowUpJob(spawned.jobPath), isWorkerRunning: () => false,
      resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: 'a'.repeat(40) }),
      postCommentImpl: async () => ({ posted: false, error: 'offline fixture' }),
      log: { log() {}, warn() {}, error() {} },
    });
    assert.notEqual(result.action, 'requeued');
    assert.equal(summarizePRRemediationLedger(rootDir, result.job).infrastructureRefundsForPR, 0);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

for (const declined of ['cap-used', 'already-refunded', 'unknown-live-head']) {
  test(`declined infrastructure refund (${declined}) keeps HQ daemon-bounce transient retry`, async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'remrefund-transient-'));
    try {
      createFollowUpJob({ rootDir, repo: 'fixture/repo', prNumber: 1, revisionRef: 'a'.repeat(40),
        reviewerModel: 'claude', reviewBody: 'Fix.', critical: true });
      const claimed = claimNextFollowUpJob({ rootDir });
      const spawned = markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, worker: {
        workerClass: 'codex', model: 'codex', dispatchMode: 'hq', dispatchId: 'fixture', hqRoot: fixtureHqRoot,
      } });
      if (declined !== 'unknown-live-head') {
        spawned.job.remediationPlan.retryHistory = (declined === 'cap-used' ? [10, 11] : [1]).map((round) => ({
          round, requeuedAt: '2026-10-11T00:00:00Z', retryMetadata: { code: 'infrastructure-refund' },
        }));
        writeFileSync(spawned.jobPath, JSON.stringify(spawned.job));
      }
      const result = await reconcileFollowUpJob({ rootDir, jobPath: spawned.jobPath, job: spawned.job,
        execFileImpl: async (_cmd, args) => {
          assert.deepEqual(args.slice(0, 3), ['dispatch', 'status', 'fixture']);
          return { stdout: JSON.stringify({ status: 'failed', failureClass: 'daemon_bounced', exitCode: 143,
            failureReason: 'publish-blocked' }) };
        },
        resolvePRLifecycleImpl: async () => declined === 'unknown-live-head' ? null
          : { source: 'live', prState: 'open', headSha: 'a'.repeat(40) },
        postCommentImpl: async () => ({ posted: false, error: 'offline fixture' }),
        log: { log() {}, warn() {}, error() {} },
      });
      assert.equal(result.action, 'requeued');
      assert.equal(result.reason, 'hq-dispatch-transient');
      assert.equal(result.job.remediationPlan.transientRetries, 1);
      assert.notEqual(result.job.remediationPlan.retryHistory.at(-1).retryMetadata?.code, 'infrastructure-refund');
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  });
}

test('local boot and signal events are durable and cannot recreate a settled job', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remrefund-local-'));
  try {
    createFollowUpJob({ rootDir, repo: 'fixture/repo', prNumber: 1, reviewerModel: 'claude',
      revisionRef: 'a', critical: true, reviewBody: 'Fix.', reviewPostedAt: '2026-10-11T00:00:00Z' });
    const claimed = claimNextFollowUpJob({ rootDir });
    const child = new EventEmitter();
    const worker = { processId: 1234, model: 'codex', child };
    markFollowUpJobSpawned({ rootDir, jobPath: claimed.jobPath, worker });
    recordLocalRemediationOutcome({ rootDir, jobPath: claimed.jobPath, worker, log: { warn() {} } });
    child.emit('error', Object.assign(new Error('fixture executable unavailable'), { syscall: 'spawn fixture' }));
    assert.equal(readFollowUpJob(claimed.jobPath).remediationWorker.recordedOutcome.failureReason, 'boot-failed');
    child.emit('exit', null, 'SIGKILL');
    const recorded = readFollowUpJob(claimed.jobPath).remediationWorker.recordedOutcome;
    assert.equal(recorded.exitCode, 137);
    assert.equal(recorded.failureReason, 'boot-failed');
    recordLocalRemediationOutcome({ rootDir, jobPath: claimed.jobPath, worker, log: { warn() {} } });
    rmSync(claimed.jobPath);
    child.emit('exit', 143, null);
    assert.equal(existsSync(claimed.jobPath), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('errors after a successful spawn are not classified as boot failures', () => {
  assert.equal(localWorkerErrorOutcome({ processId: 1234 }, new Error('kill refused')).failureReason, 'worker-error');
  assert.equal(localWorkerErrorOutcome({ processId: null }, new Error('spawn refused')).failureReason, 'boot-failed');
});
