import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { buildFollowUpJob, readFollowUpJob, requeueFollowUpJobForNextRound,
  writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { tryRetriggerRemediationFromLabel } from '../src/follow-up-retrigger-label.mjs';
import { matrixPair, HEAD } from './helpers/next-action-matrix.mjs';

function scratch(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammernolaunch-01-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('Phase 0: conflict-rebase requested confirms watcher delivery without executing a closer', t => {
  const rootDir = scratch(t);
  const shared = matrixPair({ pr: { state: 'OPEN', headSha: HEAD, mergeable: 'CONFLICTING' } });
  assert.equal(shared.decision.reason, 'conflict-rebase');
  assert.equal(shared.decision.deadline.budgetMs, 300000);
  const deliveries = [];
  const wake = requestEligibleHammerWake({ rootDir, repo: 'subject-07', prNumber: 7,
    headSha: HEAD, shared, log: { log() {}, warn() {} },
    requestWatcherWakeImpl: args => {
      deliveries.push(args);
      return { requested: true, payload: { request_id: 'synthetic-wake' } };
    } });
  assert.equal(wake.outcome, 'requested');
  assert.equal(deliveries.length, 1);
  const audit = JSON.parse(readFileSync(wake.auditPath, 'utf8'));
  assert.equal(audit.outcome, 'requested');
  assert.equal(audit.requestId, 'synthetic-wake');
  assert.equal(audit.launchRequestId, undefined, 'a wake acknowledgement is not a launch receipt');
});

function seedStoppedFinalRound(rootDir) {
  const job = buildFollowUpJob({ repo: 'fixture/project', prNumber: 42,
    branch: 'synthetic/topic', revisionRef: HEAD, reviewerModel: 'codex',
    reviewBody: '## Blocking issues\n- None.\n## Non-blocking issues\n- Clarify a timestamp.\n## Verdict\nComment only',
    maxRemediationRounds: 2 });
  Object.assign(job, { status: 'stopped', finalRound: 'comment-only',
    stoppedAt: '2026-11-15T01:58:04Z',
    reReview: { requested: false, suppressed: 'comment-only-final-round' } });
  Object.assign(job.remediationPlan, { currentRound: 2, maxRounds: 2,
    stop: { code: 'max-rounds-reached', reason: 'Reached max remediation rounds (2/2).' } });
  const jobPath = join(rootDir, 'data/follow-up-jobs/stopped', `${job.jobId}.json`);
  writeFollowUpJob(jobPath, job);
  return { job, jobPath };
}

test('Phase 0: the supplied stopped final-round shape DOES requeue after an operator budget bump', async t => {
  const rootDir = scratch(t);
  seedStoppedFinalRound(rootDir);
  const rows = [];
  const result = await tryRetriggerRemediationFromLabel({ rootDir, repo: 'fixture/project',
    prNumber: 42, revisionRef: HEAD,
    labelEvent: { id: 'synthetic-label', actor: 'synthetic-operator', headSha: HEAD },
    now: () => '2026-11-15T02:36:52Z',
    execFileImpl: async () => ({ stdout: '', stderr: '' }),
    appendAuditRow: (_root, row) => rows.push(row), findAuditRow: () => null });
  assert.equal(result.outcome, 'bumped-and-requeued', JSON.stringify(result));
  const pending = readFollowUpJob(result.jobPath);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.remediationPlan.maxRounds, 3);
  assert.equal(pending.remediationPlan.nextAction.round, 3);
  assert.equal(rows.at(-1).outcome, 'bumped-and-requeued');
});

test('Phase 0: completed final rounds deliberately refuse requeue with the hammer ownership reason', t => {
  const rootDir = scratch(t);
  const { job, jobPath } = seedStoppedFinalRound(rootDir);
  job.status = 'completed';
  job.remediationPlan.maxRounds = 3;
  const completedPath = join(rootDir, 'data/follow-up-jobs/completed', `${job.jobId}.json`);
  writeFollowUpJob(completedPath, job);
  rmSync(jobPath);
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir, jobPath: completedPath, revisionRef: HEAD }),
    /completed:comment-only-final-round; ownership belongs to the hammer/);
});
