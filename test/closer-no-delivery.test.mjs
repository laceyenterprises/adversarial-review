import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CLOSER_NO_DELIVERY_ATTEMPTS_PER_KEY,
  CLOSER_REPEAT_SKIPPED_REASON,
  CLOSER_REPEAT_SKIP_PERSIST_INTERVAL_MS,
  applyCloserOperatorRedrive,
  closerNoDeliveryAttemptKey,
  closerNoDeliveryFilePath,
  evaluateCloserNoDeliveryGate,
  readCloserNoDeliveryLedger,
  recordCloserNoDeliveryAttempt,
  recordCloserRepeatSkipped,
} from '../src/ama/closer-no-delivery.mjs';
import {
  maybeDispatchAmaCloser,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { AMA_CLOSER_LEASE_STATUS, acquireAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { main as resetPr } from '../src/reset-pr.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

// Synthetic identities only.
const REPO = 'acme/widgets';
const PR = 4100;
const IDENTITY = { repo: REPO, prNumber: PR };
const HEAD = 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const NEW_HEAD = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';
const REVIEWED = 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0';
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

function tempRoot(t, prefix = 'closer-no-delivery-') {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

const attempt = (rootDir, n, failureClass, headSha = HEAD) => recordCloserNoDeliveryAttempt(rootDir, IDENTITY, {
  headSha, failureClass, launchRequestId: `lrq_synth_${failureClass}_${n}`, now: `2026-11-01T10:0${n}:00Z` });
const gate = (rootDir, headSha = HEAD, failureClass = null) =>
  evaluateCloserNoDeliveryGate(readCloserNoDeliveryLedger(rootDir, IDENTITY), { headSha, failureClass });

// ── ledger ────────────────────────────────────────────────────────────────

test('the first failed attempt on a head keeps its one bounded retry', (t) => {
  const rootDir = tempRoot(t);
  assert.equal(gate(rootDir).skip, false);
  assert.equal(attempt(rootDir, 1, 'crashed').recorded, true);
  const decision = gate(rootDir);
  assert.equal(decision.skip, false);
  assert.equal(decision.priorAttempts, 1);
  assert.equal(CLOSER_NO_DELIVERY_ATTEMPTS_PER_KEY, 2);
});

test('a second no-delivery attempt on the same head and failure class is skipped and recorded', (t) => {
  const rootDir = tempRoot(t);
  attempt(rootDir, 1, 'ci-red');
  attempt(rootDir, 2, 'ci-red');
  const decision = gate(rootDir);
  assert.equal(decision.skip, true);
  assert.equal(decision.failureClass, 'ci-red');
  assert.equal(decision.priorAttempts, 2);
  assert.equal(decision.lastLaunchRequestId, 'lrq_synth_ci-red_2');
  // Entering the skipped state is persisted; later skips are persisted at most
  // once per interval, so a stuck PR does not rewrite the ledger every poll.
  assert.equal(CLOSER_REPEAT_SKIP_PERSIST_INTERVAL_MS, 15 * 60 * 1000);
  const skip = (now) => recordCloserRepeatSkipped(rootDir, IDENTITY, { headSha: HEAD, failureClass: 'ci-red', now });
  const filePath = closerNoDeliveryFilePath(rootDir, IDENTITY);
  assert.deepEqual(skip('2026-11-01T11:00:00Z'), { skippedCount: 1, persisted: true });
  const afterFirst = readFileSync(filePath, 'utf8');
  assert.deepEqual(skip('2026-11-01T11:05:00Z'), { skippedCount: 1, persisted: false });
  assert.deepEqual(skip('2026-11-01T11:14:59Z'), { skippedCount: 1, persisted: false });
  assert.equal(readFileSync(filePath, 'utf8'), afterFirst, 'a throttled skip does not rewrite the ledger');
  assert.deepEqual(skip('2026-11-01T11:15:00Z'), { skippedCount: 2, persisted: true });
  const key = readCloserNoDeliveryLedger(rootDir, IDENTITY).heads[HEAD].classes['ci-red'];
  assert.equal(key.skippedCount, 2);
  assert.equal(key.firstSkippedAt, '2026-11-01T11:00:00Z');
  assert.equal(key.lastSkippedAt, '2026-11-01T11:15:00Z');
  // A clock that moved backwards persists rather than suppressing the record.
  assert.deepEqual(skip('2026-11-01T10:00:00Z'), { skippedCount: 3, persisted: true });
});

test('a failed attempt without a launch id counts once across repeated polls', (t) => {
  const rootDir = tempRoot(t);
  const record = { dispatchId: 'dispatch_synth_nolrq', lastAttemptedAt: '2026-11-01T09:00:00Z' };
  const observe = (n, attemptKey) => recordCloserNoDeliveryAttempt(rootDir, IDENTITY, {
    headSha: HEAD, failureClass: 'crashed', launchRequestId: null, attemptKey,
    now: `2026-11-01T10:0${n}:00Z` });
  assert.equal(observe(1, closerNoDeliveryAttemptKey(record)).recorded, true);
  for (let n = 2; n <= 5; n += 1) {
    assert.equal(observe(n, closerNoDeliveryAttemptKey(record)).reason, 'already-recorded');
  }
  assert.equal(gate(rootDir).skip, false, 'one failure keeps its bounded retry');
  assert.equal(gate(rootDir).priorAttempts, 1);
  // A second, distinct dispatch of the same class is the repeat.
  assert.equal(observe(6, closerNoDeliveryAttemptKey({ dispatchId: 'dispatch_synth_nolrq_2' })).recorded, true);
  assert.equal(gate(rootDir).skip, true);
});

test('an attempt with no identity at all cannot spend the retry by being re-observed', (t) => {
  const rootDir = tempRoot(t);
  const observe = (n) => recordCloserNoDeliveryAttempt(rootDir, IDENTITY, {
    headSha: HEAD, failureClass: 'crashed', now: `2026-11-01T10:0${n}:00Z` });
  assert.equal(observe(1).recorded, true);
  assert.equal(observe(2).reason, 'already-recorded');
  assert.equal(gate(rootDir).skip, false);
});

test('attempt identity falls back from dispatch id to intent key to attempt time', () => {
  assert.equal(closerNoDeliveryAttemptKey({ dispatchId: 'd1', dispatchIdempotencyKey: 'k1' }), 'dispatch:d1');
  assert.equal(closerNoDeliveryAttemptKey({ dispatchIdempotencyKey: 'k1', lastAttemptedAt: 't' }), 'intent:k1');
  assert.equal(closerNoDeliveryAttemptKey({ lastAttemptedAt: 't1', dispatchedAt: 't0' }), 'attempted:t1');
  assert.equal(closerNoDeliveryAttemptKey({ dispatchedAt: 't0' }), 'attempted:t0');
  assert.equal(closerNoDeliveryAttemptKey({}), null);
  assert.equal(closerNoDeliveryAttemptKey(null), null);
});

test('re-observing one terminal launch does not count it twice', (t) => {
  const rootDir = tempRoot(t);
  assert.equal(attempt(rootDir, 1, 'crashed').recorded, true);
  assert.deepEqual(attempt(rootDir, 1, 'crashed'), { recorded: false, reason: 'already-recorded', failureClass: 'crashed' });
  assert.equal(gate(rootDir).skip, false);
});

test('a new head re-enables the closer', (t) => {
  const rootDir = tempRoot(t);
  attempt(rootDir, 1, 'conflict');
  attempt(rootDir, 2, 'conflict');
  assert.equal(gate(rootDir, HEAD).skip, true);
  assert.equal(gate(rootDir, NEW_HEAD).skip, false);
  assert.equal(gate(rootDir, NEW_HEAD).reason, 'no-prior-attempt');
});

test('a different failure class is allowed once', (t) => {
  const rootDir = tempRoot(t);
  attempt(rootDir, 1, 'crashed');
  attempt(rootDir, 2, 'crashed');
  assert.equal(gate(rootDir, HEAD, 'crashed').skip, true);
  // The latest failure is now another class: it has not repeated, so one more
  // closer is allowed; its own repeat is skipped, and the first class stays so.
  assert.equal(attempt(rootDir, 1, 'conflict').recorded, true);
  assert.equal(gate(rootDir).failureClass, 'conflict');
  assert.equal(gate(rootDir).skip, false);
  attempt(rootDir, 2, 'conflict');
  assert.equal(gate(rootDir).skip, true);
  assert.equal(gate(rootDir, HEAD, 'crashed').skip, true);
});

test('an operator re-drive re-enables the closer once per grant', (t) => {
  const rootDir = tempRoot(t);
  attempt(rootDir, 1, 'crashed');
  attempt(rootDir, 2, 'crashed');
  assert.equal(gate(rootDir).skip, true);
  const first = applyCloserOperatorRedrive(rootDir, IDENTITY, { headSha: HEAD, redriveKey: 'approval:g1' });
  assert.deepEqual(first, { reset: true, reason: 'operator-redrive' });
  assert.equal(gate(rootDir).skip, false);
  // The re-driven closer is itself bounded: two more failures stop it again,
  // and the same grant seen on a later poll cannot clear them.
  attempt(rootDir, 3, 'crashed');
  attempt(rootDir, 4, 'crashed');
  assert.equal(gate(rootDir).skip, true);
  assert.deepEqual(applyCloserOperatorRedrive(rootDir, IDENTITY, { headSha: HEAD, redriveKey: 'approval:g1' }),
    { reset: false, reason: 'redrive-already-applied' });
  assert.equal(gate(rootDir).skip, true);
  assert.equal(applyCloserOperatorRedrive(rootDir, IDENTITY, { headSha: HEAD, redriveKey: 'approval:g2' }).reset, true);
  assert.equal(gate(rootDir).skip, false);
});

test('an unreadable ledger blocks rather than reading as no prior attempts, and a re-drive repairs it', (t) => {
  const rootDir = tempRoot(t);
  attempt(rootDir, 1, 'crashed');
  const file = closerNoDeliveryFilePath(rootDir, IDENTITY);
  assert.ok(existsSync(file));
  writeFileSync(file, '{truncated');
  assert.equal(readCloserNoDeliveryLedger(rootDir, IDENTITY).__corrupt, true);
  assert.deepEqual(gate(rootDir), { skip: true, reason: 'ledger-corrupt', failureClass: null,
    priorAttempts: 0, lastLaunchRequestId: null });
  // A new attempt must not overwrite what it cannot read.
  assert.deepEqual(attempt(rootDir, 2, 'crashed'), { recorded: false, reason: 'ledger-corrupt' });
  assert.equal(applyCloserOperatorRedrive(rootDir, IDENTITY, { headSha: HEAD, redriveKey: 'approval:g1' }).reason,
    'ledger-repaired');
  assert.equal(gate(rootDir).skip, false);
});

test('ledger keeps a bounded number of heads', (t) => {
  const rootDir = tempRoot(t);
  for (let i = 0; i < 12; i += 1) {
    recordCloserNoDeliveryAttempt(rootDir, IDENTITY, { headSha: `${String(i).padStart(2, '0')}${'d'.repeat(38)}`,
      failureClass: 'crashed', launchRequestId: `lrq_synth_${i}`, now: `2026-11-01T10:${String(i).padStart(2, '0')}:00Z` });
  }
  assert.equal(Object.keys(readCloserNoDeliveryLedger(rootDir, IDENTITY).heads).length, 8);
});

test('head pruning keeps the newest heads when some timestamps are missing or malformed', (t) => {
  const rootDir = tempRoot(t);
  const heads = {};
  for (let i = 0; i < 6; i += 1) {
    heads[`bad${i}${'e'.repeat(36)}`] = { classes: {}, latestClass: null, redriveKeys: [],
      updatedAt: i % 2 ? null : 'not-a-date' };
  }
  mkdirSync(dirname(closerNoDeliveryFilePath(rootDir, IDENTITY)), { recursive: true });
  writeFileSync(closerNoDeliveryFilePath(rootDir, IDENTITY), JSON.stringify({ schemaVersion: 1, repo: REPO,
    prNumber: PR, heads }));
  const fresh = [];
  for (let i = 0; i < 8; i += 1) {
    const headSha = `${String(i).padStart(2, '0')}${'f'.repeat(38)}`;
    fresh.push(headSha);
    recordCloserNoDeliveryAttempt(rootDir, IDENTITY, { headSha, failureClass: 'crashed',
      launchRequestId: `lrq_synth_fresh_${i}`, now: `2026-11-01T10:${String(i).padStart(2, '0')}:00Z` });
  }
  assert.deepEqual(Object.keys(readCloserNoDeliveryLedger(rootDir, IDENTITY).heads).sort(), fresh.sort());
});

// ── closer dispatch ───────────────────────────────────────────────────────

function dispatchArgs(rootDir) {
  return {
    guardStackedBaseImpl: async () => null,
    reviewState: {
      verdict: 'comment-only', reviewCycleExhausted: true, headSha: REVIEWED, riskClass: 'low',
      remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, operatorApprovedEvidence: null,
      prAuthor: 'builder',
    },
    prMetadata: {
      prNumber: PR, title: 'Synthetic title', headSha: HEAD, isOpen: true, isDraft: false,
      mergeableState: 'MERGEABLE', labels: [],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
      branchProtection: { requiredContexts: [] }, author: 'builder',
    },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: false } },
    dispatchContext: {
      rootDir, repo: REPO, prUrl: `https://github.com/${REPO}/pull/${PR}`, reviewedSha: REVIEWED,
      targetRemediationSha: HEAD, allowStaleReviewHeadHammerResume: true, riskClass: 'low',
      requiredGateContext: 'agent-os/adversarial-gate', reviewedBy: 'codex-reviewer-lacey', reviewer: 'codex',
      parentSession: 'session:test:watcher', hqPath: '/bin/hq-test', hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER, currentUser: CURRENT_USER, dispatchedAt: '2026-11-01T13:05:00Z',
      closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'hammer/live' }),
    },
  };
}

// A closer launched against HEAD that ended `succeeded` with the PR still open.
function seedEndedLaunch(rootDir, { headSha = HEAD, launchRequestId = 'lrq_synth_current' } = {}) {
  const identity = { repo: REPO, prNumber: PR, headSha };
  acquireAmaCloserLease({ rootDir, ...identity, now: '2026-11-01T12:00:00Z' });
  updateAmaCloserLease({ rootDir, ...identity, status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
    lrqId: launchRequestId, now: '2026-11-01T12:00:00Z' });
  updateAmaCloserLease({ rootDir, ...identity, status: AMA_CLOSER_LEASE_STATUS.TERMINAL,
    terminalOutcome: 'failed-without-merge', now: '2026-11-01T12:31:00Z' });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({
    schemaVersion: 1, repo: REPO, prNumber: PR, headSha, reviewedSha: REVIEWED, targetRemediationSha: headSha,
    workerClass: 'hammer', dispatchWorkerClass: 'hammer', promptPath: '/tmp/synthetic-prompt.md', promptDir: '/tmp',
    hqRoot: join(rootDir, 'hq-root'), launchRequestId, dispatchId: 'dispatch_synth_current', retryCount: 1,
    state: 'dispatched', lastObservedStatus: 'unknown',
  }));
}

async function pollCloser(rootDir) {
  const events = [];
  const execCalls = [];
  const result = await maybeDispatchAmaCloser({
    ...dispatchArgs(rootDir),
    attemptDaemonCleanMergeImpl: async () => { throw new Error('unexpected daemon merge'); },
    deliverAlertImpl: async () => {},
    fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'build-completions' && args[1] === 'record-merge') {
        return { stdout: JSON.stringify({ status: 'recorded', event_id: 'synthetic-event' }), stderr: '' };
      }
      execCalls.push({ cmd, args });
      if (args[0] === 'dispatch' && args[1] === 'status') return { stdout: JSON.stringify({ status: 'succeeded' }), stderr: '' };
      return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${PR}`, dispatchId: 'dispatch_synth_retry',
        launchRequestId: 'lrq_synth_retry' }), stderr: '' };
    },
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readTemplateImpl: () => 'closer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    logger: { log() {}, info: (m) => events.push(m), warn: (m) => events.push(m), error() {} },
  });
  return { result, events, dispatchCalls: execCalls.filter((c) => c.args[0] === 'dispatch' && c.args[1] !== 'status') };
}

// Learn the class the closer assigns to the seeded failure from a first pass.
async function observedFailureClass(t) {
  const rootDir = tempRoot(t, 'closer-no-delivery-class-');
  seedEndedLaunch(rootDir);
  const { result } = await pollCloser(rootDir);
  assert.equal(result.dispatched, true, 'the first failed attempt keeps its one bounded retry');
  const ledger = readCloserNoDeliveryLedger(rootDir, IDENTITY);
  assert.equal(ledger.heads[HEAD].classes[ledger.heads[HEAD].latestClass].attempts.length, 1);
  return ledger.heads[HEAD].latestClass;
}

test('closer: a repeated no-delivery failure on the same head is skipped before any dispatch and is recorded', async (t) => {
  const failureClass = await observedFailureClass(t);
  const rootDir = tempRoot(t);
  seedEndedLaunch(rootDir);
  attempt(rootDir, 1, failureClass);
  const { result, events, dispatchCalls } = await pollCloser(rootDir);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, CLOSER_REPEAT_SKIPPED_REASON);
  assert.equal(result.needsOperator, true);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.failureClass, failureClass);
  assert.deepEqual(dispatchCalls, []);
  const ledger = readCloserNoDeliveryLedger(rootDir, IDENTITY);
  assert.equal(ledger.heads[HEAD].classes[failureClass].attempts.length, 2);
  assert.equal(ledger.heads[HEAD].classes[failureClass].skippedCount, 1);
  const logged = events.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .find((e) => e?.event === 'ama_closer.repeat_no_delivery_skipped');
  assert.ok(logged, 'the skipped repeat is written to the decision log');
  assert.equal(logged.headSha, HEAD);
  assert.equal(logged.failureClass, failureClass);
  assert.equal(logged.skipPersisted, true);
  // Every later poll is skipped and logged, not silent; within the persist
  // interval it does not rewrite the ledger.
  const again = await pollCloser(rootDir);
  assert.equal(again.result.reason, CLOSER_REPEAT_SKIPPED_REASON);
  assert.deepEqual(again.dispatchCalls, []);
  const loggedAgain = again.events.map((m) => { try { return JSON.parse(m); } catch { return null; } })
    .find((e) => e?.event === 'ama_closer.repeat_no_delivery_skipped');
  assert.ok(loggedAgain, 'a throttled skip is still written to the decision log');
  assert.equal(loggedAgain.skipPersisted, false);
  assert.equal(loggedAgain.skippedCount, 1);
  assert.equal(readCloserNoDeliveryLedger(rootDir, IDENTITY).heads[HEAD].classes[failureClass].skippedCount, 1);
});

test('closer: a new head re-enables the closer', async (t) => {
  const failureClass = await observedFailureClass(t);
  const rootDir = tempRoot(t);
  seedEndedLaunch(rootDir);
  attempt(rootDir, 1, failureClass, 'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3');
  const { result, dispatchCalls } = await pollCloser(rootDir);
  assert.equal(result.dispatched, true);
  assert.equal(dispatchCalls.length, 1);
});

test('closer: a different failure class is allowed once', async (t) => {
  const failureClass = await observedFailureClass(t);
  const rootDir = tempRoot(t);
  seedEndedLaunch(rootDir);
  attempt(rootDir, 1, 'some-other-class');
  attempt(rootDir, 2, 'some-other-class');
  const { result, dispatchCalls } = await pollCloser(rootDir);
  assert.equal(result.dispatched, true);
  assert.equal(dispatchCalls.length, 1);
  // The new class then repeats and is skipped; the earlier class stays skipped.
  const ledger = readCloserNoDeliveryLedger(rootDir, IDENTITY);
  assert.equal(ledger.heads[HEAD].classes[failureClass].attempts.length, 1);
  assert.equal(gate(rootDir, HEAD, 'some-other-class').skip, true);
});

test('closer: an operator re-drive through reset-pr re-enables the closer', async (t) => {
  const failureClass = await observedFailureClass(t);
  const rootDir = tempRoot(t);
  seedEndedLaunch(rootDir);
  attempt(rootDir, 1, failureClass);
  assert.equal((await pollCloser(rootDir)).result.reason, CLOSER_REPEAT_SKIPPED_REASON);
  const chunks = [];
  const rc = resetPr([REPO, String(PR), '--root-dir', rootDir, '--audit-root-dir', rootDir], {
    stdout: { write: (c) => chunks.push(String(c)) }, stderr: { write() {} },
    now: () => '2026-11-01T14:00:00.000Z',
  });
  assert.equal(rc, 0);
  const receipt = JSON.parse(chunks.join(''));
  assert.equal(receipt.outcome, 'reset');
  assert.equal(receipt.closerNoDeliveryLedger.from, closerNoDeliveryFilePath(rootDir, IDENTITY));
  assert.equal(existsSync(closerNoDeliveryFilePath(rootDir, IDENTITY)), false);
  assert.equal(existsSync(receipt.closerNoDeliveryLedger.to), true);
  const { result, dispatchCalls } = await pollCloser(rootDir);
  assert.equal(result.dispatched, true);
  assert.equal(dispatchCalls.length, 1);
});
