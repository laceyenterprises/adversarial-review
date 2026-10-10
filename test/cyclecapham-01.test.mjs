// CYCLECAPHAM-01 (SEV1): a PR at the review cycle cap goes to the hammer for a
// final decision, not to the operator. Operator decisions, 2026-10-10:
//   "Hammers judgement is final"
//   "they were mine" (the day's hand merges, including agent-os PR 7956)
// agent-os PR 7956 (LAC-1928) hit the cap after 5 review-then-remediate cycles,
// was labelled `reviewer-cycle-cap-reached` with "operator attention required",
// and sat ~10h at CHANGES_REQUESTED (last verdict 04:35Z) until a 14:51Z hand
// merge.
//
// The closer tests drive the real maybeDispatchAmaCloser; the hand-off tests
// drive the real watcher hook and the real coexistence resolver. Only hq, gh
// and the pager are stubbed.

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
  isHammerRemediableEligibilityMiss,
  maybeDispatchAmaCloser,
} from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import {
  HAMMER_WITHDRAWN_RESOLUTION,
  REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON,
  REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT,
  composeReviewCycleCapHammerPrompt,
  reviewCycleCapHammerFinalOutcome,
} from '../src/ama/review-cycle-cap-route.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { alertPresentationForDoc, deliverAlert } from '../src/alert-delivery.mjs';
import { maybeRouteReviewCycleCapToHammer } from '../src/review-cycle-cap-hammer.mjs';
import {
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  buildReviewCycleCapEscalationComment,
  ensureReviewCycleCapSchema,
  markReviewCycleEscalated,
  recordReviewCycleVerdict,
} from '../src/review-cycle-cap.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR_NUMBER = 7956;
// The latest Changes Requested review (04:35Z) was on REVIEWED_HEAD; the last
// remediation push REMEDIATED_HEAD is the head the watcher would have reviewed
// next when the cap tripped. HAM_HEAD is the hammer's own commit on top.
const REVIEWED_HEAD = '7956aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMEDIATED_HEAD = '7956bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HAM_HEAD = '7956cccccccccccccccccccccccccccccccccccc';
const LRQ_FIRST = 'lrq_cyclecap-first';
const LRQ_SECOND = 'lrq_cyclecap-second';
const LRQ_THIRD = 'lrq_cyclecap-third';
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';
const CAP_PAUSED_ROW = Object.freeze({
  repo: REPO,
  pr_number: PR_NUMBER,
  review_status: 'failed',
  reviewer_head_sha: REVIEWED_HEAD,
  failure_message: '[review-cycle-cap] 5 successive review/remediation cycles without converging; '
    + 'routed to the hammer for final adjudication (no further review cycle)',
});
const QUIET_LOGGER = { log() {}, info() {}, warn() {}, error() {} };

function tempRoot(t, prefix) {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

// ── wording ──────────────────────────────────────────────────────────────────

test('the cap comment routes the PR to the hammer for final adjudication, not to the operator', () => {
  const body = buildReviewCycleCapEscalationComment({
    cap: 5,
    recentVerdicts: [{ verdict_at: '2026-10-10T04:35:00Z', verdict_summary: '## Summary\nChanges Requested' }],
  });
  assert.match(body, /Review cycle cap reached — routed to the hammer for final adjudication/);
  assert.match(body, /no further\nreview-then-remediate cycle will start/);
  assert.match(body, /`withdrawn-by-hammer` with exact-head evidence/);
  assert.match(body, /Its decision is final/);
  assert.match(body, /paged only if the hammer\nrecords a no-merge decision or exhausts its bounded retry cap/);
  assert.doesNotMatch(body, /operator attention required/i);
  assert.doesNotMatch(body, /Please choose one/);
  assert.equal(HAMMER_WITHDRAWN_RESOLUTION, 'withdrawn-by-hammer', 'one record shape with HAMFINAL-01');
});

test('the cap prompt makes the hammer the final adjudicator over the latest review and cycle history', () => {
  const prompt = composeReviewCycleCapHammerPrompt({
    reviewedSha: REVIEWED_HEAD,
    targetRemediationSha: REMEDIATED_HEAD,
    cap: 5,
    history: [
      { verdict_at: '2026-10-10T02:10:00Z', head_sha: 'a'.repeat(40), verdict_summary: 'cycle four' },
      { verdict_at: '2026-10-10T04:35:00Z', head_sha: REVIEWED_HEAD, verdict_summary: 'Changes Requested' },
    ],
  });
  assert.match(prompt, /you are the final adjudicator/);
  assert.match(prompt, /Do not request another\nadversarial review/);
  assert.match(prompt, new RegExp(`latest adversarial review on \`${REVIEWED_HEAD}\``));
  assert.match(prompt, /`Resolution: withdrawn-by-hammer`/);
  assert.match(prompt, /`HAM closing status — no merge\.`/);
  assert.match(prompt, /2026-10-10T02:10:00Z @aaaaaaaaaaaa: cycle four\n- 2026-10-10T04:35:00Z @7956aaaaaaaa: Changes Requested/);
});

// ── cap reached → hammer dispatched, not an operator page ────────────────────

function cycleCapDb() {
  const db = new Database(':memory:');
  ensureReviewCycleCapSchema(db);
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    recordReviewCycleVerdict(db, {
      repo: REPO,
      prNumber: PR_NUMBER,
      headSha: cycle === 5 ? REVIEWED_HEAD : String(cycle).repeat(40),
      verdictAt: `2026-10-10T0${cycle - 1}:35:00Z`,
      verdictSummary: `## Summary\nCycle ${cycle}: Changes Requested`,
    });
  }
  return db;
}

function handOffDeps({ coexistence, alerts = [], calls = [] } = {}) {
  return {
    fetchMergeAgentCandidateImpl: async (repo, prNumber) => ({
      repo, prNumber, headSha: REMEDIATED_HEAD, prState: 'open', labels: [{ name: REVIEWER_CYCLE_CAP_REACHED_LABEL }],
    }),
    buildMergeAgentDispatchJobImpl: (_rootDir, candidate) => ({ ...candidate, lastVerdict: 'Request changes' }),
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

test('cap reached: the watcher hands the PR to the hammer with the cycle history and pages nobody', async (t) => {
  const rootDir = tempRoot(t, 'cyclecapham-dispatch-');
  const alerts = [];
  const calls = [];
  const result = await maybeRouteReviewCycleCapToHammer({
    rootDir,
    db: cycleCapDb(),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: CAP_PAUSED_ROW,
    currentRevisionRef: REMEDIATED_HEAD,
    cap: 5,
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
  const { dispatchJob, reviewStateRow, labelNames } = calls[0];
  assert.equal(dispatchJob.reviewCycleCapReached, true);
  assert.equal(dispatchJob.reviewCycleCap, 5);
  assert.deepEqual(dispatchJob.reviewCycleHistory.map((row) => row.verdict_count), [1, 2, 3, 4, 5]);
  assert.equal(dispatchJob.reviewCycleHistory.at(-1).head_sha, REVIEWED_HEAD);
  assert.equal(reviewStateRow, CAP_PAUSED_ROW);
  assert.deepEqual(labelNames, [REVIEWER_CYCLE_CAP_REACHED_LABEL]);
  assert.deepEqual(alerts, [], 'reaching the cap is not an operator page');
});

test('steady state: the re-armed row keeps routing while the cap label and the watcher escalation marker stand', async (t) => {
  const rootDir = tempRoot(t, 'cyclecapham-steady-');
  const db = cycleCapDb();
  // Once the head moves past the last reviewed head the watcher re-arms the
  // `failed` cap row to `pending`; the cap label keeps the review paused.
  const rearmedRow = { repo: REPO, pr_number: PR_NUMBER, review_status: 'pending', reviewer_head_sha: REMEDIATED_HEAD };
  const route = (overrides) => maybeRouteReviewCycleCapToHammer({
    rootDir,
    db,
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: rearmedRow,
    labelNames: [REVIEWER_CYCLE_CAP_REACHED_LABEL],
    ...overrides,
  });
  const calls = [];
  const deps = handOffDeps({ calls, coexistence: () => ({ outcome: 'ama-pending', amaClosureResult: { reason: 'hammer-closer-in-flight' } }) });

  // A hand-applied label without the watcher's escalation marker summons nothing.
  assert.equal((await route(deps)).reason, 'not-review-cycle-cap-paused');
  assert.equal(calls.length, 0);

  markReviewCycleEscalated(db, { repo: REPO, prNumber: PR_NUMBER, headSha: REVIEWED_HEAD, escalatedAt: '2026-10-10T04:36:00Z' });
  const routed = await route(deps);
  assert.equal(routed.handled, true);
  assert.equal(routed.outcome, 'ama-pending');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dispatchJob.reviewCycleCapReached, true);

  assert.equal((await route({ ...deps, labelNames: [REVIEWER_CYCLE_CAP_REACHED_LABEL, 'paused-for-redesign'] })).handled, false);
  assert.equal(calls.length, 1);
});

test('an operator-selected paused-for-redesign pause is not routed to the hammer', async (t) => {
  const rootDir = tempRoot(t, 'cyclecapham-redesign-');
  const calls = [];
  const result = await maybeRouteReviewCycleCapToHammer({
    rootDir,
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: {
      ...CAP_PAUSED_ROW,
      failure_message: '[review-cycle-cap] operator selected paused-for-redesign; automatic review remains paused for redesign',
    },
    ...handOffDeps({ calls, coexistence: () => assert.fail('must not route') }),
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not-review-cycle-cap-paused');
  assert.equal(calls.length, 0);
});

// The closer, driven for real.
function closerArgs(rootDir, { reviewCycleCapReached = true, dispatchedAt = '2026-10-10T05:00:00Z', headSha = REMEDIATED_HEAD } = {}) {
  return {
    reviewState: {
      verdict: 'request-changes',
      headSha: REVIEWED_HEAD,
      riskClass: 'medium',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 2,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'lacey-codex-agent[bot]',
      // What the orchestration sets for a `reviewCycleCapReached` dispatch job.
      reviewCycleExhausted: true,
      completedRemediationRounds: 5,
    },
    prMetadata: {
      prNumber: PR_NUMBER,
      headSha,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [REVIEWER_CYCLE_CAP_REACHED_LABEL],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
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
      targetRemediationSha: headSha,
      dispatchRecordHeadSha: REVIEWED_HEAD,
      dispatchReason: 'exhausted-final-hammer',
      reviewCycleCapReached,
      reviewCycleCap: 5,
      reviewCycleHistory: [{ verdict_at: '2026-10-10T04:35:00Z', head_sha: REVIEWED_HEAD, verdict_summary: 'Changes Requested' }],
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
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/lac-1928' }),
    },
  };
}

function closerDeps({ nextLaunch = LRQ_FIRST, comments = [], alerts = [], prompts = [] } = {}) {
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
        return { stdout: JSON.stringify({ status: 'succeeded' }), stderr: '' };
      }
      if (args[0] === 'dispatch') {
        launches.push(args);
        return { stdout: JSON.stringify({ dispatchId: nextLaunch, launchRequestId: nextLaunch }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: REMEDIATED_HEAD, comments }),
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

test('cap reached: the closer dispatches the hammer on the unreviewed remediation head', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'cyclecapham-closer-');
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, LRQ_FIRST);
  assert.equal(deps.launches.length, 1);
  assert.deepEqual(deps.alerts, [], 'dispatching the hammer pages nobody');
  const prompt = deps.prompts.map((entry) => entry.content).join('\n');
  assert.match(prompt, /CYCLECAPHAM-01 — review cycle cap: you are the final adjudicator/);
  assert.match(prompt, new RegExp(`live\\s+head \`${REMEDIATED_HEAD}\``));
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('without the cap route the same unreviewed head still parks for review (the carve-out is scoped)', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'cyclecapham-closer-scope-');
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { reviewCycleCapReached: false }),
    ...deps,
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('stale-review-head'), JSON.stringify(result.reasons));
  assert.equal(deps.launches.length, 0);

  assert.equal(isHammerRemediableEligibilityMiss(
    ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-present'],
    { reviewCycleExhausted: true, reviewCycleCapReached: true },
  ), true);
  assert.equal(isHammerRemediableEligibilityMiss(
    ['stale-review-head', 'verdict-not-settled-success', 'blocking-findings-present'],
    { reviewCycleExhausted: true },
  ), false);
});

test('cap route never preempts a remediator that still owns the reviewed head', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'cyclecapham-codex-first-');
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

// ── the hammer merges on the head it adjudicated ─────────────────────────────

function hamCertification({ findings, remediated }) {
  const auditBody = [
    `HAM audit: ${findings.map((finding) => `${finding.title} in ${finding.file}`).join('; ')}.`,
    `Resolution: ${HAMMER_WITHDRAWN_RESOLUTION}`,
    'Finding-Reviewed-Head: ' + REVIEWED_HEAD,
    '```',
    '$ node --test test/lease.test.mjs',
    '# pass 12',
    '```',
    'Doc-currency: not applicable for changed files src/lease.mjs.',
  ].join('\n');
  const trailers = {
    'Worker-Class': 'hammer',
    'Worker-Ticket': 'HAM',
    'Reviewed-Head': REVIEWED_HEAD,
    'Closed-By': 'hammer (adversarial-pipe-mode)',
    'Remediated-Findings': remediated,
  };
  return {
    hamTerminalRemediation: {
      active: true,
      ticket: 'HAM',
      // The hammer's commit sits on the last remediation push, not on the
      // reviewed head; the Reviewed-Head trailer binds it to the review.
      commit: { sha: HAM_HEAD, primaryChange: primaryChangeFixture(HAM_HEAD), parentSha: REMEDIATED_HEAD, trailers },
      auditComment: { body: auditBody, docCurrency: { status: 'not_applicable', changedFiles: ['src/lease.mjs'] }, findings },
    },
    hamTerminalRemediationGroundTruth: {
      commit: {
        sha: HAM_HEAD,
        primaryChange: primaryChangeFixture(HAM_HEAD),
        parentSha: REMEDIATED_HEAD,
        author: 'hammer-worker',
        changedFiles: ['src/lease.mjs'],
        trailers,
      },
      auditComment: { body: auditBody, author: 'hammer-worker', createdAt: '2026-10-10T05:20:00Z', id: 'IC_ham_audit' },
    },
  };
}

function capReviewStateAndPr() {
  const { reviewState, prMetadata, cfg } = closerArgs('/unused', { headSha: HAM_HEAD });
  return { reviewState, prMetadata, cfg };
}

test('the hammer merges its adjudicated head when it fixes one finding and withdraws the other as false', () => {
  const { reviewState, prMetadata, cfg } = capReviewStateAndPr();
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
    env: {},
    ...hamCertification({
      findings: [
        { title: 'Lease is never released on abort', blocking: true, file: 'src/lease.mjs', addressed: true },
        { title: 'Race on the retry counter', blocking: true, file: 'src/retry.mjs', addressed: true,
          resolution: HAMMER_WITHDRAWN_RESOLUTION },
      ],
      remediated: '2 addressed (2 blocking, 0 non-blocking)',
    }),
  });
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.trace.headMatch.current, HAM_HEAD, 'the merge predicate binds the hammer head, with no new review');
  assert.equal(result.trace.finalHammer.active, true);
  assert.deepEqual(result.trace.blockLabels, [], 'reviewer-cycle-cap-reached is not a merge hard stop');
});

test('the hammer merges its adjudicated head when it judges every remaining finding false', () => {
  const { reviewState, prMetadata, cfg } = capReviewStateAndPr();
  const result = isEligibleForAmaClosure({ ...reviewState, blockingFindingCount: 1 }, prMetadata, cfg, {
    env: {},
    ...hamCertification({
      findings: [{ title: 'Race on the retry counter', blocking: true, file: 'src/retry.mjs', addressed: true,
        resolution: HAMMER_WITHDRAWN_RESOLUTION }],
      remediated: '1 addressed (1 blocking, 0 non-blocking)',
    }),
  });
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
  assert.equal(result.trace.headMatch.current, HAM_HEAD);
});

test('no new gate and no free pass: the cap alone does not certify the unreviewed head', () => {
  const { reviewState, prMetadata, cfg } = closerArgs('/unused');
  const result = isEligibleForAmaClosure(reviewState, prMetadata, cfg, { env: {} });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('stale-review-head'), JSON.stringify(result.reasons));
});

// ── a hammer no-merge decision is final and pages the operator ───────────────

function noMergeClosingStatus(headSha) {
  return {
    author: { login: 'the-hammer-lacey' },
    body: [
      HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
      '',
      'HAM closing status — no merge.',
      'Final adjudication: finding 1 (lease never released on abort) is real and needs a schema change.',
      '',
      '<sub>',
      `HAM-Terminal-Remediation-Head: ${headSha}`,
      '</sub>',
    ].join('\n'),
  };
}

// The first cap-route hammer, launched by the real closer on the cap tick. Its
// LRQ then reports `succeeded` on every later status probe.
async function seedFinishedCapHammer(rootDir) {
  const deps = closerDeps({ nextLaunch: LRQ_FIRST });
  const first = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T05:00:00Z' }),
    ...deps,
  });
  assert.equal(first.dispatched, true, JSON.stringify(first));
  assert.equal(first.launchRequestId, LRQ_FIRST);
}

test('a cap-route hammer no-merge decision is final: no retry hammer, and the closer asks for the operator', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'cyclecapham-no-merge-');
  await seedFinishedCapHammer(rootDir);
  const comments = [noMergeClosingStatus(REMEDIATED_HEAD)];

  for (const dispatchedAt of ['2026-10-10T05:05:00Z', '2026-10-10T05:07:00Z']) {
    const deps = closerDeps({ nextLaunch: 'lrq_unexpected', comments });
    const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt }), ...deps });
    assert.equal(result.dispatched, false, JSON.stringify(result));
    assert.equal(result.reason, REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON);
    assert.equal(result.needsOperator, true);
    assert.equal(result.launchRequestId, LRQ_FIRST);
    assert.deepEqual(deps.statusProbes, [LRQ_FIRST]);
    assert.equal(deps.launches.length, 0, `${dispatchedAt}: the no-merge decision is final`);
  }
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('off the cap route, the same no-merge outcome keeps the ordinary bounded retry (HAMBG-02 unchanged)', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'cyclecapham-no-merge-scope-');
  await seedFinishedCapHammer(rootDir);
  const deps = closerDeps({ nextLaunch: LRQ_SECOND, comments: [noMergeClosingStatus(REMEDIATED_HEAD)] });
  const args = closerArgs(rootDir, { reviewCycleCapReached: false, dispatchedAt: '2026-10-10T05:05:00Z' });
  const result = await maybeDispatchAmaCloser({
    ...args,
    // The #7334 shape: a self-certified stale head, outside the cap route.
    dispatchContext: { ...args.dispatchContext, allowStaleReviewHeadHammerResume: true },
    ...deps,
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, LRQ_SECOND);
  assert.deepEqual(deps.statusProbes, [LRQ_FIRST]);
});

test('a hammer no-merge decision pages the operator through the real coexistence resolver', async (t) => {
  const rootDir = tempRoot(t, 'cyclecapham-page-');
  const alerts = [];
  const closureCalls = [];
  const result = await maybeRouteReviewCycleCapToHammer({
    rootDir,
    db: cycleCapDb(),
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: CAP_PAUSED_ROW,
    currentRevisionRef: REMEDIATED_HEAD,
    cap: 5,
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
            reason: REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON,
            needsOperator: true,
            launchRequestId: LRQ_FIRST,
          };
        },
      }),
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, 'hammer-no-merge');
  assert.equal(closureCalls.length, 1, 'neither recovery nor the orphan watchdog re-dispatches a final decision');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT);
  assert.equal(alerts[0].payload.severity, 'SEV1');
  assert.equal(alerts[0].payload.outcome, 'hammer-no-merge');
  assert.equal(alerts[0].payload.headSha, REMEDIATED_HEAD);
  assert.match(alerts[0].text, /hammer's final adjudication is NO MERGE/);
});

test('the review-cycle-cap page is a SEV1 page with one outbox identity per PR head', async (t) => {
  const rootDir = tempRoot(t, 'cyclecapham-outbox-');
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
  const payload = { severity: 'SEV1', repo: REPO, prNumber: PR_NUMBER, headSha: REMEDIATED_HEAD,
    outcome: 'hammer-no-merge', reason: REVIEW_CYCLE_CAP_HAMMER_FINAL_NO_MERGE_REASON };
  const options = { env, event: REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT, payload,
    requestText: async () => ({ statusCode: 200, body: '{}' }) };
  const first = await deliverAlert('SEV1 no merge', options);
  const repeat = await deliverAlert('SEV1 no merge (next tick)', options);
  assert.equal(first.queued, true);
  assert.equal(repeat.queued, false, 'a repeat tick re-uses the queued page');
  assert.equal(repeat.id, first.id);
  const otherHead = await deliverAlert('SEV1 no merge', { ...options, payload: { ...payload, headSha: HAM_HEAD } });
  assert.notEqual(otherHead.id, first.id);

  const presentation = alertPresentationForDoc({ event: REVIEW_CYCLE_CAP_HAMMER_PAGE_EVENT, text: 'SEV1 no merge', payload });
  assert.equal(presentation.severity, 'SEV1');
  assert.match(presentation.detail, /hammer-no-merge/);
});

// ── the hammer retry cap still bounds attempts ───────────────────────────────

test('the existing hammer retry cap still bounds cap-route attempts per head, then pages', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'cyclecapham-retry-cap-');
  await seedFinishedCapHammer(rootDir);
  const alerts = [];
  // Each hammer exits without closing (no merge, no closing status): that is
  // not a decision, so the ordinary bounded re-arm applies.
  const first = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T05:05:00Z' }),
    ...closerDeps({ nextLaunch: LRQ_SECOND, alerts }),
  });
  assert.equal(first.dispatched, true, JSON.stringify(first));
  const second = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T05:10:00Z' }),
    ...closerDeps({ nextLaunch: LRQ_THIRD, alerts }),
  });
  assert.equal(second.dispatched, true, JSON.stringify(second));

  const thirdDeps = closerDeps({ nextLaunch: 'lrq_unexpected', alerts });
  const capped = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T05:15:00Z' }),
    ...thirdDeps,
  });
  assert.equal(capped.dispatched, false);
  assert.equal(capped.reason, 'hammer-retry-cap-exhausted');
  assert.equal(capped.needsOperator, true);
  assert.equal(thirdDeps.launches.length, 0);
  assert.equal(reviewCycleCapHammerFinalOutcome(capped), 'hammer-cap-exhausted');

  const pages = [];
  const routed = await maybeRouteReviewCycleCapToHammer({
    rootDir,
    repoPath: REPO,
    prNumber: PR_NUMBER,
    existing: CAP_PAUSED_ROW,
    currentRevisionRef: REMEDIATED_HEAD,
    ...handOffDeps({ alerts: pages, coexistence: () => ({ outcome: 'await-operator', amaClosureResult: capped }) }),
  });
  assert.equal(routed.outcome, 'hammer-cap-exhausted');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].payload.outcome, 'hammer-cap-exhausted');
  assert.equal(pages[0].payload.reason, 'hammer-retry-cap-exhausted');
});

test('dispatched, in-flight and waiting outcomes are not operator pages', () => {
  for (const result of [
    { dispatched: true },
    { reason: 'hammer-closer-in-flight' },
    { reason: 'lease-held' },
    { reason: 'not-eligible', reasons: ['ci-not-green'] },
    { reason: 'failed-without-merge' },
    null,
  ]) {
    assert.equal(reviewCycleCapHammerFinalOutcome(result), null, JSON.stringify(result));
  }
});
