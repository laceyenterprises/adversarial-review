import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { hammerWakeEligibility, requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord,
  settleRefusedHammerWake, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import classifyRescue from '../src/merge-agent-rescue-classifier.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';

const repo = 'example/repair-fixture', prNumber = 37;
const reviewed = 'a'.repeat(40), head = 'b'.repeat(40);
const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
const quiet = { log() {}, warn() {}, error() {} };
const red = [{ __typename: 'CheckRun', name: 'synthetic-ci', status: 'COMPLETED', conclusion: 'FAILURE' }];

function fixture(t, mode = 'native') {
  const rootDir = mkdtempSync(join(tmpdir(), 'ciblockham-03-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const wakes = [], launches = [];
  const args = {
    rootDir, repoPath: repo, prNumber, currentRevisionRef: head, logger: quiet,
    reviewStateRow: { repo, pr_number: prNumber, pr_state: 'open', review_status: 'ci-blocked',
      failure_message: '[ci-regression-stopped] Synthetic exhausted remediation',
      reviewer: 'claude', reviewer_login: 'synthetic-reviewer', reviewer_head_sha: reviewed,
      last_verdict: 'Comment only', risk_class: 'low', review_body: body, remediation_pending: 0 },
    dispatchJob: { ciBlockedHammerOwner: true },
    candidate: { headSha: head, prState: 'open', isDraft: false, riskClass: 'low',
      prAuthor: 'synthetic-worker', title: 'Synthetic repair', body: '', baseBranch: 'main',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: red,
      branchProtection: { requiredContexts: [] } },
    labelNames: [],
    loadConfigImpl: () => ({ getOrchestrationMode: () => mode,
      getMergeAuthorityConfig: () => ({ enabled: true, workerClass: 'hammer', strictMode: true,
        autonomousMergeExecutionEnabled: true, branchProtection: { required: false },
        eligibility: { riskClasses: ['low'] } }) }),
    resolveReviewCycleExhaustionImpl: () => ({ reviewCycleExhausted: true }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, sha) => sha === reviewed ? [body] : [],
    liveReviewRetryDelaysMs: [],
    proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
    fetchHeadCloserVerifiedCommitImpl: async () => null,
    fetchMergedProtectiveDependentsImpl: async () => [],
    fetchProtectivePredecessorStateImpl: async () => null,
    probeClosureOwnershipImpl: async () => ({ owned: false, uncertain: false }),
    observeClosureWaitImpl: async () => ({}),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible' }),
    requestEligibleHammerWakeImpl: payload => {
      const wake = requestEligibleHammerWake({ ...payload,
        requestWatcherWakeImpl: () => ({ requested: true,
          payload: { request_id: 'synthetic-wake', requested_at: '2026-01-01T00:00:00Z' } }) });
      wakes.push(wake);
      return wake;
    },
    maybeDispatchAmaCloserImpl: payload => maybeDispatchAmaCloser({ ...payload,
      dispatchContext: { ...payload.dispatchContext, hqRoot: join(rootDir, 'hq'), hqPath: 'synthetic-hq',
        currentUser: userInfo().username, hqOwnerUser: userInfo().username,
        closerTokenRollupPollDelaysMs: [], livePrProbeImpl: async () => ({ state: 'OPEN',
          headRefOid: head, headBranchExists: true, headRefName: 'synthetic-branch' }) },
      fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
      guardStackedBaseImpl: async () => null,
      execFileImpl: async (_cmd, argv) => {
        if (argv[0] === 'dispatch') {
          launches.push(argv);
          return { stdout: JSON.stringify({ ticketRef: 'HAM', dispatchId: 'synthetic-dispatch',
            launchRequestId: 'synthetic-launch' }) };
        }
        throw new Error(`Unexpected external command: ${argv[0]}`);
      },
      readLaunchRequestStatusImpl: () => ({ ok: false }),
      readPullRequestStateImpl: () => null,
      fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: head, comments: [] }),
      readTemplateImpl: () => 'Synthetic <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
      writeFileImpl() {},
      resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false }),
      readBuildCompletionProducerEvidenceImpl: () => ({ ok: false }),
      deliverAlertImpl: async () => { throw new Error('Unexpected page'); },
    }),
  };
  return { args, wakes, launches };
}

for (const mode of ['native', 'agentos']) {
  test(`${mode}: exhausted red unreviewed head wakes and launches its final hammer in one pass`, async t => {
    const { args, wakes, launches } = fixture(t, mode);
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.equal(result.launchRequestId, 'synthetic-launch');
    assert.equal(launches.length, 1);
    assert.equal(wakes[0].outcome, mode === 'native' ? 'requested' : 'skipped');
    if (mode === 'native') assert.equal(wakes[0].eligibilityReason, 'exhausted-final-hammer-ci-repair');
    const record = readAmaCloserDispatchRecord(args.rootDir, { repo, prNumber, headSha: head });
    assert.equal(record.state, 'dispatched');
    assert.equal(record.dispatchReason, 'exhausted-final-hammer');
    // Dispatch is not merge authority: red CI and stale review still refuse merge.
    const merge = evaluateMergeEligibility({ verdict: 'comment-only', requiredChecks: red,
      candidateHead: head, validatedHead: reviewed, mergeable: 'MERGEABLE',
      labels: [], leaseHeld: true, branchProtectionRequired: false });
    assert.equal(merge.eligible, false);
    assert.ok(merge.reasons.includes('ci-not-green'));
    assert.ok(merge.reasons.includes('stale-head'));
  });
}

test('native wake keeps current-head blocking verdicts and every other gate ineligible', () => {
  const context = { dispatchReason: 'exhausted-final-hammer', ciBlockedHammerOwner: true,
    reviewState: { headSha: reviewed, reviewCycleExhausted: true }, headSha: head,
    checksConclusion: 'FAILURE' };
  const stale = { eligible: false, reasons: ['verdict-not-eligible', 'ci-not-green', 'stale-head'] };
  assert.equal(hammerWakeEligibility(stale, context).eligible, true);
  const current = { eligible: false, reasons: ['verdict-not-eligible', 'ci-not-green'] };
  assert.equal(hammerWakeEligibility(current, { ...context,
    reviewState: { ...context.reviewState, headSha: head, verdict: '' } }), current,
  'an empty verdict alone does not prove this head is unreviewed');
  assert.equal(hammerWakeEligibility(current, { ...context,
    reviewState: { ...context.reviewState, headSha: head, blockingFindingCount: 1 } }), current);
  for (const reason of ['label-no-merge', 'branch-protection-missing-gate', 'primary-change-unknown', 'lease-not-held']) {
    const blocked = { eligible: false, reasons: [...stale.reasons, reason] };
    assert.equal(hammerWakeEligibility(blocked, context), blocked);
  }
  for (const patch of [{ ciBlockedHammerOwner: false }, { dispatchReason: null },
    { checksConclusion: 'PENDING' }, { reviewState: { ...context.reviewState, remediationPending: true } },
    { reviewState: { ...context.reviewState, headSha: '' } },
    { reviewState: { ...context.reviewState, reviewCycleExhausted: false } }]) {
    assert.equal(hammerWakeEligibility(stale, { ...context, ...patch }), stale);
  }
});

for (const parkedHead of [reviewed, head]) test('rescue uses the stopped exhausted row to choose a final hammer: ' + parkedHead[0], async t => {
  const { args } = fixture(t);
  args.reviewStateRow.reviewer_head_sha = parkedHead;
  args.dispatchJob = {}; // Rescue has the durable row, not the watcher's handoff flag.
  args.maybeDispatchAmaCloserImpl = async payload => {
    assert.equal(payload.dispatchContext.ciBlockedHammerOwner, true);
    return { dispatched: false, skipMergeAgent: true, reason: 'synthetic-probe' };
  };
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.closureOwner.owner, 'hammer', JSON.stringify(result));
  const rescue = classifyRescue({ closureOwner: result.closureOwner, reviewHeadSha: reviewed, headSha: head });
  assert.equal(rescue.decision, 'hammer-eligible');
  assert.equal(rescue.reason, 'ci-blocked-remediation-exhausted');
});

test('a parked row without a proven stale reviewed head retains ordinary wake admission', async t => {
  const { args, wakes, launches } = fixture(t);
  args.reviewStateRow.reviewer_head_sha = head;
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(wakes[0].outcome, 'skipped');
  assert.equal(launches.length, 1);
});

for (const recordHead of [head, reviewed]) test('a refused native handoff retires its unlaunched intent with an explicit reason: ' + recordHead[0], async t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: recordHead };
  const at = '2026-01-01T00:00:00Z';
  const intent = { ...identity, targetRemediationSha: head, reviewedSha: reviewed,
    dispatchReason: 'exhausted-final-hammer', state: 'dispatching', lastAttemptedAt: at,
    launchRequestId: null, dispatchId: null, retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  const leaseIdentity = { ...identity, headSha: head };
  acquireAmaCloserLease({ rootDir: args.rootDir, ...leaseIdentity, now: at });
  args.requestEligibleHammerWakeImpl = () => ({ outcome: 'skipped', reason: 'synthetic-hold',
    eligibilityReasons: ['synthetic-hold'] });
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, skipMergeAgent: true, reason: 'not-eligible' });
  await maybeDispatchAmaClosureFor(args);
  const record = readAmaCloserDispatchRecord(args.rootDir, identity);
  assert.equal(record.state, 'dispatch-failed');
  assert.equal(record.reason, 'wake-refused:synthetic-hold');
  assert.equal(record.retryCount, 0, 'an unlaunched handoff does not spend the dispatch retry');
  assert.equal(readAmaCloserLease(args.rootDir, leaseIdentity), null);
});

test('rescue ownership preserves explicit review handoff, active remediation and hammer caps', () => {
  const input = { reviewState: { verdict: 'comment-only', headSha: reviewed }, currentHead: head,
    checks: 'FAILURE', roundsLeft: false, ciBlockedHammerOwner: true };
  assert.equal(decideClosureOwner(input).owner, 'hammer');
  assert.equal(decideClosureOwner({ ...input, lease: { status: 'handed-to-review' },
    reviewCeilingReached: true }).owner, 'review');
  assert.equal(decideClosureOwner({ ...input, retryExhausted: true }).reason, 'hammer-retry-cap');
  assert.equal(decideClosureOwner({ ...input, lifetimeExhausted: true }).reason, 'hammer-lifetime-cap');
  assert.notEqual(decideClosureOwner({ ...input, reviewState: { ...input.reviewState,
    remediationPending: true } }).owner, 'hammer');
  assert.equal(decideClosureOwner({ ...input, roundsLeft: true }).owner, 'review');
});

test('refusal reconciliation preserves launch receipts, active work and replacement intents', t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching', lastAttemptedAt: '2026-01-01T00:00:00Z' };
  const wake = { outcome: 'skipped', eligibilityReasons: ['synthetic-hold'] };
  for (const [patch, result] of [
    [{ launchRequestId: 'synthetic-live' }, { dispatched: false }],
    [{ dispatchId: 'synthetic-receipt' }, { dispatched: false }],
    [{}, { dispatched: false, inFlight: true }],
    [{}, { dispatched: false, reason: 'lease-held' }],
    [{}, { dispatched: false, backgroundDispatch: { state: 'started' } }],
    [{ lastAttemptedAt: '2026-01-02T00:00:00Z' }, { dispatched: false }],
    [{ promptPath: 'synthetic-new-prompt' }, { dispatched: false }],
  ]) {
    updateAmaCloserDispatchRecord(args.rootDir, identity, () => ({ ...intent, ...patch }));
    settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent, wake, result });
    assert.equal(readAmaCloserDispatchRecord(args.rootDir, identity).state, 'dispatching');
  }
});
