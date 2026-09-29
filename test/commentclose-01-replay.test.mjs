// COMMENTCLOSE-01 replay (SEV2 2026-09-28, "the comment-only fix rarely engages,
// and when it does the PR strands").
//
// Loads sanitized copies of the live job and remediation-reply records for
// agent-os#7311 and #7313 (test/fixtures/commentclose-01/) and replays them
// through the reconciler and the AMA closer:
//   - #7313: a clean comment-only final round pushed 6a9f27f0 over the reviewed
//     head b90d1471. Production parked it at AWAIT_OPERATOR_ACTION after four
//     `stale-review-head` retains. It must now go to hammer terminal validation.
//   - #7311: the final round pushed c1bc5316 (a rebase: GitHub compare reports
//     ahead 4 / behind 2) and reported one pending-PR-head-CI operational
//     blocker. Production filed it `stopped/max-rounds-reached` without the
//     pushed head, and gemini reviewed c1bc5316 as Request changes 12 minutes
//     later. The pushed head must now be recorded and never re-reviewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/ama-closure-orchestration.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { isTerminalCloserCommitIdentity } from '../src/head-closer-commit-suppression.mjs';
import { proveCommentOnlyFinalRoundHead } from '../src/comment-only-final-round.mjs';
import {
  claimNextFollowUpJob,
  getFollowUpJobDir,
  markFollowUpJobSpawned,
  summarizePRRemediationLedger,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob, resolveHqReplyPath } from '../src/follow-up-remediation.mjs';
import { requestReviewRereview } from '../src/review-state.mjs';
import { __test__ as reviewerInternals } from '../src/reviewer.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'commentclose-01');
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const silent = { log() {}, info() {}, warn() {}, error() {} };

function tempRoot(t, label) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `commentclose-${label}-`));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

// ── #7313: a proven final-round push reaches hammer terminal validation ────────

const PR_7313_REVIEWED = 'b90d1471efebe965b5c15d3cf975f93078c4ee99';
const PR_7313_PUSHED = '6a9f27f04fedeb533b291610b2c9dcc6300f13e1';

test('replay #7313: the proven final-round push goes to hammer terminal validation, not AWAIT_OPERATOR_ACTION', async (t) => {
  const rootDir = tempRoot(t, '7313');
  const job = fixture('pr-7313-final-round-job.json');
  delete job._fixture;
  assert.equal(job.status, 'completed');
  assert.equal(job.revisionRef, PR_7313_REVIEWED);
  assert.equal(job.completion.workerPushedHeadSha, PR_7313_PUSHED);
  const completedDir = getFollowUpJobDir(rootDir, 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFollowUpJob(path.join(completedDir, `${job.jobId}.json`), job);

  const reply = fixture('pr-7313-remediation-reply.json');
  const greenRollup = reply.validation
    .filter((line) => /release-freeze-gate, repo-guards, and submodule-pointer-gate all passed/.test(line))
    .flatMap(() => ['release-freeze-gate', 'repo-guards', 'submodule-pointer-gate'])
    .map((name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
  assert.equal(greenRollup.length, 3, 'the worker reported green PR-head CI for #7313');

  const cfg = {
    enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
    eligibility: { riskClasses: ['low', 'medium'], highRiskRequiresTwoKey: false },
    branchProtection: { required: false },
  };
  const liveReviewHeads = [];
  const execCalls = [];
  const closerPayloads = [];
  const daemonOutcomes = [];
  const stubs = {
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => cfg, get: (_key, fallback) => fallback }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => {
      liveReviewHeads.push(head);
      return head === PR_7313_REVIEWED ? [job.reviewBody] : [];
    },
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    // The real daemon clean-merge lane must decline: the head carries no HAM
    // terminal-validation audit, and a remediation worker's commit is not a
    // terminal-closer commit, so nothing certifies it for merge.
    runDaemonCleanMergeAttemptImpl: async (args) => {
      assert.equal(args.gateSnapshot.reviewedHeadSha, PR_7313_REVIEWED);
      assert.equal(args.currentPrHeadSha, PR_7313_PUSHED);
      const daemon = await runDaemonCleanMergeAttempt({
        ...args,
        candidate: { ...args.candidate, baseBranch: 'main' },
        env: { HQ_ROOT: rootDir },
        headHasValidatedHamTerminalRemediationImpl: () => false,
        resolveHeadCloserCommitSuppressionImpl: async () => isTerminalCloserCommitIdentity({
          message: `Remove the ambiguous status timestamp\n\nWorker-Job-Id: ${job.jobId}\n`,
          committer: { login: 'lacey-codex-agent[bot]' },
        }),
        fetchRollupImpl: async () => { throw new Error('the daemon must decline before reading the live rollup'); },
        attemptDaemonCleanMergeImpl: async () => { throw new Error('the daemon must not merge a final-round head'); },
      });
      daemonOutcomes.push(daemon);
      return daemon;
    },
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    // GitHub compare for #7313 reports `ahead` (ahead 1 / behind 0).
    proveCommentOnlyFinalRoundHeadImpl: (args) => proveCommentOnlyFinalRoundHead({
      ...args, execFileImpl: async () => ({ stdout: 'ahead\n' }),
    }),
    maybeDispatchAmaCloserImpl: (args) => {
      closerPayloads.push(args);
      return maybeDispatchAmaCloser({
        ...args,
        dispatchContext: {
          ...args.dispatchContext, rootDir, hqRoot: path.join(rootDir, 'hq-root'),
          hqOwnerUser: userInfo().username, currentUser: userInfo().username,
        },
        execFileImpl: async (cmd, argv) => {
          execCalls.push({ cmd, argv });
          return { stdout: JSON.stringify({ dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer_7313' }), stderr: '' };
        },
        readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
        writeFileImpl: () => {},
        resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
        readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
        readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
        logger: silent,
      });
    },
  };

  const outcome = await resolveMergeAgentCoexistenceForWatcher({
    rootDir,
    reviewStateRow: {
      repo: job.repo, pr_number: job.prNumber, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: job.riskClass, remediation_pending: 0,
      reviewer: job.reviewerModel, reviewer_head_sha: PR_7313_REVIEWED, posted_at: job.trigger.postedAt,
    },
    dispatchJob: {},
    candidate: {
      headSha: PR_7313_PUSHED, riskClass: job.riskClass, prState: 'open', prAuthor: 'claude-code-worker',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: greenRollup, branchProtection: { requiredContexts: [] },
    },
    labelNames: [],
    repoPath: job.repo,
    prNumber: job.prNumber,
    currentRevisionRef: PR_7313_PUSHED,
    logger: silent,
    maybeDispatchAmaClosureForImpl: (args) => maybeDispatchAmaClosureFor({ ...args, ...stubs }),
  });

  assert.equal(outcome.outcome, 'ama-dispatched', 'production routed this PR to AWAIT_OPERATOR_ACTION');
  assert.notEqual(outcome.coexistence?.action, 'await-operator-action');
  assert.deepEqual(liveReviewHeads, [PR_7313_REVIEWED], 'the live verdict is read from the reviewed head');
  const [payload] = closerPayloads;
  assert.equal(payload.reviewState.verdict, 'comment-only');
  assert.equal(payload.reviewState.headSha, PR_7313_REVIEWED);
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, true);
  assert.equal(payload.dispatchContext.reviewedSha, PR_7313_REVIEWED);
  assert.equal(payload.dispatchContext.targetRemediationSha, PR_7313_PUSHED);
  const hammerDispatches = execCalls.filter(({ argv }) => argv[0] === 'dispatch' && argv.includes('hammer'));
  assert.equal(hammerDispatches.length, 1);

  // The proof authorizes terminal validation only: the pushed head is still
  // ineligible to merge until the hammer writes exact-head validation evidence.
  assert.ok(!execCalls.some(({ cmd, argv }) => cmd === 'gh' && argv[0] === 'pr' && argv[1] === 'merge'));
  assert.deepEqual(daemonOutcomes.map(({ disposition, reason }) => [disposition, reason]),
    [['not-taken', 'non-blocking-findings-present']]);
  const mergeEligibility = isEligibleForAmaClosure(payload.reviewState, payload.prMetadata, cfg, { env: {} });
  assert.equal(mergeEligibility.eligible, false);
  assert.ok(mergeEligibility.reasons.includes('stale-review-head'), mergeEligibility.reasons.join(','));
});

// ── #7311: pending CI completes the final round; the pushed head is not re-reviewed

const PR_7311_REVIEWED = '0a48d65166b3a88b51ed93452de3a0871defe2cb';
const PR_7311_PUSHED = 'c1bc531623756ca7f423e5b62575ca5ebfb2207f';

// The workspace after the worker's mandatory base rebase. GitHub compare for
// 0a48d651...c1bc5316 reports ahead 4 / behind 2: the two reviewed commits were
// replayed onto one new trunk commit, and the worker added its fix on top.
function pr7311WorkspaceExec(jobId) {
  const trailer = `Retry transient RTK downloads\n\nWorker-Job-Id: ${jobId}\n`;
  return async (command, args) => {
    if (command === 'gh') return { stdout: `${PR_7311_PUSHED}\n` };
    const argv = args.slice(2);
    if (argv[0] === 'rev-parse') return { stdout: `${PR_7311_PUSHED}\n` };
    if (argv[0] === 'show') return { stdout: trailer };
    if (argv[0] === 'rev-list') return { stdout: '' };
    if (argv[0] === 'cherry' && argv[1] === PR_7311_PUSHED) return { stdout: `- ${'e'.repeat(40)}\n- ${'f'.repeat(40)}\n` };
    if (argv[0] === 'cherry' && argv[1] === PR_7311_REVIEWED) {
      return { stdout: `- ${'5'.repeat(40)}\n- ${'6'.repeat(40)}\n+ ${PR_7311_PUSHED}\n` };
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

// Queue, claim, and spawn the #7311 final round as production did, with the
// worker's reply and last message on disk; the reconcile is the caller's.
function stage7311FinalRound(t, label) {
  const rootDir = tempRoot(t, label);
  const hqRoot = path.join(rootDir, 'hq');
  const recorded = fixture('pr-7311-final-round-job.json');
  // Production outcome, for the record: the pending-CI blocker demoted the round.
  assert.equal(recorded.status, 'stopped');
  assert.equal(recorded.remediationPlan.stop.code, 'max-rounds-reached');
  assert.equal(recorded.completion.workerPushedHeadSha, undefined);

  // Rebuild the job as it was queued, before the worker ran.
  const queued = { ...recorded };
  for (const terminalField of ['_fixture', 'status', 'stoppedAt', 'reReview', 'completion', 'remediationWorker', 'claimedAt']) {
    delete queued[terminalField];
  }
  const pendingJob = {
    ...queued,
    status: 'pending',
    remediationPlan: {
      ...queued.remediationPlan, currentRound: 1, rounds: [], stop: null, stopReason: null, nextAction: null,
    },
  };
  const pendingDir = getFollowUpJobDir(rootDir, 'pending');
  mkdirSync(pendingDir, { recursive: true });
  writeFollowUpJob(path.join(pendingDir, `${pendingJob.jobId}.json`), pendingJob);

  // Root cause E: the reviewer re-queuing this same review is now a duplicate.
  const duplicate = reviewerInternals.queueFollowUpForPostedReview({
    rootDir, repo: pendingJob.repo, prNumber: pendingJob.prNumber, baseBranch: 'main', reviewerModel: 'gemini',
    revisionRef: PR_7311_REVIEWED, reviewText: pendingJob.reviewBody, reviewPostedAt: '2026-09-28T21:34:26.162Z',
    resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(duplicate.queued, false);
  assert.equal(duplicate.reason, 'duplicate-review-follow-up');

  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: recorded.claimedAt, launcherPid: 4242 });
  assert.equal(claimed.job.jobId, pendingJob.jobId);
  assert.equal(claimed.job.remediationPlan.currentRound, 2);
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(outputPath, 'I committed and pushed the RTK download retry fix to PR #7311.\n', 'utf8');
  const { replyDir, replyPath } = resolveHqReplyPath({ hqRoot, launchRequestId: claimed.job.jobId });
  mkdirSync(replyDir, { recursive: true });
  const reply = fixture('pr-7311-remediation-reply.json');
  assert.equal(reply.outcome, 'partial');
  assert.deepEqual(reply.operationalBlockers.map(({ title }) => title), ['pending-pr-head-ci']);
  writeFileSync(replyPath, `${JSON.stringify(reply, null, 2)}\n`, 'utf8');
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath,
    spawnedAt: '2026-09-28T21:36:37.574Z',
    worker: {
      model: 'codex', processId: 87311, state: 'spawned',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, path.join(artifactDir, 'codex-worker.log')),
      replyPath,
    },
  });
  return { rootDir, hqRoot, recorded, claimed, spawned };
}

async function withHqRoot(hqRoot, fn) {
  const originalHqRoot = process.env.HQ_ROOT;
  process.env.HQ_ROOT = hqRoot;
  try {
    return await fn();
  } finally {
    if (originalHqRoot === undefined) delete process.env.HQ_ROOT;
    else process.env.HQ_ROOT = originalHqRoot;
  }
}

test('replay #7311: a pending-CI final round completes with its pushed head, which is never re-reviewed', async (t) => {
  const { rootDir, hqRoot, recorded, claimed, spawned } = stage7311FinalRound(t, '7311');
  const alerts = [];
  const wakes = [];
  const result = await withHqRoot(hqRoot, () => reconcileFollowUpJob({
    rootDir, job: spawned.job, jobPath: spawned.jobPath,
    now: () => '2026-09-28T21:39:44.158Z',
    isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: PR_7311_PUSHED }),
    execFileImpl: pr7311WorkspaceExec(claimed.job.jobId),
    auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
    // The reconciler's own CI probe of the pushed head: repo-guards still running.
    inspectRemediationCiRegressionImpl: async () => ({
      state: 'pending', headSha: PR_7311_PUSHED, failedChecks: [],
      pendingChecks: [{ name: 'repo-guards', state: 'IN_PROGRESS' }],
    }),
    requestReviewRereviewImpl: () => { throw new Error('a comment-only final round must not request re-review'); },
    requestWatcherWakeImpl: (wake) => { wakes.push(wake); return { requested: true }; },
    deliverAlertImpl: async (text) => { alerts.push(text); return { queued: true }; },
    postCommentImpl: async () => ({ posted: true }),
    log: silent,
  }));

  assert.equal(result.action, 'completed', 'production filed this round stopped/max-rounds-reached');
  assert.match(result.jobPath, /follow-up-jobs\/completed\//);
  assert.equal(result.job.reReview.suppressed, 'comment-only-final-round');
  assert.equal(result.job.completion.workerPushedHeadSha, PR_7311_PUSHED);
  assert.deepEqual(result.job.completion.workerPushProof,
    { method: 'git-cherry-replay', reviewedCommitsReplayed: 2, workerCommits: 1 });
  assert.deepEqual(result.job.completion.finalRoundOutcome,
    { completed: true, reason: 'ci-probe-pending-ci', ciState: 'pending', push: 'replayed-onto-base' });
  assert.deepEqual(alerts, []);
  assert.equal(wakes[0]?.reason, 'comment-only-final-round-completed');

  // The pushed head is not re-reviewed: the watcher's stale-head auto-refresh,
  // which produced the 21:49Z gemini Request changes, is refused...
  const autoRefresh = requestReviewRereview({
    rootDir, repo: recorded.repo, prNumber: recorded.prNumber,
    reason: 'auto-refresh: posted review on stale head', targetRevisionRef: PR_7311_PUSHED, logger: silent,
  });
  assert.equal(autoRefresh.triggered, false);
  assert.equal(autoRefresh.reason, 'comment-only-final-round-completed');
  // ...and a review of it that raced the reconcile queues no follow-up job.
  const ledger = summarizePRRemediationLedger(rootDir, { repo: recorded.repo, prNumber: recorded.prNumber });
  assert.deepEqual(ledger.commentOnlyFinalRoundPushedHeads.map(({ reviewedHead, workerPushedHeadSha, status: dir }) =>
    [reviewedHead, workerPushedHeadSha, dir]), [[PR_7311_REVIEWED, PR_7311_PUSHED, 'completed']]);
  const racedReview = reviewerInternals.queueFollowUpForPostedReview({
    rootDir, repo: recorded.repo, prNumber: recorded.prNumber, baseBranch: 'main', reviewerModel: 'gemini',
    revisionRef: PR_7311_PUSHED, reviewPostedAt: '2026-09-28T21:39:40.000Z',
    reviewText: '## Blocking issues\n- **New nit**\n\n## Verdict\nRequest changes',
    resolveHandoffConfigImpl: () => ({ enabled: false }),
  });
  assert.equal(racedReview.queued, false);
  assert.equal(racedReview.reason, 'comment-only-final-round-completed');
});

test('replay #7311: a network failure during the proof leaves the round in progress, and the next tick completes it', async (t) => {
  const { rootDir, hqRoot, claimed, spawned } = stage7311FinalRound(t, '7311-transient');
  const alerts = [];
  const wakes = [];
  const reconcile = (job, jobPath, audit) => withHqRoot(hqRoot, () => reconcileFollowUpJob({
    rootDir, job, jobPath,
    now: () => '2026-09-28T21:39:44.158Z',
    isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha: PR_7311_PUSHED }),
    execFileImpl: pr7311WorkspaceExec(claimed.job.jobId),
    auditWorkspaceForContaminationImpl: audit,
    inspectRemediationCiRegressionImpl: async () => ({
      state: 'pending', headSha: PR_7311_PUSHED, failedChecks: [],
      pendingChecks: [{ name: 'repo-guards', state: 'IN_PROGRESS' }],
    }),
    requestReviewRereviewImpl: () => { throw new Error('a comment-only final round must not request re-review'); },
    requestWatcherWakeImpl: (wake) => { wakes.push(wake); return { requested: true }; },
    deliverAlertImpl: async (text) => { alerts.push(text); return { queued: true }; },
    postCommentImpl: async () => ({ posted: true }),
    log: silent,
  }));

  // The in-process retries (2 s, 5 s) all hit the same outage.
  const offline = await reconcile(spawned.job, spawned.jobPath, async () => ({
    suspect: [], error: 'fetch: fatal: unable to access \'https://github.com/\': Could not resolve host: github.com',
  }));
  assert.equal(offline.action, 'active');
  assert.equal(offline.reason, 'final-round-proof-transient');
  const onDisk = JSON.parse(readFileSync(spawned.jobPath, 'utf8'));
  assert.equal(onDisk.status, 'in_progress', 'the round is neither terminated nor held');
  assert.equal(onDisk.finalRoundProofTransient.attempts, 3);
  assert.equal(onDisk.completion, undefined);
  assert.deepEqual(alerts, []);
  assert.deepEqual(wakes, []);

  const recovered = await reconcile(onDisk, spawned.jobPath, async () => ({ suspect: [], error: null }));
  assert.equal(recovered.action, 'completed');
  assert.equal(recovered.job.completion.workerPushedHeadSha, PR_7311_PUSHED);
  assert.deepEqual(alerts, []);
});

test('replay #7311: the worker-opened draft is named as a draft, not a state change', async (t) => {
  const rootDir = tempRoot(t, '7311-draft');
  const { createAmaHammerBackgroundQueue } = await import('../src/ama-hammer-background-dispatch.mjs');
  const queue = createAmaHammerBackgroundQueue({ maxConcurrent: 1 });
  const args = {
    rootDir,
    reviewStateRow: {
      repo: 'laceyenterprises/agent-os', pr_number: 7311, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Request changes', risk_class: 'medium', reviewer: 'gemini', reviewer_head_sha: PR_7311_PUSHED,
    },
    dispatchJob: {},
    candidate: {
      headSha: PR_7311_PUSHED, riskClass: 'medium', prState: 'open', mergeable: 'MERGEABLE', isDraft: true,
      statusCheckRollup: [], branchProtection: { requiredContexts: [] },
    },
    labelNames: [],
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 7311,
    currentRevisionRef: PR_7311_PUSHED,
    logger: silent,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue,
    fetchLatestHeadReviewBodiesImpl: async () => [],
    fetchMergedProtectiveDependentsImpl: async () => [],
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    fetchCurrentPrStateImpl: async () => ({ state: 'OPEN', headSha: PR_7311_PUSHED, isDraft: true, mergeable: 'MERGEABLE' }),
    maybeDispatchAmaCloserImpl: async () => { throw new Error('a draft must not reach the closer'); },
  };
  await maybeDispatchAmaClosureFor(args);
  await queue.drain();
  const settled = await maybeDispatchAmaClosureFor(args);
  assert.equal(settled.reason, 'background-pr-draft', 'production logged background-pr-state-changed');
  assert.equal(settled.needsOperator, true);
  assert.equal(settled.operatorReason, 'pr-is-draft');
});
