// HAMWRITERTIMEOUT-01: a legacy merge writer timeout after a passed predicate is
// a registered infrastructure deferral that re-drives the merge on the same
// head; merge-target-unparseable is a closer fault; every click-hold code and
// every writer refusal is registered. Synthetic fixtures only.
import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { HAMMER_CLOSER_FAULTS, HAMMER_INFRASTRUCTURE_OUTCOMES, HAMMER_STOP_ORIGINS, hammerStopOrigin,
} from '../src/ama/hammer-stop-origin.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES, hammerPhaseAttempt } from '../src/ama/hammer-phase-outcome.mjs';
import { CloserCorrectionRequired, recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { appendAmaAuditAttempt, readAmaAuditEntry, amaAuditFilePath } from '../src/ama/audit.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { AMA_CLOSER_RETRYABLE_DEFERRAL_REASONS, retryableAmaCloserDeferralOutcome, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { runLegacyLaneWrite, LEGACY_PROOF_NOMINAL_MS } from '../src/finalization/legacy-lane-write.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';

const REPO = 'synthetic/repo';
const PR = 42;
const HEAD = 'c'.repeat(40);
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function scratch(t, prefix = 'hamwritertimeout-01-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------- registry --

// The shipped classifier is a sed alternation; read the codes out of it.
function clickHoldCodes() {
  const match = source('bin/hammer-merge.sh').match(/HAM_CLICK_HOLD=\$\(sed -nE 's\/\^legacy lane write refused: \(([^)]+)\)\$\/\\1\/p'/);
  assert.ok(match, 'the shipped click-hold classifier must exist');
  return match[1].split('|');
}

// Every refusal the writer itself returns as a literal `reason: '<code>'`.
function writerReasons() {
  const reasons = [...source('src/finalization/legacy-lane-write.mjs').matchAll(/reason:\s*'([a-z][a-z0-9-]+)'/g)]
    .map(match => match[1]).filter(reason => reason !== 'merge-command-not-spawned'); // Writer diagnostic, mapped to the charged preflight deferral.
  assert.ok(reasons.length >= 3, 'must inspect the writer refusals');
  return new Set(reasons);
}

test('every click-hold code the hammer can emit is registered in the stop-origin table', () => {
  const codes = clickHoldCodes();
  for (const code of ['legacy-writer-timeout', 'merge-target-unparseable', 'operator-review-changes-requested',
    'terminal-review-evidence-unavailable', 'terminal-review-issuer-unverifiable',
    'review-changed-since-validation', 'live-head-moved-before-merge']) {
    assert.ok(codes.includes(code), `the classifier must name ${code}`);
  }
  const unregistered = codes.filter(code => !Object.hasOwn(HAMMER_STOP_ORIGINS, code));
  assert.deepEqual(unregistered, []);
});

test('every reason the legacy lane writer returns is registered and classified by the hammer shell', () => {
  const holds = new Set(clickHoldCodes());
  const reasons = writerReasons();
  assert.deepEqual([...reasons].filter(reason => !Object.hasOwn(HAMMER_STOP_ORIGINS, reason)), []);
  // A writer refusal the shell does not name falls through to an unclassified
  // merge failure, so each must also be a recognised click hold.
  assert.deepEqual([...reasons].filter(reason => !holds.has(reason)), []);
});

test('the writer timeout is infrastructure and merge-target-unparseable is a closer fault', () => {
  assert.equal(HAMMER_INFRASTRUCTURE_OUTCOMES.has('legacy-writer-timeout'), true);
  assert.equal(hammerStopOrigin('legacy-writer-timeout'), 'infrastructure');
  assert.equal(HAMMER_RETRYABLE_READ_OUTCOMES.has('legacy-writer-timeout'), true);
  assert.equal(hammerStopOrigin('merge-target-unparseable'), 'closer');
  assert.equal(HAMMER_CLOSER_FAULTS.has('merge-target-unparseable'), true);
  assert.equal(HAMMER_INFRASTRUCTURE_OUTCOMES.has('merge-target-unparseable'), false);
});

test('only the timeout joins the retry allowlist; operator-veto and review-change holds do not', () => {
  const deferred = reason => retryableAmaCloserDeferralOutcome({ outcome: 'deferred', reason });
  assert.equal(deferred('legacy-writer-timeout'), 'retryable-legacy-writer-timeout');
  for (const reason of ['operator-review-changes-requested', 'review-changed-since-validation',
    'terminal-review-issuer-unverifiable', 'live-head-moved-before-merge']) {
    assert.equal(AMA_CLOSER_RETRYABLE_DEFERRAL_REASONS.has(reason), false, reason);
    assert.equal(deferred(reason), null, reason);
    assert.equal(hammerPhaseAttempt({ outcome: 'failed-without-merge', reason }).outcome, 'failed-without-merge', reason);
  }
});

// ---------------------------------------------------------- terminal audit --

const launch = 'lrq_synthetic-1';
const run = 'wrun_synthetic-1';
const auditEnv = root => ({ HAM_HQ_ROOT: root, HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
  HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: launch, HQ_WORKER_RUN_ID: run });

test('a writer timeout after a passed predicate records its real code, not stop-reason-unregistered', t => {
  const root = scratch(t);
  // HAM_RUN_DIR is what makes a closer-origin stop demand an in-run correction,
  // which is how the unregistered code overwrote the phase receipt.
  const env = { ...auditEnv(root), HAM_RUN_DIR: root };
  // What hammer-merge.sh appends at the click hold, then the run's final stop.
  appendAmaAuditAttempt({ hqRoot: root, repo: REPO, prNumber: PR, headSha: HEAD,
    attempt: hammerPhaseAttempt({ outcome: 'deferred', reason: 'legacy-writer-timeout', launchRequestId: launch,
      attemptPhase: 'hammer-gh-pr-merge', preMergeEligible: true }),
    metadata: { closureAuthority: 'ham-terminal-remediation' } });
  // ham_append_terminal_audit also names the phase; the unregistered final
  // stop used to overwrite it with stop-reason-unregistered.
  recordHammerPhase('legacy-writer-timeout', { env });
  recordHammerEarlyFailure('legacy-writer-timeout', { env, final: true });
  const entry = readAmaAuditEntry(root, REPO, PR, HEAD);
  const attempt = entry.attempts.at(-1);
  assert.equal(attempt.reason, 'legacy-writer-timeout');
  assert.equal(attempt.outcome, 'deferred');
  assert.equal(entry.status, 'deferred');
  assert.equal(attempt.originalReason, undefined);
  assert.equal(entry.attempts.some(item => item.reason === 'stop-reason-unregistered'), false);
  const phase = JSON.parse(readFileSync(join(root, 'dispatch', launch, 'hammer-progress', run, 'last-phase.json'), 'utf8'));
  assert.equal(phase.reason, 'legacy-writer-timeout');
  // A retryable infrastructure stop is not final for this head.
  assert.equal(existsSync(join(root, 'dispatch', launch, 'hammer-progress', run, 'terminal-stop.json')), false);
});

test('without a prior click-hold audit the final stop still records the registered infrastructure deferral', t => {
  const root = scratch(t);
  recordHammerEarlyFailure('legacy-writer-timeout', { env: auditEnv(root), final: true });
  const attempt = readAmaAuditEntry(root, REPO, PR, HEAD).attempts.at(-1);
  assert.equal(attempt.reason, 'legacy-writer-timeout');
  assert.equal(attempt.stopOrigin, 'infrastructure');
  assert.equal(attempt.outcome, 'deferred');
});

test('merge-target-unparseable is a closer fault: one in-run correction, then a deferral under its own code', t => {
  const root = scratch(t);
  const env = { ...auditEnv(root), HAM_RUN_DIR: root };
  assert.throws(() => recordHammerEarlyFailure('merge-target-unparseable', { env, final: true }), CloserCorrectionRequired);
  recordHammerEarlyFailure('merge-target-unparseable', { env, final: true });
  const attempt = readAmaAuditEntry(root, REPO, PR, HEAD).attempts.at(-1);
  assert.equal(attempt.reason, 'merge-target-unparseable');
  assert.equal(attempt.stopOrigin, 'closer');
  assert.equal(attempt.outcome, 'deferred');
});

test('operator-veto and review-change holds keep their world-fact terminal audit', t => {
  for (const reason of ['operator-review-changes-requested', 'review-changed-since-validation']) {
    const root = scratch(t);
    recordHammerEarlyFailure(reason, { env: auditEnv(root), final: true });
    const attempt = readAmaAuditEntry(root, REPO, PR, HEAD).attempts.at(-1);
    assert.equal(attempt.reason, reason);
    assert.equal(attempt.stopOrigin, 'world');
    assert.equal(attempt.outcome, 'failed-without-merge');
  }
});

// ----------------------------------------------------------------- re-drive --

function dispatchArgs(root, dispatchedAt) {
  const user = userInfo().username;
  return {
    guardStackedBaseImpl: async () => null,
    reviewState: { verdict: 'comment-only', reviewCycleExhausted: true, headSha: HEAD, riskClass: 'low',
      remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0, prAuthor: 'synthetic-builder' },
    prMetadata: { prNumber: PR, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], author: 'synthetic-builder', branchProtection: { requiredContexts: [] },
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash', branchProtection: { required: false },
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false } },
    dispatchContext: { rootDir: root, repo: REPO, prUrl: `https://github.com/${REPO}/pull/${PR}`,
      reviewedSha: HEAD, riskClass: 'low', requiredGateContext: 'synthetic/gate', reviewedBy: 'synthetic-reviewer',
      reviewer: 'codex', parentSession: 'synthetic-session', hqPath: '/bin/hq-synthetic', hqRoot: join(root, 'hq'),
      hqOwnerUser: user, currentUser: user, dispatchedAt, closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'synthetic-branch' }) },
  };
}

// The hammer's worker process exits 0 ("succeeded") with the PR still open.
function harness(root) {
  const state = { launches: 0, ended: null, alerts: [] };
  const deps = {
    deliverAlertImpl: async (message, options) => { state.alerts.push({ message, options }); },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv[1] === 'status') return { stdout: '{"status":"succeeded"}' };
      if (argv[0] === 'dispatch') {
        state.launches++;
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${PR}`, launchRequestId: `lrq_synthetic-${state.launches}`,
          dispatchId: `dispatch_synthetic-${state.launches}` }) };
      }
      return { stdout: '{}' };
    },
    readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true, row: launchRequestId === state.ended
      ? { status: 'succeeded' } : { status: 'running' } }),
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
  // The ended hammer left the click-hold audit its merge script appends.
  const endCurrent = (reason, mergeWriter) => {
    const record = readAmaCloserDispatchRecord(root, identity);
    updateAmaCloserDispatchRecord(root, identity, current => ({ ...current, workerRunId: `wrun_synthetic-${state.launches}` }));
    appendAmaAuditAttempt({ hqRoot: join(root, 'hq'), repo: REPO, prNumber: PR, headSha: HEAD,
      attempt: hammerPhaseAttempt({ outcome: 'deferred', reason, launchRequestId: record.launchRequestId,
        attemptPhase: 'hammer-gh-pr-merge', preMergeEligible: true, ...(mergeWriter ? { mergeWriter } : {}) }),
      metadata: { closureAuthority: 'ham-terminal-remediation' } });
    state.ended = record.launchRequestId;
  };
  return { state, deps, endCurrent, identity };
}

const at = n => new Date(Date.parse('2026-11-01T00:00:00Z') + n * 60_000).toISOString();

test('a historical writer timeout without a writer receipt remains compatible with redrive', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root);
  const pass = minutes => maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps });
  assert.equal((await pass(0)).dispatched, true);
  assert.equal(state.launches, 1);
  endCurrent('legacy-writer-timeout');
  const redrive = await pass(10);
  assert.equal(redrive.dispatched, true, JSON.stringify(redrive));
  assert.notEqual(redrive.needsOperator, true);
  assert.equal(state.launches, 2, 'a fresh launch retries the merge');
  // The retry is for the same head; only the live replacement is charged.
  assert.equal(readAmaCloserDispatchRecord(root, identity).headSha, HEAD);
  const ledger = readHammerRetryCapLedger(root, identity);
  for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) {
    assert.equal(ledger[key], 1, key);
  }
});

test('historical timeouts without writer receipts retain the legacy backoff', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent } = harness(root);
  const pass = minutes => maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps });
  await pass(0);
  const results = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    endCurrent('legacy-writer-timeout');
    results.push(await pass(attempt * 10));
  }
  assert.equal(results[0].dispatched, true, JSON.stringify(results[0]));
  for (const result of results) assert.notEqual(result.needsOperator, true, JSON.stringify(result));
  assert.ok(state.launches >= 2);
});

for (const [reason, phase, detail] of [['legacy-writer-timeout', 'review-proof', 'legacy-writer-timeout'],
  ['legacy-writer-preflight-refused', 'preparation', 'merge-command-not-spawned'],
  ['legacy-writer-preflight-refused', 'lane-admission', 'lane-transfer-required'],
  ['legacy-writer-preflight-refused', 'lane-admission', 'lane-reconciliation-required'],
  ['legacy-writer-preflight-refused', 'lane-admission', 'owner-operation-in-flight'],
  ['legacy-writer-preflight-refused', 'transport', 'stale-credential-rejected']]) {
  test(`${detail} uses durable deferral backoff with both launches charged`, async t => {
    const root = scratch(t);
    const { state, deps, endCurrent, identity } = harness(root);
    const pass = minutes => maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps });
    assert.equal((await pass(0)).dispatched, true);
    endCurrent(reason, { baseSha: 'b'.repeat(40), baseRef: 'main', reason: detail, phase,
      write: phase === 'transport' ? 'rejected' : 'not-invoked', readback: 'open', readbackHead: HEAD });
    const initial = readHammerRetryCapLedger(root, identity);
    for (const minute of [1, 2]) {
      assert.equal((await pass(minute)).reason, 'hammer-deferral-backoff');
      const held = readHammerRetryCapLedger(root, identity);
      for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount', 'lifetimeDeferralRefundCount', 'dispatchCharges']) {
        assert.deepEqual(held[key], initial[key], key);
      }
      assert.deepEqual(held.deferralLaunches, [launch]);
      assert.equal(held.deferralNextAt, at(3));
      assert.equal(state.launches, 1);
    }
    const redrive = await pass(3);
    assert.equal(redrive.dispatched, true, JSON.stringify(redrive));
    assert.equal(state.launches, 2);
    assert.deepEqual(state.alerts, []);
    const ledger = readHammerRetryCapLedger(root, identity);
    for (const key of ['attemptCount', 'targetAttemptCount', 'lifetimeAttemptCount']) {
      assert.equal(ledger[key], 2, key);
    }
  });
}

test('an unreadable launch cannot enroll charged writer deferral or transfer custody', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root);
  assert.equal((await maybeDispatchAmaCloser({ ...dispatchArgs(root, at(0)), ...deps })).dispatched, true);
  endCurrent('legacy-writer-preflight-refused', { phase: 'lane-admission', write: 'not-invoked',
    reason: 'lane-transfer-required', baseSha: 'b'.repeat(40), baseRef: 'main' });
  const charged = readHammerRetryCapLedger(root, identity);
  const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root, at(1)), ...deps,
    readLaunchRequestStatusImpl: () => ({ ok: false }) });
  assert.equal(result.dispatched, false);
  assert.equal(result.preservePredecessorArtifacts, true);
  assert.equal(state.launches, 1);
  assert.deepEqual(readHammerRetryCapLedger(root, identity), charged);
});

test('an unresolved writer intent stays parked across watcher passes and pages once', async t => {
  const root = scratch(t);
  const { state, deps } = harness(root);
  const base = 'b'.repeat(40);
  appendAmaAuditAttempt({ hqRoot: join(root, 'hq'), repo: REPO, prNumber: PR, headSha: HEAD, attempt: {
    outcome: 'in_progress', reason: 'merge-writer-intent', attemptPhase: 'hammer-gh-pr-merge', validatedHead: HEAD,
    mergeWriter: { baseSha: base, baseRef: 'main', phase: 'review-proof', write: 'unknown', readback: 'unavailable' },
  } });
  let live, probes = 0;
  const pass = minutes => maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps,
    readPullRequestStateImpl: ({ includeBase }) => { if (includeBase) probes++; return live; } });
  const active = { state: 'OPEN', headRefOid: HEAD, baseRefName: 'main', baseRefOid: base };
  for (const [index, observation] of [null, active].entries()) {
    live = observation;
    const result = await pass(index);
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'merge-writer-deferred');
    assert.equal(result.preservePredecessorArtifacts, true);
  }
  assert.equal(state.alerts.length, 1);
  assert.match(state.alerts[0].message, new RegExp(`${HEAD}.*audit attempt 1; base ${base}.*review-proof.*write unknown, readback unavailable`));
  assert.equal(state.launches, 0);
  assert.equal(probes, 1);
  live = { ...active, baseRefOid: 'e'.repeat(40) };
  assert.equal((await pass(4)).reason, 'merge-writer-deferred');
  assert.equal(probes, 1);
  const changed = await pass(5);
  assert.equal(changed.dispatched, true, JSON.stringify(changed));
  assert.equal(state.launches, 1);
  assert.equal(probes, 2);
});

test('held probes honor clock reset, a new hold, a new head and cancellation', async t => {
  const root = scratch(t);
  const { deps, identity } = harness(root);
  const hold = headSha => appendAmaAuditAttempt({ hqRoot: join(root, 'hq'), ...identity, headSha, attempt: {
    outcome: 'in_progress', reason: 'merge-writer-intent', attemptPhase: 'hammer-gh-pr-merge', validatedHead: headSha,
    mergeWriter: { baseSha: 'b'.repeat(40), baseRef: 'main', phase: 'review-proof', write: 'unknown', readback: 'unavailable' },
  } });
  let probes = 0;
  const pass = (minute, headSha, signal) => {
    const args = dispatchArgs(root, at(minute));
    args.prMetadata.headSha = args.reviewState.headSha = args.dispatchContext.reviewedSha = headSha;
    return maybeDispatchAmaCloser({ ...args, ...deps, signal, readPullRequestStateImpl: () => {
      probes++;
      return { state: 'OPEN', headRefOid: headSha, baseRefName: 'main', baseRefOid: 'b'.repeat(40) };
    } });
  };
  hold(HEAD);
  assert.equal((await pass(5, HEAD)).reason, 'merge-writer-deferred');
  assert.equal((await pass(4, HEAD)).reason, 'merge-writer-deferred');
  assert.equal((await pass(5, HEAD)).reason, 'merge-writer-deferred');
  assert.equal(probes, 2);
  hold(HEAD);
  assert.equal((await pass(5, HEAD)).reason, 'merge-writer-deferred');
  const next = 'd'.repeat(40);
  hold(next);
  assert.equal((await pass(5, next)).reason, 'merge-writer-deferred');
  await assert.rejects(pass(5, next, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(probes, 4);
});

for (const observedState of ['MERGED', 'CLOSED']) {
  test(`writer hold yields to the normal ${observedState} finalizer without launching`, async t => {
    const root = scratch(t);
    const { state, deps, identity } = harness(root);
    appendAmaAuditAttempt({ hqRoot: join(root, 'hq'), ...identity, attempt: {
      outcome: 'in_progress', reason: 'merge-writer-intent', attemptPhase: 'hammer-gh-pr-merge', validatedHead: HEAD,
      mergeWriter: { baseSha: 'b'.repeat(40), baseRef: 'main', write: 'unknown', readback: 'unavailable' },
    } });
    const live = { state: observedState, headRefOid: HEAD, baseRefName: 'main', baseRefOid: 'b'.repeat(40) };
    const args = dispatchArgs(root, at(0));
    args.dispatchContext.livePrProbeImpl = async () => ({ ...live, headBranchExists: false });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps, readPullRequestStateImpl: () => live });
    assert.equal(result.dispatched, false);
    assert.notEqual(result.reason, 'merge-writer-deferred');
    assert.equal(result.prState, observedState);
    assert.equal(state.launches, 0);
    assert.equal(state.alerts.length, 0);
    const lease = readAmaCloserLease(root, identity);
    if (observedState === 'MERGED') {
      assert.equal(lease.status, 'terminal');
      assert.equal(lease.terminalOutcome, 'succeeded');
    } else assert.equal(lease, null);
    assert.equal(readAmaAuditEntry(join(root, 'hq'), REPO, PR, HEAD).status, 'in_progress',
      'a confirmed target does not manufacture the old writer own-merge receipt');
  });
}

test('a moved writer target waits for a fresh snapshot and does not wedge the new head', async t => {
  const root = scratch(t);
  const { state, deps, identity } = harness(root);
  appendAmaAuditAttempt({ hqRoot: join(root, 'hq'), ...identity, attempt: {
    outcome: 'in_progress', reason: 'merge-writer-intent', attemptPhase: 'hammer-gh-pr-merge', validatedHead: HEAD,
    mergeWriter: { baseSha: 'b'.repeat(40), baseRef: 'main', write: 'unknown', readback: 'unavailable' },
  } });
  const next = 'd'.repeat(40);
  const live = { state: 'OPEN', headRefOid: next, baseRefName: 'main', baseRefOid: 'b'.repeat(40) };
  const first = await maybeDispatchAmaCloser({ ...dispatchArgs(root, at(0)), ...deps,
    readPullRequestStateImpl: () => live });
  assert.equal(first.dispatched, false);
  assert.equal(first.reason, 'merge-writer-head-superseded');
  assert.equal(first.candidateSuperseded, true);
  assert.equal(first.observedHeadSha, next);
  assert.equal(state.launches, 0);
  assert.equal(readAmaCloserLease(root, identity), null);
  const fresh = dispatchArgs(root, at(1));
  fresh.prMetadata.headSha = next;
  fresh.reviewState.headSha = next;
  fresh.dispatchContext.reviewedSha = next;
  const result = await maybeDispatchAmaCloser({ ...fresh, ...deps, readPullRequestStateImpl: () => live });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(state.launches, 1);
});

test('malformed audit without terminal certification returns a structured hold without launching', async t => {
  const root = scratch(t);
  const { state, deps } = harness(root);
  const hqRoot = join(root, 'hq');
  appendAmaAuditAttempt({ hqRoot, repo: REPO, prNumber: PR, headSha: HEAD,
    attempt: { outcome: 'in_progress', reason: 'merge-writer-intent' } });
  const file = amaAuditFilePath(hqRoot, REPO, PR, HEAD);
  writeFileSync(file, '{broken');
  for (const minutes of [0, 1]) {
    const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps });
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, 'park-audit-unreadable');
    assert.equal(result.needsOperator, true);
    assert.equal(readFileSync(file, 'utf8'), '{broken', 'retain the original corrupt evidence');
  }
  assert.equal(state.launches, 0);
  assert.equal(readHammerRetryCapLedger(root, { repo: REPO, prNumber: PR }), null, 'no attempt ledger is admitted');
});

test('an invalid writer audit pages once and parks without a launch', async t => {
  const root = scratch(t);
  const { state, deps } = harness(root);
  appendAmaAuditAttempt({ hqRoot: join(root, 'hq'), repo: REPO, prNumber: PR, headSha: HEAD, attempt: {
    outcome: 'in_progress', reason: 'merge-writer-intent', attemptPhase: 'hammer-gh-pr-merge', validatedHead: HEAD,
    mergeWriter: { baseSha: 'invalid', baseRef: 'main', write: 'unknown', readback: 'unavailable' },
  } });
  for (const minutes of [0, 1]) {
    const result = await maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps });
    assert.equal(result.reason, 'merge-writer-audit-unreadable');
    assert.equal(result.preservePredecessorArtifacts, true);
  }
  assert.equal(state.launches, 0);
  assert.equal(state.alerts.length, 1);
  assert.match(state.alerts[0].message, /reconcile the writer audit identity/);
});

test('an operator-veto hold is not re-driven by the infrastructure path', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent } = harness(root);
  const pass = minutes => maybeDispatchAmaCloser({ ...dispatchArgs(root, at(minutes)), ...deps });
  await pass(0);
  endCurrent('operator-review-changes-requested');
  const result = await pass(10);
  assert.notEqual(result.reason, 'closer-inconclusive-retry-backoff');
  assert.equal(readHammerRetryCapLedger(root, { repo: REPO, prNumber: PR }).selfErrorRefunds, undefined,
    'a world refusal is never refunded as an infrastructure retry');
  assert.ok(state.launches <= 2);
});

// ------------------------------------------------------------ deadline rule --

const subject = { target: `https://github.com/${REPO}/pull/${PR}`, head: HEAD };
const lane = { repository: REPO, base: 'main' };
const at0 = '2026-10-25T00:00:00.000Z';
// loadAvg1m 2.848 on one core is the 5.62 multiplier seen in the incident run.
const loaded = { enabled: true, maxMultiplier: 6, loadAvg1m: 2.848, cpuCount: 1, cpuBusyPercent: 100 };
function write(rootDir, extra) {
  return runLegacyLaneWrite({ rootDir, ...lane, readConfig: () => ({}), command: 'x', argv: [], now: () => at0,
    subject, prNumber: PR, reviewValidatedAt: at0, ...extra });
}
function queueRoot(t) {
  const rootDir = scratch(t, 'hamwritertimeout-01-lane-');
  openFinalizationQueueStore({ rootDir }).close();
  return rootDir;
}

test('the proof-read deadline follows the load-aware value past the former fixed 30 s cap', async t => {
  const rootDir = queueRoot(t);
  const expected = loadAwareTimeoutMs(LEGACY_PROOF_NOMINAL_MS, { ...loaded, maxMs: 600_000 });
  assert.ok(expected > 80_000 && expected < 90_000, `load multiplier 5.62 asks for ~84 s, got ${expected}`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let proofSignal, started;
  const admitted = new Promise(resolve => { started = resolve; });
  const pending = write(rootDir, { timeoutMs: 600_000, load: loaded,
    readReviewProof: async ({ signal }) => { proofSignal = signal; started(); return new Promise(() => {}); },
    exec: () => assert.fail('an expired proof never invokes transport') });
  await admitted;
  t.mock.timers.tick(30_000);
  assert.equal(proofSignal.aborted, false, 'the former 30 s cap no longer applies');
  t.mock.timers.tick(expected - 30_000 - 1);
  assert.equal(proofSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).reason, 'legacy-writer-timeout');
  assert.equal(proofSignal.aborted, true);
});

test('a proof read slower than 30 s but inside the load-aware deadline still reaches transport', async t => {
  const rootDir = queueRoot(t);
  const monotonicNow = performance.now.bind(performance);
  let seen;
  const result = await write(rootDir, { timeoutMs: 600_000, load: loaded,
    readReviewProof: async () => {
      t.mock.method(performance, 'now', () => monotonicNow() + 45_000);
      return { ok: true };
    },
    exec: async (_command, _argv, options) => { seen = options; return { stdout: 'merged' }; } });
  assert.equal(result.stdout, 'merged');
  assert.ok(seen.timeout <= 600_000 - 45_000, 'the read is charged to the run budget');
  assert.ok(seen.timeout > 0);
});

test('the deadline never exceeds the remaining run budget and never starts transport with none left', async t => {
  const rootDir = queueRoot(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let proofSignal, started;
  const admitted = new Promise(resolve => { started = resolve; });
  const pending = write(rootDir, { timeoutMs: 20_000, load: loaded,
    readReviewProof: async ({ signal }) => { proofSignal = signal; started(); return new Promise(() => {}); },
    exec: () => assert.fail('an expired proof never invokes transport') });
  await admitted;
  t.mock.timers.tick(19_999);
  assert.equal(proofSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).reason, 'legacy-writer-timeout');
});

test('an idle host keeps the nominal proof deadline', async t => {
  const rootDir = queueRoot(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let proofSignal, started;
  const admitted = new Promise(resolve => { started = resolve; });
  const pending = write(rootDir, { timeoutMs: 240_000, load: { loadAvg1m: 0, cpuCount: 1 },
    readReviewProof: async ({ signal }) => { proofSignal = signal; started(); return new Promise(() => {}); },
    exec: () => assert.fail('an expired proof never invokes transport') });
  await admitted;
  t.mock.timers.tick(LEGACY_PROOF_NOMINAL_MS - 1);
  assert.equal(proofSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).reason, 'legacy-writer-timeout');
});

// The prior writer's charge is retained; only a live exact-head lease and a
// fresh matching branch observation may reconcile a drained ambiguous write.
test('drained writer reconciliation requires current lease and fresh exact identity', async t => {
  const { reconcileHammerWriterHold, readHammerWriterHold, WRITER_HOLD_DRAIN_MS } =
    await import('../src/ama/hammer-writer-hold.mjs');
  const root = scratch(t), base = 'b'.repeat(40), started = '2026-01-01T00:00:00.000Z';
  appendAmaAuditAttempt({ hqRoot: root, repo: REPO, prNumber: PR, headSha: HEAD, now: started,
    attempt: { outcome: 'in_progress', path: 'hammer', attemptPhase: 'hammer-gh-pr-merge',
      reason: 'merge-writer-intent', validatedHead: HEAD,
      mergeWriter: { baseRef: 'main', baseSha: base, phase: 'transport', write: 'unknown' } } });
  const hold = readHammerWriterHold(root, REPO, PR, HEAD);
  const lease = { leaseId: 'lease-fixture', holderPr: PR, holderHead: HEAD,
    holderPid: process.pid, repo: REPO, base: 'main' };
  const live = { state: 'OPEN', headRefOid: HEAD, baseRefName: 'main', baseRefOid: base };
  const args = { rootDir: root, hqRoot: root, repo: REPO, prNumber: PR, hold,
    leaseId: lease.leaseId, now: Date.parse(started) + WRITER_HOLD_DRAIN_MS,
    inspectLeaseImpl: () => ({ lease, holderLiveness: 'live' }), readIdentityImpl: async () => live };
  assert.equal(await reconcileHammerWriterHold({ ...args, now: args.now - 1 }), false);
  assert.equal(await reconcileHammerWriterHold({ ...args, leaseId: 'other' }), false);
  assert.equal(await reconcileHammerWriterHold({ ...args, inspectLeaseImpl: () =>
    ({ lease: { ...lease, holderPid: 999999 }, holderLiveness: 'live' }) }), false);
  assert.equal(await reconcileHammerWriterHold({ ...args,
    inspectLeaseImpl: () => ({ lease, holderLiveness: 'unknown' }) }), false);
  for (const changed of [{ ...live, baseRefOid: 'd'.repeat(40) }, { ...live, state: 'CLOSED' },
    { ...live, headRefOid: 'e'.repeat(40) }, { ...live, baseRefOid: null }]) {
    assert.equal(await reconcileHammerWriterHold({ ...args, readIdentityImpl: async () => changed }), false);
  }
  assert.equal(readAmaAuditEntry(root, REPO, PR, HEAD).attempts.length, 1);
  assert.equal(await reconcileHammerWriterHold(args), true);
  const audit = readAmaAuditEntry(root, REPO, PR, HEAD);
  assert.equal(audit.attempts.length, 2);
  assert.equal(audit.attempts[0].reason, 'merge-writer-intent');
  assert.equal(audit.attempts[1].reason, 'merge-writer-reconciled');
  assert.notEqual(audit.status, 'succeeded');
  assert.equal(readHammerWriterHold(root, REPO, PR, HEAD), null);
  assert.equal(await reconcileHammerWriterHold(args), false);
});

test('queued writer waits do not page or acquire drain-based re-click authority', async t => {
  const { writerHoldDrainElapsed, readHammerWriterHold, WRITER_HOLD_DRAIN_MS } =
    await import('../src/ama/hammer-writer-hold.mjs');
  const root = scratch(t), started = '2026-01-01T00:00:00.000Z';
  appendAmaAuditAttempt({ hqRoot: root, repo: REPO, prNumber: PR, headSha: HEAD, now: started,
    attempt: { outcome: 'deferred', path: 'hammer', attemptPhase: 'hammer-gh-pr-merge',
      reason: 'merge-queue-pending', validatedHead: HEAD,
      mergeWriter: { baseRef: 'main', baseSha: 'b'.repeat(40), acknowledgement: 'queued' } } });
  const hold = readHammerWriterHold(root, REPO, PR, HEAD);
  assert.ok(hold);
  assert.equal(writerHoldDrainElapsed(hold, Date.parse(started) + 10 * WRITER_HOLD_DRAIN_MS), false);
});
