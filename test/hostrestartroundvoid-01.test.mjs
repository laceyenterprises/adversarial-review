import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
// HOSTRESTARTROUNDVOID-01: the orchestrator settles a closer killed by a host
// restart with the terminal class `worker_lost_to_host_restart`, which does not
// charge an attempt. The PR round ledger and the hammer retry cap must agree:
// that closer voids its round and gives its retry-cap charge back, so a reboot
// can never walk a clean PR into cap exhaustion. Other classes keep their
// dispatch charge on this path. The PR budget counts settled rounds.
//
// Synthetic fixtures only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  _resetHammerRetryCapAlertDebounceForTests,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease, AMA_CLOSER_LEASE_STATUS, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { classifyDeadHammerCause, INFRA_DEAD_HAMMER_FAILURE_CLASSES } from '../src/ama/dead-hammer-rearm.mjs';
import {
  HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
  evaluateHammerRetryCap,
  hammerRetryCapFilePath,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
  refundHammerRetryDispatch,
  voidHostRestartLostHammerDispatch,
} from '../src/ama/hammer-retry-cap.mjs';
import { readCloserNoDeliveryLedger } from '../src/ama/closer-no-delivery.mjs';
import { recordHammerProgress } from '../src/ama/hammer-progress.mjs';
import { VOID_TERMINAL_CLASSES, isVoidTerminalClass, prRoundLedgerPath, readPrRoundLedger, summarizePrRoundLedger } from '../src/pr-round-ledger.mjs';
import { noWorkVerdict } from './fixtures/execution-verdict.mjs';

const REPO = 'synthetic-org/synthetic-repo';
const PR_NUMBER = 42;
const HEAD = 'a'.repeat(40);
const LOST = 'worker_lost_to_host_restart';
const IDENTITY = { repo: REPO, prNumber: PR_NUMBER };
const CURRENT_USER = userInfo().username || process.env.USER || 'unknown';

function tempRoot(t, label) {
  const rootDir = mkdtempSync(join(tmpdir(), `hostrestartroundvoid-${label}-`));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function chargeHammer(rootDir, launchRequestId, { now = '2026-11-01T00:00:00Z' } = {}) {
  return recordHammerRetryDispatch(rootDir, IDENTITY, { jobKey: HEAD, headSha: HEAD,
    dispatchKey: `intent-${launchRequestId}`, launchRequestId, now });
}

function recordPriorPublishedHammer(rootDir) {
  chargeHammer(rootDir, 'lrq_first');
  recordHammerProgress('remediation-pushed', { env: {
    HAM_HQ_ROOT: rootDir, HQ_LAUNCH_REQUEST_ID: 'lrq_first', HQ_WORKER_RUN_ID: 'wrun_first',
  }, headSha: 'b'.repeat(40), now: new Date('2026-11-01T00:30:00Z') });
}

function counts(rootDir) {
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  return { attemptCount: ledger.attemptCount, targetAttemptCount: ledger.targetAttemptCount,
    lifetimeAttemptCount: ledger.lifetimeAttemptCount,
    rounds: summarizePrRoundLedger(rootDir, IDENTITY).remediationRoundsUsed };
}

test('only the exact structured host-restart class is void', () => {
  assert.deepEqual([...VOID_TERMINAL_CLASSES], [LOST]);
  assert.equal(isVoidTerminalClass(LOST), true);
  for (const value of ['worker_crashed', 'worker_killed', 'process_exited_after_progress',
    ...INFRA_DEAD_HAMMER_FAILURE_CLASSES, 'worker-lost-to-host-restart', 'WORKER_LOST_TO_HOST_RESTART',
    ` ${LOST}`, `${LOST}:detail`, 'lost to host restart', '', null, undefined, { failure_class: LOST }]) {
    assert.equal(isVoidTerminalClass(value), false, JSON.stringify(value));
  }
});

test('a host-restart closer leaves the round and retry counts unchanged', (t) => {
  const rootDir = tempRoot(t, 'void');
  recordPriorPublishedHammer(rootDir);
  const before = counts(rootDir);
  chargeHammer(rootDir, 'lrq_lost', { now: '2026-11-01T01:00:00Z' });
  assert.deepEqual(counts(rootDir), { attemptCount: 2, targetAttemptCount: 2, lifetimeAttemptCount: 2, rounds: 1 });
  assert.equal(evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, IDENTITY), { jobKey: HEAD, headSha: HEAD })
    .capExhausted, true, 'two charged closers exhaust the series cap');

  const outcome = voidHostRestartLostHammerDispatch(rootDir, IDENTITY, {
    launchRequestId: 'lrq_lost', dispatchKey: 'intent-lrq_lost', terminalClass: LOST, now: '2026-11-01T02:00:00Z' });
  assert.deepEqual(outcome, { voided: true, refunded: true, reason: 'worker-lost-to-host-restart' });
  assert.deepEqual(counts(rootDir), before);
  assert.equal(evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, IDENTITY), { jobKey: HEAD, headSha: HEAD })
    .capExhausted, false);
  const rounds = readPrRoundLedger(rootDir, IDENTITY);
  assert.deepEqual(rounds.map(entry => [entry.launchRequestId, entry.voided]), [['lrq_first', false], ['lrq_lost', true]]);
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  assert.equal(ledger.hostRestartVoids['intent-lrq_lost'].terminalClass, LOST);
  assert.deepEqual(ledger.dispatchCharges['intent-lrq_lost'].refundedBudgets,
    { head: true, pr: true, lifetime: true });

  // Every later observation of the same launch is idempotent.
  const again = voidHostRestartLostHammerDispatch(rootDir, IDENTITY, {
    launchRequestId: 'lrq_lost', dispatchKey: 'intent-lrq_lost', terminalClass: LOST });
  assert.deepEqual(again, { voided: true, refunded: false, reason: 'already-refunded' });
  assert.deepEqual(counts(rootDir), before);
  // Another refund path cannot give the same charge back twice.
  assert.equal(refundHammerRetryDispatch(rootDir, IDENTITY, { jobKey: HEAD, headSha: HEAD,
    launchRequestId: 'lrq_lost', dispatchKey: 'intent-lrq_lost', executionVerdict: noWorkVerdict('lrq_lost') }).reason,
  'already-refunded');
  assert.equal(refundHammerRetryDispatch(rootDir, IDENTITY, { jobKey: HEAD, headSha: HEAD,
    launchRequestId: 'lrq_lost' }).reason, 'already-refunded');
  assert.deepEqual(counts(rootDir), before);
});

test('the void survives a later charge in the same series', (t) => {
  const rootDir = tempRoot(t, 'durable');
  chargeHammer(rootDir, 'lrq_lost');
  voidHostRestartLostHammerDispatch(rootDir, IDENTITY, { launchRequestId: 'lrq_lost', terminalClass: LOST });
  chargeHammer(rootDir, 'lrq_next', { now: '2026-11-01T03:00:00Z' });
  assert.ok(readHammerRetryCapLedger(rootDir, IDENTITY).hostRestartVoids, 'the receipt is durable');
  assert.equal(voidHostRestartLostHammerDispatch(rootDir, IDENTITY, { launchRequestId: 'lrq_lost', terminalClass: LOST })
    .reason, 'already-refunded');
  assert.deepEqual(counts(rootDir), { attemptCount: 1, targetAttemptCount: 1, lifetimeAttemptCount: 1, rounds: 0 });
});

for (const priorRefund of ['host-restart', 'no-work']) {
  test(`a durable ${priorRefund} receipt reconciles a round left charged after interruption`, t => {
    const rootDir = tempRoot(t, 'receipt-replay');
    chargeHammer(rootDir, 'lrq_lost');
    const path = prRoundLedgerPath(rootDir, IDENTITY);
    const chargedRound = readFileSync(path, 'utf8');
    if (priorRefund === 'host-restart') {
      voidHostRestartLostHammerDispatch(rootDir, IDENTITY, { launchRequestId: 'lrq_lost', terminalClass: LOST });
    } else {
      refundHammerRetryDispatch(rootDir, IDENTITY, { jobKey: HEAD, headSha: HEAD,
        launchRequestId: 'lrq_lost', executionVerdict: noWorkVerdict('lrq_lost') });
    }
    // Model interruption after the retry refund committed, before the round void.
    writeFileSync(path, chargedRound);
    assert.equal(readPrRoundLedger(rootDir, IDENTITY)[0].voided, false);
    assert.equal(summarizePrRoundLedger(rootDir, IDENTITY).remediationRoundsUsed, 0);
    assert.deepEqual(voidHostRestartLostHammerDispatch(rootDir, IDENTITY, {
      launchRequestId: 'lrq_lost', terminalClass: LOST,
    }), { voided: true, refunded: false, reason: 'already-refunded' });
    assert.deepEqual(counts(rootDir), { attemptCount: 0, targetAttemptCount: 0, lifetimeAttemptCount: 0, rounds: 0 });
  });
}

const refusedLedgers = [
  ['missing', path => rmSync(path), 'no-ledger'],
  ['corrupt', path => writeFileSync(path, '{'), 'no-ledger'],
  ['invalid counters', path => {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    ledger.attemptCount = -1;
    writeFileSync(path, JSON.stringify(ledger));
  }, 'invalid-charge-counters'],
  ['unproven charge', path => {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    ledger.dispatchCharges = {};
    writeFileSync(path, JSON.stringify(ledger));
  }, 'no-charged-attempt'],
];

for (const [label, damage, reason] of refusedLedgers) {
  test(`host-restart refund refusal (${label}) retains the round and can recover`, t => {
    const rootDir = tempRoot(t, 'refund-refused');
    chargeHammer(rootDir, 'lrq_lost');
    const path = hammerRetryCapFilePath(rootDir, IDENTITY);
    const original = readFileSync(path, 'utf8');
    damage(path);
    const damaged = readHammerRetryCapLedger(rootDir, IDENTITY);
    assert.deepEqual(voidHostRestartLostHammerDispatch(rootDir, IDENTITY, {
      launchRequestId: 'lrq_lost', dispatchKey: 'intent-lrq_lost', terminalClass: LOST,
    }), { voided: false, refunded: false, reason });
    assert.deepEqual(readHammerRetryCapLedger(rootDir, IDENTITY), damaged);
    assert.equal(summarizePrRoundLedger(rootDir, IDENTITY).remediationRoundsUsed, 0);
    assert.equal(readPrRoundLedger(rootDir, IDENTITY)[0].voided, false);

    writeFileSync(path, original);
    assert.equal(voidHostRestartLostHammerDispatch(rootDir, IDENTITY, {
      launchRequestId: 'lrq_lost', terminalClass: LOST,
    }).voided, true);
    assert.deepEqual(counts(rootDir), { attemptCount: 0, targetAttemptCount: 0, lifetimeAttemptCount: 0, rounds: 0 });
  });
}

for (const terminalClass of ['worker_crashed', ...INFRA_DEAD_HAMMER_FAILURE_CLASSES, 'process_exited_after_progress',
  'worker-lost-to-host-restart', null]) {
  test(`terminal class ${JSON.stringify(terminalClass)} keeps its charge on this path`, (t) => {
    const rootDir = tempRoot(t, 'charged');
    chargeHammer(rootDir, 'lrq_dead');
    const before = counts(rootDir);
    assert.deepEqual(voidHostRestartLostHammerDispatch(rootDir, IDENTITY, {
      launchRequestId: 'lrq_dead', dispatchKey: 'intent-lrq_dead', terminalClass }),
    { voided: false, refunded: false, reason: 'charging-terminal-class' });
    assert.deepEqual(counts(rootDir), before);
    assert.equal(readPrRoundLedger(rootDir, IDENTITY)[0].voided, false);
  });
}

test('the existing infrastructure refund classes are unchanged', (t) => {
  assert.deepEqual([...INFRA_DEAD_HAMMER_FAILURE_CLASSES], ['oauth_access_token_revoked', 'adapter_boot_crash']);
  for (const cls of INFRA_DEAD_HAMMER_FAILURE_CLASSES) assert.equal(classifyDeadHammerCause({ failureClass: cls }).infra, true);
  assert.equal(classifyDeadHammerCause({ failureClass: 'worker_crashed' }).infra, false);
  assert.equal(classifyDeadHammerCause({ failureClass: LOST }).infra, false, 'host restart is not a dead-hammer cause');
  // A no-work verdict still refunds through its own receipt, once.
  const rootDir = tempRoot(t, 'nowork');
  chargeHammer(rootDir, 'lrq_nowork');
  const refund = refundHammerRetryDispatch(rootDir, IDENTITY, { jobKey: HEAD, headSha: HEAD,
    launchRequestId: 'lrq_nowork', dispatchKey: 'intent-lrq_nowork', executionVerdict: noWorkVerdict('lrq_nowork') });
  assert.equal(refund.refunded, true);
  assert.equal(refund.reason, 'unexecuted');
  assert.deepEqual(refund.receipt.budgets, { head: true, pr: true, lifetime: true, transient: false });
  const ledger = readHammerRetryCapLedger(rootDir, IDENTITY);
  assert.deepEqual([ledger.attemptCount, ledger.lifetimeAttemptCount], [0, 0]);
  assert.ok(ledger.noWorkRefunds['intent-lrq_nowork']);
  assert.equal(voidHostRestartLostHammerDispatch(rootDir, IDENTITY, { launchRequestId: 'lrq_nowork', terminalClass: LOST })
    .reason, 'already-refunded', 'a host-restart void never refunds a no-work refund twice');
  assert.deepEqual([readHammerRetryCapLedger(rootDir, IDENTITY).attemptCount,
    readHammerRetryCapLedger(rootDir, IDENTITY).lifetimeAttemptCount], [0, 0]);
});

// --- Closer replay through the real maybeDispatchAmaCloser -----------------

function seedSecondDeadCloser(rootDir, lostLaunch) {
  recordPriorPublishedHammer(rootDir);
  chargeHammer(rootDir, lostLaunch, { now: '2026-11-01T01:00:00Z' });
  const at = '2026-11-01T01:00:00Z';
  updateAmaCloserDispatchRecord(rootDir, { ...IDENTITY, headSha: HEAD }, () => ({
    schemaVersion: 1, ...IDENTITY, headSha: HEAD, reviewedSha: HEAD, targetRemediationSha: HEAD,
    dispatchReason: 'exhausted-final-hammer', workerClass: 'hammer-claude', dispatchWorkerClass: 'hammer-claude',
    workerId: `hammer-ama-pr-${PR_NUMBER}-${HEAD.slice(0, 12)}`, hqRoot: join(rootDir, 'hq-root'),
    dispatchTimeoutMs: 600000, lastAttemptedAt: at, dispatchedAt: at, dispatchId: lostLaunch,
    launchRequestId: lostLaunch, dispatchIdempotencyKey: `intent-${lostLaunch}`, retryCount: 2,
    branchHolderBlockCount: 0, state: 'dispatched', lastObservedStatus: 'starting', lastObservedAt: at, lastError: null,
  }));
  acquireAmaCloserLease({ rootDir, ...IDENTITY, headSha: HEAD, now: at });
  updateAmaCloserLease({ rootDir, ...IDENTITY, headSha: HEAD, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: lostLaunch, now: at });
  updateAmaCloserLease({ rootDir, ...IDENTITY, headSha: HEAD, status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
    terminalOutcome: 'failed-without-merge', now: '2026-11-01T01:30:00Z' });
}

function closerArgs(rootDir, dispatchedAt) {
  return {
    reviewState: {
      verdict: 'comment-only', headSha: HEAD, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 1, operatorApprovedEvidence: null, prAuthor: 'builder', reviewCycleExhausted: true,
    },
    prMetadata: {
      prNumber: PR_NUMBER, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
      branchProtection: { requiredContexts: [] }, author: 'builder',
    },
    cfg: {
      enabled: true, workerClass: 'hammer-claude', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: false },
      amaCloserMaxConcurrentLaunches: 1, amaCloserConcurrentLaunchCeiling: 1,
    },
    dispatchContext: {
      rootDir, repo: REPO, prUrl: `https://github.com/${REPO}/pull/${PR_NUMBER}`, reviewedSha: HEAD,
      targetRemediationSha: HEAD, dispatchRecordHeadSha: HEAD, allowStaleReviewHeadHammerResume: true,
      dispatchReason: 'exhausted-final-hammer', riskClass: 'low', requiredGateContext: 'synthetic/adversarial-gate',
      reviewedBy: 'synthetic-reviewer', reviewer: 'claude', parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test', hqRoot: join(rootDir, 'hq-root'), hqOwnerUser: CURRENT_USER, currentUser: CURRENT_USER,
      dispatchedAt,
      ledgerTarget: { backend: 'sqlite', path: join(rootDir, 'absent-ledger.sqlite') },
      closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: HEAD, headBranchExists: true, headRefName: 'hammer/live' }),
    },
  };
}

function closerDeps({ launchRows, nextLaunch = 'lrq_next', alerts = [] }) {
  const launches = [];
  const events = [];
  const record = (line) => { try { const parsed = JSON.parse(line); if (parsed?.event) events.push(parsed); } catch { /* text */ } };
  return {
    launches, events, alerts,
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') return { stdout: JSON.stringify({ status: 'failed' }), stderr: '' };
      if (args[0] === 'dispatch') {
        launches.push(args);
        return { stdout: JSON.stringify({ ticketRef: args[args.indexOf('--ticket') + 1], dispatchId: nextLaunch,
          launchRequestId: nextLaunch }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    // The orchestrator's verdict for a reboot mid-run: work had started.
    readExecutionVerdictsImpl: async ({ launchRequestId }) => ({ ok: true,
      verdicts: [noWorkVerdict(launchRequestId, { verdict: 'work_started', reason: 'productive_progress' })] }),
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    readLaunchRequestStatusImpl: async ({ launchRequestId }) => (launchRows[launchRequestId]
      ? { ok: true, row: launchRows[launchRequestId] } : { ok: false, reason: 'missing-launch-request-row' }),
    deliverAlertImpl: async (alert) => { alerts.push(alert); return { ok: true }; },
    logger: { log() {}, info: line => record(String(line)), warn: line => record(String(line)), error() {} },
  };
}

test('closer replay: a second closer lost to a host restart re-dispatches instead of exhausting the cap', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'closer-lost');
  seedSecondDeadCloser(rootDir, 'lrq_lost');
  const launchRows = { lrq_lost: { launch_request_id: 'lrq_lost', status: 'failed', failure_class: LOST,
    // Free text is never evidence; only the structured class decides.
    failure_detail: 'worker crashed' } };
  const deps = closerDeps({ launchRows });
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, '2026-11-01T02:00:00Z'), ...deps });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, 'lrq_next');
  assert.equal(deps.launches.length, 1);
  assert.deepEqual(deps.events.filter(e => e.event === 'ama_closer.host_restart_void').map(e => [e.launchRequestId, e.refunded]),
    [['lrq_lost', true]]);
  // The new dispatch spends firing capacity. The first publication spends a round.
  assert.deepEqual(counts(rootDir), { attemptCount: 2, targetAttemptCount: 2, lifetimeAttemptCount: 2, rounds: 1 });
  assert.deepEqual(readPrRoundLedger(rootDir, IDENTITY).filter(e => e.voided).map(e => e.launchRequestId), ['lrq_lost']);
  const record = readAmaCloserDispatchRecord(rootDir, { ...IDENTITY, headSha: HEAD });
  assert.equal(record.launchRequestId, 'lrq_next');
  assert.deepEqual(readCloserNoDeliveryLedger(rootDir, IDENTITY).heads?.[HEAD] ?? null, null,
    'a void closer spends no same-head no-delivery attempt');
});

test('closer replay: a second closer that crashed still exhausts the cap', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = tempRoot(t, 'closer-crashed');
  seedSecondDeadCloser(rootDir, 'lrq_crashed');
  const launchRows = { lrq_crashed: { launch_request_id: 'lrq_crashed', status: 'failed', failure_class: 'worker_crashed',
    failure_detail: 'worker_lost_to_host_restart' } };
  const alerts = [];
  const deps = closerDeps({ launchRows, nextLaunch: 'lrq_unexpected', alerts });
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, '2026-11-01T02:00:00Z'), ...deps });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'hammer-retry-cap-exhausted');
  assert.equal(deps.launches.length, 0);
  assert.deepEqual(counts(rootDir), { attemptCount: HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
    targetAttemptCount: HAMMER_RETRY_CAP_TOTAL_DISPATCHES, lifetimeAttemptCount: HAMMER_RETRY_CAP_TOTAL_DISPATCHES,
    rounds: 1 });
  assert.equal(deps.events.filter(e => e.event === 'ama_closer.host_restart_void').length, 0);
  assert.equal(readHammerRetryCapLedger(rootDir, IDENTITY).hostRestartVoids, undefined);
});

for (const [label, damage] of refusedLedgers) {
  test(`closer replay: refused host-restart refund (${label}) retains every other budget`, async t => {
    _resetHammerRetryCapAlertDebounceForTests();
    const rootDir = tempRoot(t, 'closer-refused');
    seedSecondDeadCloser(rootDir, 'lrq_lost');
    const path = hammerRetryCapFilePath(rootDir, IDENTITY);
    const original = readFileSync(path, 'utf8');
    damage(path);
    const damaged = readHammerRetryCapLedger(rootDir, IDENTITY);
    const deps = closerDeps({ launchRows: { lrq_lost: {
      launch_request_id: 'lrq_lost', status: 'failed', failure_class: LOST,
    } } });
    for (const dispatchedAt of ['2026-11-01T02:00:00Z', '2026-11-01T02:01:00Z']) {
      const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, dispatchedAt), ...deps });
      assert.equal(result.reason, 'host-restart-refund-unavailable');
      assert.equal(result.recoveryWait, true);
      assert.equal(result.dispatched, false);
      assert.equal(deps.launches.length, 0);
      assert.deepEqual(readHammerRetryCapLedger(rootDir, IDENTITY), damaged);
      assert.equal(summarizePrRoundLedger(rootDir, IDENTITY).remediationRoundsUsed, 1);
      const record = readAmaCloserDispatchRecord(rootDir, { ...IDENTITY, headSha: HEAD });
      assert.equal(record.launchRequestId, 'lrq_lost');
      assert.equal(record.hostRestartVoidedLaunchRequestId, undefined);
      assert.equal(record.unexecutedRefundCount || 0, 0);
      assert.equal(record.retryCount, 2);
      assert.deepEqual(readCloserNoDeliveryLedger(rootDir, IDENTITY).heads?.[HEAD] ?? null, null);
      assert.equal(deps.events.filter(e => e.event === 'ama_closer.host_restart_void').length, 0);
    }

    writeFileSync(path, original);
    const recovered = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, '2026-11-01T02:02:00Z'), ...deps });
    assert.equal(recovered.dispatched, true, JSON.stringify(recovered));
    assert.equal(deps.launches.length, 1);
    assert.deepEqual(readPrRoundLedger(rootDir, IDENTITY).filter(e => e.voided).map(e => e.launchRequestId), ['lrq_lost']);
    assert.deepEqual(counts(rootDir), { attemptCount: 2, targetAttemptCount: 2, lifetimeAttemptCount: 2, rounds: 1 });
  });
}
