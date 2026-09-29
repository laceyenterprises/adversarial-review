// COMMENTCLOSE-01 item 2: after a comment-only final round pushes, the AMA closer
// proves the pushed head against the REVIEWED head and hands it to the hammer's
// terminal validation. It never merges on that proof, and an unproven descendant
// fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';
import {
  FINAL_ROUND_CI_WAIT_DEADLINE_MS,
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/ama-closure-orchestration.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { findCommentOnlyFinalRoundPushJob } from '../src/comment-only-final-round.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR = 265;
const REVIEWED = '1'.repeat(40);
const PUSHED = '2'.repeat(40);
const HUMAN = '3'.repeat(40);
const COMMENT_ONLY_BODY = [
  '## Summary', 'Docs only.', '',
  '## Blocking issues', '- None.', '',
  '## Non-blocking issues', '- **Typo in status timestamp**', '  - **Problem:** `22:2xZ` is ambiguous.', '',
  '## Verdict', 'Comment only',
].join('\n');
const REQUEST_CHANGES_BODY = COMMENT_ONLY_BODY
  .replace('## Blocking issues\n- None.', '## Blocking issues\n- **Broken link**\n  - **Problem:** 404.')
  .replace('Comment only', 'Request changes');

function seedFinalRound(rootDir, { status = 'completed', pushed = PUSHED } = {}) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', status);
  mkdirSync(dir, { recursive: true });
  const jobId = `laceyenterprises__adversarial-review-pr-${PR}-2026-09-28T22-33-55-502Z`;
  writeFileSync(join(dir, `${jobId}.json`), JSON.stringify({
    schemaVersion: 1, kind: 'adversarial-review-follow-up', jobId, status,
    repo: REPO, prNumber: PR, domainId: 'code-pr', revisionRef: REVIEWED, riskClass: 'low',
    finalRound: 'comment-only', nonBlockingOnly: true, reviewBody: COMMENT_ONLY_BODY,
    remediationPlan: { currentRound: 1, maxRounds: 2, stop: null },
    remediationWorker: { state: 'completed' },
    completedAt: '2026-09-28T22:38:59.717Z',
    reReview: { requested: false, suppressed: 'comment-only-final-round' },
    completion: { workerPushedHeadSha: pushed },
  }));
  return jobId;
}

const postedRow = { review_status: 'posted', reviewer_head_sha: REVIEWED };
const PUSHED_AT_MS = Date.parse('2026-09-28T22:38:59.717Z');
const pushes = [{ reviewedHead: REVIEWED, workerPushedHeadSha: PUSHED, status: 'completed' }];

test('the settled verdict of a proven final-round push resolves from the reviewed head', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-verdict-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const resolved = resolveSettledReviewVerdict(rootDir, {
    repo: REPO, prNumber: PR, reviewRow: postedRow, currentHeadSha: PUSHED, commentOnlyFinalRoundPushes: pushes,
  });
  assert.equal(resolved.verdict, 'comment-only');
  assert.equal(resolved.reviewedHeadSha, REVIEWED, 'the proof never re-labels the pushed head as reviewed');
  assert.equal(resolved.commentOnlyFinalRoundPush, true);
  assert.equal(resolved.blockingFindingState, 'known');
  assert.equal(resolved.blockingFindingCount, 0);
  assert.equal(resolved.nonBlockingFindingState, 'known');
  assert.equal(resolved.nonBlockingFindingCount, 1);
});

test('without recorded pushes, or for any other descendant, a moved head stays unknown', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-verdict-closed-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const base = { repo: REPO, prNumber: PR, reviewRow: postedRow };
  // The published gate projection never passes pushes, so it is unchanged.
  assert.equal(resolveSettledReviewVerdict(rootDir, { ...base, currentHeadSha: PUSHED }).verdict, '');
  // A human push on top of the final round matches no record.
  const human = resolveSettledReviewVerdict(rootDir, { ...base, currentHeadSha: HUMAN, commentOnlyFinalRoundPushes: pushes });
  assert.equal(human.verdict, '');
  assert.equal(human.blockingFindingState, 'unknown');
  // A ledger entry with no marked terminal job behind it proves nothing.
  const emptyRoot = mkdtempSync(join(tmpdir(), 'final-round-verdict-empty-'));
  t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
  assert.equal(resolveSettledReviewVerdict(emptyRoot, {
    ...base, currentHeadSha: PUSHED, commentOnlyFinalRoundPushes: pushes,
  }).verdict, '');
});

test('a live Request changes on the reviewed head wins; an unresolved live lookup fails closed', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-verdict-live-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const base = { repo: REPO, prNumber: PR, reviewRow: postedRow, currentHeadSha: PUSHED, commentOnlyFinalRoundPushes: pushes };
  const flipped = resolveSettledReviewVerdict(rootDir, {
    ...base, liveHeadReview: { resolved: true, bodies: [REQUEST_CHANGES_BODY, COMMENT_ONLY_BODY] },
  });
  assert.equal(flipped.verdict, 'request-changes');
  assert.equal(flipped.blockingFindingCount, 1);
  const unresolved = resolveSettledReviewVerdict(rootDir, { ...base, liveHeadReview: { resolved: false } });
  assert.equal(unresolved.verdict, '');
  assert.equal(unresolved.blockingFindingState, 'unknown');
});

test('the final-round job finder requires the marker, the reviewed head and the exact pushed head', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-finder-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir, { status: 'stopped' });
  const query = { repo: REPO, prNumber: PR, reviewedHead: REVIEWED, workerPushedHeadSha: PUSHED };
  assert.equal(findCommentOnlyFinalRoundPushJob(rootDir, query)?.status, 'stopped');
  assert.equal(findCommentOnlyFinalRoundPushJob(rootDir, { ...query, workerPushedHeadSha: HUMAN }), null);
  assert.equal(findCommentOnlyFinalRoundPushJob(rootDir, { ...query, reviewedHead: HUMAN }), null);
});

function closureArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    reviewStateRow: {
      repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0,
      reviewer: 'gemini', reviewer_head_sha: REVIEWED, posted_at: '2026-09-28T22:33:55Z',
    },
    dispatchJob: {},
    candidate: {
      headSha: PUSHED, riskClass: 'low', prAuthor: 'claude-code-worker', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: false,
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] },
    },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: REPO,
    prNumber: PR,
    currentRevisionRef: PUSHED,
    logger: { log() {}, warn() {} },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [COMMENT_ONLY_BODY],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: 'not-closer-commit' }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'non-blocking-findings-present' }),
    requestEligibleHammerWakeImpl: () => ({ requested: false }),
    proveCommentOnlyFinalRoundHeadImpl: async ({ reviewedHead, currentHead, completedRevisionRefs, completedPushedHeads }) =>
      completedRevisionRefs.includes(reviewedHead) &&
      completedPushedHeads.some((entry) => entry.reviewedHead === reviewedHead && entry.workerPushedHeadSha === currentHead),
    ...overrides,
  };
}

test('AMA hands a proven final-round head to hammer terminal validation, reading the reviewed head live', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const liveHeads = [];
  let payload = null;
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => { liveHeads.push(head); return [COMMENT_ONLY_BODY]; },
    maybeDispatchAmaCloserImpl: async (args) => { payload = args; return { dispatched: true, launchRequestId: 'lrq_hammer' }; },
  }));
  assert.equal(result.dispatched, true);
  assert.deepEqual(liveHeads, [REVIEWED], 'live reconcile reads the reviewed head, not the pushed one');
  assert.equal(payload.reviewState.verdict, 'comment-only');
  assert.equal(payload.reviewState.headSha, REVIEWED);
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, true);
  assert.equal(payload.dispatchContext.targetRemediationSha, PUSHED);

  // The real closer admits exactly that payload as terminal remediation.
  const execCalls = [];
  const dispatched = await maybeDispatchAmaCloser({
    ...payload,
    cfg: { ...payload.cfg, workerClass: 'hammer', eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: false } },
    dispatchContext: {
      ...payload.dispatchContext, rootDir, hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: userInfo().username, currentUser: userInfo().username,
    },
    execFileImpl: async (cmd, args) => {
      execCalls.push({ cmd, args });
      return { stdout: JSON.stringify({ dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  });
  assert.equal(dispatched.dispatched, true);
  const hammerDispatches = execCalls.filter(({ args }) => args[0] === 'dispatch' && args.includes('hammer'));
  assert.equal(hammerDispatches.length, 1, 'exactly one hammer dispatch');
  assert.ok(!execCalls.some(({ cmd, args }) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge'), 'no merge is attempted on the proof alone');
});

test('a human push on top of the final round fails closed: no verdict, no hand-off', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-human-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  let payload = null;
  await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    candidate: { ...closureArgs(rootDir).candidate, headSha: HUMAN },
    currentRevisionRef: HUMAN,
    maybeDispatchAmaCloserImpl: async (args) => { payload = args; return { dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head'] }; },
  }));
  assert.equal(payload.reviewState.verdict, '');
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, false);
});

test('pending CI on a proven final-round head waits without spending the retain-loop cap', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-ci-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const pendingRollup = [{ __typename: 'CheckRun', name: 'repo-guards', status: 'IN_PROGRESS', conclusion: null }];
  let payload = null;
  const closure = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: pendingRollup },
    now: () => PUSHED_AT_MS + 10 * 60 * 1000,
    maybeDispatchAmaCloserImpl: async (args) => {
      payload = args;
      return { dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head', 'ci-not-green'] };
    },
  }));
  assert.equal(payload.dispatchContext.commentOnlyFinalRoundResume, false, 'the hammer waits for green CI');
  assert.equal(closure.commentOnlyFinalRoundAwaitingCi, true);

  const logs = [];
  for (let tick = 0; tick < 6; tick += 1) {
    const outcome = await resolveMergeAgentCoexistenceForWatcher({
      rootDir, reviewStateRow: {}, dispatchJob: {}, candidate: { headSha: PUSHED },
      repoPath: REPO, prNumber: PR, currentRevisionRef: PUSHED,
      logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
      maybeDispatchAmaClosureForImpl: async () => closure,
    });
    assert.equal(outcome.outcome, 'ama-pending', `tick ${tick} must not route to AWAIT_OPERATOR_ACTION`);
  }
  assert.ok(logs.some((line) => /holding .*#265 for PR-head CI on a proven comment-only final-round head/.test(line)));
  assert.ok(!logs.some((line) => /retain-loop cap reached/.test(line)));

  // Red CI is not a wait: it still counts toward the cap.
  const red = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'FAILURE' }] },
    maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head', 'ci-not-green'] }),
  }));
  assert.equal(red.commentOnlyFinalRoundAwaitingCi, undefined);
});

test('CI pending past the deadline on a proven final-round head counts toward the retain cap again', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-ci-timeout-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const pendingRollup = [{ __typename: 'CheckRun', name: 'repo-guards', status: 'QUEUED', conclusion: null }];
  const warnings = [];
  const closure = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: pendingRollup },
    now: () => PUSHED_AT_MS + FINAL_ROUND_CI_WAIT_DEADLINE_MS + 1,
    logger: { log() {}, warn: (line) => warnings.push(line) },
    maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head', 'ci-not-green'] }),
  }));
  assert.equal(closure.commentOnlyFinalRoundAwaitingCi, undefined, 'the wait is no longer exempt');
  assert.ok(warnings.some((line) => /final-round-ci-pending-timeout .*#265/.test(line)));

  const logs = [];
  let outcome = null;
  for (let tick = 0; tick < 12 && outcome?.outcome !== 'await-operator'; tick += 1) {
    outcome = await resolveMergeAgentCoexistenceForWatcher({
      rootDir, reviewStateRow: {}, dispatchJob: {}, candidate: { headSha: PUSHED },
      repoPath: REPO, prNumber: PR, currentRevisionRef: PUSHED,
      logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
      maybeDispatchAmaClosureForImpl: async () => closure,
    });
  }
  assert.equal(outcome.outcome, 'await-operator', 'a hung CI wait escalates to the operator');
  assert.ok(logs.some((line) => /retain-loop cap reached/.test(line)));
});
