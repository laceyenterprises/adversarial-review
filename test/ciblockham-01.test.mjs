// CIBLOCKHAM-01 (SEV1): a PR whose head fails external CI with no remediation
// job left has no owner; route it to the hammer. Operator decision, 2026-10-10:
// "Hammers judgement is final".
//
// agent-os PR 8007 (WSNODE-01): remediation round 2 of 2 pushed head c6ceb79b,
// repo-guards failed on it, and every later poll logged `ci-regression-no-job`
// and held the re-review. Nobody owned the red head.
//
// The guard tests drive the real CI admission guard; the closer tests drive the
// real maybeDispatchAmaCloser; the hand-off tests drive the real watcher hook
// and the real coexistence resolver. Only hq, gh and the pager are stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { primaryChangeFixture } from './helpers/primary-change.mjs';
import {
  _resetHammerRetryCapAlertDebounceForTests,
  HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
  maybeDispatchAmaCloser,
} from '../src/ama/dispatch-closer.mjs';
import { readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import {
  CI_BLOCKED_HAMMER_FINAL_NO_MERGE_REASON,
  CI_BLOCKED_HAMMER_PAGE_EVENT,
  HAMMER_OWNER_ROUTES,
  REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT,
  composeCiBlockedHammerPrompt,
  hammerOwnerRouteFinalOutcome,
  hammerOwnerRouteOf,
} from '../src/ama/review-cycle-cap-route.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { alertPresentationForDoc, deliverAlert } from '../src/alert-delivery.mjs';
import { latestReviewedHeadSha, maybeRouteCiBlockedToHammer } from '../src/ci-blocked-hammer.mjs';
import { guardRereviewCiBeforeReviewer } from '../src/reviewer-ci-admission.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { REREVIEW_CI_BLOCKED_STATUS } from '../src/review-statuses.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR_NUMBER = 8007;
// The 15:52Z comment-only review read REVIEWED_HEAD. Remediation round 2 of 2
// rebased and pushed RED_HEAD; repo-guards failed on it at 16:38Z.
const REVIEWED_HEAD = '20543470ec' + 'a'.repeat(30);
const RED_HEAD = 'c6ceb79b7d8a9d9faa58922e3a5c30936709f27c';
const LRQ_FIRST = 'lrq_ciblocked-first';
const LRQ_SECOND = 'lrq_ciblocked-second';
const LRQ_THIRD = 'lrq_ciblocked-third';
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';
const REPO_GUARDS_FAILURE = Object.freeze({
  name: 'repo-guards',
  state: 'FAILURE',
  workflowName: 'repo-guards',
  detailsUrl: `https://github.com/${REPO}/actions/runs/8007/job/1`,
});
const RED_CI_GATE = Object.freeze({
  state: 'failed',
  conclusion: 'FAILURE',
  headSha: RED_HEAD,
  totalExternalChecks: 3,
  failedChecks: [REPO_GUARDS_FAILURE],
  pendingChecks: [],
});
const QUIET_LOGGER = { log() {}, info() {}, warn() {}, error() {} };

function tempRoot(t, prefix) {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function guard(overrides = {}) {
  return guardRereviewCiBeforeReviewer({
    rootDir: '/tmp/ciblockham-fixture',
    repo: REPO,
    prNumber: PR_NUMBER,
    passKind: 'rereview',
    reviewerHeadSha: RED_HEAD,
    log: QUIET_LOGGER,
    now: () => '2026-10-10T17:26:00.000Z',
    inspectCiImpl: async () => RED_CI_GATE,
    ...overrides,
  });
}

// The review DB as the watcher leaves it: the comment-only review posted on
// REVIEWED_HEAD, and the re-review row parked on the unreviewed RED_HEAD.
function reviewDb(t, { postedReview = true } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  ensureReviewStateSchema(db);
  if (postedReview) {
    db.prepare(`INSERT INTO reviewer_passes
      (repo, pr_number, attempt_number, reviewer_class, pass_kind, started_at, ended_at, status,
       head_sha, gh_comment_id, body_md, body_captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(REPO, PR_NUMBER, 1, 'codex', 'first-pass', '2026-10-10T15:40:00Z', '2026-10-10T15:52:00Z',
        'completed', REVIEWED_HEAD, 'IC_8007_review', '## Verdict\nComment only', '2026-10-10T15:52:00Z');
  }
  return db;
}

const PARKED_ROW = Object.freeze({
  repo: REPO,
  pr_number: PR_NUMBER,
  review_status: REREVIEW_CI_BLOCKED_STATUS,
  reviewer_head_sha: RED_HEAD,
  revision_ref: RED_HEAD,
  failure_message: '[ci-regression-no-job] Re-review is parked',
});

function handOffDeps({ coexistence, alerts = [], calls = [] } = {}) {
  return {
    fetchMergeAgentCandidateImpl: async (repo, prNumber) => ({
      repo, prNumber, headSha: RED_HEAD, prState: 'open', labels: [], checksConclusion: 'FAILURE',
    }),
    buildMergeAgentDispatchJobImpl: (_rootDir, candidate) => ({ ...candidate, lastVerdict: 'Comment only' }),
    resolveMergeAgentCoexistenceForWatcherImpl: async (args) => {
      calls.push(args);
      return coexistence(args);
    },
    deliverAlertImpl: async (text, options) => {
      alerts.push({ text, ...options });
      return { status: 'queued', queued: true };
    },
    logger: QUIET_LOGGER,
  };
}

// ── (a) failed CI + no job → hammer dispatched, not parked forever ───────────

test('(a) failed CI with no follow-up job: the guard parks the reviewer and names the hammer as owner', async () => {
  const result = await guard({ latestJobFinder: () => null });

  assert.equal(result.proceed, false, 'reviewer admission still requires green external CI');
  assert.equal(result.reason, 'ci-regression-no-job');
  assert.equal(result.parkReview, true);
  assert.equal(result.parkReviewStatus, REREVIEW_CI_BLOCKED_STATUS);
  assert.equal(result.hammerOwner, true);
  assert.match(result.failureMessage, /^\[ci-regression-no-job\]/);
  assert.match(result.failureMessage, /repo-guards=FAILURE/);
  assert.match(result.failureMessage, /Routed to the hammer for final adjudication/);
  assert.doesNotMatch(result.failureMessage, /Push a fix or requeue remediation/);
});

test('(a) failed CI with no follow-up job: the watcher hands the red head to the hammer and pages nobody', async (t) => {
  const rootDir = tempRoot(t, 'ciblockham-dispatch-');
  const ciAdmission = await guard({ latestJobFinder: () => null });
  const alerts = [];
  const calls = [];
  const result = await maybeRouteCiBlockedToHammer({
    ciAdmission,
    rootDir,
    db: reviewDb(t),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: PARKED_ROW,
    currentRevisionRef: RED_HEAD,
    ...handOffDeps({
      alerts,
      calls,
      coexistence: () => ({
        outcome: 'ama-dispatched',
        amaClosureResult: { dispatched: true, launchRequestId: LRQ_FIRST, workerClass: 'hammer' },
      }),
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'ama-dispatched');
  assert.equal(calls.length, 1);
  const { dispatchJob, reviewStateRow } = calls[0];
  assert.equal(dispatchJob.ciBlockedHammerOwner, true);
  assert.equal(hammerOwnerRouteOf(dispatchJob), 'ci-blocked');
  assert.deepEqual(dispatchJob.ciFailedChecks, [REPO_GUARDS_FAILURE]);
  assert.equal(dispatchJob.ciBlockedReason, 'ci-regression-no-job');
  assert.equal(reviewStateRow.reviewer_head_sha, REVIEWED_HEAD,
    'the closer is pinned to the head the review read, never the unreviewed red head');
  assert.equal(reviewStateRow.review_status, REREVIEW_CI_BLOCKED_STATUS, 'the reviewer stays parked');
  assert.deepEqual(alerts, [], 'dispatching the hammer is not an operator page');
});

test('(a) without a posted review to pin, the hand-off fails closed and dispatches nothing', async (t) => {
  const calls = [];
  const result = await maybeRouteCiBlockedToHammer({
    ciAdmission: await guard({ latestJobFinder: () => null }),
    rootDir: tempRoot(t, 'ciblockham-no-reviewed-head-'),
    db: reviewDb(t, { postedReview: false }),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: PARKED_ROW,
    ...handOffDeps({ calls, coexistence: () => assert.fail('must not reach the closer') }),
  });
  assert.equal(result.handled, false);
  assert.match(result.error.message, /authoritative reviewed head unavailable/);
  assert.equal(calls.length, 0);
  assert.equal(latestReviewedHeadSha({ db: reviewDb(t), repoPath: REPO, prNumber: PR_NUMBER }), REVIEWED_HEAD);
});

test('(a) remediation rounds spent: the requeue re-stops the job and the hammer owns the red head', async () => {
  const result = await guard({
    latestJobFinder: () => ({ jobPath: '/fixture/completed/round-2.json', job: { status: 'completed' } }),
    requeueImpl: () => ({
      jobPath: '/fixture/stopped/round-2.json',
      job: { status: 'stopped', remediationPlan: { currentRound: 2, maxRounds: 2, stop: { code: 'max-rounds-reached' } } },
    }),
  });
  assert.equal(result.reason, 'ci-regression-stopped');
  assert.equal(result.hammerOwner, true);
  assert.equal(result.parkReview, true);
  assert.equal(result.jobPath, '/fixture/stopped/round-2.json');
  assert.match(result.failureMessage, /^\[ci-regression-stopped\] .*no remediation round is left to requeue/);
});

// ── (b) failed CI + requeueable job → unchanged ──────────────────────────────

test('(b) failed CI with a requeueable job is unchanged: remediation is requeued and no hammer is summoned', async (t) => {
  let requeueArgs = null;
  const ciAdmission = await guard({
    latestJobFinder: () => ({ jobPath: '/fixture/completed/round-1.json', job: { status: 'completed' } }),
    requeueImpl: (args) => {
      requeueArgs = args;
      return { jobPath: '/fixture/pending/round-1.json', job: { status: 'pending' } };
    },
  });
  assert.equal(ciAdmission.reason, 'ci-regression-requeued');
  assert.equal(ciAdmission.hammerOwner, undefined);
  assert.equal(ciAdmission.parkReview, undefined);
  assert.equal(requeueArgs.revisionRef, RED_HEAD);

  const calls = [];
  const routed = await maybeRouteCiBlockedToHammer({
    ciAdmission,
    rootDir: tempRoot(t, 'ciblockham-requeued-'),
    db: reviewDb(t),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: PARKED_ROW,
    ...handOffDeps({ calls, coexistence: () => assert.fail('a requeued remediation owns the head') }),
  });
  assert.equal(routed.handled, false);
  assert.equal(routed.reason, 'not-ci-blocked-hammer-owner');
  assert.equal(calls.length, 0);
});

test('(b) pending and green CI never route to the hammer', async () => {
  const pending = await guard({
    inspectCiImpl: async () => ({ ...RED_CI_GATE, state: 'pending', failedChecks: [],
      pendingChecks: [{ name: 'repo-guards', state: 'PENDING' }] }),
  });
  assert.equal(pending.reason, 'ci-settlement-pending');
  assert.equal(pending.hammerOwner, undefined);
  const green = await guard({ inspectCiImpl: async () => ({ ...RED_CI_GATE, state: 'green', failedChecks: [] }) });
  assert.equal(green.proceed, true);
  assert.equal(green.hammerOwner, undefined);
});

// ── the closer, driven for real ──────────────────────────────────────────────

function closerArgs(rootDir, { ciBlockedHammerOwner = true, dispatchedAt = '2026-10-10T17:30:00Z' } = {}) {
  return {
    reviewState: {
      verdict: 'comment-only',
      headSha: REVIEWED_HEAD,
      riskClass: 'medium',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      operatorApprovedEvidence: null,
      prAuthor: 'lacey-codex-agent[bot]',
      // Round 2 of 2 is spent: the orchestration reports the cycle exhausted.
      reviewCycleExhausted: true,
      completedRemediationRounds: 2,
    },
    prMetadata: {
      prNumber: PR_NUMBER,
      headSha: RED_HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'COMPLETED', conclusion: 'FAILURE' }],
      branchProtection: { requiredContexts: [] },
      author: 'lacey-codex-agent[bot]',
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low', 'medium'], highRiskRequiresTwoKey: false },
      branchProtection: { required: false },
    },
    dispatchContext: {
      rootDir,
      repo: REPO,
      prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      reviewedSha: REVIEWED_HEAD,
      targetRemediationSha: RED_HEAD,
      dispatchRecordHeadSha: REVIEWED_HEAD,
      dispatchReason: 'exhausted-final-hammer',
      ciBlockedHammerOwner,
      ciFailedChecks: ciBlockedHammerOwner ? [REPO_GUARDS_FAILURE] : [],
      riskClass: 'medium',
      requiredGateContext: 'agent-os/adversarial-gate',
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt,
      closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/wsnode-01' }),
    },
  };
}

function closerDeps({ nextLaunch = LRQ_FIRST, comments = [], alerts = [], prompts = [], workerStatus = 'succeeded' } = {}) {
  const statusProbes = [];
  const launches = [];
  return {
    statusProbes,
    launches,
    alerts,
    prompts,
    fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        statusProbes.push(args[2]);
        return { stdout: JSON.stringify({ status: workerStatus }), stderr: '' };
      }
      if (args[0] === 'dispatch') {
        launches.push(args);
        return { stdout: JSON.stringify({ dispatchId: nextLaunch, launchRequestId: nextLaunch }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: RED_HEAD, comments }),
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: (_dir, path, content) => { prompts.push({ path, content: String(content) }); },
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    deliverAlertImpl: async (text, options) => {
      alerts.push({ text, ...options });
      return { ok: true };
    },
    logger: QUIET_LOGGER,
  };
}

test('(a) the closer dispatches the hammer on the red, unreviewed head with the failing checks in its prompt', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'ciblockham-closer-');
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, LRQ_FIRST);
  assert.equal(deps.launches.length, 1);
  assert.deepEqual(deps.alerts, [], 'dispatching the hammer pages nobody');
  const prompt = deps.prompts.map((entry) => entry.content).join('\n');
  assert.match(prompt, /CIBLOCKHAM-01 — failed CI with no remediation job left: you are the owner/);
  assert.match(prompt, new RegExp(`live head \`${RED_HEAD}\``));
  assert.match(prompt, /- repo-guards: FAILURE \(https:\/\/github\.com\/laceyenterprises\/agent-os\/actions\/runs\/8007\/job\/1\)/);
  assert.match(prompt, /your dispatch does not/);
  assert.match(prompt, /`HAM closing status — no merge\.`/);
  assert.doesNotMatch(prompt, /CYCLECAPHAM-01/);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('without the CI-blocked route the same red unreviewed head parks (the PR 8007 failure)', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'ciblockham-closer-scope-');
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { ciBlockedHammerOwner: false }), ...deps });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('stale-review-head'), JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('ci-not-green'), JSON.stringify(result.reasons));
  assert.equal(deps.launches.length, 0);
});

test('the CI-blocked route never preempts a remediator that still owns the reviewed head', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'ciblockham-codex-first-');
  const args = closerArgs(rootDir);
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({
    ...args,
    reviewState: { ...args.reviewState, remediationPending: true },
    ...deps,
  });
  assert.equal(result.dispatched, false, JSON.stringify(result));
  assert.equal(deps.launches.length, 0);
});

// ── (e) hammer no-merge → final, operator page ───────────────────────────────

function noMergeClosingStatus(headSha) {
  return {
    author: { login: 'the-hammer-lacey' },
    body: [
      HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
      '',
      'HAM closing status — no merge.',
      'Final adjudication: the config ratchet failure needs a schema owner decision.',
      '',
      '<sub>',
      `HAM-Terminal-Remediation-Head: ${headSha}`,
      '</sub>',
    ].join('\n'),
  };
}

async function seedFinishedCiBlockedHammer(rootDir) {
  const first = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T17:30:00Z' }),
    ...closerDeps({ nextLaunch: LRQ_FIRST }),
  });
  assert.equal(first.dispatched, true, JSON.stringify(first));
  assert.equal(first.launchRequestId, LRQ_FIRST);
}

test('(e) a CI-blocked hammer no-merge decision is final: no retry hammer, and the closer asks for the operator', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'ciblockham-no-merge-');
  await seedFinishedCiBlockedHammer(rootDir);
  for (const dispatchedAt of ['2026-10-10T17:35:00Z', '2026-10-10T17:40:00Z']) {
    const deps = closerDeps({ nextLaunch: 'lrq_unexpected', comments: [noMergeClosingStatus(RED_HEAD)] });
    const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt }), ...deps });
    assert.equal(result.dispatched, false, JSON.stringify(result));
    assert.equal(result.reason, CI_BLOCKED_HAMMER_FINAL_NO_MERGE_REASON);
    assert.equal(result.needsOperator, true);
    assert.equal(result.launchRequestId, LRQ_FIRST);
    assert.equal(deps.launches.length, 0, `${dispatchedAt}: the no-merge decision is final`);
    assert.equal(hammerOwnerRouteFinalOutcome(result), 'hammer-no-merge');
  }
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('(e) a hammer no-merge decision pages the operator through the real coexistence resolver', async (t) => {
  const rootDir = tempRoot(t, 'ciblockham-page-');
  const alerts = [];
  const closureCalls = [];
  const result = await maybeRouteCiBlockedToHammer({
    ciAdmission: await guard({ latestJobFinder: () => null }),
    rootDir,
    db: reviewDb(t),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: PARKED_ROW,
    currentRevisionRef: RED_HEAD,
    ...handOffDeps({
      alerts,
      coexistence: (args) => resolveMergeAgentCoexistenceForWatcher({
        ...args,
        maybeDispatchAmaClosureForImpl: async (closureArgs) => {
          closureCalls.push(closureArgs);
          return {
            amaEnabled: true,
            dispatched: false,
            skipMergeAgent: true,
            reason: CI_BLOCKED_HAMMER_FINAL_NO_MERGE_REASON,
            needsOperator: true,
            launchRequestId: LRQ_FIRST,
          };
        },
      }),
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'hammer-no-merge');
  assert.equal(closureCalls.length, 1);
  assert.equal(closureCalls[0].dispatchJob.ciBlockedHammerOwner, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, CI_BLOCKED_HAMMER_PAGE_EVENT);
  assert.equal(alerts[0].payload.severity, 'SEV1');
  assert.equal(alerts[0].payload.outcome, 'hammer-no-merge');
  assert.equal(alerts[0].payload.route, 'ci-blocked');
  assert.equal(alerts[0].payload.headSha, RED_HEAD);
  assert.match(alerts[0].text, /external CI failed with no remediation job left and the hammer's final adjudication is NO MERGE/);
});

test('(e) the CI-blocked page is a SEV1 page with one outbox identity per PR head, distinct from the cap page', async (t) => {
  const rootDir = tempRoot(t, 'ciblockham-outbox-');
  const env = {
    ALERT_TO: '123456',
    ALERT_AGENT_ID: 'ops',
    ALERT_NAME: 'Adversarial Watcher Health Test',
    ALERT_CHANNEL: 'telegram',
    AGENT_OS_GBI_ALERT_BUS_URL: 'http://127.0.0.1:18799/hooks/wake',
    AGENT_OS_ALERT_DELIVERY_SCRIPT: '',
    OPENCLAW_HOOKS_TOKEN_FILE: '/secrets/hooks.token',
    ADVERSARIAL_ALERT_DELIVERY_ROOT: rootDir,
  };
  const payload = { severity: 'SEV1', repo: REPO, prNumber: PR_NUMBER, headSha: RED_HEAD,
    outcome: 'hammer-no-merge', reason: CI_BLOCKED_HAMMER_FINAL_NO_MERGE_REASON, route: 'ci-blocked' };
  const options = { env, event: CI_BLOCKED_HAMMER_PAGE_EVENT, payload,
    requestText: async () => ({ statusCode: 200, body: '{}' }) };
  const first = await deliverAlert('SEV1 no merge', options);
  const repeat = await deliverAlert('SEV1 no merge (next tick)', options);
  assert.equal(first.queued, true);
  assert.equal(repeat.queued, false, 'a repeat tick re-uses the queued page');
  assert.equal(repeat.id, first.id);
  const capPage = await deliverAlert('SEV1 no merge', { ...options, event: REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT });
  assert.notEqual(capPage.id, first.id);

  const presentation = alertPresentationForDoc({ event: CI_BLOCKED_HAMMER_PAGE_EVENT, text: 'SEV1 no merge', payload });
  assert.equal(presentation.severity, 'SEV1');
  assert.equal(presentation.headline, HAMMER_OWNER_ROUTES['ci-blocked'].headline);
  assert.match(presentation.detail, /hammer-no-merge/);
});

// ── (d) the existing hammer retry cap bounds attempts ────────────────────────

test('(d) the existing hammer retry cap bounds CI-blocked attempts per head, then pages', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'ciblockham-retry-cap-');
  await seedFinishedCiBlockedHammer(rootDir);
  // Each hammer exits without closing (no merge, no closing status): that is
  // not a decision, so the ordinary bounded re-arm applies.
  const second = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T17:35:00Z' }),
    ...closerDeps({ nextLaunch: LRQ_SECOND }),
  });
  assert.equal(second.dispatched, true, JSON.stringify(second));
  const third = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T17:40:00Z' }),
    ...closerDeps({ nextLaunch: LRQ_THIRD }),
  });
  assert.equal(third.dispatched, true, JSON.stringify(third));

  const cappedDeps = closerDeps({ nextLaunch: 'lrq_unexpected' });
  const capped = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T17:45:00Z' }),
    ...cappedDeps,
  });
  assert.equal(capped.dispatched, false);
  assert.equal(capped.reason, 'hammer-retry-cap-exhausted');
  assert.equal(capped.needsOperator, true);
  assert.equal(cappedDeps.launches.length, 0);
  assert.equal(hammerOwnerRouteFinalOutcome(capped), 'hammer-cap-exhausted');

  const pages = [];
  const routed = await maybeRouteCiBlockedToHammer({
    ciAdmission: await guard({ latestJobFinder: () => null }),
    rootDir,
    db: reviewDb(t),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: PARKED_ROW,
    currentRevisionRef: RED_HEAD,
    ...handOffDeps({ alerts: pages, coexistence: () => ({ outcome: 'await-operator', amaClosureResult: capped }) }),
  });
  assert.equal(routed.outcome, 'hammer-cap-exhausted');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].event, CI_BLOCKED_HAMMER_PAGE_EVENT);
  assert.equal(pages[0].payload.outcome, 'hammer-cap-exhausted');
  assert.equal(pages[0].payload.reason, 'hammer-retry-cap-exhausted');
});

test('dispatched, in-flight and waiting CI-blocked outcomes are not operator pages', async (t) => {
  for (const amaClosureResult of [
    { dispatched: true, launchRequestId: LRQ_FIRST },
    { reason: 'hammer-closer-in-flight' },
    { reason: 'lease-held' },
    { reason: 'failed-without-merge' },
  ]) {
    const pages = [];
    const routed = await maybeRouteCiBlockedToHammer({
      ciAdmission: await guard({ latestJobFinder: () => null }),
      rootDir: tempRoot(t, 'ciblockham-not-a-page-'),
      db: reviewDb(t),
      repoPath: REPO,
      prNumber: PR_NUMBER,
      existing: PARKED_ROW,
      ...handOffDeps({ alerts: pages, coexistence: () => ({ outcome: 'ama-pending', amaClosureResult }) }),
    });
    assert.equal(routed.handled, true, JSON.stringify(amaClosureResult));
    assert.deepEqual(pages, [], JSON.stringify(amaClosureResult));
  }
});

test('the CI-blocked prompt shares the cap route contract and caps the failing-check list', () => {
  const prompt = composeCiBlockedHammerPrompt({
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: RED_HEAD,
    failedChecks: Array.from({ length: 25 }, (_, index) => ({ name: `check-${index}`, state: 'FAILURE' })),
  });
  assert.match(prompt, /"Hammers judgement is final"/);
  assert.match(prompt, /`Resolution: withdrawn-by-hammer`/);
  assert.match(prompt, new RegExp(`\`Reviewed-Head: ${REVIEWED_HEAD}\``));
  assert.match(prompt, /- check-19: FAILURE/);
  assert.doesNotMatch(prompt, /check-20/);
  assert.match(composeCiBlockedHammerPrompt({}), /did not capture the failing check names/);
});
