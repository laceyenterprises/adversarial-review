import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { hammerWakeEligibility, requestEligibleHammerWake } from '../src/hammer-wake.mjs';
import { amaCloserDispatchFilePath, maybeDispatchAmaCloser, readAmaCloserDispatchRecord,
  settleRefusedHammerWake, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import classifyRescue from '../src/merge-agent-rescue-classifier.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { decideClosureOwner } from '../src/ama/closure-owner.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { routeCappedReviewToClosure } from '../src/hamclose-review-admission.mjs';
import { classifyRereviewWakeOutcome, requestRereviewWake, consumeRereviewWakes, rereviewWakeBacklog } from '../src/rereview-wake.mjs';

const repo = 'example/repair-fixture', prNumber = 37;
const reviewed = 'a'.repeat(40), head = 'b'.repeat(40);
const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
const quiet = { log() {}, warn() {}, error() {} };
const red = [{ __typename: 'CheckRun', name: 'synthetic-ci', status: 'COMPLETED', conclusion: 'FAILURE' }];
const failedConclusions = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR'];

function fixture(t, mode = 'native', liveHammer = false) {
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
        if (liveHammer && argv[0] === 'dispatch' && argv[1] === 'status') {
          return { stdout: JSON.stringify({ status: 'running', ticketRef: 'HAM' }) };
        }
        if (argv[0] === 'dispatch') {
          launches.push(argv);
          return { stdout: JSON.stringify({ ticketRef: 'HAM', dispatchId: 'synthetic-dispatch',
            launchRequestId: 'synthetic-launch' }) };
        }
        throw new Error(`Unexpected external command: ${argv[0]}`);
      },
      readLaunchRequestStatusImpl: () => liveHammer
        ? ({ ok: true, row: { status: 'running', ticket_ref: 'HAM' } }) : ({ ok: false }),
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

// CEILINGPUSH-01 exercises the green sibling of the exhausted CI handoff,
// through the same real orchestration, wake, dispatcher, lease and merge gates.
const blockingBody = '## Blocking issues\n- **Validate input**\n  - **File:** `src/fixture.mjs`\n  - **Lines:** `1`\n  - **Problem:** unchecked input\n  - **Recommended fix:** validate it\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes';
function ceilingFixture(t) {
  const f = fixture(t, 'native', true);
  delete f.args.dispatchJob.ciBlockedHammerOwner;
  Object.assign(f.args.reviewStateRow, { review_status: 'posted', last_verdict: 'Request changes',
    review_body: blockingBody, rereview_reason: 'system-review-ceiling-closure',
    posted_at: '2026-01-01T00:00:00Z' });
  f.args.candidate.statusCheckRollup = red.map(check => ({ ...check, conclusion: 'SUCCESS' }));
  f.args.resolveReviewCycleExhaustionImpl = () => ({ reviewCycleExhausted: false });
  f.args.fetchLatestHeadReviewBodiesImpl = async (_repo, _pr, sha) => sha === reviewed ? [blockingBody] : [];
  return f;
}

test('CEILINGPUSH-01: moved green head dispatches one terminal hammer with the older blocking findings', async t => {
  const { args, wakes, launches } = ceilingFixture(t);
  const dispatch = args.maybeDispatchAmaCloserImpl;
  args.maybeDispatchAmaCloserImpl = payload => {
    assert.equal(payload.reviewState.headSha, reviewed);
    assert.equal(payload.reviewState.verdict, 'request-changes');
    assert.equal(payload.reviewState.blockingFindingCount, 1);
    assert.equal(payload.reviewState.reviewCycleExhausted, true);
    assert.equal(payload.dispatchContext.reviewCycleCapReached, true);
    assert.equal(payload.dispatchContext.reviewedSha, reviewed);
    assert.equal(payload.dispatchContext.targetRemediationSha, head);
    return dispatch(payload);
  };
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(launches.length, 1);
  assert.equal(wakes[0].outcome, 'requested');
  assert.equal(wakes[0].eligibilityReason, 'review-ceiling-terminal-remediation');
  assert.equal(readAmaCloserLease(args.rootDir, { repo, prNumber, headSha: head }).status, 'dispatched');
  await maybeDispatchAmaClosureFor(args);
  assert.equal(launches.length, 1, 'a live lease prevents duplicate hammers');
  assert.equal(wakes[1].outcome, 'duplicate');
  const merge = evaluateMergeEligibility({ verdict: 'request-changes',
    requiredChecks: args.candidate.statusCheckRollup, candidateHead: head, validatedHead: reviewed,
    mergeable: 'MERGEABLE', labels: [], leaseHeld: true, branchProtectionRequired: false });
  assert.deepEqual(merge.reasons, ['verdict-not-eligible', 'stale-head']);
});

test('CEILINGPUSH-01: repeated ceiling observations restore the review once and settle closeout as hammer-owned', t => {
  const { args } = ceilingFixture(t);
  const db = openReviewStateDb(args.rootDir); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,reviewer_head_sha,posted_at)
    VALUES (?,?,'2026-01-01','claude','posted',?,'2026-01-01')`).run(repo, prNumber, reviewed);
  db.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,started_at,
    ended_at,status,head_sha,body_md) VALUES (?,?,1,'claude','first-pass','2026-01-01','2026-01-01',
    'completed',?,?)`).run(repo, prNumber, reviewed, blockingBody);
  const stmtGetReviewRow = db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?');
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    assert.notEqual(sql, 'SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?', 'reuse the cached row statement');
    return prepare(sql);
  };
  const logs = [], route = { db, stmtGetReviewRow, repo, prNumber, headSha: head, ceiling: 1,
    logger: { log: line => logs.push(JSON.parse(line)) } };
  const original = db.prepare('SELECT * FROM reviewed_prs').get();
  for (const row of [original, original, db.prepare('SELECT * FROM reviewed_prs').get()]) {
    assert.equal(routeCappedReviewToClosure({ ...route, row }), true);
  }
  const routed = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(routeCappedReviewToClosure({ ...route, row: routed }), true);
  assert.equal(logs.length, 1, 'including a stale snapshot must not repeat posted -> posted');
  assert.equal(routeCappedReviewToClosure({ ...route, row: routed, headSha: reviewed }), false);
  const at = '2026-01-01T00:01:00Z';
  requestRereviewWake({ rootDir: args.rootDir, repo, prNumber, headSha: head,
    reason: 'remediation-closeout', requestedAt: at, db, log: quiet,
    requestWatcherWakeImpl: () => ({ requested: true }) });
  const consumed = consumeRereviewWakes({ rootDir: args.rootDir, repo, prNumber,
    reviewRow: routed, currentHeadSha: head, at, db, log: quiet });
  assert.equal(consumed.skipped, 1);
  assert.equal(consumed.completed, 0);
  assert.equal(consumed.outcomes[0].reason, 'review-ceiling-hammer-owned');
  assert.equal(rereviewWakeBacklog({ rootDir: args.rootDir }).pending, 0);
});

test('CEILINGPUSH-01: an unavailable closure records its reason and pages once within the existing wait bound', async t => {
  const { args } = ceilingFixture(t);
  const pages = [], observations = [];
  let clock = 0;
  args.now = () => clock;
  args.env = { AMA_CLOSURE_WAIT_BOUND_MS: '100' };
  args.observeClosureWaitImpl = input => {
    observations.push(input.reason);
    return observeClosureWait({ ...input, now: clock, pageImpl: async text => pages.push(text) });
  };
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false,
    reason: 'not-eligible', reasons: ['branch-protection-missing-gate'] });
  for (clock of [0, 101, 102]) await maybeDispatchAmaClosureFor(args);
  assert.equal(pages.length, 1);
  assert.match(pages[0], /branch-protection-missing-gate/);
  assert.ok(observations.every(reason => reason.includes('branch-protection-missing-gate')));
});

test('CEILINGPUSH-01: same-head and ordinary wakes retain their existing review admission semantics', () => {
  const eligibility = { eligible: false, reasons: ['verdict-not-eligible', 'stale-head'] };
  const options = { dispatchReason: 'exhausted-final-hammer', reviewCeilingReached: true,
    reviewState: { headSha: reviewed, reviewCycleExhausted: true }, headSha: head };
  const ceilingOptions = [options, { ...options, dispatchReason: null },
    { ...options, dispatchReason: 'review-ceiling-terminal-remediation',
      reviewState: { headSha: reviewed, reviewCycleExhausted: false } }];
  for (const input of ceilingOptions) {
    assert.equal(hammerWakeEligibility(eligibility, input).eligible, true);
    for (const reason of ['ci-not-green', 'branch-protection-missing-gate', 'label-do-not-merge',
      'labels-unavailable', 'primary-change-reverted', 'lease-not-held']) {
      const held = { eligible: false, reasons: [...eligibility.reasons, reason] };
      assert.equal(hammerWakeEligibility(held, input), held);
    }
  }
  for (const changed of [{ headSha: reviewed }, { reviewCeilingReached: false },
    { reviewCeilingReached: false, dispatchReason: null },
    { reviewCeilingReached: false, reviewState: { headSha: reviewed, reviewCycleExhausted: false } },
    { reviewState: { ...options.reviewState, remediationPending: true } }]) {
    assert.equal(hammerWakeEligibility(eligibility, { ...options, ...changed }), eligibility);
  }
  const record = { headSha: head, reason: 'remediation-closeout', requestedAt: '2026-01-01T00:00:00Z' };
  const row = { review_status: 'posted', rereview_reason: 'system-review-ceiling-closure',
    reviewer_head_sha: head, posted_at: '2026-01-01T00:01:00Z' };
  assert.equal(classifyRereviewWakeOutcome({ record, reviewRow: row, currentHeadSha: head }).reason, 'rereview-posted');
  assert.equal(classifyRereviewWakeOutcome({ record, reviewRow: { ...row, reviewer_head_sha: reviewed },
    currentHeadSha: 'c'.repeat(40) }).reason, 'head-superseded');
});

for (const mode of ['native', 'agentos']) {
  for (const conclusion of failedConclusions) test(`${mode}: exhausted ${conclusion} unreviewed head wakes and launches its final hammer in one pass`, async t => {
    const { args, wakes, launches } = fixture(t, mode);
    const checks = red.map(check => ({ ...check, conclusion }));
    args.candidate.statusCheckRollup = checks;
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
    const merge = evaluateMergeEligibility({ verdict: 'comment-only', requiredChecks: checks,
      candidateHead: head, validatedHead: reviewed, mergeable: 'MERGEABLE',
      labels: [], leaseHeld: true, branchProtectionRequired: false });
    assert.equal(merge.eligible, false);
    assert.ok(merge.reasons.includes('ci-not-green'));
    assert.ok(merge.reasons.includes('stale-head'));
  });
}

test('the CI handoff derives exhaustion before constructing the wake and closer snapshots', async t => {
  const { args, wakes, launches } = fixture(t);
  args.resolveReviewCycleExhaustionImpl = () => ({ reviewCycleExhausted: false });
  const dispatch = args.maybeDispatchAmaCloserImpl;
  args.maybeDispatchAmaCloserImpl = payload => {
    assert.equal(payload.reviewState.reviewCycleExhausted, true);
    assert.equal(payload.dispatchContext.dispatchReason, 'exhausted-final-hammer');
    return dispatch(payload);
  };
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.closureOwner.owner, 'hammer');
  assert.equal(wakes[0].outcome, 'requested');
  assert.equal(launches.length, 1);
});

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

for (const parkedHead of [reviewed, head]) test('rescue requires a stale reviewed head for CI-repair ownership: ' + parkedHead[0], async t => {
  const { args, wakes } = fixture(t);
  args.reviewStateRow.reviewer_head_sha = parkedHead;
  args.dispatchJob = {}; // Rescue has the durable row, not the watcher's handoff flag.
  args.maybeDispatchAmaCloserImpl = async payload => {
    assert.equal(payload.dispatchContext.ciBlockedHammerOwner, true);
    assert.deepEqual(payload.dispatchContext.ciFailedChecks, [{ name: 'synthetic-ci',
      state: 'FAILURE', workflowName: null, detailsUrl: null }]);
    return { dispatched: false, skipMergeAgent: true, reason: 'synthetic-probe' };
  };
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.closureOwner.owner, parkedHead === reviewed ? 'hammer' : 'page', JSON.stringify(result));
  assert.equal(wakes[0].outcome, parkedHead === reviewed ? 'requested' : 'skipped');
  const rescue = classifyRescue({ closureOwner: result.closureOwner, reviewHeadSha: reviewed, headSha: head });
  if (parkedHead === reviewed) {
    assert.equal(rescue.decision, 'hammer-eligible');
    assert.equal(rescue.reason, 'ci-blocked-remediation-exhausted');
  } else {
    assert.notEqual(rescue.decision, 'hammer-eligible');
    assert.equal(result.closureOwner.reason, 'review-rounds-exhausted');
  }
});

test('a parked row without a proven stale reviewed head retains ordinary wake admission', async t => {
  const { args, wakes, launches } = fixture(t);
  args.reviewStateRow.reviewer_head_sha = head;
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(wakes[0].outcome, 'skipped');
  assert.equal(launches.length, 1);
});

for (const outcome of ['skipped', 'requested', 'duplicate'])
for (const recordHead of [head, reviewed]) test(`a ${outcome} wake records the actual handoff refusal: ${recordHead[0]}`, async t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: recordHead };
  const at = '2026-01-01T00:00:00Z';
  const intent = { ...identity, targetRemediationSha: head, reviewedSha: reviewed,
    dispatchReason: 'exhausted-final-hammer', state: 'dispatching', lastAttemptedAt: at,
    launchRequestId: null, dispatchId: null, retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  const leaseIdentity = { ...identity, headSha: head };
  acquireAmaCloserLease({ rootDir: args.rootDir, ...leaseIdentity, now: at });
  args.requestEligibleHammerWakeImpl = () => ({ outcome, reason: 'synthetic-hold',
    eligibilityReasons: ['synthetic-hold'] });
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, skipMergeAgent: true, reason: 'not-eligible' });
  await maybeDispatchAmaClosureFor(args);
  const record = readAmaCloserDispatchRecord(args.rootDir, identity);
  assert.equal(record.state, 'dispatch-failed');
  assert.equal(record.reason, 'wake-refused:not-eligible');
  assert.equal(record.lastError, 'wake-refused:not-eligible');
  assert.equal(record.retryCount, 0, 'an unlaunched handoff does not spend the dispatch retry');
  assert.equal(readAmaCloserLease(args.rootDir, leaseIdentity), null);
});

test('a missing reviewed head cannot adopt and settle a headless dispatch record', async t => {
  const { args } = fixture(t);
  args.reviewStateRow.reviewer_head_sha = null;
  args.reviewStateRow.review_body = null;
  args.reviewStateRow.last_verdict = null;
  args.fetchLatestHeadReviewBodiesImpl = async () => [];
  const identity = { repo, prNumber, headSha: null };
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, repo, prNumber, headSha: head, now: intent.lastAttemptedAt });
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'synthetic-refusal' });
  await maybeDispatchAmaClosureFor(args);
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  assert.equal(readAmaCloserLease(args.rootDir, { repo, prNumber, headSha: head }).status, 'pending');
});

test('rescue ownership preserves explicit review handoff, active remediation and hammer caps', () => {
  const input = { reviewState: { verdict: 'comment-only', headSha: reviewed }, currentHead: head,
    checks: 'FAILURE', roundsLeft: false, ciBlockedHammerOwner: true };
  assert.equal(decideClosureOwner(input).owner, 'hammer');
  assert.deepEqual(decideClosureOwner({ ...input,
    reviewState: { headSha: head, verdict: '' } }),
  { owner: 'page', reason: 'review-rounds-exhausted' },
  'a missing same-head verdict cannot establish an unreviewed repair head');
  assert.equal(decideClosureOwner({ ...input, lease: { status: 'handed-to-review' },
    reviewCeilingReached: true }).owner, 'review');
  assert.equal(decideClosureOwner({ ...input, retryExhausted: true }).reason, 'hammer-retry-cap');
  assert.equal(decideClosureOwner({ ...input, lifetimeExhausted: true }).reason, 'hammer-lifetime-cap');
  assert.notEqual(decideClosureOwner({ ...input, reviewState: { ...input.reviewState,
    remediationPending: true } }).owner, 'hammer');
  assert.equal(decideClosureOwner({ ...input, roundsLeft: true }).owner, 'review');
  for (const checks of ['SUCCESS', 'PENDING', 'IN_PROGRESS', null, 'UNKNOWN']) {
    assert.notEqual(decideClosureOwner({ ...input, checks }).owner, 'hammer', String(checks));
  }
});

test('an early daemon deferral after wake does not retire an interrupted closer intent', async t => {
  const { args, wakes } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: intent.lastAttemptedAt });
  const lease = readAmaCloserLease(args.rootDir, identity);
  args.runDaemonCleanMergeAttemptImpl = async () => ({ disposition: 'deferred', reason: 'synthetic-daemon-wait' });
  args.maybeDispatchAmaCloserImpl = () => assert.fail('daemon deferral never invokes the closer');
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(wakes.length, 1);
  assert.equal(result.reason, 'daemon-deferred');
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  assert.deepEqual(readAmaCloserLease(args.rootDir, identity), lease);
});

test('background pre-dispatch refusal leaves the interrupted intent and its lease untouched', async t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: intent.lastAttemptedAt });
  const lease = readAmaCloserLease(args.rootDir, identity);
  args.resolveAmaHammerDispatchModeImpl = () => 'background';
  args.fetchCurrentPrStateImpl = async () => ({ state: 'OPEN', headSha: head, isDraft: true });
  args.maybeDispatchAmaCloserImpl = () => assert.fail('background draft refusal never invokes the closer');
  let submission;
  args.amaHammerBackgroundQueueImpl = () => ({ submit(options) { submission = options; return { state: 'started' }; } });
  await maybeDispatchAmaClosureFor(args);
  const result = await submission.run(new AbortController().signal);
  assert.equal(result.reason, 'background-pr-draft');
  submission.onSettled({ ok: true, result, elapsedMs: 0 });
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  assert.deepEqual(readAmaCloserLease(args.rootDir, identity), lease);
});

for (const requiredFailure of [false, true]) test(`rescue prompt includes only configured required failures: ${requiredFailure}`, async t => {
  const { args } = fixture(t);
  args.dispatchJob = {};
  const load = args.loadConfigImpl;
  args.loadConfigImpl = () => {
    const config = load();
    const getConfig = config.getMergeAuthorityConfig;
    return { ...config, getMergeAuthorityConfig: () => ({ ...getConfig(), requiredCheckContexts: [' Synthetic-CI '] }) };
  };
  args.candidate.statusCheckRollup = [
    { ...red[0], conclusion: requiredFailure ? 'FAILURE' : 'SUCCESS' },
    { ...red[0], name: 'optional-ci' },
  ];
  let invoked = false;
  args.maybeDispatchAmaCloserImpl = async payload => {
    invoked = true;
    assert.equal(payload.dispatchContext.ciBlockedHammerOwner, requiredFailure);
    assert.deepEqual(payload.dispatchContext.ciFailedChecks.map(check => check.name), requiredFailure ? ['synthetic-ci'] : []);
    return { dispatched: false, reason: 'synthetic-probe' };
  };
  await maybeDispatchAmaClosureFor(args);
  assert.equal(invoked, true);
});

test('watcher CI handoff cannot treat only the adversarial gate as failed CI ownership or a repair wake', async t => {
  const { args, wakes } = fixture(t);
  args.candidate.statusCheckRollup = [
    { ...red[0], conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'FAILURE' },
  ];
  args.maybeDispatchAmaCloserImpl = async () => ({ dispatched: false, reason: 'synthetic-probe' });
  const result = await maybeDispatchAmaClosureFor(args);
  assert.notEqual(result.closureOwner?.reason, 'ci-blocked-remediation-exhausted');
  assert.equal(wakes[0].outcome, 'skipped');
});

for (const name of [undefined, null, 42]) test(`rescue handles malformed external check names: ${name}`, async t => {
  const { args } = fixture(t);
  args.dispatchJob = {};
  args.cfg = { ama: { required_check_contexts: ['synthetic-ci'] } };
  args.candidate.statusCheckRollup = [{ ...red[0], name }, red[0]];
  let invoked = false;
  args.maybeDispatchAmaCloserImpl = async payload => {
    invoked = true;
    assert.equal(payload.dispatchContext.ciBlockedHammerOwner, true);
    assert.deepEqual(payload.dispatchContext.ciFailedChecks.map(check => check.name), ['synthetic-ci']);
    return { dispatched: false, reason: 'synthetic-probe' };
  };
  await maybeDispatchAmaClosureFor(args);
  assert.equal(invoked, true);
});

test('failed dispatch settlement preserves the unlaunched prompt and pending lease', t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const promptDir = join(args.rootDir, 'prompts');
  mkdirSync(promptDir);
  const promptPath = join(promptDir, `${repo.replace('/', '-')}-pr-${prNumber}-${reviewed}-hammer-scratch-fixture.md`);
  writeFileSync(promptPath, 'synthetic unlaunched prompt');
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    promptDir, promptPath, lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: intent.lastAttemptedAt });
  const leaseBefore = readAmaCloserLease(args.rootDir, identity);
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === amaCloserDispatchFilePath(args.rootDir, identity)) {
      throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent,
      result: { dispatched: false, reason: 'not-eligible' } }), /synthetic rename failure/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  assert.deepEqual(readAmaCloserLease(args.rootDir, identity), leaseBefore);
  assert.equal(existsSync(promptPath), true);
});

for (const pathKind of ['owned', 'outside', 'wrong-namespace']) test(`refused unlaunched prompt cleanup respects its path namespace: ${pathKind}`, t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const promptDir = join(args.rootDir, 'prompts');
  mkdirSync(promptDir);
  const filename = `${repo.replace('/', '-')}-pr-${prNumber}-${reviewed}-hammer-scratch-fixture.md`;
  const promptPath = pathKind === 'outside' ? join(args.rootDir, filename)
    : join(promptDir, pathKind === 'wrong-namespace' ? 'unrelated.md' : filename);
  writeFileSync(promptPath, 'synthetic unlaunched prompt');
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    promptDir, promptPath, lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: intent.lastAttemptedAt });
  settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent,
    result: { dispatched: false, reason: 'not-eligible' } });
  assert.equal(readAmaCloserDispatchRecord(args.rootDir, identity).state, 'dispatch-failed');
  assert.equal(existsSync(promptPath), pathKind !== 'owned');
});

test('refusal reconciliation preserves launch receipts, active work and replacement intents', t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching', lastAttemptedAt: '2026-01-01T00:00:00Z' };
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: intent.lastAttemptedAt });
  const wake = { outcome: 'skipped', eligibilityReasons: ['synthetic-hold'] };
  for (const [patch, result] of [
    [{ launchRequestId: 'synthetic-live' }, { dispatched: false }],
    [{ dispatchId: 'synthetic-receipt' }, { dispatched: false }],
    [{}, { dispatched: false, inFlight: true }],
    [{}, { dispatched: false, reason: 'lease-held' }],
    [{}, { dispatched: false, reason: 'closer-lease-held-by-other-process' }],
    [{ lastError: 'already-failed' }, { dispatched: false }],
    [{}, { dispatched: false, backgroundDispatch: { state: 'started' } }],
    [{ lastAttemptedAt: '2026-01-02T00:00:00Z' }, { dispatched: false }],
    [{ promptPath: 'synthetic-new-prompt' }, { dispatched: false }],
  ]) {
    const captured = { ...intent, promptPath: 'synthetic-original-prompt' };
    updateAmaCloserDispatchRecord(args.rootDir, identity, () => ({ ...captured, ...patch }));
    settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent: captured, wake, result });
    assert.equal(readAmaCloserDispatchRecord(args.rootDir, identity).state, 'dispatching');
  }
});

for (const promptPath of [undefined, null, '']) test(`refusal settles a matching attempt that populated its prompt after capture: ${String(promptPath)}`, t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const intent = { ...identity, targetRemediationSha: head, promptPath,
    state: 'dispatching', lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: intent.lastAttemptedAt });
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => ({ ...intent, promptPath: 'synthetic-generated-prompt' }));
  settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent,
    result: { dispatched: false, reason: 'synthetic-refusal' } });
  const record = readAmaCloserDispatchRecord(args.rootDir, identity);
  assert.equal(record.state, 'dispatch-failed');
  assert.equal(record.reason, 'wake-refused:synthetic-refusal');
  assert.equal(record.retryCount, 0);
  assert.equal(readAmaCloserLease(args.rootDir, identity), null);
});

test('a plain refusal preserves a fresh live-pid pending lease and its dispatch intent', t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const now = '2026-10-18T00:00:00Z';
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    lastAttemptedAt: now, retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now, watcherPid: process.pid });
  const leaseBefore = readAmaCloserLease(args.rootDir, identity);
  settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent, now,
    result: { dispatched: false } });
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  assert.deepEqual(readAmaCloserLease(args.rootDir, identity), leaseBefore);
  // The same fresh lease becomes reclaimable only with proven owner death.
  settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent, now,
    processKillImpl: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    result: { dispatched: false, reason: 'not-eligible' } });
  assert.equal(readAmaCloserDispatchRecord(args.rootDir, identity).reason, 'wake-refused:not-eligible');
  assert.equal(readAmaCloserLease(args.rootDir, identity), null);
});

test('refusal settlement cannot retire an intent without a matching reclaimable lease', t => {
  const { args } = fixture(t);
  const identity = { repo, prNumber, headSha: head };
  const intent = { ...identity, targetRemediationSha: head, state: 'dispatching',
    lastAttemptedAt: '2026-01-01T00:00:00Z', retryCount: 1 };
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => intent);
  const settle = () => settleRefusedHammerWake({ rootDir: args.rootDir, identity, intent,
    result: { dispatched: false, reason: 'not-eligible' } });
  settle();
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  acquireAmaCloserLease({ rootDir: args.rootDir, ...identity, now: '2026-01-02T00:00:00Z' });
  const leaseBefore = readAmaCloserLease(args.rootDir, identity);
  settle();
  assert.deepEqual(readAmaCloserDispatchRecord(args.rootDir, identity), intent);
  assert.deepEqual(readAmaCloserLease(args.rootDir, identity), leaseBefore);
});

for (const checks of [[], [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }],
  [{ name: 'synthetic-ci', status: 'IN_PROGRESS' }],
  [{ name: 'synthetic-ci', conclusion: 'FAILURE', startedAt: '2026-01-01' },
    { name: 'synthetic-ci', conclusion: 'SUCCESS', startedAt: '2026-01-02' }],
  [{ __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'FAILURE' }]]) {
  test('historical stop evidence without live failed external CI cannot derive CI-blocked ownership: ' + JSON.stringify(checks), async t => {
    const { args } = fixture(t);
    args.dispatchJob = {};
    args.candidate.statusCheckRollup = checks;
    args.maybeDispatchAmaCloserImpl = async payload => {
      assert.equal(payload.dispatchContext.ciBlockedHammerOwner, false);
      assert.deepEqual(payload.dispatchContext.ciFailedChecks, []);
      return { dispatched: false, reason: 'synthetic-probe' };
    };
    const result = await maybeDispatchAmaClosureFor(args);
    assert.notEqual(result.closureOwner?.reason, 'ci-blocked-remediation-exhausted');
  });
}
