import { primaryChangeFixture } from './helpers/primary-change.mjs';
// COMMENTCLOSE-02 replay (SEV3 2026-09-29, "a stale auto-refresh rereview reason
// bypasses the comment-only final-round close", agent-os#7340).
//
// agent-os#7334's comment-only final round completed correctly: the marker is on
// the job, the pushed head 365500c3 is the live head, and re-review was
// suppressed. But its review row still carried the rereview_reason written by the
// head change BEFORE the reviewed head ("auto-refresh: posted review on stale head
// b3f27d7f025e; current head is defd5d0fb1cd"). The gate read that sticky reason as
// a head change in flight, skipped the COMMENTCLOSE-01 final-round branch, and the
// closer parked the PR at AWAIT_OPERATOR_ACTION on `stale-review-head`.
//
// Loads sanitized copies of the live job and review row
// (test/fixtures/commentclose-02/) and replays them through the AMA closer, then
// pins the resolver rules either side of the fix:
//   - a recorded final-round push wins over any rereview_reason (item 1);
//   - a head-change reason is current only while it names the gated head and no
//     review of that head has posted (item 2);
//   - a genuine pending head-change re-review keeps failing closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pickAdversarialGateStatus,
  resolveProvenReviewedHead,
  resolveSettledReviewVerdict,
} from '../src/adversarial-gate-status.mjs';
import {
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/ama-closure-orchestration.mjs';
import { isHammerRemediableEligibilityMiss, maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { runDaemonCleanMergeAttempt as runDaemonCleanMergeAttemptReal } from '../src/daemon-clean-merge.mjs';
import { isTerminalCloserCommitIdentity } from '../src/head-closer-commit-suppression.mjs';
import { proveCommentOnlyFinalRoundHead } from '../src/comment-only-final-round.mjs';
import { getFollowUpJobDir, summarizePRRemediationLedger, writeFollowUpJob } from '../src/follow-up-jobs.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'commentclose-02');
const fixture = (name) => {
  const record = JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
  delete record._fixture;
  return record;
};
const silent = { log() {}, info() {}, warn() {}, error() {} };

const REVIEWED = 'defd5d0fb1cd7fb500f2011808f5a254d4c4b7be';
const PUSHED = '365500c3d1bcfdf8fc83c9133533af3a5cd5c8b6';
const HUMAN = '7'.repeat(40);
// Live, and what the row carries: the reason from the head change that led TO
// the reviewed head, which that head's posted review already answered.
const STALE_REASON = 'auto-refresh: posted review on stale head b3f27d7f025e; current head is defd5d0fb1cd';
// What a genuine head change to the pushed head would read, before its review posts.
const PENDING_REASON = `auto-refresh: posted review on stale head ${REVIEWED.slice(0, 12)}; current head is ${PUSHED.slice(0, 12)}`;

function tempRoot(t, label) {
  const rootDir = mkdtempSync(path.join(tmpdir(), `commentclose-02-${label}-`));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

// The live #7334 job, recorded where production recorded it.
function seed7334(rootDir) {
  const job = fixture('pr-7334-final-round-job.json');
  const completedDir = getFollowUpJobDir(rootDir, 'completed');
  mkdirSync(completedDir, { recursive: true });
  writeFollowUpJob(path.join(completedDir, `${job.jobId}.json`), job);
  const ledger = summarizePRRemediationLedger(rootDir, { repo: job.repo, prNumber: job.prNumber });
  return { job, pushes: ledger.commentOnlyFinalRoundPushedHeads };
}

const REQUEST_CHANGES_BODY = [
  '## Summary', 'A later pass on the reviewed head.', '',
  '## Blocking issues', '- **Live ledger still written from tests**', '  - **Problem:** the redirect is bypassed.', '',
  '## Non-blocking issues', '- None.', '',
  '## Verdict', 'Request changes',
].join('\n');

// ── #7334: the recorded final-round push reaches hammer terminal validation ────

test('replay #7334: a stale auto-refresh reason no longer parks the proven final-round push at AWAIT_OPERATOR_ACTION', async (t) => {
  const rootDir = tempRoot(t, '7334');
  const { job, pushes } = seed7334(rootDir);
  const row = fixture('pr-7334-review-row.json');
  assert.equal(job.status, 'completed');
  assert.equal(job.finalRound, 'comment-only');
  assert.equal(job.reReview.suppressed, 'comment-only-final-round');
  assert.equal(job.revisionRef, REVIEWED);
  assert.equal(job.completion.workerPushedHeadSha, PUSHED);
  assert.equal(job.completion.workerPushProof.method, 'git-cherry-replay');
  assert.deepEqual(pushes.map(({ reviewedHead, workerPushedHeadSha }) => [reviewedHead, workerPushedHeadSha]), [[REVIEWED, PUSHED]]);
  assert.equal(row.review_status, 'posted');
  assert.equal(row.reviewer_head_sha, REVIEWED);
  assert.equal(row.rereview_reason, STALE_REASON);

  // `gh pr checks 7334` on the pushed head: all three required checks passed.
  const greenRollup = ['release-freeze-gate', 'repo-guards', 'submodule-pointer-gate']
    .map((name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
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
      return head === REVIEWED ? [job.reviewBody] : [];
    },
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    // The real daemon clean-merge lane still declines: nothing certifies the
    // pushed head for merge until the hammer writes exact-head validation.
    runDaemonCleanMergeAttemptImpl: async (args) => {
      assert.equal(args.gateSnapshot.reviewedHeadSha, REVIEWED);
      assert.equal(args.currentPrHeadSha, PUSHED);
      const daemon = await runDaemonCleanMergeAttempt({
        ...args,
        candidate: { ...args.candidate, baseBranch: 'main' },
        env: { HQ_ROOT: rootDir },
        headHasValidatedHamTerminalRemediationImpl: () => false,
        resolveHeadCloserCommitSuppressionImpl: async () => isTerminalCloserCommitIdentity({
          message: `Fix the five non-blocking findings\n\nWorker-Job-Id: ${job.jobId}\n`,
          committer: { login: 'lacey-claude-agent[bot]' },
        }),
        fetchRollupImpl: async () => { throw new Error('the daemon must decline before reading the live rollup'); },
        attemptDaemonCleanMergeImpl: async () => { throw new Error('the daemon must not merge a final-round head'); },
      });
      daemonOutcomes.push(daemon);
      return daemon;
    },
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    // GitHub compare defd5d0f...365500c3 reports `diverged` (ahead 4 / behind 2):
    // the worker replayed the reviewed commits onto a fresh base.
    proveCommentOnlyFinalRoundHeadImpl: (args) => proveCommentOnlyFinalRoundHead({
      ...args, execFileImpl: async () => ({ stdout: 'diverged\n' }),
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
          return { stdout: JSON.stringify({ dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer_7334' }), stderr: '' };
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
      ...row, last_verdict: 'Comment only', risk_class: job.riskClass, remediation_pending: 0,
    },
    dispatchJob: {},
    candidate: {
      headSha: PUSHED, riskClass: job.riskClass, prState: 'open', prAuthor: 'claude-code-worker',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: greenRollup, branchProtection: { requiredContexts: [] },
    },
    labelNames: [],
    repoPath: job.repo,
    prNumber: job.prNumber,
    currentRevisionRef: PUSHED,
    logger: silent,
    maybeDispatchAmaClosureForImpl: (args) => maybeDispatchAmaClosureFor({ ...args, ...stubs }),
  });

  assert.equal(outcome.outcome, 'ama-dispatched', 'production retained this PR on stale-review-head, then parked it');
  assert.notEqual(outcome.coexistence?.action, 'await-operator-action');
  assert.deepEqual(liveReviewHeads, [REVIEWED], 'the live verdict is read from the reviewed head, not the pushed one');
  const [payload] = closerPayloads;
  assert.equal(payload.reviewState.verdict, 'comment-only');
  assert.equal(payload.reviewState.headSha, REVIEWED);
  assert.equal(payload.reviewState.blockingFindingCount, 0);
  assert.equal(payload.reviewState.nonBlockingFindingCount, 5);
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, true);
  assert.equal(payload.dispatchContext.reviewedSha, REVIEWED);
  assert.equal(payload.dispatchContext.targetRemediationSha, PUSHED);
  const hammerDispatches = execCalls.filter(({ argv }) => argv[0] === 'dispatch' && argv.includes('hammer'));
  assert.equal(hammerDispatches.length, 1);

  // Merge still binds to exact-head HAM terminal validation evidence only.
  assert.ok(!execCalls.some(({ cmd, argv }) => cmd === 'gh' && argv[0] === 'pr' && argv[1] === 'merge'));
  assert.deepEqual(daemonOutcomes.map(({ disposition, reason }) => [disposition, reason]),
    [['not-taken', 'non-blocking-findings-present']]);
  const mergeEligibility = isEligibleForAmaClosure(payload.reviewState, payload.prMetadata, cfg, { env: {} });
  assert.equal(mergeEligibility.eligible, false);
  assert.ok(mergeEligibility.reasons.includes('stale-review-head'), mergeEligibility.reasons.join(','));
});

// #7334's final round was round 2 of 2, so the review cycle is exhausted. The
// exhausted branch refused every stale reviewed head before it reached the
// COMMENTCLOSE-01 final-round resume; #7313 (round 1 of 2) never hit it.
test('an exhausted review cycle admits a proven final-round head, and nothing else that is stale', () => {
  const reasons = ['stale-review-head', 'verdict-not-settled-success', 'non-blocking-findings-present'];
  const exhausted = { reviewCycleExhausted: true };
  assert.equal(isHammerRemediableEligibilityMiss(reasons, exhausted), false, 'an unproven stale head still parks');
  assert.equal(isHammerRemediableEligibilityMiss(reasons, { ...exhausted, commentOnlyFinalRoundResume: true }), true);
  for (const blocker of ['blocking-findings-present', 'blocking-findings-unknown', 'ci-not-green']) {
    assert.equal(
      isHammerRemediableEligibilityMiss([...reasons, blocker], { ...exhausted, commentOnlyFinalRoundResume: true }),
      false,
      blocker,
    );
  }
  // Exhaustion without a stale head is unchanged.
  assert.equal(isHammerRemediableEligibilityMiss(['verdict-not-settled-success'], exhausted), true);
});

// ── Item 1: the recorded final-round push wins over any rereview_reason ───────

test('a recorded final-round push resolves the comment-only verdict whatever rereview_reason the row carries', (t) => {
  const rootDir = tempRoot(t, 'verdict');
  const { pushes } = seed7334(rootDir);
  const base = { repo: 'laceyenterprises/agent-os', prNumber: 7334, currentHeadSha: PUSHED, commentOnlyFinalRoundPushes: pushes };
  // PENDING_REASON names the live head, so even a reason the scoping rule would
  // call current cannot outrank the recorded push on a posted row. That override
  // is flagged on the result and warned about, once per PR/head/reason.
  const warnings = [];
  const logger = { ...silent, warn: (line) => warnings.push(line) };
  for (const rereview_reason of [STALE_REASON, PENDING_REASON, PENDING_REASON, null]) {
    const resolved = resolveSettledReviewVerdict(rootDir, {
      ...base, logger, reviewRow: { review_status: 'posted', reviewer_head_sha: REVIEWED, rereview_reason },
    });
    assert.equal(resolved.verdict, 'comment-only', `rereview_reason=${rereview_reason}`);
    assert.equal(resolved.overrodeHeadChangeRereview === true, rereview_reason === PENDING_REASON);
    assert.equal(resolved.commentOnlyFinalRoundPush, true);
    assert.equal(resolved.remediationPending, false);
    assert.equal(resolveProvenReviewedHead(resolved), REVIEWED, 'the pushed head is never re-labelled as reviewed');
    assert.equal(resolved.blockingFindingState, 'known');
    assert.equal(resolved.blockingFindingCount, 0);
    assert.equal(resolved.nonBlockingFindingCount, 5);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /comment-only-final-round-overrides-rereview: repo=laceyenterprises\/agent-os pr=#7334 /);
  assert.ok(warnings[0].includes(`pushed=${PUSHED}`));
});

test('with a stale reason on the row, a later Request changes on the reviewed head still wins and a human push fails closed', (t) => {
  const rootDir = tempRoot(t, 'fail-closed');
  const { job, pushes } = seed7334(rootDir);
  const reviewRow = { review_status: 'posted', reviewer_head_sha: REVIEWED, rereview_reason: STALE_REASON };
  const base = { repo: job.repo, prNumber: job.prNumber, reviewRow, commentOnlyFinalRoundPushes: pushes };

  const flipped = resolveSettledReviewVerdict(rootDir, {
    ...base, currentHeadSha: PUSHED,
    liveHeadReview: { resolved: true, bodies: [REQUEST_CHANGES_BODY, job.reviewBody] },
  });
  assert.equal(flipped.verdict, 'request-changes');
  assert.equal(flipped.blockingFindingCount, 1);

  const unresolved = resolveSettledReviewVerdict(rootDir, { ...base, currentHeadSha: PUSHED, liveHeadReview: { resolved: false } });
  assert.equal(unresolved.verdict, '');
  assert.equal(unresolved.blockingFindingState, 'unknown');

  const human = resolveSettledReviewVerdict(rootDir, { ...base, currentHeadSha: HUMAN });
  assert.equal(human.verdict, '');
  assert.equal(human.blockingFindingState, 'unknown');
  assert.equal(human.commentOnlyFinalRoundPush, undefined);
});

// ── Item 2: a head-change reason is scoped to the head it names ───────────────

function recordingFinder(job) {
  const queries = [];
  const finder = (_rootDir, query) => { queries.push(query); return job; };
  return { queries, finder };
}

const CLEAN_JOB = {
  status: 'completed',
  revisionRef: REVIEWED,
  reviewBody: '## Blocking issues\n- None.\n\n## Verdict\nComment only',
  reReview: { requested: false },
};

test('a reason whose head has since been reviewed is history: the row resolves against its own head', () => {
  const { queries, finder } = recordingFinder(CLEAN_JOB);
  const resolved = resolveSettledReviewVerdict('/root', {
    repo: 'laceyenterprises/agent-os', prNumber: 7334, currentHeadSha: REVIEWED,
    reviewRow: { review_status: 'posted', reviewer_head_sha: REVIEWED, rereview_reason: STALE_REASON },
    latestJobFinder: finder,
    capturedReviewerPassFinder: () => null,
  });
  // A current head-change reason would have widened this to a PR-wide lookup.
  assert.deepEqual(queries, [{ repo: 'laceyenterprises/agent-os', prNumber: 7334, revisionRef: REVIEWED }]);
  assert.equal(resolved.verdict, 'comment-only');
  assert.equal(resolveProvenReviewedHead(resolved), REVIEWED);
});

test('a genuine pending head-change re-review, named by the watcher\'s 12-char head, stays current', () => {
  const { queries, finder } = recordingFinder(CLEAN_JOB);
  resolveSettledReviewVerdict('/root', {
    repo: 'laceyenterprises/agent-os', prNumber: 7334, currentHeadSha: PUSHED,
    reviewRow: { review_status: 'pending', reviewer_head_sha: null, rereview_reason: PENDING_REASON },
    latestJobFinder: finder,
  });
  assert.deepEqual(queries, [{ repo: 'laceyenterprises/agent-os', prNumber: 7334 }]);
});

test('a pending reason naming a head the PR has since left is not current and fails closed', () => {
  const { queries, finder } = recordingFinder(CLEAN_JOB);
  const resolved = resolveSettledReviewVerdict('/root', {
    repo: 'laceyenterprises/agent-os', prNumber: 7334, currentHeadSha: HUMAN,
    reviewRow: { review_status: 'pending', reviewer_head_sha: null, rereview_reason: PENDING_REASON },
    latestJobFinder: finder,
  });
  assert.deepEqual(queries, []);
  assert.equal(resolved.verdict, '');
  assert.equal(resolved.blockingFindingState, 'unknown');

  // The published gate does not report that stale request as settled success.
  const decision = pickAdversarialGateStatus({
    headSha: HUMAN,
    reviewRow: { review_status: 'pending', rereview_reason: PENDING_REASON },
    latestJob: { ...CLEAN_JOB, revisionRef: HUMAN, reReview: { requested: true } },
  });
  assert.equal(decision.state, 'pending');
  assert.equal(decision.reason, 'rereview-queued');
});

test('FSR-06B trailer-only reasons are scoped the same way, by their live= head', () => {
  const reason = `FSR-06B: trailer-only head move detected; request fresh adversarial review. reviewed=${REVIEWED} live=${PUSHED}`;
  const pending = recordingFinder(CLEAN_JOB);
  resolveSettledReviewVerdict('/root', {
    repo: 'laceyenterprises/agent-os', prNumber: 7334, currentHeadSha: PUSHED,
    reviewRow: { review_status: 'pending', reviewer_head_sha: null, rereview_reason: reason },
    latestJobFinder: pending.finder,
  });
  assert.deepEqual(pending.queries, [{ repo: 'laceyenterprises/agent-os', prNumber: 7334 }]);

  const posted = recordingFinder(CLEAN_JOB);
  resolveSettledReviewVerdict('/root', {
    repo: 'laceyenterprises/agent-os', prNumber: 7334, currentHeadSha: PUSHED,
    reviewRow: { review_status: 'posted', reviewer_head_sha: PUSHED, rereview_reason: reason },
    latestJobFinder: posted.finder,
    capturedReviewerPassFinder: () => null,
  });
  assert.deepEqual(posted.queries, [{ repo: 'laceyenterprises/agent-os', prNumber: 7334, revisionRef: PUSHED }]);
});

// ── A genuine pending head-change re-review keeps failing closed ──────────────

test('a genuine pending head-change re-review of the pushed head keeps failing closed, final-round record or not', async (t) => {
  const rootDir = tempRoot(t, 'pending');
  const { job, pushes } = seed7334(rootDir);
  // The head change to the pushed head is real and its review has not posted.
  // The recorded final round must not stand in for that review.
  for (const reviewRow of [
    { review_status: 'pending', reviewer_head_sha: null, rereview_reason: PENDING_REASON },
    { review_status: 'reviewing', reviewer_head_sha: PUSHED, rereview_reason: PENDING_REASON },
  ]) {
    const resolved = resolveSettledReviewVerdict(rootDir, {
      repo: job.repo, prNumber: job.prNumber, reviewRow, currentHeadSha: PUSHED, commentOnlyFinalRoundPushes: pushes,
    });
    assert.equal(resolved.commentOnlyFinalRoundPush, undefined, reviewRow.review_status);
    const settledOnPushedHead = ['comment-only', 'approved'].includes(resolved.verdict)
      && resolveProvenReviewedHead(resolved) === PUSHED;
    assert.equal(settledOnPushedHead, false, reviewRow.review_status);
  }

  // Through the closer: the live reconcile reads the pushed head, which has no
  // review yet, so there is no verdict, no final-round resume and no hand-off.
  const liveReviewHeads = [];
  let payload = null;
  await maybeDispatchAmaClosureFor({
    rootDir,
    reviewStateRow: {
      repo: job.repo, pr_number: job.prNumber, pr_state: 'open', review_status: 'pending',
      reviewer: 'claude', reviewer_head_sha: null, rereview_reason: PENDING_REASON,
      risk_class: job.riskClass, remediation_pending: 0,
    },
    dispatchJob: {},
    candidate: {
      headSha: PUSHED, riskClass: job.riskClass, prAuthor: 'claude-code-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] },
    },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: job.repo,
    prNumber: job.prNumber,
    currentRevisionRef: PUSHED,
    logger: silent,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => {
      liveReviewHeads.push(head);
      return head === REVIEWED ? [job.reviewBody] : [];
    },
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'non-blocking-findings-present' }),
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    proveCommentOnlyFinalRoundHeadImpl: async () => { throw new Error('no settled comment-only verdict, so nothing to prove'); },
    maybeDispatchAmaCloserImpl: async (args) => {
      payload = args;
      return { dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head'] };
    },
  });
  assert.deepEqual(liveReviewHeads, [PUSHED]);
  assert.equal(payload.reviewState.verdict, '');
  assert.equal(payload.reviewState.blockingFindingState, 'unknown');
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, false);
});

// Inject history evidence so these wiring fixtures remain offline.
function runDaemonCleanMergeAttempt(args) {
  return runDaemonCleanMergeAttemptReal({
    fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
    ...args,
  });
}
