// HAMREFUND-01: offline replays of the signal and tool-host deaths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { _resetPrelaunchRefusalPageDebounceForTests } from '../src/ama/prelaunch-refusal-retry.mjs';
test.beforeEach(() => _resetPrelaunchRefusalPageDebounceForTests());

import {
  HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import {
  deleteAmaCloserLease,
  acquireAmaCloserLease,
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import {
  HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES,
  evaluateHammerRetryCap,
  markHammerRetryCapExhausted,
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
  refundHammerRetryDispatch,
  refundUnexecutedHammerDispatch,
} from '../src/ama/hammer-retry-cap.mjs';
import { unexecutedHammerReason } from '../src/ama/dead-hammer-rearm.mjs';
import { selectNewerHammerLaunchRecord } from '../src/ama/hammer-outcome-truth.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR_NUMBER = 8035;
const HEAD = '428ad20c7f0ae9e5840586aaf70f4c08132875b4';
const DEAD_LRQ = 'lrq_58bbdea0';
const NEXT_LRQ = 'lrq_rearmed-hammer';
// The launch that held the concurrency slot on the first pass (agent-os#7344).
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

function closerArgs(rootDir, { dispatchedAt, prNumber = PR_NUMBER, head = HEAD }) {
  return {
    reviewState: {
      verdict: 'comment-only',
      headSha: head,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 3,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      reviewCycleExhausted: true,
    },
    prMetadata: {
      prNumber,
      headSha: head,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
      branchProtection: { requiredContexts: [] },
      author: 'builder',
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer-claude',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      branchProtection: { required: false },
      amaCloserMaxConcurrentLaunches: 1,
      amaCloserConcurrentLaunchCeiling: 1, // Pin the replay's deliberately saturated capacity.
    },
    dispatchContext: {
      rootDir,
      repo: REPO,
      prUrl: `https://github.com/${REPO}/pull/${prNumber}`,
      reviewedSha: head,
      targetRemediationSha: head,
      dispatchRecordHeadSha: head,
      allowStaleReviewHeadHammerResume: true,
      dispatchReason: 'exhausted-final-hammer',
      riskClass: 'low',
      requiredGateContext: 'agent-os/adversarial-gate',
      reviewedBy: 'claude-reviewer-lacey',
      reviewer: 'claude',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt,
      // No session ledger: the token rollup read must not reach the host's.
      ledgerTarget: { backend: 'sqlite', path: join(rootDir, 'absent-ledger.sqlite') },
      closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: head, headBranchExists: true, headRefName: 'hammer/live' }),
    },
  };
}

function closerDeps({ nextLaunch = NEXT_LRQ, launchStatus = 'failed', launchRows = {}, alerts = [] } = {}) {
  const statusProbes = [];
  const launches = [];
  const warnings = [];
  const events = [];
  const record = (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.event) events.push(parsed);
    } catch {
      // Not a structured event.
    }
  };
  return {
    readPullRequestStateImpl: () => null,
    statusProbes,
    launches,
    warnings,
    events,
    alerts,
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        statusProbes.push(args[2]);
        return { stdout: JSON.stringify({ status: launchStatus }), stderr: '' };
      }
      if (args[0] === 'dispatch') {
        launches.push(args);
        return { stdout: JSON.stringify({ ticketRef: args[args.indexOf('--ticket') + 1], dispatchId: nextLaunch, launchRequestId: nextLaunch }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: true, row: { repo: REPO, signal_kind: 'merged' } }),
    readLaunchRequestStatusImpl: async ({ launchRequestId }) => (launchRows[launchRequestId]
      ? { ok: true, row: launchRows[launchRequestId] }
      : launchRequestId === DEAD_LRQ
        ? { ok: true, row: { status: launchStatus } }
        : { ok: false, reason: 'missing-launch-request-row' }),
    deliverAlertImpl: async (alert) => {
      alerts.push(alert);
      return { ok: true };
    },
    logger: {
      log() {},
      info: (line) => record(String(line)),
      warn: (line) => {
        warnings.push(String(line));
        record(String(line));
      },
      error() {},
    },
  };
}


// A dead hammer's deployed record (data/follow-up-jobs/ama-closer-dispatches)
// as the closer found it after the death: still `dispatched`, still `starting`.
// `retryCount` is the attempt number the closer pass is keyed on. The SEV
// describes the shape with none; #7347's deployed record carries 1. Both key
// attempt 1.
function seedDeadHammer(rootDir, {
  prNumber = PR_NUMBER,
  head = HEAD,
  launchRequestId = DEAD_LRQ,
  retryCount,
  dispatchedAt = '2026-10-10T23:05:00Z',
  deadAt = '2026-10-10T23:06:00Z',
  chargedDispatches = 1,
} = {}) {
  const identity = { repo: REPO, prNumber };
  updateAmaCloserDispatchRecord(rootDir, { ...identity, headSha: head }, () => ({
    schemaVersion: 1,
    ...identity,
    headSha: head,
    reviewedSha: head,
    targetRemediationSha: head,
    dispatchReason: 'exhausted-final-hammer',
    workerClass: 'hammer-claude',
    dispatchWorkerClass: 'hammer-claude',
    workerId: `hammer-ama-pr-${prNumber}-${head.slice(0, 12)}`,
    hqRoot: join(rootDir, 'hq-root'),
    dispatchTimeoutMs: 600000,
    lastAttemptedAt: dispatchedAt,
    dispatchedAt,
    dispatchId: launchRequestId,
    launchRequestId,
    ...(retryCount === undefined ? {} : { retryCount }),
    branchHolderBlockCount: 0,
    state: 'dispatched',
    lastObservedStatus: 'starting',
    lastObservedAt: dispatchedAt,
    lastError: null,
  }));
  // The lease the stuck-claim sweep left: terminal, failed-without-merge.
  acquireAmaCloserLease({ rootDir, ...identity, headSha: head, now: dispatchedAt });
  updateAmaCloserLease({
    rootDir, ...identity, headSha: head, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: launchRequestId, now: dispatchedAt,
  });
  updateAmaCloserLease({
    rootDir, ...identity, headSha: head, status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
    terminalOutcome: 'failed-without-merge', now: deadAt,
  });
  for (let index = 0; index < chargedDispatches; index += 1) {
    recordHammerRetryDispatch(rootDir, identity, { jobKey: head, headSha: head, now: dispatchedAt });
  }
}


for (const [label, launchRequestId, row] of [
  ['failed signal (PR 8035)', 'lrq_58bbdea0', { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' }],
  ['Codex tool host (PR 8047)', 'lrq_556cc4da', { status: 'failed', failure_class: 'codex-tool-host-unavailable' }],
  ['SIGKILL harness detail', 'lrq_sigkill', { status: 'failed', failure_class: 'worker_killed', failure_detail: 'worker killed by SIGKILL' }],
]) {
  test(`HAMREFUND-01: ${label} refunds and waits, even at the per-head bound`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedDeadHammer(rootDir, { launchRequestId, retryCount: 3 });
    const deps = closerDeps({ launchStatus: row.status, launchRows: { [launchRequestId]: row } });
    const result = await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
    });
    assert.equal(result.reason, 'dispatch-refusal-slow-retry-wait');
    assert.equal(deps.launches.length, 0);
    assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 0);
    assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).lifetimeAttemptCount, 1);
    assert.equal(deps.alerts.length, 1);
    assert.match(deps.alerts[0], /SIGTERM|SIGKILL|codex-tool-host-unavailable/);
  });
}

test('HAMREFUND-01: three deaths retain lifetime charges; cadence and both pages persist across launches', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-series-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedDeadHammer(rootDir, { retryCount: 1 });
  const alerts = [];
  const rows = { [DEAD_LRQ]: { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' } };
  let now = Date.parse('2026-10-10T23:07:00Z');
  // Terminal observations use the wall clock independently of dispatchedAt.
  t.mock.timers.enable({ apis: ['Date'], now });
  const tick = async (at, nextLaunch) => {
    t.mock.timers.setTime(at);
    const deps = closerDeps({ launchRows: rows, alerts, nextLaunch });
    const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt: new Date(at).toISOString() }), ...deps });
    return { result, deps };
  };
  let first = await tick(now);
  assert.equal(first.result.reason, 'dispatch-refusal-slow-retry-wait');
  const start = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: HEAD }).prelaunchRefusalSlowRetry.startedAt;
  for (let index = 0; index < 2; index += 1) {
    const nextLaunch = ['lrq_445fb3b9', 'lrq_c923732b'][index];
    now += 32 * 60_000;
    const due = await tick(now, nextLaunch);
    assert.equal(due.result.dispatched, true, JSON.stringify(due.result));
    rows[nextLaunch] = { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' };
    now += 60_000;
    const died = await tick(now);
    assert.equal(died.result.reason, 'dispatch-refusal-slow-retry-wait');
    const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
    assert.equal(ledger.attemptCount, 0);
    assert.equal(ledger.lifetimeAttemptCount, index + 2);
    assert.equal(ledger.unexecutedLaunchRequestIds.length, index + 2);
    const wait = await tick(now + 60_000);
    assert.equal(wait.deps.launches.length, 0);
  }
  assert.equal(alerts.length, 1);
  const ended = await tick(Date.parse(start) + 6 * 60 * 60_000);
  assert.equal(ended.result.reason, 'dispatch-retry-exhausted');
  assert.equal(ended.deps.launches.length, 0);
  assert.equal(alerts.length, 2);
  assert.match(alerts[1], /window closed/);
  await tick(Date.parse(start) + 7 * 60 * 60_000);
  assert.equal(alerts.length, 2);
});

test('HAMREFUND-01: only exact durable host/signal evidence earns the new refund', () => {
  assert.equal(unexecutedHammerReason({ failure_class: 'worker_crashed', failure_detail: 'SIGTERM' }), null);
  assert.equal(unexecutedHammerReason({ failure_class: 'worker_killed', exit_code: 143 }), null);
  assert.equal(unexecutedHammerReason({ reason: 'codex-tool-host-unavailable' }), null);
  assert.equal(unexecutedHammerReason({ failure_reason: 'codex-tool-host-unavailable' }), null);
  assert.equal(unexecutedHammerReason({ failure_detail: 'codex-tool-host-unavailable' }), 'codex-tool-host-unavailable');
  assert.equal(unexecutedHammerReason({ failure_class: 'worker_killed', failure_detail: 'ordinary crash' }), null);
  assert.equal(unexecutedHammerReason({ failure_detail: 'worker quoted codex-tool-host-unavailable' }), null);
  assert.equal(unexecutedHammerReason({ failure_class: 'worker_killed', failure_detail: 'API Error: 429' }), null);
});

test('HAMREFUND-01: repeated reconciliation is idempotent and leaves the old refund grant available', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-idempotent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD });
  const args = { jobKey: HEAD, headSha: HEAD, launchRequestId: DEAD_LRQ };
  assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, args).refunded, true);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD });
  assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, args).reason, 'already-refunded');
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 1);
  assert.equal(refundHammerRetryDispatch(rootDir, identity, { ...args, launchRequestId: 'lrq_429' }).refunded, true);
});

test('HAMREFUND-01: a refunded closer head remains the series owner while waiting', () => {
  const record = {
    headSha: 'a'.repeat(40), reviewedSha: HEAD, dispatchedAt: '2026-10-10T23:05:00Z',
    launchRequestId: null, previousUnexecutedLaunchRequestId: DEAD_LRQ,
    prelaunchRefusalSlowRetry: { kind: 'non-execution', startedAt: '2026-10-10T23:07:00Z' },
  };
  assert.equal(selectNewerHammerLaunchRecord([record], { reviewedSha: HEAD, reviewedHeadSha: HEAD }), record);
});

for (const [name, live, comments] of [
  ['advanced head', { state: 'OPEN', headRefOid: 'a'.repeat(40) }, []],
  ['merged PR', { state: 'MERGED', headRefOid: HEAD }, []],
  ['closed PR', { state: 'CLOSED', headRefOid: HEAD }, []],
  ['unreadable live state', null, []],
  ['closing comment', { state: 'OPEN', headRefOid: HEAD }, [{ author: { login: 'the-hammer-lacey' }, body: `${HAM_TERMINAL_REMEDIATION_AUDIT_MARKER}\nHAM-Terminal-Remediation-Head: ${HEAD}\nHAM closing status — no merge` }]],
]) {
  test(`HAMREFUND-01: ${name} never refunds the launch`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-provenance-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedDeadHammer(rootDir, { retryCount: 1 });
    const deps = closerDeps({ launchRows: { [DEAD_LRQ]: { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' } } });
    await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
      dispatchContext: { ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }).dispatchContext, dispatchedAt: '2026-10-10T23:07:00Z', livePrProbeImpl: async () => live },
      fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments }),
    });
    assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).unexecutedLaunchRequestIds, undefined);
  });
}

for (const signalRead of [
  { ok: false, reason: 'ledger-read-failed' },
  { ok: false, reason: 'missing-build-completion-signal' },
]) {
  test(`FINALCLOSE-01 terminal final launch retries on confirmed open head despite unavailable merge-signal metadata (${signalRead.reason})`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-success-hold-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedDeadHammer(rootDir, { retryCount: 1 });
    const identity = { repo: REPO, prNumber: PR_NUMBER, headSha: HEAD };
    deleteAmaCloserLease(rootDir, identity);
    acquireAmaCloserLease({ rootDir, ...identity, now: '2026-10-10T23:05:00Z' });
    updateAmaCloserLease({ rootDir, ...identity, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED, lrqId: DEAD_LRQ, now: '2026-10-10T23:05:00Z' });
    const deps = closerDeps({ launchStatus: 'succeeded' });
    const result = await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
      readBuildCompletionSignalForPrImpl: () => signalRead,
      readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.equal(deps.launches.length, 1);
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    assert.notEqual(record.launchRequestId, DEAD_LRQ);
    assert.equal(Number(record.unexecutedRefundCount || 0), 0);
    const ledger = readHammerRetryCapLedger(rootDir, identity);
    assert.equal(ledger.attemptCount, 2);
    assert.equal(ledger.lifetimeAttemptCount, 2);
    assert.equal(ledger.retryable, undefined);
  });
}

test('FINALCLOSE-01 final launches stay charged after a cleanly missing merge signal', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-success-bounded-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedDeadHammer(rootDir, { retryCount: 1 });
  const deps = closerDeps({ launchStatus: 'succeeded' });
  await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
  });
  const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
  assert.equal(ledger.retryableLaunchRequestIds, undefined);
  assert.equal(ledger.retryable, undefined);
  assert.equal(ledger.unexecutedLaunchRequestIds, undefined);
  assert.equal(ledger.lifetimeAttemptCount, 2, 'both the exit and the new launch remain charged');
});

test('HAMREFUND-01: lifetime ceiling and suppression survive signal refunds and fresh reviews', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-lifetime-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  for (let index = 0; index < HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES; index += 1) {
    const head = String(index).padStart(40, 'a');
    recordHammerRetryDispatch(rootDir, identity, { jobKey: head, headSha: head });
    assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, {
      jobKey: head, headSha: head, launchRequestId: `lrq_lifetime_${index}`,
    }).refunded, true);
    assert.equal(readHammerRetryCapLedger(rootDir, identity).lifetimeAttemptCount, index + 1);
  }
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(evaluateHammerRetryCap(ledger, { jobKey: 'fresh-head', headSha: 'fresh-head' }).lifetimeCapExhausted, true);
  markHammerRetryCapExhausted(rootDir, identity, { jobKey: ledger.jobKey, headSha: ledger.targetRemediationSha, attemptCount: 1, lifetime: true });
  assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, {
    jobKey: ledger.jobKey, headSha: ledger.targetRemediationSha, launchRequestId: 'lrq_suppressed',
  }).refunded, true);
  const suppressed = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(suppressed.lifetimeAttemptCount, HAMMER_RETRY_CAP_LIFETIME_TOTAL_DISPATCHES);
  assert.equal(suppressed.lifetimeSuppressed, true);
  markHammerRetryCapExhausted(rootDir, identity, { jobKey: 'fresh-head', headSha: 'fresh-head', attemptCount: 0 });
  assert.equal(readHammerRetryCapLedger(rootDir, identity).lifetimeSuppressed, true);
});

test('HAMREFUND-01: refund history stays bounded across fresh series and suppression writes', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-history-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  for (let index = 0; index < 13; index += 1) {
    const head = `head-${index}`;
    recordHammerRetryDispatch(rootDir, identity, { jobKey: head, headSha: head });
    const args = { jobKey: head, headSha: head, launchRequestId: `lrq_history_${index}` };
    assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, args).refunded, true);
    assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, args).reason, 'already-refunded');
  }
  markHammerRetryCapExhausted(rootDir, identity, { jobKey: 'new-series', headSha: 'new-head', attemptCount: 0 });
  const history = readHammerRetryCapLedger(rootDir, identity).unexecutedLaunchRequestIds;
  assert.equal(history.length, 10);
  assert.equal(history[0], 'lrq_history_3');
  assert.equal(history.at(-1), 'lrq_history_12');
});

test('HAMREFUND-01: a concurrent dispatch-record change logs the persisted refund', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-record-race-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedDeadHammer(rootDir, { retryCount: 1 });
  const deps = closerDeps({ launchRows: { [DEAD_LRQ]: { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' } } });
  const identity = { repo: REPO, prNumber: PR_NUMBER, headSha: HEAD };
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
    execFileImpl: async (command, args, options) => {
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        updateAmaCloserDispatchRecord(rootDir, identity, (current) => ({ ...current, launchRequestId: 'lrq_concurrent' }));
      }
      return deps.execFileImpl(command, args, options);
    },
  });
  assert.equal(result.reason, 'dispatch-record-changed');
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).launchRequestId, 'lrq_concurrent');
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity).unexecutedLaunchRequestIds, [DEAD_LRQ]);
  const event = deps.events.find((entry) => entry.event === 'ama_closer.unexecuted_refund_dispatch_record_changed');
  assert.equal(event.launchRequestId, DEAD_LRQ);
  assert.equal(event.refund.refunded, true);
});

for (const [label, signalRead, producerRead] of [
  ['ledger read failed', { ok: false, reason: 'ledger-read-failed' }, { ok: true }],
  ['producer evidence unknown', { ok: false, reason: 'missing-build-completion-signal' }, { ok: false, reason: 'missing-build-completion-producer-evidence' }],
  ['merged signal present', { ok: true, row: { head_sha: HEAD } }, { ok: true }],
]) {
  test(`HAMREFUND-01: durable signal failure is not refunded when ${label}`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hamrefund-merged-evidence-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedDeadHammer(rootDir, { retryCount: 1 });
    const deps = closerDeps({ launchRows: { [DEAD_LRQ]: { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' } } });
    await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
      readBuildCompletionSignalForPrImpl: () => signalRead,
      readBuildCompletionProducerEvidenceImpl: () => producerRead,
    });
    const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
    assert.equal(ledger.unexecutedLaunchRequestIds, undefined);
    assert.ok(ledger.lifetimeAttemptCount >= 1);
  });
}


test('LABELGATE-01: later signal reconciliation cannot credit the same launch twice', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-signal-refund-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedDeadHammer(rootDir, { retryCount: 3 });
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  const refund = refundUnexecutedHammerDispatch(rootDir, identity, {
    jobKey: HEAD, headSha: HEAD, launchRequestId: DEAD_LRQ, now: '2026-10-10T23:06:00Z',
  });
  assert.equal(refund.refunded, true);
  updateAmaCloserDispatchRecord(rootDir, { ...identity, headSha: HEAD }, current => ({
    ...current, labelGateRefundedLaunchRequestId: DEAD_LRQ, unexecutedRefundCount: 1,
  }));
  const deps = closerDeps({ launchRows: {
    [DEAD_LRQ]: { status: 'failed', failure_class: 'worker_killed', failure_detail: 'SIGTERM' },
  } });
  const result = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-10-10T23:07:00Z' }), ...deps,
  });
  assert.equal(result.reason, 'dispatch-refusal-slow-retry-wait');
  assert.equal(readAmaCloserDispatchRecord(rootDir, { ...identity, headSha: HEAD }).unexecutedRefundCount, 1);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 0);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).lifetimeAttemptCount, 1);
});


test('LABELGATE-01: ordinary exit refund cannot reuse durable label/non-execution credit', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-cross-refund-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedDeadHammer(rootDir, { chargedDispatches: 2 });
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  const args = { jobKey: HEAD, headSha: HEAD, launchRequestId: DEAD_LRQ };
  assert.equal(refundUnexecutedHammerDispatch(rootDir, identity, args).refunded, true);
  assert.equal(refundHammerRetryDispatch(rootDir, identity, args).reason, 'already-refunded');
  assert.equal(readHammerRetryCapLedger(rootDir, identity).attemptCount, 1);
  assert.equal(refundHammerRetryDispatch(rootDir, identity, { ...args, launchRequestId: NEXT_LRQ }).refunded, true);
});
