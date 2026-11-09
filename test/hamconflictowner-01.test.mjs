import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHammerStopHold } from '../src/ama/hammer-stop-hold.mjs';
import { handoffConflictPrimary } from '../src/ama/conflict-primary-handoff.mjs';
import { claimNextFollowUpJob, readFollowUpJob, getFollowUpJobDir, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { closureOwnerShadowEvidence } from '../src/pr-next-action-consumer.mjs';
import classifyRescue from '../src/merge-agent-rescue-classifier.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { remediationCloseout, closeoutRereview } from '../src/remediation-closeout.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamconflictowner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, hqRoot: rootDir, repo: 'fixture/repo', prNumber: 1, headSha: HEAD, now: AT };
  let reads = 0;
  const execFileImpl = async (bin, args) => {
    assert.equal(bin, 'gh');
    assert.deepEqual(args, ['pr', 'view', '1', '--repo', identity.repo,
      '--json', 'state,headRefOid,headRefName,baseRefName,title,reviews,comments']);
    reads++;
    return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: HEAD, headRefName: 'fixture-branch',
      baseRefName: 'main', title: '[codex] Fixture correction',
      reviews: [{ body: 'Synthetic open finding: preserve the new upstream default.' }],
      comments: [{ body: 'Synthetic inline context.' }] }) };
  };
  const args = { ...identity, execFileImpl, logger: quiet,
    prMetadata: { headSha: HEAD, isOpen: true, mergeableState: 'CONFLICTING' } };
  const stop = reason => ({ attempts: [{ path: 'hammer', outcome: 'failed-without-merge',
    head: HEAD, reason, startedAt: AT }] });
  return { rootDir, args, stop, reads: () => reads };
}

function shared() {
  const snapshot = deriveNextActionSnapshot({
    subjectKey: 'fixture/repo#1', head: HEAD, observedAt: AT,
    anchors: { firstActionableAt: AT },
    observations: {
      pr: { state: 'OPEN', headSha: HEAD, mergeable: 'CONFLICTING' },
      leases: { closer: null }, launches: { closer: null },
      reviews: { headSha: HEAD, verdict: 'comment-only',
        blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 1 },
      checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false },
      policy: { autonomousMergeExecutionEnabled: true },
    },
  });
  return { snapshot, decision: nextAction(snapshot) };
}

test('unproven stop queues one runnable builder-tag remediation and transfers the shared owner', async t => {
  const f = fixture(t);
  assert.equal(shared().decision.actor, 'hammer');
  const result = await evaluateHammerStopHold({ ...f.args, sharedNextAction: shared(),
    readAuditImpl: () => f.stop('conflict-primary-unproven') });
  assert.equal(result.action, 'hold');
  const jobPath = join(getFollowUpJobDir(f.rootDir, 'pending'), `${result.remediation.jobId}.json`);
  const job = readFollowUpJob(jobPath);
  assert.equal(job.repo, f.args.repo);
  assert.equal(job.prNumber, 1);
  assert.equal(job.revisionRef, HEAD);
  assert.equal(job.builderTag, 'codex');
  assert.equal(job.branch, 'fixture-branch');
  assert.equal(job.baseBranch, 'main');
  assert.equal(job.trigger.type, 'closer-terminal-audit');
  assert.deepEqual(job.closureHandoff, { reason: 'conflict-primary-unproven', headSha: HEAD, review: 'full',
    reviewContext: [{ body: 'Synthetic open finding: preserve the new upstream default.', url: null },
      { body: 'Synthetic inline context.', url: null }] });
  assert.match(job.reviewBody, /Rebase or merge onto the current base/);
  assert.match(job.reviewBody, /preserving both\s+sides/);
  assert.match(job.reviewBody, /address all open findings/);
  assert.match(job.reviewBody, /full-range validation/);
  assert.match(job.reviewBody, /normal full adversarial\s+review/);
  assert.equal(job.finalRound, undefined);
  assert.equal(job.nonBlockingOnly, false);
  const prompt = buildRemediationPrompt(job, { template: 'Synthetic remediation template.',
    remediationReplyPath: join(f.rootDir, 'reply.json') });
  assert.match(prompt, /Untrusted PR Review Context/);
  assert.match(prompt, /Synthetic open finding: preserve the new upstream default/);
  assert.match(prompt, /Synthetic inline context/);
  const decision = result.nextActionShared.decision;
  assert.equal(decision.action, 'remediate');
  assert.equal(decision.actor, 'remediator');
  assert.equal(decision.reason, 'conflict-primary-unproven');
  assert.equal(classifyRescue({ headSha: HEAD, sharedNextAction: result.nextActionShared }).decision,
    'remediation-eligible');
  const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: AT });
  assert.equal(claimed.job.jobId, job.jobId, 'normal queue claim must admit conflict remediation');
  assert.equal(claimed.job.status, 'in_progress');
  const repeated = await evaluateHammerStopHold({ ...f.args, sharedNextAction: shared(),
    readAuditImpl: () => f.stop('conflict-primary-unproven') });
  assert.equal(repeated.nextActionShared.decision.actor, 'remediator');
  assert.equal(repeated.nextActionShared.decision.reason, 'live-owner');
  // Even the final allowed push must return to normal full review, rather
  // than becoming the suppressed-final-push hammer shortcut.
  for (const state of ['green', 'pending']) {
    const closeout = remediationCloseout({ rootDir: f.rootDir,
      job: { ...claimed.job, remediationPlan: { ...claimed.job.remediationPlan,
        currentRound: claimed.job.remediationPlan.maxRounds } },
      snapshot: shared().snapshot, completedAt: AT, headSha: NEXT, workerPushedHeadSha: NEXT,
      lifecycle: { prState: 'OPEN', headSha: NEXT, mergeable: 'MERGEABLE' },
      ciGate: { state, headSha: NEXT } });
    assert.equal(closeout.snapshot.observations.remediation.value.finalPush, undefined);
    assert.equal(closeoutRereview(closeout).requested, true);
    assert.equal(closeout.decision.action, state === 'green' ? 'review' : 'wait-for-CI');
  }
});

test('repeated and concurrent stops on the same head deduplicate even after terminal settlement', async t => {
  const f = fixture(t);
  const args = { ...f.args, readAuditImpl: () => f.stop('conflict-primary-unproven') };
  const results = await Promise.all([evaluateHammerStopHold(args),
    evaluateHammerStopHold({ ...args, now: '2026-01-01T00:10:00.000Z' })]);
  assert.equal(results[0].remediation.jobId, results[1].remediation.jobId);
  const pending = getFollowUpJobDir(f.rootDir, 'pending');
  assert.equal(readdirSync(pending).length, 1);
  const pendingPath = join(pending, `${results[0].remediation.jobId}.json`);
  const original = readFollowUpJob(pendingPath);
  writeFollowUpJob(pendingPath, { ...original,
    reviewBody: original.reviewBody.replace('through builder remediation', 'through reviewed builder remediation') });
  const upper = await evaluateHammerStopHold({ ...args, headSha: HEAD.toUpperCase(),
    readAuditImpl: () => ({ attempts: [{ ...f.stop('conflict-primary-unproven').attempts[0],
      head: HEAD.toUpperCase() }] }) });
  assert.equal(upper.remediation.jobId, results[0].remediation.jobId);
  const stopped = getFollowUpJobDir(f.rootDir, 'stopped');
  mkdirSync(stopped, { recursive: true });
  writeFollowUpJob(pendingPath, { ...readFollowUpJob(pendingPath), status: 'stopped', stoppedAt: AT });
  renameSync(pendingPath,
    join(stopped, `${results[0].remediation.jobId}.json`));
  const again = await evaluateHammerStopHold(args);
  assert.equal(again.remediation.jobId, results[0].remediation.jobId);
  assert.equal(readdirSync(pending).length, 0);
  const archived = join(getFollowUpJobDir(f.rootDir, 'stoppedArchived'), '2026-01');
  mkdirSync(archived, { recursive: true });
  renameSync(join(stopped, `${again.remediation.jobId}.json`), join(archived, `${again.remediation.jobId}.json`));
  assert.equal((await evaluateHammerStopHold(args)).remediation.jobId, again.remediation.jobId);
  assert.equal(readdirSync(pending).length, 0);
});

test('the terminal audit writer feeds the production stop reader and durable queue handoff', async t => {
  const f = fixture(t);
  recordHammerEarlyFailure('conflict-primary-unproven', { env: {
    HAM_HQ_ROOT: f.rootDir, HAM_REPO: f.args.repo, HAM_PR_NUMBER: '1', HAM_REVIEWED_SHA: HEAD,
  } });
  const result = await evaluateHammerStopHold(f.args);
  assert.equal(result.action, 'hold');
  assert.equal(result.hammerStop.owner, 'remediator');
  assert.ok(result.remediation.jobId);
});

test('timeout keeps the existing conflicting-head retry and never reads or queues a handoff', async t => {
  const f = fixture(t);
  const result = await evaluateHammerStopHold({ ...f.args,
    readAuditImpl: () => f.stop('conflict-primary-timeout') });
  assert.equal(result.action, 'release');
  assert.ok(result.changed.includes('conflicting'));
  assert.equal(f.reads(), 0);
  assert.equal(result.remediation, undefined);
});

test('a successful replay has no handoff and leaves the existing closure path selected', async t => {
  const f = fixture(t);
  const result = await evaluateHammerStopHold({ ...f.args,
    readAuditImpl: () => ({ attempts: [{ path: 'hammer', outcome: 'succeeded', head: HEAD, startedAt: AT }] }) });
  assert.equal(result.action, 'none');
  assert.equal(f.reads(), 0);
});

test('unavailable provenance retains the stop; a moved or closed head cannot enqueue stale work', async t => {
  const f = fixture(t);
  const result = await evaluateHammerStopHold({ ...f.args,
    readAuditImpl: () => f.stop('conflict-primary-unproven'),
    execFileImpl: async () => { throw new Error('synthetic read failure'); } });
  assert.equal(result.action, 'hold');
  assert.equal(result.hammerStop.handoffPending, true);
  for (const pr of [{ state: 'OPEN', headRefOid: NEXT }, { state: 'CLOSED', headRefOid: HEAD }]) {
    const moved = await handoffConflictPrimary({ ...f.args,
      execFileImpl: async () => ({ stdout: JSON.stringify(pr) }),
      createJobImpl: () => assert.fail('must not enqueue stale work') });
    assert.equal(moved.action, 'none');
  }
});

test('persisted pending ownership survives admission delay and applies only to its exact head', () => {
  const snapshot = shared().snapshot;
  const job = { status: 'pending', jobId: 'fixture-remediation', revisionRef: HEAD, createdAt: AT,
    closureHandoff: { reason: 'conflict-primary-unproven', headSha: HEAD, review: 'full' } };
  const evidence = closureOwnerShadowEvidence({ repo: 'fixture/repo', prNumber: 1,
    currentHeadSha: HEAD, followUpJob: job });
  const projected = evidence.observations.remediation.job;
  assert.deepEqual(projected.closureHandoff, job.closureHandoff);
  const decide = (head = HEAD) => nextAction(deriveNextActionSnapshot({ base: snapshot,
    observedAt: '2026-01-01T01:00:00.000Z',
    observations: { remediation: { roundsLeft: false, job: { ...projected, headSha: head, live: false } } } }));
  assert.equal(decide().actor, 'remediator');
  assert.equal(decide().reason, 'conflict-primary-unproven');
  assert.notEqual(decide(NEXT).reason, 'conflict-primary-unproven');
});

test('a durable pending handoff retains ownership through a later GitHub outage', async t => {
  const f = fixture(t);
  const args = { ...f.args, readAuditImpl: () => f.stop('conflict-primary-unproven'),
    sharedNextAction: shared() };
  const first = await evaluateHammerStopHold(args);
  const repeated = await evaluateHammerStopHold({ ...args, now: '2026-01-01T01:00:00.000Z',
    execFileImpl: async () => assert.fail('existing ownership must not require another GitHub read') });
  assert.equal(repeated.remediation.jobId, first.remediation.jobId);
  assert.equal(repeated.nextActionShared.decision.actor, 'remediator');
  assert.equal(repeated.nextActionShared.decision.reason, 'conflict-primary-unproven');
  assert.equal(repeated.remediation.live, false, 'queued custody is not running-worker liveness');
});
