import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';
import { remediationCloseout, closeoutRereview } from '../src/remediation-closeout.mjs';
import { completeWorkerPublishedHead } from '../src/remediation-published-head.mjs';
import { deriveNextActionSnapshot } from '../src/pr-next-action.mjs';
import { resolveSharedNextAction } from '../src/pr-next-action-shadow.mjs';
import { findFinalRemediationPushJob } from '../src/comment-only-final-round.mjs';
import { resolveFirstPassReviewBudgetSuppression } from '../src/first-pass-review-suppression.mjs';
import { deliveryLockPath } from '../src/adapters/comms/github-pr-comments/comment-delivery.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-record-read.mjs';
import { guardRereviewCiBeforeReviewer } from '../src/reviewer-ci-admission.mjs';
import { requeueFollowUpJobForNextRound } from '../src/follow-up-jobs.mjs';

const OLD = 'a'.repeat(40), HEAD = 'b'.repeat(40), OTHER = 'c'.repeat(40);
const AT = '2026-01-01T00:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {} };
const body = '## Blocking issues\n- None.\n\n## Non-blocking issues\n- Synthetic finding\n\n## Verdict\nComment only';
function fixture(t, finalRound = null) {
  const rootDir = mkdtempSync(join(tmpdir(), 'nxa-closeout-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const workspaceDir = join(rootDir, 'workspace');
  mkdirSync(join(workspaceDir, '.git'), { recursive: true });
  const job = { schemaVersion: 2, jobId: 'subject-04-pr-4-round', repo: 'subject-04', prNumber: 4,
    revisionRef: OLD, status: 'in_progress', workspaceDir, reviewBody: body,
    ...(finalRound ? { finalRound } : {}),
    remediationWorker: { state: 'spawned', model: 'codex', spawnedAt: AT },
    remediationPlan: { currentRound: 2, maxRounds: 2, rounds: [
      { round: 2, state: 'spawned', startHeadSha: OLD, spawnedAt: AT } ] } };
  const jobPath = join(rootDir, 'data', 'follow-up-jobs', 'in-progress', `${job.jobId}.json`);
  mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'in-progress'), { recursive: true });
  writeFileSync(jobPath, JSON.stringify(job));
  const snapshot = deriveNextActionSnapshot({ subjectKey: 'subject-04', head: HEAD, observedAt: AT,
    observations: { policy: { autonomousMergeExecutionEnabled: true, strictMode: true },
      leases: { closer: null }, launches: { closer: null } } });
  const decide = (options = {}) => remediationCloseout({ rootDir, job, snapshot,
    completedAt: AT, headSha: HEAD, workerPushedHeadSha: HEAD,
    ciGate: { state: 'green', headSha: HEAD }, ...options });
  const effects = [];
  const complete = (options = {}) => completeWorkerPublishedHead({ rootDir, jobPath, headSha: HEAD,
    completedAt: AT, snapshot, ciGate: { state: 'green', headSha: HEAD },
    execFileSyncImpl: () => `${HEAD}\nSynthetic commit\n\nWorker-Job-Id: ${job.jobId}\n`,
    requestReviewRereviewImpl: () => { effects.push('review'); return { triggered: true, status: 'pending' }; },
    requestRereviewWakeImpl: () => { effects.push('rereview-wake'); return {
      requested: true, wakeReason: 'remediation-closeout', outcome: 'requested' }; },
    requestWatcherWakeImpl: () => { effects.push('watcher-wake'); return { requested: true }; }, ...options });
  return { rootDir, job, jobPath, snapshot, decide, complete, effects };
}

for (const finalRound of [null, 'comment-only']) {
  for (const state of ['pending', 'green', 'failed', 'runnerless']) {
    test(`recovered final push: ${finalRound || 'blocking'} / ${state}`, t => {
      const f = fixture(t, finalRound);
      if (!finalRound) {
        f.job.reviewBody = body.replace('Comment only', 'Request changes').replace('- None.', '- Synthetic blocking finding');
        writeFileSync(f.jobPath, JSON.stringify(f.job));
      }
      const ciGate = { headSha: HEAD, state: state === 'runnerless' ? 'failed' : state,
        ...(state === 'runnerless' ? { runnerless: [{}] } : {}) };
      const result = f.complete({ ciGate });
      const next = result.job.reReview.nextAction;
      assert.equal(result.job.status, 'completed');
      assert.equal(next.action, state === 'pending' ? 'wait-for-CI' : 'hammer');
      assert.equal(next.actor, state === 'pending' ? 'ci' : 'hammer');
      assert.ok(next.deadline.at.endsWith('Z'));
      assert.equal(next.deadline.anchoredAt, AT);
      assert.equal(result.job.completion.workerPushedHeadSha, HEAD);
      assert.equal(result.job.completion.finalRemediationPush, true);
      assert.equal(result.job.remediationPlan.currentRound, 2);
      assert.equal(result.job.remediationPlan.maxRounds, 2);
      assert.deepEqual(result.job.remediationPlan.rounds[0].reReview, result.job.reReview);
      assert.ok(result.job.commentDelivery.body.includes("**Owner:** `" + next.actor + "`"));
      assert.ok(result.job.commentDelivery.body.includes(next.deadline.at));
      assert.ok(findFinalRemediationPushJob(f.rootDir, { repo: f.job.repo, prNumber: 4, headSha: HEAD }));
      assert.equal(findFinalRemediationPushJob(f.rootDir, { repo: f.job.repo, prNumber: 4, headSha: OTHER }), null);
      assert.deepEqual(f.effects, ['watcher-wake']);
      assert.equal(f.complete(), null, 'a second sweep cannot duplicate rereview or wake');
      assert.deepEqual(f.effects, ['watcher-wake']);
    });
  }
}

for (const state of ['green', 'failed']) test(`pending final push redecides on ${state} without another round`, async t => {
  const f = fixture(t);
  const result = f.complete({ ciGate: { headSha: HEAD, state: 'pending' } });
  const initial = result.job.reReview.nextAction;
  const shared = f.decide({ job: result.job, completedAt: '2026-01-01T01:00:00.000Z', ciGate: { headSha: HEAD, state } });
  assert.equal(shared.decision.action, 'hammer');
  assert.equal(shared.decision.deadline.anchoredAt, initial.deadline.anchoredAt);
  assert.equal((await resolveSharedNextAction({ snapshot: shared.snapshot })).decision.decisionKey, shared.decision.decisionKey);
  assert.equal(result.job.remediationPlan.currentRound, 2);
  if (state === 'failed') {
    const repair = await guardRereviewCiBeforeReviewer({ rootDir: f.rootDir, repo: f.job.repo, prNumber: 4,
      passKind: 'rereview', reviewerHeadSha: HEAD, inspectCiImpl: async () => ({ headSha: HEAD, state: 'failed' }),
      log: quiet, deliverAlertImpl: async () => { throw new Error('unexpected alert'); } });
    assert.equal(repair.reason, 'ci-regression-hammer-owned');
    assert.equal(JSON.parse(readFileSync(result.jobPath, 'utf8')).status, 'completed');
    assert.throws(() => requeueFollowUpJobForNextRound({ rootDir: f.rootDir, jobPath: result.jobPath }), /ownership belongs to the hammer/);
  }
});

test('unproven or unrelated push goes to exact-head review; no push grants no final-push proof', t => {
  const f = fixture(t);
  for (const workerPushedHeadSha of [null, OLD, OTHER]) {
    const shared = f.decide({ workerPushedHeadSha });
    assert.equal(shared.decision.action, 'review');
    assert.equal(closeoutRereview(shared).requested, true);
    assert.equal(shared.snapshot.observations.remediation.value.finalPush, undefined);
  }
  const noPush = f.decide({ headSha: OLD, workerPushedHeadSha: null, ciGate: { headSha: OLD, state: 'green' } });
  assert.notEqual(noPush.decision.reason, 'suppressed-final-push');
});

test('missing head and unreadable checks retain an observer without throwing', t => {
  const f = fixture(t);
  const shared = remediationCloseout({ rootDir: f.rootDir, job: { ...f.job, revisionRef: null },
    completedAt: AT, ciGate: null, snapshot: deriveNextActionSnapshot({ observedAt: AT, observations: {
      policy: { autonomousMergeExecutionEnabled: true }, leases: { closer: null }, launches: { closer: null } } }) });
  assert.equal(shared.decision.action, 'wait-for-CI');
  assert.equal(shared.decision.actor, 'watcher');
  assert.equal(shared.decision.reason, 'pr-unknown');
  assert.equal(shared.snapshot.observations.checks.provenance.readState, 'unknown');
});

test('delivery contention changes no records; retry retains one successor and one wake', t => {
  const f = fixture(t);
  const path = join(f.rootDir, 'data', 'follow-up-jobs', 'completed', `${f.job.jobId}.json`);
  mkdirSync(join(f.rootDir, 'data', 'follow-up-jobs', 'completed'), { recursive: true });
  writeFileSync(deliveryLockPath(path), JSON.stringify({ claimer: 'synthetic-claim', claimedAt: new Date().toISOString() }));
  const before = readFileSync(f.jobPath, 'utf8');
  assert.equal(f.complete().reason, 'delivery-claim-held');
  assert.equal(readFileSync(f.jobPath, 'utf8'), before);
  assert.deepEqual(f.effects, []);
  rmSync(deliveryLockPath(path));
  assert.equal(f.complete().job.reReview.nextAction.actor, 'hammer');
  assert.deepEqual(f.effects, ['watcher-wake']);
});

for (const state of ['pending', 'unknown']) {
  for (const settled of ['green', 'failed']) test(`recovered non-final ${state} CI retains admission through ${settled}`, async t => {
    const f = fixture(t);
    f.job.remediationPlan.currentRound = 1;
    f.job.remediationPlan.rounds[0].round = 1;
    writeFileSync(f.jobPath, JSON.stringify(f.job));
    const result = f.complete({ ciGate: { headSha: HEAD, state } });
    assert.equal(result.job.reReview.requested, true);
    assert.equal(result.job.reReview.nextAction.action, 'wait-for-CI');
    assert.equal(result.job.remediationPlan.currentRound, 1);
    assert.deepEqual(f.effects, ['review', 'rereview-wake']);
    assert.deepEqual(JSON.parse(readFileSync(result.jobPath, 'utf8')).reReview, result.job.reReview);
    const admit = state => guardRereviewCiBeforeReviewer({ rootDir: f.rootDir, repo: f.job.repo, prNumber: 4,
      passKind: 'rereview', reviewerHeadSha: HEAD, log: quiet,
      inspectCiImpl: async () => ({ headSha: HEAD, state,
        failedChecks: state === 'failed' ? [{ name: 'unit', state: 'FAILURE' }] : [] }) });
    assert.equal((await admit(state)).proceed, false);
    const after = await admit(settled);
    if (settled === 'green') assert.equal(after.proceed, true);
    else {
      assert.equal(after.reason, 'ci-regression-requeued');
      assert.equal(after.job.status, 'pending');
    }
  });
}

test('recovered non-final failed CI registers admission for the remaining remediation round', async t => {
  const f = fixture(t);
  f.job.remediationPlan.currentRound = 1;
  f.job.remediationPlan.rounds[0].round = 1;
  writeFileSync(f.jobPath, JSON.stringify(f.job));
  const result = f.complete({ ciGate: { headSha: HEAD, state: 'failed' } });
  assert.equal(result.job.reReview.requested, true);
  assert.equal(result.job.reReview.nextAction.action, 'remediate');
  assert.deepEqual(f.effects, ['review', 'rereview-wake']);
  const admission = await guardRereviewCiBeforeReviewer({ rootDir: f.rootDir, repo: f.job.repo, prNumber: 4,
    passKind: 'rereview', reviewerHeadSha: HEAD, log: quiet,
    inspectCiImpl: async () => ({ headSha: HEAD, state: 'failed',
      failedChecks: [{ name: 'unit', state: 'FAILURE' }] }) });
  assert.equal(admission.proceed, false);
  assert.equal(admission.reason, 'ci-regression-requeued');
  assert.equal(admission.job.status, 'pending');
});

for (const reason of ['review-row-missing', 'malformed-title-terminal', 'pr-not-open']) {
  test(`a refused recovery rereview retains one recovery owner: ${reason}`, t => {
    const f = fixture(t);
    f.job.remediationPlan.currentRound = 1;
    f.job.remediationPlan.rounds[0].round = 1;
    writeFileSync(f.jobPath, JSON.stringify(f.job));
    const result = f.complete({ requestReviewRereviewImpl: () => ({ status: 'blocked', reason }) });
    assert.equal(result.job.reReview.status, 'blocked');
    assert.equal(result.job.reReview.nextAction.actor, 'closure-recovery');
    assert.equal(result.job.reReview.nextAction.reason, 'automated-stop');
    assert.equal(result.job.reReview.nextAction.deadline.anchoredAt, AT);
    const persisted = JSON.parse(readFileSync(result.jobPath, 'utf8'));
    assert.deepEqual(persisted.reReview, result.job.reReview);
    assert.deepEqual(persisted.remediationPlan.rounds[0].reReview, result.job.reReview);
    assert.ok(persisted.commentDelivery.body.includes('closure-recovery'));
    assert.equal(f.complete(), null, 'a later sweep preserves the durable refusal');
    assert.deepEqual(f.effects, []);
  });
}

test('only the bound final push suppresses the otherwise owed last review', t => {
  const f = fixture(t);
  f.complete();
  const budget = headSha => resolveFirstPassReviewBudgetSuppression({ rootDir: f.rootDir, repoPath: f.job.repo,
    prNumber: 4, currentHeadSha: headSha, reviewRow: { reviewer_head_sha: OLD, review_status: 'posted', posted_at: AT },
    summarizePRRemediationLedgerImpl: () => ({ completedRoundsForPR: 2, latestMaxRounds: 2,
      completedRoundTimestamps: [{ round: 2, terminalAt: AT }] }),
    resolveRoundBudgetForJobImpl: () => ({ roundBudget: 2 }), countCompletedReviewerRereviewRoundsImpl: () => 0,
    hasCompletedReviewerRereviewAfterImpl: () => false, logger: quiet });
  assert.equal(budget(HEAD).suppressed, true);
  assert.equal(budget(HEAD).nextAction.actor, 'hammer');
  assert.equal(budget(OTHER).suppressed, false);
});

for (const malformed of [false, true]) test(`retained receipt never licenses speculative rereview (malformed=${malformed})`, t => {
  const f = fixture(t);
  f.job.remediationPlan.currentRound = 1;
  const path = amaCloserDispatchFilePath(f.rootDir, { ...f.job, headSha: HEAD });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, malformed ? '{' : JSON.stringify({ launchRequestId: 'synthetic-attempt', state: 'dispatched' }));
  const snapshot = deriveNextActionSnapshot({ observations: { policy: { autonomousMergeExecutionEnabled: true },
    leases: { closer: null } } });
  const shared = f.decide({ snapshot });
  assert.equal(shared.decision.reason, 'ownership-unreadable');
  assert.equal(shared.decision.actor, 'closure-recovery');
  assert.equal(closeoutRereview(shared).requested, false);
  assert.ok(Object.isFrozen(shared.snapshot.observations));
});

for (const [observations, expected] of [
  [{ policy: { autonomousMergeExecutionEnabled: false } }, ['operator-hold', 'operator', 'merge-execution-disabled']],
  [{ pr: { state: 'MERGED' } }, ['done', 'none', 'merged']],
  [{ controls: { safetyRefusal: { deterministic: true } }, pr: { state: 'OPEN', mergeStateStatus: 'DIRTY' } },
    ['hammer', 'closure-recovery', 'safety-refusal']],
  [{ leases: { closer: { headSha: HEAD, status: 'terminal', terminalOutcome: 'succeeded' } } },
    ['hammer', 'closure-recovery', 'merge-receipt-unconfirmed']],
]) test(`closeout retains shared priority: ${expected[2]}`, t => {
  const f = fixture(t);
  const snapshot = deriveNextActionSnapshot({ base: f.snapshot, observations });
  const shared = f.decide({ snapshot });
  assert.deepEqual([shared.decision.action, shared.decision.actor, shared.decision.reason], expected);
  assert.equal(closeoutRereview(shared).requested, false);
});

for (const policy of [{ drain: { active: true } }, { capacity: { hammer: { inFlight: 1, cap: 1 } } }]) {
  test(`closeout retains queued intent under ${policy.drain ? 'drain' : 'capacity'}`, t => {
    const f = fixture(t);
    const snapshot = deriveNextActionSnapshot({ base: f.snapshot,
      observations: { policy: { autonomousMergeExecutionEnabled: true, ...policy } } });
    const shared = f.decide({ snapshot });
    assert.equal(shared.decision.action, 'hammer');
    assert.equal(shared.decision.reason, 'suppressed-final-push');
    assert.equal(shared.decision.queue.deferredBy, policy.drain ? 'drain' : 'capacity');
    assert.equal(shared.decision.deadline.anchoredAt, AT);
  });
}

for (const [finalRound, currentRound] of [[null, 2], ['comment-only', 2], [null, 1]]) {
  for (const state of (finalRound ? ['pending', 'green', 'failed'] : ['pending', 'green', 'failed', 'head-moved'])) test(`normal completion delegate: ${finalRound || 'blocking'} round ${currentRound} / ${state}`, async t => {
    const f = fixture(t, finalRound);
    f.job.remediationPlan.currentRound = currentRound;
    f.job.remediationPlan.rounds[0].round = currentRound;
    const workspace = f.job.workspaceDir;
    const git = (...args) => execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
        GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' } }).trim();
    git('init', '-q', '-b', 'main');
    writeFileSync(join(workspace, 'sample.txt'), 'before\n');
    git('add', 'sample.txt'); git('commit', '-q', '-m', 'Synthetic reviewed change');
    f.job.revisionRef = git('rev-parse', 'HEAD');
    f.job.remediationPlan.rounds[0].startHeadSha = f.job.revisionRef;
    git('update-ref', 'refs/remotes/origin/main', f.job.revisionRef);
    writeFileSync(join(workspace, 'sample.txt'), 'after\n');
    git('add', 'sample.txt'); git('commit', '-q', '-m', `Synthetic repair\n\nWorker-Job-Id: ${f.job.jobId}`);
    const head = git('rev-parse', 'HEAD');
    f.job.baseBranch = 'main';
    f.job.workspaceDir = 'workspace';
    f.job.reviewBody = body.replace('- Synthetic finding', '- None.');
    f.job.branch = 'synthetic';
    const outputPath = join(workspace, 'result.md');
    const replyPath = join(process.env.HQ_ROOT, 'dispatch', 'remediation-replies', f.job.jobId, 'remediation-reply.json');
    mkdirSync(join(process.env.HQ_ROOT, 'dispatch', 'remediation-replies', f.job.jobId), { recursive: true });
    writeFileSync(outputPath, 'Synthetic work completed.');
    writeFileSync(replyPath, JSON.stringify({ kind: 'adversarial-review-remediation-reply', schemaVersion: 1,
      jobId: f.job.jobId, repo: f.job.repo, prNumber: 4, outcome: 'completed', summary: 'Synthetic repair.',
      validation: ['Synthetic validation.'], addressed: [], pushback: [], blockers: [],
      reReview: { requested: !finalRound, reason: 'Synthetic completion.' } }));
    f.job.remediationWorker = { ...f.job.remediationWorker, processId: 98765,
      outputPath: 'workspace/result.md', replyPath, logPath: 'workspace/worker.log' };
    f.job.remediationReply = { path: replyPath };
    writeFileSync(f.jobPath, JSON.stringify(f.job));
    let lifecycleReads = 0;
    const result = await reconcileFollowUpJob({ rootDir: f.rootDir, jobPath: f.jobPath,
      now: () => AT, isProcessAliveImpl: () => false,
      resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open',
        headSha: state === 'head-moved' && ++lifecycleReads > 1 ? OTHER : head }),
      auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
      inspectRemediationCiRegressionImpl: async () => ({ headSha: head, state: state === 'head-moved' ? 'green' : state }),
      requestReviewRereviewImpl: () => { f.effects.push('review'); return { triggered: true, status: 'pending' }; },
      requestRereviewWakeImpl: ({ headSha }) => {
        assert.equal(headSha, state === 'head-moved' ? OTHER : head);
        f.effects.push('rereview-wake');
        return { requested: true };
      },
      requestWatcherWakeImpl: () => { f.effects.push('watcher-wake'); return { requested: true }; },
      postCommentImpl: async () => ({ posted: false, reason: 'synthetic-delivery-retry' }),
      deliverAlertImpl: async () => { throw new Error('unexpected alert'); },
      execFileImpl: async (command, args) => {
        if (command === 'git') return { stdout: execFileSync(command, args, { encoding: 'utf8', timeout: 5000 }) };
        if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return { stdout: args.includes('--jq') ? head : JSON.stringify({ headRefOid: head }) };
        }
        throw new Error('unexpected external boundary');
      },
    });
    assert.equal(result.outcome, 'completed', JSON.stringify(result.job.failure || result.reason));
    const next = result.job.reReview.nextAction;
    assert.equal(next.action, ['pending', 'head-moved'].includes(state) ? 'wait-for-CI'
      : currentRound === 1 ? state === 'failed' ? 'remediate' : 'review' : 'hammer');
    assert.equal(next.head, state === 'head-moved' ? OTHER : head);
    if (state === 'head-moved') {
      assert.equal(result.job.completion.finalRemediationPush, false);
      assert.equal(f.decide({ job: result.job, headSha: OTHER, workerPushedHeadSha: head,
        ciGate: { headSha: OTHER, state: 'green' } }).decision.action, 'review');
    }
    assert.equal(result.job.completion.workerPushedHeadSha, head);
    assert.equal(result.job.remediationPlan.currentRound, currentRound);
    assert.equal(result.job.remediationPlan.maxRounds, 2);
    assert.deepEqual(f.effects, currentRound === 1 ? ['review', 'rereview-wake'] : ['watcher-wake']);
    if (currentRound === 1) {
      assert.equal(result.job.reReview.wake.requested, true);
      assert.deepEqual(JSON.parse(readFileSync(result.jobPath, 'utf8')).reReview,
        JSON.parse(JSON.stringify(result.job.reReview)));
    }
  });
}
