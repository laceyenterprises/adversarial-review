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
  { failure_class: 'boot-failed' }, { exitCode: 143 }, { exit_code: 137 },
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
  for (const outcome of [{ failureDetail: 'publish-blocked' }, { exitCode: 1 }, null]) {
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
  const job = { remediationPlan: { retryHistory: [{ retryMetadata: {
    code: 'infrastructure-refund', harnessSpecific: true, workerClass: 'codex',
  } }] } };
  const args = { primary: 'codex', fallbackWorkerClasses: ['claude-code'], job, execFileImpl: null, env: {} };
  const routing = await resolveRemediationWorkerClassWithFallback(args);
  assert.equal(routing.workerClass, 'claude-code');
  assert.equal(routing.fellBack, true);
  const refused = await resolveRemediationWorkerClassWithFallback({ ...args, reviewerModels: ['claude'] });
  assert.equal(refused.hold, true);
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

test('matching infrastructure terminal events preserve reasons and signal exits without status polling', async () => {
  for (const outcome of [{ failureReason: 'publish-blocked' }, { exitCode: 137 }, { failureClass: 'boot-failure' }]) {
    const result = await assessWorkerLivenessDetailed({ remediationWorker: {
      dispatchMode: 'hq', dispatchId: 'fixture', launchRequestId: 'lrq_fixture', state: 'spawned',
    } }, { workerTerminalEvent: { lrq: 'lrq_fixture', status: 'failed', ...outcome },
      execFileImpl: async () => { throw new Error('unexpected status poll'); } });
    assert.equal(result.state, 'exited');
    assert.ok(infrastructureRefundReason({ outcome: result.dispatchStatus, startHead: 'a', endHead: 'a' }));
  }
});

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
