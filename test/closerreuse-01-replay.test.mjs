// CLOSERREUSE-01 (SEV2 2026-09-29, agent-os#7355): a dead hammer's terminal
// closer record failed every later closer decision for its PR.
//
// agent-os#7347's hammer (lrq_1049fcf5) died on a Claude account 429 at 09:17Z.
// The first closer pass after that reconciled the failed launch, recorded its
// closer pass (reviewer_passes attempt=1), and then deferred the re-dispatch on
// another PR's in-flight launch (`ama-closer-launch-in-progress`). Every later
// pass re-reconciled the same launch, tried to record the same closer pass
// again, and threw `refusing to reuse terminal reviewer_passes row ...
// attempt=1 pass_kind=closer status=failed`. The throw escaped
// maybeDispatchAmaCloser, so the watcher fell back to a merge-agent that could
// not run, and the PR stranded for 3.5 hours.
//
// These tests drive the real maybeDispatchAmaCloser through that shape. Only
// hq and gh are stubbed. The record and lease are the deployed ones, read-only,
// from the watcher host.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import {
  _resetHammerRetryCapAlertDebounceForTests,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import {
  acquireAmaCloserLease,
  AMA_CLOSER_LEASE_STATUS,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR_NUMBER = 7347;
const HEAD = '428ad20c7f0ae9e5840586aaf70f4c08132875b4';
const DEAD_LRQ = 'lrq_1049fcf5-d0de-435e-8cb8-4039592d5335';
const NEXT_LRQ = 'lrq_rearmed-hammer';
// The launch that held the concurrency slot on the first pass (agent-os#7344).
const OTHER_PR = 7344;
const OTHER_HEAD = 'b5a26bfb8c87a37b5c74f538458b1099867545b5';
const OTHER_LRQ = 'lrq_other-pr-hammer';
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

// The tail of every dead hammer's stdout.log in the SEV (lrq_1049fcf5,
// lrq_35ef52f7, lrq_9152ec06, lrq_c3c0ab3e): Claude Code's stream-json, ending
// in the provider's 429. Trimmed to the fields the classifier reads.
const DEAD_HAMMER_429_STDOUT = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: '3b86170d', model: 'claude-opus-5-5' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later." }] },
    error: 'rate_limit',
    is_api_error_message: true,
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: 429,
    result: "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
    num_turns: 1,
  }),
  '',
].join('\n');

// The dispatch daemon's LRQ row for a hammer the drain reaped after its
// process exited (dispatch audit: reap_dead_workers, process_exited_after_progress).
function deadLaunchRow(launchRequestId, failureClass = 'process_exited_after_progress') {
  return { launch_request_id: launchRequestId, status: 'failed', failure_class: failureClass };
}

function writeWorkerStdout(rootDir, launchRequestId, stdout) {
  const dir = join(rootDir, 'hq-root', 'dispatch', launchRequestId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout.log'), stdout);
}

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
        return { stdout: JSON.stringify({ dispatchId: nextLaunch, launchRequestId: nextLaunch }), stderr: '' };
      }
      return { stdout: '{}', stderr: '' };
    },
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
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
  dispatchedAt = '2026-09-29T09:01:45Z',
  deadAt = '2026-09-29T09:17:17Z',
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

// agent-os#7344's hammer, in flight and holding the only launch slot.
function seedOtherPrLaunch(rootDir) {
  const identity = { repo: REPO, prNumber: OTHER_PR, headSha: OTHER_HEAD };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({
    schemaVersion: 1,
    ...identity,
    reviewedSha: OTHER_HEAD,
    targetRemediationSha: OTHER_HEAD,
    workerClass: 'hammer-claude',
    dispatchWorkerClass: 'hammer-claude',
    dispatchTimeoutMs: 600000,
    lastAttemptedAt: '2026-09-29T09:01:12Z',
    dispatchedAt: '2026-09-29T09:01:12Z',
    dispatchId: OTHER_LRQ,
    launchRequestId: OTHER_LRQ,
    retryCount: 1,
    state: 'dispatched',
    lastObservedStatus: 'running',
    lastObservedAt: '2026-09-29T09:15:00Z',
    lastError: null,
  }));
  acquireAmaCloserLease({ rootDir, ...identity, now: '2026-09-29T09:01:00Z' });
  updateAmaCloserLease({
    rootDir, ...identity, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED, lrqId: OTHER_LRQ, now: '2026-09-29T09:15:00Z',
  });
}

function releaseOtherPrLaunch(rootDir) {
  updateAmaCloserLease({
    rootDir, repo: REPO, prNumber: OTHER_PR, headSha: OTHER_HEAD,
    status: AMA_CLOSER_LEASE_STATUS.TERMINAL, terminalOutcome: 'succeeded', now: '2026-09-29T09:40:00Z',
  });
}

function closerPassRows(rootDir, prNumber = PR_NUMBER) {
  const db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true });
  try {
    return db.prepare(
      `SELECT attempt_number, status, json_extract(metadata_json, '$.launchRequestId') AS launch
         FROM reviewer_passes WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'
        ORDER BY attempt_number`,
    ).all(REPO, prNumber);
  } finally {
    db.close();
  }
}

for (const retryCount of [undefined, 1]) {
  test(`#7347 replay (retryCount=${retryCount}): the second pass over a dead hammer's terminal record does not throw`, async (t) => {
    _resetHammerRetryCapAlertDebounceForTests();
    const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-7347-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seedDeadHammer(rootDir, { retryCount });
    seedOtherPrLaunch(rootDir);
    writeWorkerStdout(rootDir, DEAD_LRQ, DEAD_HAMMER_429_STDOUT);
    const launchRows = { [DEAD_LRQ]: deadLaunchRow(DEAD_LRQ), [OTHER_LRQ]: { status: 'running' } };

    // 09:18Z, the first pass after the death: the pass is recorded, then the
    // re-dispatch waits for #7344's launch.
    const first = closerDeps({ launchRows });
    const pass1 = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T09:18:23Z' }), ...first });
    assert.equal(pass1.dispatched, false, JSON.stringify(pass1));
    assert.equal(pass1.reason, 'ama-closer-launch-in-progress');
    assert.deepEqual(first.statusProbes, [DEAD_LRQ]);
    assert.deepEqual(closerPassRows(rootDir), [{ attempt_number: 1, status: 'failed', launch: DEAD_LRQ }]);
    const rearmEvents = (deps) => deps.events.filter((entry) => entry.event === 'ama_closer.infra_dead_hammer_rearm');
    assert.deepEqual(rearmEvents(first).map((entry) => [entry.rearmed, entry.cause]),
      [[true, 'process_exited_after_progress:api-429']]);

    // 09:30Z: the same record, the same launch, the same attempt. Before
    // CLOSERREUSE-01 this threw and the watcher logged `AMA dispatch failed`.
    const second = closerDeps({ launchRows });
    const pass2 = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T09:30:40Z' }), ...second });
    assert.equal(pass2.dispatched, false, JSON.stringify(pass2));
    assert.equal(pass2.reason, 'ama-closer-launch-in-progress');
    assert.deepEqual(closerPassRows(rootDir), [{ attempt_number: 1, status: 'failed', launch: DEAD_LRQ }],
      'recording the same launch again is a no-op');
    assert.ok(second.warnings.some((line) => line.includes('closer pass already recorded')), second.warnings.join('\n'));
    assert.deepEqual(rearmEvents(second), [], 'the refunded launch is not re-logged while the re-dispatch waits');

    // #7344's launch finishes: the next pass re-arms the dead hammer's head.
    releaseOtherPrLaunch(rootDir);
    launchRows[OTHER_LRQ] = { status: 'succeeded' };
    const third = closerDeps({ launchRows });
    const pass3 = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T09:41:02Z' }), ...third });
    assert.equal(pass3.dispatched, true, JSON.stringify(pass3));
    assert.equal(pass3.launchRequestId, NEXT_LRQ);
    assert.equal(third.launches.length, 1);
    const record = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: HEAD });
    assert.equal(record.launchRequestId, NEXT_LRQ);
    assert.equal(record.retryCount, (retryCount || 0) + 1);
    const lease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR_NUMBER, headSha: HEAD });
    assert.equal(lease.status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
    assert.equal(lease.lrqId, NEXT_LRQ);
    // The 429 death was refunded once, on the first pass, not once per pass.
    const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER });
    assert.equal(ledger.retryable, 1);
    assert.deepEqual(ledger.retryableLaunchRequestIds, [DEAD_LRQ]);
    assert.equal(ledger.attemptCount, 1, 'only the re-arm is charged');
    assert.equal(ledger.lifetimeAttemptCount, 2, 'the lifetime count is never refunded');
  });
}

test('a closer-pass recording error is logged and does not fail the closer decision', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-record-error-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seedDeadHammer(rootDir, { retryCount: 1 });
  // reviews.db cannot be opened: every reviewer_passes read and write throws.
  mkdirSync(join(rootDir, 'data', 'reviews.db'), { recursive: true });
  writeFileSync(join(rootDir, 'data', 'reviews.db', 'not-a-database'), '');

  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T09:18:23Z' }), ...deps });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, NEXT_LRQ);
  const warning = deps.warnings.find((line) => line.includes('closer pass recording failed'));
  assert.ok(warning, deps.warnings.join('\n'));
  assert.match(warning, new RegExp(`${REPO}#${PR_NUMBER}`));
  assert.match(warning, new RegExp(DEAD_LRQ));
});

test('a different launch at an occupied attempt is recorded at the next free attempt', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-next-attempt-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  // An earlier review series' first closer (retryCount 1) already holds attempt 1.
  const metadata = { amaCloser: true, launchRequestId: 'lrq_earlier-series' };
  beginReviewerPass(rootDir, {
    repo: REPO, prNumber: PR_NUMBER, attemptNumber: 1, reviewerClass: 'hammer-claude', passKind: 'closer',
    workerRunId: 'wr-earlier', startedAt: '2026-09-28T01:00:00Z', metadata,
  });
  completeReviewerPass(rootDir, {
    repo: REPO, prNumber: PR_NUMBER, attemptNumber: 1, passKind: 'closer', status: 'failed',
    endedAt: '2026-09-28T01:10:00Z', workerRunId: 'wr-earlier', metadata,
  });
  seedDeadHammer(rootDir, { retryCount: 1 });

  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T09:18:23Z' }), ...deps });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.deepEqual(closerPassRows(rootDir), [
    { attempt_number: 1, status: 'failed', launch: 'lrq_earlier-series' },
    { attempt_number: 2, status: 'failed', launch: DEAD_LRQ },
  ]);
  const collision = deps.warnings.find((line) => line.includes('attempt-number collision'));
  assert.ok(collision, deps.warnings.join('\n'));
  assert.match(collision, /lrq_earlier-series/);
  assert.match(collision, new RegExp(`recording launchRequestId=${DEAD_LRQ} at attempt=2`));
});

// agent-os#7349 (VDBORPHAN-01R2): two hammer-claude launches, both dead on
// Claude account 429s before they did anything. The second death met the
// per-series cap (2 dispatches) and parked the PR for an operator.
const PR_7349 = 7349;
const HEAD_7349 = '69ce8fd93651126428ec5b3ec9a6e543e41d7550';
const LRQ_7349_SECOND = 'lrq_9152ec06-ed3c-4865-a0ab-483d81d703b5';
const LRQ_7349_REARM = 'lrq_rearmed-7349';

function seed7349AfterSecondDeath(rootDir) {
  seedDeadHammer(rootDir, {
    prNumber: PR_7349,
    head: HEAD_7349,
    launchRequestId: LRQ_7349_SECOND,
    retryCount: 2,
    dispatchedAt: '2026-09-29T09:41:02Z',
    deadAt: '2026-09-29T09:55:40Z',
    chargedDispatches: 2,
  });
  writeWorkerStdout(rootDir, LRQ_7349_SECOND, DEAD_HAMMER_429_STDOUT);
}

test('#7349 replay: a hammer dead on a 429 re-arms within the series budget, then the cap pages', async (t) => {
  _resetHammerRetryCapAlertDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-7349-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  seed7349AfterSecondDeath(rootDir);
  const alerts = [];
  const identity = { repo: REPO, prNumber: PR_7349 };

  // 10:01Z. Before CLOSERREUSE-01: `hammer-retry-cap-exhausted`, operator paged.
  const first = closerDeps({
    nextLaunch: LRQ_7349_REARM,
    launchRows: { [LRQ_7349_SECOND]: deadLaunchRow(LRQ_7349_SECOND) },
    alerts,
  });
  const rearmed = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T10:01:00Z', prNumber: PR_7349, head: HEAD_7349 }),
    ...first,
  });
  assert.equal(rearmed.dispatched, true, JSON.stringify(rearmed));
  assert.equal(rearmed.launchRequestId, LRQ_7349_REARM);
  assert.equal(alerts.length, 0);
  const event = first.events.find((entry) => entry.event === 'ama_closer.infra_dead_hammer_rearm');
  assert.equal(event?.rearmed, true, JSON.stringify(first.events));
  assert.equal(event.cause, 'process_exited_after_progress:api-429');
  let ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.retryable, 1);
  assert.deepEqual(ledger.retryableLaunchRequestIds, [LRQ_7349_SECOND]);
  assert.equal(ledger.attemptCount, 2, 'the dead launch was handed back; the re-arm is charged');
  assert.equal(ledger.lifetimeAttemptCount, 3);

  // The re-armed hammer dies the same way. The series' one refund is spent, so
  // this death stays charged and the normal cap suppresses and pages.
  writeWorkerStdout(rootDir, LRQ_7349_REARM, DEAD_HAMMER_429_STDOUT);
  const second = closerDeps({
    nextLaunch: 'lrq_unexpected',
    launchRows: { [LRQ_7349_REARM]: deadLaunchRow(LRQ_7349_REARM) },
    alerts,
  });
  const capped = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T10:20:00Z', prNumber: PR_7349, head: HEAD_7349 }),
    ...second,
  });
  assert.deepEqual(second.statusProbes, [LRQ_7349_REARM]);
  assert.equal(capped.dispatched, false);
  assert.equal(capped.reason, 'hammer-retry-cap-exhausted');
  assert.equal(capped.needsOperator, true);
  assert.equal(second.launches.length, 0);
  assert.equal(alerts.length, 1);
  const spent = second.events.find((entry) => entry.event === 'ama_closer.infra_dead_hammer_rearm');
  assert.equal(spent?.rearmed, false, JSON.stringify(second.events));
  assert.equal(spent.reason, 'retry-budget-exhausted');
  ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.suppressed, true);
  assert.equal(ledger.retryable, 1);

  // Observing the same dead launch again neither throws, refunds nor re-logs.
  const third = closerDeps({ nextLaunch: 'lrq_unexpected', launchRows: { [LRQ_7349_REARM]: deadLaunchRow(LRQ_7349_REARM) }, alerts });
  const again = await maybeDispatchAmaCloser({
    ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T10:25:00Z', prNumber: PR_7349, head: HEAD_7349 }),
    ...third,
  });
  assert.equal(again.dispatched, false);
  assert.equal(again.reason, 'hammer-retry-cap-exhausted');
  assert.equal(third.events.some((entry) => entry.event === 'ama_closer.infra_dead_hammer_rearm'), false);
  assert.equal(readHammerRetryCapLedger(rootDir, identity).retryable, 1);
});

for (const [label, launchRow, stdout] of [
  ['an ordinary crash', deadLaunchRow(LRQ_7349_SECOND, 'worker_crashed'), DEAD_HAMMER_429_STDOUT],
  ['an exit after progress with no 429', deadLaunchRow(LRQ_7349_SECOND), '{"type":"result","is_error":true,"result":"boom"}\n'],
  ['an unreadable LRQ row', null, DEAD_HAMMER_429_STDOUT],
]) {
  test(`#7349 shape with ${label}: the death stays charged and the cap pages`, async (t) => {
    _resetHammerRetryCapAlertDebounceForTests();
    const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-7349-charged-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    seed7349AfterSecondDeath(rootDir);
    writeWorkerStdout(rootDir, LRQ_7349_SECOND, stdout);
    const alerts = [];
    const deps = closerDeps({
      nextLaunch: 'lrq_unexpected',
      launchRows: launchRow ? { [LRQ_7349_SECOND]: launchRow } : {},
      alerts,
    });

    const result = await maybeDispatchAmaCloser({
      ...closerArgs(rootDir, { dispatchedAt: '2026-09-29T10:01:00Z', prNumber: PR_7349, head: HEAD_7349 }),
      ...deps,
    });

    assert.equal(result.dispatched, false, JSON.stringify(result));
    assert.equal(result.reason, 'hammer-retry-cap-exhausted');
    assert.equal(deps.launches.length, 0);
    assert.equal(alerts.length, 1);
    const ledger = readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_7349 });
    assert.equal(ledger.retryable, undefined);
    assert.equal(ledger.attemptCount, 2);
  });
}
