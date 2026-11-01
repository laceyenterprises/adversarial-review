// COMMENTCLOSE-01 item 2: after a comment-only final round pushes, the AMA closer
// proves the pushed head against the REVIEWED head and hands it to the hammer's
// terminal validation. It never merges on that proof, and an unproven descendant
// fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { resolveSettledReviewVerdict } from '../src/adversarial-gate-status.mjs';
import {
  maybeDispatchAmaClosureFor,
  resolveMergeAgentCoexistenceForWatcher,
} from '../src/ama-closure-orchestration.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { findCommentOnlyFinalRoundPushJob } from '../src/comment-only-final-round.mjs';

const REPO = 'fixture/project';
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
const ZERO_FINDINGS_BODY = COMMENT_ONLY_BODY.replace(
  '- **Typo in status timestamp**\n  - **Problem:** `22:2xZ` is ambiguous.', '- None.',
);
const REQUEST_CHANGES_BODY = COMMENT_ONLY_BODY
  .replace('## Blocking issues\n- None.', '## Blocking issues\n- **Broken link**\n  - **Problem:** 404.')
  .replace('Comment only', 'Request changes');

function seedFinalRound(rootDir, { status = 'completed', pushed = PUSHED, reviewBody = COMMENT_ONLY_BODY } = {}) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', status);
  mkdirSync(dir, { recursive: true });
  const jobId = `fixture__project-pr-${PR}-2026-09-28T22-33-55-502Z`;
  writeFileSync(join(dir, `${jobId}.json`), JSON.stringify({
    schemaVersion: 1, kind: 'adversarial-review-follow-up', jobId, status,
    repo: REPO, prNumber: PR, domainId: 'code-pr', revisionRef: REVIEWED, riskClass: 'low',
    finalRound: 'comment-only', nonBlockingOnly: true, reviewBody,
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

for (const { name, conclusion, mergeable, mergeStateStatus, blocker, handoff = false, reviewBody = COMMENT_ONLY_BODY, strictNonBlockingRemediation = true } of [
  { name: 'green', conclusion: 'SUCCESS' },
  { name: 'expired shared hammer handoff', conclusion: 'SUCCESS', handoff: true },
  { name: 'expired shared hammer handoff with blocking findings', conclusion: 'SUCCESS', handoff: true, reviewBody: REQUEST_CHANGES_BODY },
  { name: 'red', conclusion: 'FAILURE' },
  { name: 'red without findings', conclusion: 'FAILURE', reviewBody: ZERO_FINDINGS_BODY },
  { name: 'red BLOCKED without findings', conclusion: 'FAILURE', mergeable: '', mergeStateStatus: 'BLOCKED', reviewBody: ZERO_FINDINGS_BODY },
  { name: 'red with strict non-blocking remediation disabled', conclusion: 'FAILURE', strictNonBlockingRemediation: false },
  { name: 'red BLOCKED', conclusion: 'FAILURE', mergeable: '', mergeStateStatus: 'BLOCKED' },
  { name: 'red with blocking findings', conclusion: 'FAILURE', blocker: 'present' },
  { name: 'red with unknown blocking findings', conclusion: 'FAILURE', blocker: 'unknown' },
]) {
  test(`AMA final-round handoff: ${name} CI retains terminal validation gates`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const id = seedFinalRound(rootDir, { reviewBody });
    if (handoff) {
      const jobPath = join(rootDir, 'data', 'follow-up-jobs', 'completed', `${id}.json`);
      const job = JSON.parse(readFileSync(jobPath, 'utf8'));
      delete job.finalRound;
      job.completion.finalRemediationPush = true;
      job.reReview = { requested: false, status: 'suppressed', suppressed: 'shared-next-action',
        nextAction: { action: 'hammer', actor: 'hammer', reason: 'suppressed-final-push', head: PUSHED,
          deadline: { class: 'admission', budgetMs: 300000, at: new Date(PUSHED_AT_MS + 300000).toISOString() } } };
      writeFileSync(jobPath, JSON.stringify(job));
      mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'workspaces', id), { recursive: true });
      const staleDir = join(rootDir, 'data', 'follow-up-jobs', 'in-progress');
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, `${id}-stale.json`), JSON.stringify({
        ...job, status: 'in_progress', lastHeartbeatAt: job.completedAt,
        remediationWorker: { dispatchMode: 'hq', state: 'spawned', spawnedAt: job.completedAt },
      }));
    }
    const liveHeads = [];
    let payload = null;
    const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
      candidate: { ...closureArgs(rootDir).candidate,
        ...(mergeable !== undefined ? { mergeable, mergeStateStatus } : {}),
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }],
      },
      fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => { liveHeads.push(head); return [reviewBody]; },
      maybeDispatchAmaCloserImpl: async (args) => { payload = args; return { dispatched: true, launchRequestId: 'lrq_hammer' }; },
    }));
    assert.equal(result.dispatched, true);
    assert.deepEqual(liveHeads, reviewBody === REQUEST_CHANGES_BODY ? [] : handoff ? [PUSHED, PUSHED] : [REVIEWED],
      'a general handoff reconciles the current head; a final-round proof reconciles the reviewed head');
    assert.equal(payload.reviewState.verdict, reviewBody === REQUEST_CHANGES_BODY ? 'request-changes' : handoff ? '' : 'comment-only');
    assert.equal(payload.reviewState.headSha, REVIEWED);
    assert.equal(payload.sharedNextAction.decision.action, 'hammer');
    assert.equal(payload.dispatchContext.targetRemediationSha, PUSHED);
    assert.equal(payload.reviewState.nonBlockingFindingCount, handoff && reviewBody !== REQUEST_CHANGES_BODY
      ? 0 : reviewBody === ZERO_FINDINGS_BODY ? 0 : 1);
    if (handoff && reviewBody !== REQUEST_CHANGES_BODY) {
      assert.equal(payload.reviewState.blockingFindingState, 'unknown', 'a general final push grants no merge proof');
    }
    assert.notEqual(payload.reviewState.headSha, payload.prMetadata.headSha);
    assert.equal(result.commentOnlyFinalRoundAwaitingCi, undefined);

    // The real closer admits exactly that payload as terminal remediation.
    const execCalls = [];
    const closerArgs = {
      ...payload,
      reviewState: { ...payload.reviewState,
        ...(blocker === 'present' ? { blockingFindingCount: 1 } : {}),
        ...(blocker === 'unknown' ? { blockingFindingState: 'unknown', blockingFindingCount: null } : {}),
      },
      cfg: { ...payload.cfg, strictNonBlockingRemediation, workerClass: 'hammer', eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: false } },
      dispatchContext: {
        ...payload.dispatchContext, rootDir, hqRoot: join(rootDir, 'hq-root'),
        hqOwnerUser: userInfo().username, currentUser: userInfo().username,
      },
      execFileImpl: async (cmd, args) => {
        execCalls.push({ cmd, args });
        return { stdout: JSON.stringify({ ticketRef: args[args.indexOf('--ticket') + 1], dispatchId: 'dispatch_hammer', launchRequestId: 'lrq_hammer' }), stderr: '' };
      },
      readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
      writeFileImpl: () => {},
      resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
      readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
      logger: { log() {}, info() {}, warn() {}, error() {} },
    };
    const dispatched = await maybeDispatchAmaCloser(closerArgs);
    // Findings are repair admission, including on the final round. They remain
    // forbidden merge authority without exact-head HAM validation.
    assert.equal(isEligibleForAmaClosure(payload.reviewState, payload.prMetadata,
      payload.cfg, { env: {} }).eligible, false);
    assert.equal(dispatched.dispatched, true, JSON.stringify(dispatched));
    if (handoff) {
      const repeated = await maybeDispatchAmaCloser({ ...closerArgs,
        readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'running' }, retryChain: [] }) });
      assert.equal(repeated.dispatched, false, 'the existing closer retains the handoff on a repeated pass');
    }
    const hammerDispatches = execCalls.filter(({ args }) => args[0] === 'dispatch' && args.includes('hammer'));
    assert.equal(hammerDispatches.length, 1, 'exactly one hammer dispatch');
    assert.ok(!execCalls.some(({ cmd, args }) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge'), 'no merge is attempted on the proof alone');
  });
}

test('a human push on top of the final round fails closed: no verdict, no hand-off', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-human-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  let payload = null;
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    candidate: { ...closureArgs(rootDir).candidate, headSha: HUMAN },
    currentRevisionRef: HUMAN,
    maybeDispatchAmaCloserImpl: async (args) => { payload = args; return { dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head'] }; },
  }));
  assert.equal(payload, null);
  assert.equal(result.nextAction.action, 'review');
  assert.equal(result.nextAction.head, HUMAN);
});

const WAITING_ROLLUPS = [
  { name: 'pending', rollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'IN_PROGRESS', conclusion: null }] },
  { name: 'empty', rollup: [] },
  { name: 'only the pipeline gate', rollup: [{ __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'PENDING' }] },
];

test('CLOSERDEADLOCK-01: a live blocking verdict on a green final-round push cannot authorize daemon merge', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-round-blocking-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedFinalRound(rootDir);
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({
      enabled: true, autonomousMergeExecutionEnabled: true,
    }) }),
    fetchLatestHeadReviewBodiesImpl: async () => [REQUEST_CHANGES_BODY],
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('a blocking verdict cannot enter daemon merge'),
    maybeDispatchAmaCloserImpl: async (args) => {
      assert.equal(args.reviewState.verdict, 'request-changes');
      assert.ok(args.reviewState.blockingFindingCount > 0);
      assert.equal(isEligibleForAmaClosure(args.reviewState, args.prMetadata, args.cfg, { env: {} }).eligible, false);
      return { dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['blocking-findings-present'] };
    },
  }));
  assert.equal(result.dispatched, false);
});

test('NXA-04: a blocking final-push handoff retains its shared observer until CI settles', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'final-successor-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const id = seedFinalRound(rootDir, { reviewBody: REQUEST_CHANGES_BODY });
  const path = join(rootDir, 'data', 'follow-up-jobs', 'completed', `${id}.json`);
  const job = JSON.parse(readFileSync(path, 'utf8'));
  delete job.finalRound;
  job.completion.finalRemediationPush = true;
  job.remediationPlan = { currentRound: 2, maxRounds: 2 };
  job.reReview = { requested: false, suppressed: 'shared-next-action', nextAction: {
    action: 'wait-for-CI', actor: 'ci', reason: 'checks-pending', head: PUSHED,
    deadline: { at: '2026-09-28T23:08:59.717Z', anchoredAt: job.completedAt },
    decisionKey: 'synthetic-decision', evidenceRefs: ['synthetic-publish'] } };
  writeFileSync(path, JSON.stringify(job));
  const observations = [];
  const observedNow = Date.parse(job.completedAt) + 60000;
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: WAITING_ROLLUPS[0].rollup },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true, autonomousMergeExecutionEnabled: true }) }),
    fetchLatestHeadReviewBodiesImpl: async () => [REQUEST_CHANGES_BODY],
    now: () => observedNow,
    observeClosureWaitImpl: async args => { observations.push(args); return { retryAfterMs: 30000, exhausted: true }; },
    maybeDispatchAmaCloserImpl: async () => { throw new Error('pending CI cannot launch the ceiling hammer'); },
  }));
  assert.equal(result.dispatched, false);
  assert.equal(result.recoveryWait, true);
  assert.equal(result.nextAction.action, 'wait-for-CI');
  assert.equal(result.nextAction.actor, 'ci');
  const closeoutObservations = observations.filter(entry => entry.reason?.startsWith('action=wait-for-CI'));
  assert.equal(closeoutObservations.length, 1);
  assert.equal(closeoutObservations[0].now, observedNow);
  assert.equal(closeoutObservations[0].headSha, PUSHED);
  assert.equal(closeoutObservations[0].waitClass, 'final-round');
  assert.equal(closeoutObservations[0].startedAt, Date.parse(job.completedAt));
  assert.deepEqual(result.boundedWait, { retryAfterMs: 30000, exhausted: true });
  assert.equal(result.needsOperator, undefined, 'an overdue report cannot refuse later work');
});

for (const { name, rollup: pendingRollup } of WAITING_ROLLUPS) {
  test(`${name} CI on a proven final-round head waits without spending the retain-loop cap`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-ci-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedFinalRound(rootDir);
    let payload = null;
    const closure = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
      candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: pendingRollup },
      now: () => PUSHED_AT_MS + 10 * 60 * 1000,
      maybeDispatchAmaCloserImpl: async (args) => {
        payload = args;
        return { dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head', 'ci-not-green'] };
      },
    }));
    assert.equal(payload, null, 'the observer does not launch terminal validation');
    assert.equal(closure.nextAction.action, 'wait-for-CI');

    const logs = [];
    for (let tick = 0; tick < 6; tick += 1) {
      const outcome = await resolveMergeAgentCoexistenceForWatcher({
        rootDir, reviewStateRow: {}, dispatchJob: {}, candidate: { headSha: PUSHED },
        repoPath: REPO, prNumber: PR, currentRevisionRef: PUSHED,
        logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
        recoveryOptions: { requestRereviewImpl: async () => ({ triggered: false }), pageImpl: async () => {} },
        maybeDispatchAmaClosureForImpl: async () => closure,
      });
      assert.equal(outcome.outcome, 'ama-pending', `tick ${tick} must not route to AWAIT_OPERATOR_ACTION`);
    }
    assert.equal(closure.nextAction.head, PUSHED);
    assert.ok(!logs.some((line) => /retain-loop cap reached/.test(line)));

    // Red CI is not a wait: it still counts toward the cap.
    const red = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
      candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'FAILURE' }] },
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head', 'ci-not-green'] }),
    }));
    assert.equal(red.commentOnlyFinalRoundAwaitingCi, undefined);
  });

  test(`${name} CI past the deadline retains the selected observer without blocking work`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'final-round-ama-ci-timeout-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedFinalRound(rootDir);
    const warnings = [];
    const closure = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
      candidate: { ...closureArgs(rootDir).candidate, statusCheckRollup: pendingRollup },
      now: () => PUSHED_AT_MS + 2 * 60 * 60 * 1000 + 1,
      logger: { log() {}, warn: (line) => warnings.push(line) },
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, skipMergeAgent: true, reason: 'not-eligible', reasons: ['stale-review-head', 'ci-not-green'] }),
    }));
    assert.equal(closure.commentOnlyFinalRoundAwaitingCi, undefined, 'the wait is no longer exempt');
    assert.equal(closure.nextAction.action, 'wait-for-CI');

    const logs = [];
    let outcome = null;
    for (let tick = 0; tick < 12 && outcome?.outcome !== 'recovery-exhausted'; tick += 1) {
      outcome = await resolveMergeAgentCoexistenceForWatcher({
        rootDir, reviewStateRow: {}, dispatchJob: {}, candidate: { headSha: PUSHED },
        repoPath: REPO, prNumber: PR, currentRevisionRef: PUSHED,
        logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
        recoveryOptions: { requestRereviewImpl: async () => ({ triggered: false }), pageImpl: async () => {},
          stuckDeadlineMs: 1000, now: () => tick * 1000 },
        maybeDispatchAmaClosureForImpl: async () => closure,
      });
    }
    assert.equal(outcome.outcome, 'ama-pending', 'overdue reporting does not invent an operator hold');
    assert.ok(!logs.some((line) => /ama.automated_recovery.exhausted/.test(line)));
  });
}
