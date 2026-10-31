// CLOSURERECOVERYEXEC-01: an R04 `closure-recovery` next action has an
// executor. Synthetic fixtures only: made-up repo, PR, heads and launch ids.
import test from 'node:test';
import './helpers/rate-limit-state-isolation.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import './helpers/load-aware-timeout-fixture.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { proveCloserAuthoredStaleHead } from '../src/closer-authored-stale.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease, deleteAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { maybeDispatchAmaClosureFor, resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { createAmaHammerBackgroundQueue } from '../src/ama-hammer-background-dispatch.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { CLOSURE_RECOVERY_ESCALATED_REASON, CLOSURE_RECOVERY_WAIT_CLASS, CLOSURE_RECOVERY_REPAGE_MS,
  enforceClosureRecoveryDeadline, refreshClosureRecoveryCustody } from '../src/ama/closure-recovery.mjs';
import { hasClosureRecoveryIntent, hasHammerDispatchIntent, reviseClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import { collectReviewPipelineHealth, readExpiredNextActions } from '../src/review-pipeline-health.mjs';
import { expiredNextActionDeadline } from '../src/next-action-deadline.mjs';

const REPO = 'example-org/subject-41';
const PR = 41;
const REVIEWED = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const LRQ = 'lrq-synthetic-closer-41';
const POSTED_MS = Date.parse('2026-03-01T00:00:00.000Z');
const BODY = '## Summary\nLooks fine.\n\n## Verdict\nComment only\n\n## Blocking Issues\n\n- None.\n\n'
  + '## Non-blocking Issues\n\n- None.';
const quiet = { log() {}, info() {}, warn() {}, error() {} };

// A closer-authored stale head: the hammer pushed HEAD on top of the reviewed
// head, the settled review is clean, and the review refresh is suppressed for
// the closer-commit trailer.
function closerHeadArgs(t, overrides = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'closure-recovery-exec-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = {
    rootDir,
    reviewStateRow: { repo: REPO, pr_number: PR, pr_state: 'open', review_status: 'posted',
      last_verdict: 'Comment only', risk_class: 'low', remediation_pending: 0, reviewer: 'claude',
      reviewer_login: 'claude-reviewer-lacey', reviewer_head_sha: REVIEWED, review_body: BODY,
      posted_at: new Date(POSTED_MS).toISOString() },
    dispatchJob: {},
    candidate: { headSha: HEAD, riskClass: 'low', prAuthor: 'codex-worker-bot', prState: 'open',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] }, isDraft: false },
    labelNames: [],
    operatorApprovalEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: REPO,
    prNumber: PR,
    currentRevisionRef: HEAD,
    logger: quiet,
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true, branchProtection: { required: false } }) }),
    resolveReviewCycleExhaustionImpl: () => ({ riskClass: 'low', reviewCycleExhausted: false }),
    fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, head) => (head === REVIEWED ? [BODY] : []),
    proveCloserAuthoredStaleHeadImpl: options => proveCloserAuthoredStaleHead({ ...options,
      comments: [{ author: 'the-hammer-lacey[bot]', body: `HAM-Base-Head: ${REVIEWED}\nHAM-Validated-Head: ${HEAD}` }] }),
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: true, reason: 'closer-commit-trailer' }),
    fetchHeadCloserVerifiedCommitImpl: async () => ({ sha: HEAD, parentSha: REVIEWED, message: 'Closed-By: hammer' }),
    resolveHamTerminalRemediationEvidenceImpl: async () => null,
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible', reasons: [] }),
    fetchMergedProtectiveDependentsImpl: async () => [],
    fetchProtectivePredecessorStateImpl: async () => null,
    requestEligibleHammerWakeImpl: () => ({ outcome: 'skipped' }),
    fetchCurrentPrStateImpl: async () => ({ state: 'OPEN', headSha: HEAD, isDraft: false, mergeable: 'MERGEABLE' }),
    mergeabilitySampleDelayMs: 0,
    ...overrides,
  };
  // The previous closer's launch: its lease is terminal and still names the
  // launch, so ownership needs that launch's ledger status.
  const identity = { rootDir, repo: REPO, prNumber: PR, headSha: HEAD };
  acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: new Date(POSTED_MS).toISOString() });
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: LRQ, now: new Date(POSTED_MS).toISOString() });
  updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge',
    now: new Date(POSTED_MS).toISOString() });
  return args;
}

const MINUTE = 60_000;
const DEADLINE_MS = POSTED_MS + 5 * MINUTE;
const IDENTITY = { repo: REPO, prNumber: PR, headSha: HEAD };

function pageRecorder() {
  const pages = [];
  return { pages, observeClosureWaitImpl: options => observeClosureWait({ ...options,
    pageImpl: async (message, metadata) => { pages.push({ message, metadata }); } }) };
}

// The snapshot's ledger read is down for the whole test: the route selects R04.
function ledgerOutage(t) {
  t.mock.method(dispatchReadTransport, 'lookup', async () => { throw new Error('synthetic ledger outage'); });
}

// Mirrors the real closer's admission: it reconciles the recorded launch with
// its own custody reader, then refuses through its shared-intent gate unless
// the reconciled decision is a hammer dispatch.
function custodyCloser({ readable }) {
  const decisions = [];
  const impl = async payload => {
    decisions.push(payload.sharedNextAction.decision);
    let shared = payload.sharedNextAction;
    if (readable()) {
      shared = reviseClosureNextAction(shared, { launches: { closer: { headSha: HEAD, launchRequestId: LRQ,
        probe: { ok: true, row: { launch_request_id: LRQ, status: 'failed' }, retryChain: [] },
        outcome: 'no-merge', retryable: true } } });
    }
    if (!hasHammerDispatchIntent(shared, IDENTITY)) {
      return { dispatched: false, skipMergeAgent: true, recoveryWait: true, reason: shared.decision.reason,
        nextActionShared: shared };
    }
    return { dispatched: true, launchRequestId: `${LRQ}-r2`, workerClass: 'hammer', nextActionShared: shared };
  };
  return { decisions, impl };
}

for (const mode of ['inline', 'background']) {
  test(`CLOSURERECOVERYEXEC-01: resolvable launch evidence dispatches the closer before the deadline (${mode})`, async t => {
    ledgerOutage(t);
    const { pages, observeClosureWaitImpl } = pageRecorder();
    const closer = custodyCloser({ readable: () => true });
    const queue = createAmaHammerBackgroundQueue();
    const args = closerHeadArgs(t, { resolveAmaHammerDispatchModeImpl: () => mode,
      amaHammerBackgroundQueueImpl: () => queue, now: () => POSTED_MS + 2 * MINUTE, observeClosureWaitImpl,
      maybeDispatchAmaCloserImpl: closer.impl });
    let result = await maybeDispatchAmaClosureFor(args);
    if (mode === 'background') {
      assert.equal(result.closureRecovery.outcome, 'executing');
      await queue.drain();
      result = await maybeDispatchAmaClosureFor(args);
    }
    assert.equal(result.dispatched, true, JSON.stringify(result.reason));
    assert.equal(result.launchRequestId, `${LRQ}-r2`);
    assert.equal(closer.decisions.length, 1);
    assert.equal(closer.decisions[0].reason, 'ownership-unreadable',
      'the closer receives the R04 decision and reconciles its custody');
    assert.equal(pages.length, 0);
  });
}

test('CLOSURERECOVERYEXEC-01: unreadable ownership escalates exactly once; 10 ticks never loop on closure-decision-mismatch', async t => {
  ledgerOutage(t);
  const { pages, observeClosureWaitImpl } = pageRecorder();
  const queue = createAmaHammerBackgroundQueue();
  const closer = custodyCloser({ readable: () => false });
  const settled = [];
  let tickNow = POSTED_MS;
  const args = closerHeadArgs(t, { resolveAmaHammerDispatchModeImpl: () => 'background',
    amaHammerBackgroundQueueImpl: () => queue, now: () => tickNow, observeClosureWaitImpl,
    logger: { ...quiet, log: message => { if (/background dispatch settled/.test(message)) settled.push(message); } },
    maybeDispatchAmaCloserImpl: closer.impl });
  const results = [];
  for (let tick = 1; tick <= 10; tick++) {
    tickNow = POSTED_MS + tick * MINUTE;
    const applied = await resolveMergeAgentCoexistenceForWatcher({ ...args,
      maybeDispatchAmaClosureForImpl: input => maybeDispatchAmaClosureFor({ ...args, ...input }),
      recoverOrphanImpl: () => assert.fail('the executor owns this recovery and its one escalation'),
      recoverAmaAutomationImpl: () => assert.fail('the executor owns this recovery'),
      orphanOptions: { now: new Date(tickNow).toISOString() } });
    await queue.drain();
    results.push({ tickMs: tickNow, applied });
  }
  const outcomes = results.map(({ applied }) => applied.amaClosureResult.closureRecovery?.outcome);
  assert.deepEqual(outcomes, ['executing', 'pending', 'executing', 'pending', 'executing',
    'escalated', 'executing', 'escalated', 'executing', 'escalated']);
  for (const { tickMs, applied } of results) {
    const result = applied.amaClosureResult;
    assert.equal(applied.outcome, 'ama-pending');
    assert.notEqual(result.reason, 'closure-decision-mismatch');
    assert.equal(result.mismatchReason, undefined);
    assert.equal(result.nextAction.actor, 'closure-recovery');
    assert.equal(result.nextAction.reason, 'ownership-unreadable');
    assert.equal(result.closureRecovery.ageMs, tickMs - DEADLINE_MS);
    if (result.closureRecovery.outcome === 'executing') continue;
    assert.equal(result.closerReason, 'ownership-unreadable');
    assert.equal(result.closureRecovery.launchRequestId, LRQ);
    assert.ok(result.closureRecovery.unresolved.includes('launch:retry-chain-unreadable'));
    if (tickMs < DEADLINE_MS) assert.equal(result.reason, 'ownership-unreadable');
    else {
      assert.equal(result.reason, CLOSURE_RECOVERY_ESCALATED_REASON);
      assert.equal(result.needsOperator, true);
      assert.equal(result.boundedWait.exhausted, true);
    }
  }
  // Both sides consumed the same shared decision: every background run reached
  // the closer with the route's R04 decision, and none settled as a mismatch.
  assert.equal(settled.length, 5);
  for (const line of settled) assert.match(line, /dispatched=false reason=ownership-unreadable /);
  assert.equal(new Set(closer.decisions.map(decision => decision.decisionKey)).size, 1);
  assert.ok(closer.decisions.every(decision => hasClosureRecoveryIntent({ snapshot: { subjectKey: `${REPO}#${PR}`,
    head: HEAD }, decision }, IDENTITY)));
  assert.equal(pages.length, 1, 'exactly one escalation across every expired tick');
  assert.match(pages[0].message, /closure-recovery-ownership-unresolved: action=hammer actor=closure-recovery reason=ownership-unreadable/);
  assert.match(pages[0].message, /closer=ownership-unreadable unresolved=lease:terminal:lrq-synthetic-closer-41,launch:retry-chain-unreadable/);
  assert.equal(pages[0].metadata.severity, 'SEV1');
  assert.equal(pages[0].metadata.dedupKey, `hamclose:${REPO}:${PR}:${HEAD}:${CLOSURE_RECOVERY_WAIT_CLASS}:${DEADLINE_MS + MINUTE}`);
});

test('CLOSURERECOVERYEXEC-01: a refused escalation page is retried, then delivered once', async t => {
  ledgerOutage(t);
  const delivered = [];
  let refuse = true;
  const warnings = [];
  const args = closerHeadArgs(t, { resolveAmaHammerDispatchModeImpl: () => 'inline',
    now: () => DEADLINE_MS + MINUTE, logger: { ...quiet, warn: message => warnings.push(message) },
    observeClosureWaitImpl: options => observeClosureWait({ ...options, pageImpl: async message => {
      if (refuse) throw new Error('synthetic delivery refusal');
      delivered.push(message);
    } }),
    maybeDispatchAmaCloserImpl: custodyCloser({ readable: () => false }).impl });
  const first = await maybeDispatchAmaClosureFor(args);
  assert.equal(first.reason, CLOSURE_RECOVERY_ESCALATED_REASON);
  assert.equal(first.closureRecovery.paged, false);
  assert.match(first.closureRecovery.pageError, /synthetic delivery refusal/);
  assert.ok(warnings.some(message => /closure-recovery escalation delivery failed/.test(message)));
  refuse = false;
  assert.equal((await maybeDispatchAmaClosureFor(args)).closureRecovery.paged, true);
  assert.equal((await maybeDispatchAmaClosureFor(args)).closureRecovery.paged, false);
  assert.equal(delivered.length, 1);
});

test('CLOSURERECOVERYEXEC-01: other closer refusals keep their own reason and owner', async t => {
  ledgerOutage(t);
  const args = closerHeadArgs(t, { resolveAmaHammerDispatchModeImpl: () => 'inline',
    now: () => DEADLINE_MS + MINUTE, observeClosureWaitImpl: () => assert.fail('not a custody refusal'),
    maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, skipMergeAgent: true,
      reason: 'active-remediation-job' }) });
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.reason, 'active-remediation-job');
  assert.equal(result.closureRecovery, undefined);
});

// The merge-agent rescue bridge calls maybeDispatchAmaClosureFor with this
// exact shape and reads `dispatched`, `reason` and the launch id.
const RESCUE = { orphanRecovery: { closerHead: true, primaryRepair: false },
  runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'rescue-dispatch-only' }) };

test('CLOSURERECOVERYEXEC-01: rescue dispatch-closer apply records the dispatch id', async t => {
  ledgerOutage(t);
  const args = closerHeadArgs(t, { ...RESCUE, now: () => DEADLINE_MS + 30 * MINUTE,
    resolveAmaHammerDispatchModeImpl: () => 'background',
    maybeDispatchAmaCloserImpl: custodyCloser({ readable: () => true }).impl });
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, `${LRQ}-r2`);
});

test('CLOSURERECOVERYEXEC-01: rescue dispatch-closer apply names why it did not dispatch', async t => {
  ledgerOutage(t);
  const { pages, observeClosureWaitImpl } = pageRecorder();
  for (const [offsetMs, reason] of [[-MINUTE, 'ownership-unreadable'],
    [6 * 60 * MINUTE, CLOSURE_RECOVERY_ESCALATED_REASON]]) {
    const args = closerHeadArgs(t, { ...RESCUE, now: () => DEADLINE_MS + offsetMs, observeClosureWaitImpl,
      maybeDispatchAmaCloserImpl: custodyCloser({ readable: () => false }).impl });
    const result = await maybeDispatchAmaClosureFor(args);
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, reason);
    assert.equal(result.namedReason, reason);
    assert.equal(result.closerReason, 'ownership-unreadable');
    assert.equal(result.closureRecovery.launchRequestId, LRQ);
    assert.match(result.closureRecovery.detail,
      /reason=ownership-unreadable .* closer=ownership-unreadable unresolved=lease:terminal:lrq-synthetic-closer-41,launch:retry-chain-unreadable/);
  }
  assert.equal(pages.length, 1);
});

test('CLOSURERECOVERYEXEC-01: an expired deadline shows in the watcher log and pipeline health with its age', async t => {
  ledgerOutage(t);
  const args = closerHeadArgs(t, { resolveAmaHammerDispatchModeImpl: () => 'inline',
    now: () => DEADLINE_MS + 2 * MINUTE, ...pageRecorder(),
    maybeDispatchAmaCloserImpl: custodyCloser({ readable: () => false }).impl });
  const amaClosureResult = await maybeDispatchAmaClosureFor(args);
  assert.equal(amaClosureResult.nextAction.reason, 'ownership-unreadable');
  const warnings = [];
  const observedAt = new Date(DEADLINE_MS + 3 * MINUTE).toISOString();
  const gate = createNoProgressLaneGate({ rootDir: args.rootDir, hqRoot: args.rootDir, now: () => observedAt,
    logger: { ...quiet, warn: message => warnings.push(message) },
    readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: REVIEWED, posted_at: new Date(POSTED_MS).toISOString() }),
    deliverAlertFn: async () => {} });
  await gate.record({ repoPath: REPO, prNumber: PR, headSha: HEAD },
    { value: { outcome: 'ama-pending', amaClosureResult } });
  const line = warnings.find(message => message.includes('next-action deadline expired'));
  assert.ok(line, warnings.join('\n'));
  assert.match(line, new RegExp(`${REPO}#${PR}: action=hammer actor=closure-recovery reason=ownership-unreadable`));
  assert.match(line, /deadline=2026-03-01T00:05:00.000Z class=recovery age_ms=180000 route=closure-recovery-ownership-unresolved/);

  const health = collectReviewPipelineHealth({ rootDir: args.rootDir, now: () => new Date(DEADLINE_MS + 10 * MINUTE) });
  assert.equal(health.expiredNextActions.expiredCount, 1);
  assert.equal(health.expiredNextActions.closureRecoveryExpired, 1);
  assert.equal(health.expiredNextActions.oldestAgeMs, 10 * MINUTE);
  const [item] = health.expiredNextActions.expired;
  assert.deepEqual({ ...item, lane: undefined, observedAt: undefined }, {
    repo: REPO, prNumber: PR, action: 'hammer', actor: 'closure-recovery', reason: 'ownership-unreadable',
    row: 'R04-ownership', head: HEAD, deadlineAt: '2026-03-01T00:05:00.000Z', deadlineClass: 'recovery',
    ageMs: 10 * MINUTE, closureRecovery: true, lane: undefined, observedAt: undefined,
  });
  assert.equal(item.observedAt, observedAt);
  // Before its deadline the same decision is not expired.
  const early = collectReviewPipelineHealth({ rootDir: args.rootDir, now: () => new Date(DEADLINE_MS - 1) });
  assert.equal(early.expiredNextActions.expiredCount, 0);
  assert.equal(early.expiredNextActions.total, 1);
});

test('CLOSURERECOVERYEXEC-01: refresh cadence and other heads are not reported as expired', () => {
  const decision = { action: 'wait-for-CI', actor: 'watcher', reason: 'snapshot-refresh', head: HEAD,
    deadline: { at: new Date(POSTED_MS).toISOString(), class: 'refresh' } };
  assert.equal(expiredNextActionDeadline(decision, { nowMs: POSTED_MS + 60 * MINUTE }), null);
  const admission = { ...decision, action: 'hammer', actor: 'hammer', deadline: { ...decision.deadline, class: 'admission' } };
  assert.equal(expiredNextActionDeadline(admission, { nowMs: POSTED_MS + MINUTE }).ageMs, MINUTE);
  assert.equal(expiredNextActionDeadline(admission, { nowMs: POSTED_MS + MINUTE }).closureRecovery, false);
  assert.equal(expiredNextActionDeadline(admission, { headSha: 'd'.repeat(40), nowMs: POSTED_MS + MINUTE }), null);
});


function expiredLaneFixture(t, number = PR) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'closure-final-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = path.join(rootDir, 'data', 'watcher-no-progress-lane');
  mkdirSync(dir, { recursive: true });
  const nextAction = { action: 'hammer', actor: 'closure-recovery', row: 'R04-ownership',
    reason: 'ownership-unreadable', head: HEAD, queue: { intent: 'reconcile' },
    deadline: { at: new Date(DEADLINE_MS).toISOString(), class: 'recovery' } };
  writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ repo: REPO, prNumber: number,
    headSha: HEAD, nextAction }));
  return { rootDir, dir, nextAction };
}

test('final review: standalone expired-action reads default the clock and options', t => {
  const { rootDir } = expiredLaneFixture(t);
  t.mock.method(Date, 'now', () => DEADLINE_MS + MINUTE);
  for (const options of [undefined, {}]) {
    const health = readExpiredNextActions(rootDir, options);
    assert.equal(health.total, 1);
    assert.equal(health.expiredCount, 1);
    assert.equal(health.oldestAgeMs, MINUTE);
  }
});

test('final review: historical closed ledgers do not inflate the active total', t => {
  const { rootDir, dir, nextAction } = expiredLaneFixture(t);
  for (const number of [42, 43]) writeFileSync(path.join(dir, `${number}.json`),
    JSON.stringify({ repo: REPO, prNumber: number, headSha: HEAD, nextAction }));
  const reviewRows = new Map([[`${REPO}#42`, { pr_state: 'closed' }],
    [`${REPO}#43`, { pr_state: 'merged' }]]);
  const health = readExpiredNextActions(rootDir, { nowMs: DEADLINE_MS + MINUTE, reviewRows });
  assert.equal(health.total, 1);
  assert.equal(health.expiredCount, 1);
  assert.equal(health.expired[0].prNumber, PR);
});

test('final review: missing snapshot observations still enforce the custody deadline', async t => {
  const { rootDir, nextAction } = expiredLaneFixture(t);
  let observed = 0;
  const result = await enforceClosureRecoveryDeadline({ rootDir, ...IDENTITY,
    shared: { snapshot: { subjectKey: `${REPO}#${PR}`, head: HEAD }, decision: nextAction },
    result: { dispatched: false, reason: 'ownership-unreadable' }, now: DEADLINE_MS + MINUTE,
    observeWaitImpl: async () => { observed += 1; return { notify: true }; }, logger: quiet });
  assert.equal(observed, 1);
  assert.equal(result.reason, CLOSURE_RECOVERY_ESCALATED_REASON);
  assert.equal(result.closureRecovery.launchRequestId, null);
  assert.equal(result.closureRecovery.outcome, 'escalated');
});

function recoveryDispatchFixture(t, { status = 'failed', pending = false } = {}) {
  const { rootDir } = expiredLaneFixture(t);
  acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 424242, dispatchTimeoutMs: MINUTE,
    now: new Date(POSTED_MS - (pending ? 60 * MINUTE : 0)).toISOString() });
  if (!pending) {
    updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched', lrqId: LRQ,
      now: new Date(POSTED_MS).toISOString() });
    updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'terminal', terminalOutcome: 'failed-without-merge',
      now: new Date(POSTED_MS).toISOString() });
  }
  const snapshot = deriveNextActionSnapshot({ subjectKey: `${REPO}#${PR}`, head: HEAD,
    observedAt: new Date(DEADLINE_MS + MINUTE).toISOString(),
    anchors: { firstActionableAt: new Date(POSTED_MS).toISOString() }, observations: {
      pr: { state: 'OPEN', headSha: HEAD, mergeable: 'MERGEABLE', labels: [] },
      reviews: { verdict: 'comment-only', headSha: HEAD, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false },
      policy: { autonomousMergeExecutionEnabled: true, strictMode: true },
      leases: { state: 'unknown', value: null },
      launches: { state: 'unknown', value: null },
    } });
  const shared = { snapshot, decision: nextAction(snapshot) };
  assert.equal(shared.decision.reason, 'ownership-unreadable');
  let launches = 0;
  const events = [];
  const args = { sharedNextAction: shared,
    reviewState: { verdict: 'comment-only', headSha: HEAD, riskClass: 'low', remediationPending: false,
      reviewCycleExhausted: true, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'synthetic-builder' },
    prMetadata: { prNumber: PR, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], branchProtection: { requiredContexts: [] },
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: false } },
    dispatchContext: { rootDir, repo: REPO, prUrl: `https://github.com/${REPO}/pull/${PR}`,
      reviewedSha: HEAD, riskClass: 'low', reviewedBy: 'synthetic-reviewer', reviewer: 'codex',
      hqPath: '/bin/synthetic-hq', hqRoot: path.join(rootDir, 'hq'), hqOwnerUser: userInfo().username,
      currentUser: userInfo().username, parentSession: 'synthetic-watcher',
      dispatchedAt: new Date(DEADLINE_MS + MINUTE).toISOString(), closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'synthetic/branch' }) },
    guardStackedBaseImpl: async () => null,
    deliverAlertImpl: async () => {},
    fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
    readLaunchRequestStatusImpl: async ({ launchRequestId }) => ({ ok: true,
      row: { status: launchRequestId === LRQ ? status : 'running', launch_request_id: launchRequestId }, retryChain: [] }),
    readTemplateImpl: () => 'Synthetic closer <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readPullRequestStateImpl: async () => null,
    readBuildCompletionSignalForPrImpl: async () => ({ ok: false }),
    readBuildCompletionProducerEvidenceImpl: async () => ({ ok: false }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    processKillImpl: () => { throw Object.assign(new Error('synthetic dead process'), { code: 'ESRCH' }); },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv[1] === '--priority') {
        const lease = readAmaCloserLease(rootDir, IDENTITY);
        assert.equal(lease.status, 'pending', 'release and exclusive reacquisition precede submission');
        assert.equal(lease.lrqId, null);
        launches++;
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${PR}`,
          launchRequestId: `${LRQ}-fresh`, dispatchId: 'synthetic-dispatch' }) };
      }
      return { stdout: '{}' };
    },
    logger: { ...quiet, info: message => events.push(message) },
  };
  return { rootDir, shared, args, launches: () => launches, events };
}

for (const pending of [false, true]) test(`RECOVERYSTALL-01: overdue ${pending ? 'dead pending' : 'terminal recorded launch without receipt'} custody releases before exactly one dispatch`, async t => {
  const f = recoveryDispatchFixture(t, { pending });
  const results = await Promise.all([maybeDispatchAmaCloser(f.args), maybeDispatchAmaCloser(f.args)]);
  assert.equal(results.filter(result => result.dispatched).length, 1, JSON.stringify(results));
  assert.equal(f.launches(), 1);
  assert.equal(readAmaCloserLease(f.rootDir, IDENTITY).lrqId, `${LRQ}-fresh`);
  assert.equal((await maybeDispatchAmaCloser(f.args)).dispatched, false);
  assert.equal(f.launches(), 1);
  const recovered = results.find(result => result.dispatched).closureRecovery;
  assert.equal(recovered.deadlineAt, new Date(DEADLINE_MS).toISOString());
  assert.ok(recovered.attempts >= 1);
  assert.equal(recovered.lastEvidence.readable, true);
  if (!pending) assert.ok(f.events.some(event => event.includes('terminal-custody-confirmed')));
});

for (const status of ['running', 'suspended', 'waiting_input']) test(`RECOVERYSTALL-01: overdue custody with ${status} worker cannot dispatch`, async t => {
  const f = recoveryDispatchFixture(t, { status });
  const result = await maybeDispatchAmaCloser(f.args);
  assert.equal(result.dispatched, false);
  assert.equal(f.launches(), 0);
  assert.equal(readAmaCloserLease(f.rootDir, IDENTITY).lrqId, LRQ);
  assert.equal(result.closureRecovery.lastEvidence.owned, true);
});

for (const [name, probe] of [
  ['live retry', { ok: true, row: { status: 'failed' },
    retryChain: [{ launch_request_id: 'synthetic-live-retry', status: 'running' }] }],
  ['missing retry chain', { ok: true, row: { status: 'failed' } }],
  ['unreadable retries', { ok: true, row: { status: 'failed' }, retryChain: [], retryChainUnreadable: true }],
]) test(`RECOVERYSTALL-01: ${name} retains custody past the deadline`, async t => {
  const f = recoveryDispatchFixture(t);
  const result = await maybeDispatchAmaCloser({ ...f.args, readLaunchRequestStatusImpl: async () => probe });
  assert.equal(result.dispatched, false);
  assert.equal(f.launches(), 0);
  assert.equal(readAmaCloserLease(f.rootDir, IDENTITY).lrqId, LRQ);
});

test('RECOVERYSTALL-01: ledger outage re-pages after six hours, retains attempts across restart, then recovers', async t => {
  const f = recoveryDispatchFixture(t);
  const held = await maybeDispatchAmaCloser({ ...f.args,
    readLaunchRequestStatusImpl: async () => { throw new Error('synthetic outage'); } });
  assert.equal(held.dispatched, false);
  assert.equal(f.launches(), 0);
  const pages = [];
  let now = DEADLINE_MS + MINUTE;
  const refresh = () => refreshClosureRecoveryCustody({ rootDir: f.rootDir, ...IDENTITY,
    shared: f.shared, now, readLaunchImpl: async () => { throw new Error('synthetic outage'); } });
  const observe = async () => {
    const recovery = await refresh();
    const result = await enforceClosureRecoveryDeadline({ rootDir: f.rootDir, ...IDENTITY,
      shared: recovery.shared, result: { dispatched: false, reason: 'ownership-unreadable',
        closureRecovery: recovery.closureRecovery }, now,
      observeWaitImpl: options => observeClosureWait({ ...options,
        pageImpl: async (_message, metadata) => pages.push(metadata.dedupKey) }) });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, CLOSURE_RECOVERY_ESCALATED_REASON);
    assert.equal(result.closureRecovery.lastEvidence.readable, false);
    return result;
  };
  assert.equal((await observe()).closureRecovery.attempts, 2);
  now += CLOSURE_RECOVERY_REPAGE_MS - 1;
  await observe();
  assert.equal(pages.length, 1);
  now++;
  assert.equal((await observe()).closureRecovery.attempts, 4);
  assert.equal(pages.length, 2);
  assert.notEqual(pages[0], pages[1], 'delivery dedup must allow the later reminder');
  assert.equal(readAmaCloserLease(f.rootDir, IDENTITY).lrqId, LRQ);
  const status = readExpiredNextActions(f.rootDir, { nowMs: now }).expired[0].recoveryCustody;
  assert.equal(status.attempts, 4, 'existing next-action health output exposes persisted attempts');
  assert.equal(status.deadlineAt, new Date(DEADLINE_MS).toISOString());
  assert.equal(status.lastEvidence.readable, false);
  assert.equal((await maybeDispatchAmaCloser(f.args)).dispatched, true);
});

test('RECOVERYSTALL-01: replacement custody during the read never retires the new owner', async t => {
  const f = recoveryDispatchFixture(t);
  const result = await refreshClosureRecoveryCustody({ rootDir: f.rootDir, ...IDENTITY, shared: f.shared,
    now: DEADLINE_MS + MINUTE, readLaunchImpl: async () => {
      deleteAmaCloserLease(f.rootDir, IDENTITY);
      acquireAmaCloserLease({ rootDir: f.rootDir, ...IDENTITY, watcherPid: process.pid });
      return { ok: true, row: { status: 'failed' }, retryChain: [] };
    } });
  assert.equal(result.shared.decision.reason, 'ownership-unreadable');
  assert.equal(result.closureRecovery.lastEvidence.reason, 'lease-changed-during-recovery');
  assert.equal(readAmaCloserLease(f.rootDir, IDENTITY).status, 'pending');
});

test('RECOVERYSTALL-01: custody refresh preserves a recorded non-retryable terminal decision', async t => {
  const f = recoveryDispatchFixture(t);
  const shared = reviseClosureNextAction(f.shared, { launches: { state: 'unknown', value: {
    closer: { headSha: HEAD, launchRequestId: LRQ, retryable: false, attempt: 3 },
  } } });
  const result = await maybeDispatchAmaCloser({ ...f.args, sharedNextAction: shared });
  assert.equal(result.dispatched, false);
  assert.equal(f.launches(), 0);
  assert.equal(readAmaCloserLease(f.rootDir, IDENTITY).lrqId, LRQ);
});
