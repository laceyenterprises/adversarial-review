// INCONCLUSIVERETRY-01b: closer infrastructure failures become owned retries
// and never spend the closer budget. Synthetic fixtures only.
import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { CloserCorrectionRequired, recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { proveConflictPrimary } from '../src/ama/conflict-primary.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { readCloserNoDeliveryLedger } from '../src/ama/closer-no-delivery.mjs';
import { CLOSER_INCONCLUSIVE_RETRY_DEFAULTS, classifyCloserOutcome, closerInconclusiveRetryDelayMs,
  closerInconclusiveRetryPolicy, evaluateCloserInconclusiveRetryGate, readCloserInconclusiveRetries,
  recordCloserInconclusiveRetry } from '../src/ama/closer-inconclusive-retry.mjs';
import { escalateClosureBudget, refundInconclusiveExhaustion } from '../src/ama/closure-budget-escalation.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { loadConfig } from '../src/config-loader.mjs';

const REPO = 'synthetic/repo';
const PR = 42;
const HEAD = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'inconclusiveretry-01b-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const INCONCLUSIVE = [
  { reason: 'dispatch-phase-scripts-missing' },
  { reason: 'endpoint-bootstrap-failed' },
  { reason: 'head-context-failed' },
  { reason: 'head-context-timeout' },
  { reason: 'validation-environment-failed' },
  { reason: 'checkout-failed' },
  { reason: 'github-unreachable' },
  { reason: 'pr-mergeability-unknown' },
  { reason: 'github-gate-read-failed' },
  { failureClass: 'spawn_never_registered' },
  { failureClass: 'worker_never_started' },
  { failureClass: 'provision_failed' },
  { failureClass: 'checkout_failed' },
  { reason: 'unknown', failureClass: 'endpoint_bootstrap_failed' },
];
const REAL = [
  'blocking-findings-present', 'findings-unresolved', 'targeted-validation-failed', 'validation-failed',
  'github-gate-red', 'reversal-not-authorized', 'ham-commit-identity-unlinked', 'review-evidence-invalid',
  'stale-review-head', 'head-changed', 'merge-refused',
];

test('classifier: every inconclusive reason code is an owned retry, every real refusal stays real', () => {
  for (const input of INCONCLUSIVE) assert.equal(classifyCloserOutcome(input).kind, 'inconclusive', JSON.stringify(input));
  for (const reason of REAL) {
    assert.equal(classifyCloserOutcome({ reason }).kind, 'real', reason);
    assert.equal(classifyCloserOutcome({ reason, failureClass: 'worker_never_started' }).kind, 'real',
      `a recorded world refusal outranks the launch class: ${reason}`);
  }
  assert.equal(classifyCloserOutcome({ reason: 'some free-text exit' }).kind, 'real', 'unknown stays counted');
  assert.equal(classifyCloserOutcome({}).kind, 'real');
});

test('owned retry record: owner, attempt, next time, reason; backoff from N; idempotent per launch', t => {
  const root = scratch(t), identity = { repo: REPO, prNumber: PR };
  const policy = closerInconclusiveRetryPolicy({ closerInconclusiveRetry: { surfaceAfterAttempts: 2,
    backoffBaseMs: 60_000, backoffMaxMs: 150_000 } });
  assert.deepEqual([1, 2, 3, 4, 5].map(n => closerInconclusiveRetryDelayMs(n, policy)), [0, 60_000, 120_000, 150_000, 150_000]);
  assert.deepEqual(closerInconclusiveRetryPolicy({ closerInconclusiveRetry: { surfaceAfterAttempts: 0, backoffBaseMs: 'x' } }),
    CLOSER_INCONCLUSIVE_RETRY_DEFAULTS, 'invalid tunables fall back to defaults');
  const now = '2026-11-01T00:00:00.000Z';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const owned = recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: `lrq_s-${attempt}`,
      reason: 'checkout-failed', now, policy });
    assert.equal(owned.recorded, true);
    assert.equal(owned.entry.owner, 'watcher');
    assert.equal(owned.entry.attempt, attempt);
    assert.equal(owned.entry.reason, 'checkout-failed');
    assert.equal(owned.entry.deadline, owned.entry.nextAttemptAt);
    assert.equal(recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: `lrq_s-${attempt}`,
      reason: 'checkout-failed', now, policy }).reason, 'already-recorded');
  }
  const doc = readCloserInconclusiveRetries(root, identity);
  assert.equal(evaluateCloserInconclusiveRetryGate(doc, { headSha: HEAD, now }).retryAfterMs, 120_000);
  assert.equal(evaluateCloserInconclusiveRetryGate(doc, { headSha: HEAD, now: '2026-11-01T00:02:00.000Z' }).wait, false);
  assert.equal(evaluateCloserInconclusiveRetryGate(doc, { headSha: OTHER, now }).entry, null, 'keyed by exact head');
});

test('config loader exposes the tunable with defaults', t => {
  const root = scratch(t);
  const cfg = loadConfig({ topPath: join(root, 'missing.yaml'), env: {} }).getMergeAuthorityConfig();
  assert.deepEqual(cfg.closerInconclusiveRetry, { surfaceAfterAttempts: 3, backoffBaseMs: 300_000, backoffMaxMs: 3_600_000 });
});

test('retry gate enforces the same backoff for ISO and numeric timestamps', () => {
  const due = Date.parse('2026-11-01T00:02:00.000Z');
  const entry = { nextAttemptAt: new Date(due).toISOString() };
  const doc = { heads: { [HEAD]: entry } };
  for (const offset of [-60_000, 0, 60_000]) {
    const nowMs = due + offset;
    for (const now of [nowMs, new Date(nowMs).toISOString()]) {
      const result = evaluateCloserInconclusiveRetryGate(doc, { headSha: HEAD, now });
      assert.equal(result.wait, offset < 0);
      assert.equal(result.retryAfterMs, Math.max(0, -offset));
      assert.equal(result.entry, entry);
    }
  }
});

function dispatchArgs(root, dispatchedAt, overrides = {}) {
  const user = userInfo().username;
  return {
    guardStackedBaseImpl: async () => null,
    reviewState: { verdict: 'comment-only', reviewCycleExhausted: true, headSha: HEAD, riskClass: 'low',
      remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'synthetic-builder',
      ...overrides.reviewState },
    prMetadata: { prNumber: PR, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], author: 'synthetic-builder', branchProtection: { requiredContexts: [] },
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
      ...overrides.prMetadata },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash', branchProtection: { required: false },
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false } },
    dispatchContext: { rootDir: root, repo: REPO, prUrl: `https://github.com/${REPO}/pull/${PR}`,
      reviewedSha: HEAD, riskClass: 'low', requiredGateContext: 'synthetic/gate', reviewedBy: 'synthetic-reviewer',
      reviewer: 'codex', parentSession: 'synthetic-session', hqPath: '/bin/hq-synthetic', hqRoot: join(root, 'hq'),
      hqOwnerUser: user, currentUser: user, dispatchedAt, closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'synthetic-branch' }) },
  };
}

// Each closer exits with the PR open and no terminal audit; its own last-phase
// receipt names the stop it reached.
function harness(root, lastPhase) {
  const state = { launches: 0, ended: null, alerts: [] };
  const deps = {
    deliverAlertImpl: async (message, options) => { state.alerts.push({ message, options }); },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv[1] === 'status') return { stdout: '{"status":"failed"}' };
      if (argv[0] === 'dispatch') {
        state.launches++;
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${PR}`, launchRequestId: `lrq_synthetic-${state.launches}`,
          dispatchId: `dispatch_synthetic-${state.launches}` }) };
      }
      return { stdout: '{}' };
    },
    // The producer reports the ended closer as failed with no work done.
    readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true, row: launchRequestId === state.ended
      ? { status: 'failed', failure_class: 'no_work_done' } : { status: 'running' } }),
    readTemplateImpl: () => 'hammer <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    logger: quiet,
  };
  const identity = { repo: REPO, prNumber: PR, headSha: HEAD };
  const endCurrent = () => {
    const record = readAmaCloserDispatchRecord(root, identity);
    const runId = `wrun_synthetic-${state.launches}`;
    updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, workerRunId: runId }));
    recordHammerPhase(lastPhase, { env: { HAM_HQ_ROOT: join(root, 'hq'),
      HQ_LAUNCH_REQUEST_ID: record.launchRequestId, HQ_WORKER_RUN_ID: runId } });
    state.ended = record.launchRequestId;
  };
  return { state, deps, endCurrent, identity };
}

const minutes = n => new Date(Date.parse('2026-11-01T00:00:00Z') + n * 60_000).toISOString();

test('site 1: an inconclusive exit spends no budget or no-delivery key, surfaces once at N and stays owned', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root, 'endpoint-bootstrap-failed');
  const run = (at, overrides) => maybeDispatchAmaCloser({ ...dispatchArgs(root, at, overrides), ...deps });
  assert.equal((await run(minutes(0))).dispatched, true);
  // Five consecutive inconclusive exits: more than the CLOSERRETRY key bound
  // (2), the old self-error cap (3) and the series retry budget.
  let at = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    endCurrent();
    at += 10;
    let result = await run(minutes(at));
    if (attempt >= 3) {
      assert.equal(result.dispatched, false, JSON.stringify(result));
      assert.equal(result.reason, 'closer-inconclusive-retry-backoff');
      assert.equal(result.recoveryWait, true);
      assert.notEqual(result.needsOperator, true, 'an owned retry is never a park');
      assert.deepEqual(Object.keys(result.ownedRetry).sort(), ['attempt', 'deadline', 'nextAttemptAt', 'owner', 'reason']);
      assert.equal(result.ownedRetry.owner, 'watcher');
      assert.equal(result.ownedRetry.reason, 'endpoint-bootstrap-failed');
      assert.equal(Date.parse(result.ownedRetry.nextAttemptAt) - Date.parse(minutes(at)), 5 * 60_000 * 2 ** (attempt - 3));
      at += 5 * 2 ** (attempt - 3);
      result = await run(minutes(at));
    }
    assert.equal(result.dispatched, true, `attempt ${attempt}: ${JSON.stringify(result)}`);
    const ledger = readHammerRetryCapLedger(root, identity);
    for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) {
      assert.equal(ledger[key], 1, `only the live replacement is charged (${key}, attempt ${attempt})`);
    }
  }
  assert.equal(state.launches, 6);
  assert.deepEqual(readCloserNoDeliveryLedger(root, identity).heads, {}, 'no CLOSERRETRY key was spent');
  const surfaced = state.alerts.filter(alert => alert.options?.event === 'ama_closer.inconclusive_retry_surfaced');
  assert.equal(surfaced.length, 1, 'surfaced once to the existing operator channel');
  assert.match(surfaced[0].message, /owner watcher retries at/);
  assert.match(surfaced[0].message, /no closer budget was spent/);
  const owned = readCloserInconclusiveRetries(root, identity).heads[HEAD];
  assert.equal(owned.attempt, 5);
  assert.ok(owned.surfacedAt);
});

test('site 1: a real refusal stays counted and takes no owned retry', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root, 'blocking-findings-present');
  const run = at => maybeDispatchAmaCloser({ ...dispatchArgs(root, at), ...deps });
  assert.equal((await run(minutes(0))).dispatched, true);
  endCurrent();
  await run(minutes(10));
  assert.equal(readCloserInconclusiveRetries(root, identity).heads[HEAD], undefined);
  const classes = readCloserNoDeliveryLedger(root, identity).heads[HEAD]?.classes || {};
  assert.equal(Object.values(classes).flatMap(entry => entry.attempts).length, 1, 'the real attempt spends its key');
  assert.equal(readHammerRetryCapLedger(root, identity).selfErrorRefunds, undefined, 'no inconclusive refund');
  assert.equal(state.alerts.filter(alert => alert.options?.event === 'ama_closer.inconclusive_retry_surfaced').length, 0);
});

test('site 1: an owned retry is an ordinary dispatch that re-evaluates the live head and closes nothing by itself', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent } = harness(root, 'checkout-failed');
  const run = (at, overrides) => maybeDispatchAmaCloser({ ...dispatchArgs(root, at, overrides), ...deps });
  assert.equal((await run(minutes(0))).dispatched, true);
  for (let attempt = 1; attempt <= 3; attempt++) { endCurrent(); await run(minutes(attempt * 10)); }
  assert.equal(state.launches, 3);
  // A closed PR gets no retry, backoff or not.
  const closed = await run(minutes(60), { prMetadata: { isOpen: false, state: 'CLOSED' } });
  assert.equal(closed.dispatched, false, JSON.stringify(closed));
  assert.notEqual(closed.reason, 'closer-inconclusive-retry-backoff');
  assert.equal(state.launches, 3);
  // After the backoff the retry re-runs eligibility against the live head:
  // a review of the old head does not match, so the shared merge predicate
  // (exact-head review, attestation, leases, required checks) cannot pass
  // on the record's say-so. The owned record only paces its own head.
  const moved = await run(minutes(61), { prMetadata: { headSha: OTHER } });
  assert.equal(moved.dispatched, true, JSON.stringify(moved));
  assert.equal(moved.eligibilityReasons.headMatch.current, OTHER);
  assert.equal(moved.eligibilityReasons.headMatch.ok, false);
  assert.equal(readCloserInconclusiveRetries(root, { repo: REPO, prNumber: PR }).heads[OTHER], undefined);
});

function exhaustedLedger(root, launches) {
  const identity = { repo: REPO, prNumber: PR };
  for (const launchRequestId of launches) {
    recordHammerRetryDispatch(root, identity, { jobKey: HEAD, headSha: HEAD, launchRequestId, now: minutes(0) });
  }
  return identity;
}

const R07 = { row: 'R07-stop', reason: 'retry-exhausted', head: HEAD };

test('exhaustion refunds use the current time when called without now', t => {
  const root = scratch(t);
  const identity = exhaustedLedger(root, ['lrq_default_time']);
  recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: 'lrq_default_time',
    reason: 'checkout-failed', now: minutes(0) });
  const before = Date.now();
  const result = refundInconclusiveExhaustion({ rootDir: root, ...identity });
  const after = Date.now();
  assert.equal(result.recovered, true);
  assert.equal(result.refunded, 1);
  const ledger = readHammerRetryCapLedger(root, identity);
  for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) assert.equal(ledger[key], 0, key);
  const refundedAt = Date.parse(ledger.updatedAt);
  assert.ok(refundedAt >= before && refundedAt <= after, 'refund persists the current timestamp');
});

test('site 2: exhaustion reached only through inconclusive attempts does not exhaust', async t => {
  const root = scratch(t);
  const identity = exhaustedLedger(root, ['lrq_a', 'lrq_b']);
  for (const launchRequestId of ['lrq_a', 'lrq_b']) recordCloserInconclusiveRetry(root, identity,
    { headSha: HEAD, launchRequestId, reason: 'provision-failed', now: minutes(0) });
  let pages = 0;
  const result = await escalateClosureBudget({ result: { nextAction: R07 }, rootDir: root, ...identity,
    now: Date.parse(minutes(1)), observeWaitImpl: async () => { pages++; } });
  assert.equal(pages, 0);
  assert.equal(result.needsOperator, false);
  assert.equal(result.recoveryWait, true);
  assert.equal(result.ownedRetry.owner, 'watcher');
  assert.equal(result.inconclusiveExhaustion.refunded, 2);
  const ledger = readHammerRetryCapLedger(root, identity);
  for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) assert.equal(ledger[key], 0, key);
});

test('site 2: real exhaustion surfaces once with PR, reason and next action, and stays owned', async t => {
  const root = scratch(t);
  // CLOSERRETRYREFUND-01: the fault charge is refunded on its own first; the
  // two real charges still spend the budget and surface it.
  const identity = exhaustedLedger(root, ['lrq_real', 'lrq_real_2', 'lrq_infra']);
  recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: 'lrq_infra',
    reason: 'checkout-failed', now: minutes(0) });
  const pages = [];
  const observeWaitImpl = options => observeClosureWait({ ...options,
    pageImpl: async message => { pages.push(message); } });
  const refunded = await escalateClosureBudget({ result: { nextAction: R07 }, rootDir: root, ...identity,
    now: Date.parse(minutes(0)), observeWaitImpl });
  assert.equal(refunded.needsOperator, false);
  assert.equal(refunded.inconclusiveExhaustion.reason, 'fault-charges-refunded');
  assert.equal(refunded.inconclusiveExhaustion.realAttempts, 2);
  for (let tick = 1; tick <= 3; tick++) {
    const result = await escalateClosureBudget({ result: { nextAction: R07 }, rootDir: root, ...identity,
      now: Date.parse(minutes(tick)), observeWaitImpl });
    assert.equal(result.needsOperator, true);
    assert.equal(result.operatorReason, 'closure-retry-exhausted');
    assert.equal(result.ownedRetry.owner, 'watcher');
    assert.match(result.ownedRetry.recommendedAction, /closer audit/);
    assert.equal(result.inconclusiveExhaustion.reason, 'real-attempts-spent-budget');
    assert.equal(result.reason, 'closure-retry-exhausted', 'typed terminal state, not a mismatch loop');
    assert.equal(result.closureTerminal.owner, 'operator');
  }
  assert.equal(pages.length, 1, 'surfaced once');
  assert.match(pages[0], new RegExp(`${REPO} PR ${PR}@${HEAD}`));
  assert.match(pages[0], /closure-retry-exhausted/);
  assert.match(pages[0], /recommended next action/);
  assert.equal(readHammerRetryCapLedger(root, identity).attemptCount, 2, 'real charges stay spent');
});

test('site 2: an open charge with no owner record is real; a refund helper error stays inconclusive', t => {
  const root = scratch(t);
  const identity = exhaustedLedger(root, ['lrq_x']);
  assert.equal(refundInconclusiveExhaustion({ rootDir: root, ...identity, now: Date.parse(minutes(1)) }).reason,
    'real-attempts-spent-budget');
  recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: 'lrq_x', reason: 'checkout-failed', now: minutes(0) });
  const busy = refundInconclusiveExhaustion({ rootDir: root, ...identity, now: Date.parse(minutes(1)),
    refundImpl: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  assert.equal(busy.reason, 'refund-incomplete');
});

// (a)+(b): the closer's helper timed out under load (SIGALRM/SIGTERM), the
// controller recorded `controller-setup-failed`, the terminal audit asked for
// one correction (exit 21) and the run ended with launch status `succeeded`,
// having pushed and merged nothing.
test('a succeeded launch that pushed nothing after a helper timeout is an owned retry, never a terminal or a spent budget', async t => {
  const root = scratch(t);
  const { state, deps, identity } = harness(root, 'unused');
  deps.execFileImpl = (inner => async (cmd, argv) => (argv[0] === 'dispatch' && argv[1] === 'status'
    ? { stdout: '{"status":"succeeded"}' } : inner(cmd, argv)))(deps.execFileImpl);
  deps.readLaunchRequestStatusImpl = ({ launchRequestId }) => ({ ok: true,
    row: { status: launchRequestId === state.ended ? 'succeeded' : 'running' } });
  const run = at => maybeDispatchAmaCloser({ ...dispatchArgs(root, at), ...deps });
  assert.equal((await run(minutes(0))).dispatched, true);
  const results = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const record = readAmaCloserDispatchRecord(root, identity);
    const runId = `wrun_synthetic-${state.launches}`;
    updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, workerRunId: runId }));
    const env = { HAM_RUN_DIR: mkdtempSync(join(root, 'run-')), HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO,
      HAM_PR_NUMBER: String(PR), HAM_TARGET_REMEDIATION_SHA: HEAD, HAM_REVIEWED_SHA: HEAD,
      HQ_LAUNCH_REQUEST_ID: record.launchRequestId, HQ_WORKER_RUN_ID: runId };
    assert.throws(() => recordHammerEarlyFailure('controller-setup-failed', { env, final: true }), CloserCorrectionRequired);
    // The run then ended; the worker pool reported `succeeded`.
    state.ended = record.launchRequestId;
    updateAmaCloserLease({ rootDir: root, ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge',
      now: minutes(attempt * 10) });
    let result = await run(minutes(attempt * 10));
    if (result.reason === 'closer-inconclusive-retry-backoff') {
      results.push(result);
      result = await run(result.ownedRetry.nextAttemptAt);
    }
    assert.equal(result.dispatched, true, `attempt ${attempt}: ${JSON.stringify(result)}`);
    assert.notEqual(result.reason, 'closer-self-error-budget-exhausted');
    const ledger = readHammerRetryCapLedger(root, identity);
    for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) assert.equal(ledger[key], 1, key);
  }
  assert.ok(results.every(result => result.needsOperator !== true && result.ownedRetry.reason === 'controller-setup-failed'));
  assert.equal(results.length, 2, 'attempts 3 and 4 wait for their backoff');
  assert.deepEqual(readCloserNoDeliveryLedger(root, identity).heads, {});
  assert.equal(readCloserInconclusiveRetries(root, identity).heads[HEAD].attempt, 4);
});

test('a succeeded launch that pushed nothing with a real recorded refusal stays terminal and counted', async t => {
  const root = scratch(t);
  const { state, deps, identity, endCurrent } = harness(root, 'findings-unresolved');
  deps.execFileImpl = (inner => async (cmd, argv) => (argv[0] === 'dispatch' && argv[1] === 'status'
    ? { stdout: '{"status":"succeeded"}' } : inner(cmd, argv)))(deps.execFileImpl);
  deps.readLaunchRequestStatusImpl = ({ launchRequestId }) => ({ ok: true,
    row: { status: launchRequestId === state.ended ? 'succeeded' : 'running' } });
  const run = at => maybeDispatchAmaCloser({ ...dispatchArgs(root, at), ...deps });
  assert.equal((await run(minutes(0))).dispatched, true);
  endCurrent();
  updateAmaCloserLease({ rootDir: root, ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge', now: minutes(10) });
  await run(minutes(10));
  assert.equal(readCloserInconclusiveRetries(root, identity).heads[HEAD], undefined);
  assert.equal(Object.values(readCloserNoDeliveryLedger(root, identity).heads[HEAD]?.classes || {})
    .flatMap(entry => entry.attempts).length, 1);
});

// (c): an unproven conflict replay is real only when the proof shows a
// primary-line conflict; a proof that could not run is inconclusive.
test('conflict-primary: a real primary-line conflict refuses; missing proof evidence is inconclusive', async t => {
  const kinds = [];
  const onRefusal = kind => kinds.push(kind);
  const sha = c => c.repeat(40);
  assert.equal(await proveConflictPrimary({ reviewedHead: 'bad', sourceHead: 'bad', head: sha('1'), base: sha('2'),
    git: async () => '', onRefusal }), null);
  assert.equal(await proveConflictPrimary({ reviewedHead: sha('a'), sourceHead: sha('a'), head: sha('b'), base: sha('c'),
    git: async () => '\n', onRefusal }), null);
  // One reviewed commit and one replayed commit whose patches differ.
  const git = async args => {
    if (args[0] === 'merge-base') return `${sha('f')}\n`;
    if (args[0] === 'rev-list') return args.at(-1).endsWith(sha('a')) ? `${sha('a')} ${sha('f')}\n` : `${sha('b')} ${sha('c')}\n`;
    if (args[0] === 'log') return 'x\0author\0a@example.invalid\0subject\n\0'.replace(/^x/, args.at(-1).endsWith(sha('a')) ? sha('a') : sha('b'));
    if (args[0] === 'diff') return args.at(-2).startsWith(sha('a')) ? '@@ -1 +1 @@\n-old\n+author line\n' : '@@ -1 +1 @@\n-old\n+other line\n';
    return '';
  };
  assert.equal(await proveConflictPrimary({ reviewedHead: sha('a'), sourceHead: sha('a'), head: sha('b'), base: sha('c'),
    git, onRefusal }), null);
  assert.deepEqual(kinds, ['unavailable', 'unavailable', 'conflict']);
  assert.equal(classifyCloserOutcome({ reason: 'conflict-primary-failed' }).kind, 'inconclusive');
  assert.equal(classifyCloserOutcome({ reason: 'conflict-primary-timeout' }).kind, 'inconclusive');
  assert.equal(classifyCloserOutcome({ reason: 'conflict-primary-unproven' }).kind, 'real');
  const dir = mkdtempSync(join(tmpdir(), 'inconclusiveretry-01b-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = spawnSync(process.execPath, [new URL('../bin/hammer-conflict-primary.mjs', import.meta.url).pathname,
    sha('a'), sha('a'), sha('c')], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir,
      GIT_CEILING_DIRECTORIES: dir } });
  assert.equal(helper.status, 75, helper.stderr);
  assert.match(helper.stderr, /conflict-primary-failed/);
  // HAMCONFLICTSYNC-01: the proof gate lives in the shipped conflict repair.
  const repair = readFileSync(new URL('../bin/hammer-conflict-repair.sh', import.meta.url), 'utf8');
  assert.match(repair, /\*\) HAM_CONFLICT_PROOF_REASON=conflict-primary-failed;;/);
  assert.match(repair, / 1\) HAM_CONFLICT_PROOF_REASON=conflict-primary-unproven;;/);
});
