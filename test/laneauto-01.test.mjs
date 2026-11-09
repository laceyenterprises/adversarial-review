import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffFinalFixAll, finalFixAllQueueOwner } from '../src/ama/final-fix-all.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { claimNextFollowUpJob, createFollowUpJob, getFollowUpJobDir, listFollowUpJobsInDir } from '../src/follow-up-jobs.mjs';
import { remediationCloseout, closeoutRereview } from '../src/remediation-closeout.mjs';
import { deriveNextActionSnapshot } from '../src/pr-next-action.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';

const HEAD = 'a'.repeat(40), NEXT = 'b'.repeat(40), AT = '2026-01-01T00:00:00.000Z';
const BODY = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- Synthetic finding\n\n## Verdict\nComment only';
const CLEAN = BODY.replace('Synthetic finding', 'None.');
const quiet = { log() {}, warn() {}, error() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'laneauto-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let body = BODY, head = HEAD, reads = 0;
  const effects = [];
  const identity = { rootDir, repo: 'fixture/repo', prNumber: 5, headSha: HEAD, now: AT };
  const execFileImpl = async (_bin, args) => {
    reads++;
    return { stdout: JSON.stringify(args[0] === 'api' ? [[]] : {
      state: 'OPEN', headRefOid: head, headRefName: 'synthetic-branch', baseRefName: 'main',
      title: '[codex] Synthetic change', reviews: [{ body }], comments: [],
    }) };
  };
  const args = { rootDir, repoPath: identity.repo, prNumber: 5, currentRevisionRef: HEAD,
    reviewStateRow: { repo: identity.repo, pr_number: 5, pr_state: 'open', review_status: 'posted',
      reviewer: 'codex', reviewer_head_sha: HEAD, review_body: body, posted_at: AT },
    dispatchJob: { remediationStopCode: 'max-rounds-reached' }, labelNames: [],
    candidate: { headSha: HEAD, title: '[codex] Synthetic change', prState: 'OPEN',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    now: () => Date.parse(AT), logger: quiet, env: { ...process.env, HQ_ROOT: rootDir },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    fetchLatestHeadReviewBodiesImpl: async () => [body], fetchMergedProtectiveDependentsImpl: async () => [],
    handoffFinalFixAllImpl: params => handoffFinalFixAll({ ...params, execFileImpl }),
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    observeClosureWaitImpl: async () => ({ exhausted: true, retryAfterMs: 30_000 }),
    runDaemonCleanMergeAttemptImpl: async () => { effects.push('daemon'); return { disposition: 'merged', merged: true }; },
    maybeDispatchAmaCloserImpl: async () => { effects.push('closer'); return { dispatched: true, reason: 'dispatched' }; },
  };
  return { rootDir, args, identity, effects, execFileImpl, reads: () => reads,
    review: (nextBody, nextHead = HEAD) => {
      body = nextBody; head = nextHead;
      args.candidate.headSha = nextHead; args.currentRevisionRef = nextHead;
      Object.assign(args.reviewStateRow, { reviewer_head_sha: nextHead, review_body: body });
    } };
}
function finish(f, job, outputHead = NEXT) {
  const bucket = job.status === 'in_progress' ? 'inProgress' : 'pending';
  const old = join(getFollowUpJobDir(f.rootDir, bucket), `${job.jobId}.json`);
  const completed = { ...job, status: 'completed', completion: { workerPushedHeadSha: outputHead } };
  writeFileSync(old, JSON.stringify(completed));
  const dir = getFollowUpJobDir(f.rootDir, 'completed');
  mkdirSync(dir, { recursive: true });
  renameSync(old, join(dir, `${job.jobId}.json`));
  return completed;
}

test('final-round non-blocking review enqueues one runnable fix-all and fences every closer', async t => {
  const f = fixture(t);
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(result.reason, 'final-fix-all-builder-remediation');
  assert.equal(result.nextAction.actor, 'remediator');
  assert.equal(result.nextAction.reason, 'final-fix-all');
  assert.deepEqual(f.effects, []);
  const [{ job }] = listFollowUpJobsInDir(f.rootDir, 'pending');
  assert.equal(job.reviewBody, BODY);
  assert.equal(job.closureHandoff.review, 'full');
  assert.equal(job.builderTag, 'codex');
  assert.equal(job.finalRound, undefined);
  assert.equal(job.remediationPlan.maxRounds, 1);
  const prompt = buildRemediationPrompt(job, { template: 'Synthetic template.', remediationReplyPath: join(f.rootDir, 'reply.json') });
  assert.match(prompt, /fix every finding/);
  assert.match(prompt, /fix this PR's own red checks/);
  // The pending receipt survives the ordinary liveness grace.
  f.args.now = () => Date.parse(AT) + 60 * 60 * 1000;
  const again = await maybeDispatchAmaClosureFor(f.args);
  assert.equal(again.nextAction.actor, 'remediator');
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 1);
  assert.deepEqual(f.effects, []);
  const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: AT });
  assert.equal(claimed.job.jobId, job.jobId);
  assert.equal(claimed.job.remediationPlan.currentRound, 1);
  assert.equal(finalFixAllQueueOwner(f.rootDir, f.identity).jobId, job.jobId);
});

for (const checks of ['green', 'pending']) test(`fix-all publication requires full re-review with ${checks} checks`, async t => {
  const f = fixture(t);
  await handoffFinalFixAll({ ...f.identity, reviewBody: BODY, execFileImpl: f.execFileImpl });
  const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: AT });
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'fixture/repo#5', head: HEAD, observedAt: AT,
    observations: { leases: { closer: null }, launches: { closer: null },
      policy: { autonomousMergeExecutionEnabled: true } } });
  const closeout = remediationCloseout({ rootDir: f.rootDir, job: claimed.job, snapshot,
    completedAt: AT, headSha: NEXT, workerPushedHeadSha: NEXT,
    lifecycle: { prState: 'OPEN', headSha: NEXT, mergeable: 'MERGEABLE' }, ciGate: { state: checks, headSha: NEXT } });
  assert.equal(closeout.snapshot.observations.remediation.value.fullReviewRequired, true);
  assert.equal(closeout.snapshot.observations.remediation.value.finalPush, undefined);
  assert.equal(closeoutRereview(closeout).requested, true);
  assert.equal(closeout.decision.action, checks === 'green' ? 'review' : 'wait-for-CI');
});

for (const clean of [true, false]) test(`re-review ${clean ? 'clean merges through daemon' : 'with findings falls back'}`, async t => {
  const f = fixture(t);
  await maybeDispatchAmaClosureFor(f.args);
  const [{ job }] = listFollowUpJobsInDir(f.rootDir, 'pending');
  finish(f, job);
  f.review(clean ? CLEAN : BODY, NEXT);
  await maybeDispatchAmaClosureFor(f.args);
  assert.deepEqual(f.effects, [clean ? 'daemon' : 'closer']);
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 0);
});

test('terminal receipt deduplicates a review edit at the same head without remote reads', async t => {
  const f = fixture(t);
  await handoffFinalFixAll({ ...f.identity, reviewBody: BODY, execFileImpl: f.execFileImpl });
  const [{ job }] = listFollowUpJobsInDir(f.rootDir, 'pending');
  finish(f, job, HEAD);
  const result = await handoffFinalFixAll({ ...f.identity, reviewBody: BODY + '\nEdited.',
    execFileImpl: () => assert.fail('durable receipt must precede remote reads') });
  assert.equal(result.action, 'fallback');
});

test('live closer and PR dispatch lock each prevent fix-all enqueue', async t => {
  const f = fixture(t);
  const release = tryAcquireCloserIntentLock(f.rootDir, f.identity);
  assert.equal((await handoffFinalFixAll({ ...f.identity, reviewBody: BODY })).reason, 'final-fix-all-owner-busy');
  release();
  acquireAmaCloserLease({ ...f.identity, watcherPid: process.pid });
  updateAmaCloserLease({ ...f.identity, status: 'dispatched', lrqId: 'synthetic-lrq' });
  const held = await handoffFinalFixAll({ ...f.identity, reviewBody: BODY });
  assert.equal(held.reason, 'final-fix-all-existing-owner');
  assert.equal(f.reads(), 0);
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 0);
});

test('existing remediation owner prevents another enqueue', async t => {
  const f = fixture(t);
  createFollowUpJob({ rootDir: f.rootDir, repo: f.identity.repo, prNumber: 5, revisionRef: HEAD,
    branch: 'synthetic-branch', reviewBody: BODY, reviewPostedAt: AT });
  const result = await handoffFinalFixAll({ ...f.identity, reviewBody: BODY });
  assert.equal(result.reason, 'final-fix-all-existing-owner');
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 1);
});

test('blocking final review preserves existing closure routing', async t => {
  const f = fixture(t);
  f.review(BODY.replace('- None.', '- [P1] Synthetic blocker').replace('Comment only', 'Request changes'));
  f.args.handoffFinalFixAllImpl = () => assert.fail('blocking review cannot enter fix-all lane');
  await maybeDispatchAmaClosureFor(f.args);
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 0);
  assert.ok(!f.effects.includes('daemon'));
});


test('concurrent enqueue attempts and review edits keep one source-head receipt', async t => {
  const f = fixture(t);
  const results = await Promise.all([
    handoffFinalFixAll({ ...f.identity, reviewBody: BODY, execFileImpl: f.execFileImpl }),
    handoffFinalFixAll({ ...f.identity, reviewBody: BODY + '\nEdited.', execFileImpl: f.execFileImpl }),
  ]);
  assert.equal(results.filter(result => result.remediation).length, 1);
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 1);
});

test('a moved or closed live head cannot enqueue the stale review', async t => {
  const f = fixture(t);
  f.review(BODY, NEXT);
  const result = await handoffFinalFixAll({ ...f.identity, reviewBody: BODY, execFileImpl: f.execFileImpl });
  assert.equal(result.action, 'none');
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 0);
});

for (const mode of ['not-final', 'disabled', 'stale-review', 'conflict']) test(`fix-all preserves ${mode} routing`, async t => {
  const f = fixture(t);
  if (mode === 'not-final') f.args.dispatchJob = {};
  if (mode === 'disabled') f.args.loadConfigImpl = () => ({ getMergeAuthorityConfig: () => ({ enabled: true, autonomousMergeExecutionEnabled: false }) });
  if (mode === 'stale-review') f.args.candidate.headSha = NEXT;
  if (mode === 'conflict') { f.args.candidate.mergeable = 'CONFLICTING'; f.args.candidate.mergeStateStatus = 'DIRTY'; }
  f.args.handoffFinalFixAllImpl = () => assert.fail('ineligible review cannot enter fix-all');
  await maybeDispatchAmaClosureFor(f.args);
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 0);
});


test('the one-round work order preserves critical risk classification', async t => {
  const f = fixture(t);
  await handoffFinalFixAll({ ...f.identity, reviewBody: BODY, riskClass: 'critical', execFileImpl: f.execFileImpl });
  const [{ job }] = listFollowUpJobsInDir(f.rootDir, 'pending');
  assert.equal(job.riskClass, 'critical');
  assert.equal(job.remediationPlan.maxRounds, 1);
  const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: AT });
  assert.equal(claimed.job.riskClass, 'critical');
  assert.equal(claimed.job.remediationPlan.maxRounds, 1);
});

test('final findings with the PR own red checks select builder fix-all', async t => {
  const f = fixture(t);
  f.args.candidate.statusCheckRollup[0].conclusion = 'FAILURE';
  await maybeDispatchAmaClosureFor(f.args);
  const [{ job }] = listFollowUpJobsInDir(f.rootDir, 'pending');
  assert.equal(job.closureHandoff.reason, 'final-fix-all');
  assert.deepEqual(f.effects, []);
});


test('remediation queued during live metadata reads wins the handoff', async t => {
  const f = fixture(t);
  let appeared = false;
  const result = await handoffFinalFixAll({ ...f.identity, reviewBody: BODY,
    execFileImpl: async (...args) => {
      if (!appeared) {
        appeared = true;
        createFollowUpJob({ rootDir: f.rootDir, repo: f.identity.repo, prNumber: 5, revisionRef: HEAD,
          branch: 'synthetic-branch', reviewBody: BODY, reviewPostedAt: AT });
      }
      return f.execFileImpl(...args);
    } });
  assert.equal(result.reason, 'final-fix-all-existing-owner');
  assert.equal(listFollowUpJobsInDir(f.rootDir, 'pending').length, 1);
});
