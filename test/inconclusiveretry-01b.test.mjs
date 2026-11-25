// INCONCLUSIVERETRY-01b: closer infrastructure failures become owned retries
// and never spend the closer budget. Synthetic fixtures only.
import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { recordHammerPhase } from '../src/ama/hammer-outcome.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { recordHammerProgress } from '../src/ama/hammer-progress.mjs';
import { continueDeferredSourceCustody, findDeferredSourceHold,
  readDeferredSourceHold, retainDeferredControllerCleanup, startDeferredSourceCustody } from '../src/ama/deferred-source-custody.mjs';
import { requestCloserSuccessor, settleCloserSuccessor } from '../src/ama/closer-successor.mjs';
import { CloserCorrectionRequired, recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { proveConflictPrimary } from '../src/ama/conflict-primary.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { readCloserNoDeliveryLedger } from '../src/ama/closer-no-delivery.mjs';
import { CLOSER_INCONCLUSIVE_RETRY_DEFAULTS, classifyCloserOutcome, closerInconclusiveRetryDelayMs, closerInconclusiveRetryFilePath,
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
  { reason: 'checkout-timeout' },
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
  'stale-review-head', 'head-changed', 'merge-refused', 'checkout-failed',
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
      reason: 'checkout-timeout', now, policy });
    assert.equal(owned.recorded, true);
    assert.equal(owned.entry.owner, 'watcher');
    assert.equal(owned.entry.attempt, attempt);
    assert.equal(owned.entry.reason, 'checkout-timeout');
    assert.equal(owned.entry.deadline, owned.entry.nextAttemptAt);
    assert.equal(recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: `lrq_s-${attempt}`,
      reason: 'checkout-timeout', now, policy }).reason, 'already-recorded');
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
function harness(root, lastPhase, endedStatus = 'failed') {
  const state = { launches: 0, ended: null, alerts: [] };
  const deps = {
    deliverAlertImpl: async (message, options) => { state.alerts.push({ message, options }); },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv[1] === 'status') return { stdout: JSON.stringify({ status: endedStatus }) };
      if (argv[0] === 'dispatch') {
        state.launches++;
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${PR}`, launchRequestId: `lrq_synthetic-${state.launches}`,
          dispatchId: `dispatch_synthetic-${state.launches}` }) };
      }
      return { stdout: '{}' };
    },
    readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true, row: launchRequestId === state.ended
      ? { status: endedStatus, ...(endedStatus === 'failed' ? { failure_class: 'no_work_done' } : {}) }
      : { status: 'running' } }),
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

function recordControlledDeferral(root, launchRequestId, { reasonDetail, overloadEvidence } = {}) {
  const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: launchRequestId, HAM_RUN_DIR: root,
    HAM_CONTROLLER_RECORD: join(root, 'controller.json') };
  startDeferredSourceCustody({ env, launchRequestId, sourceHead: HEAD, clean: true });
  writeFileSync(join(root, 'deferred-controller-controller.json'), JSON.stringify({ headSha: HEAD }));
  recordHammerEarlyFailure(reasonDetail ?? 'canonical-validation-deferred', { env, overloadEvidence });
  return {
    readAudit: () => readAmaAuditEntry(env.HAM_HQ_ROOT, REPO, PR, HEAD),
    cleanup: released => retainDeferredControllerCleanup(env, env.HAM_CONTROLLER_RECORD, {
      launchRequestId, state: 'quiescent', drained: true, leaseCleanup: { released },
    }),
  };
}

for (const endedStatus of ['failed', 'succeeded']) {
  test(`a published-head timeout with confirmed cleanup uses paced retry after ${endedStatus}`, async t => {
    const root = scratch(t);
    const { state, deps, endCurrent } = harness(root, 'canonical-validation-deferred', endedStatus);
    const run = at => {
      const args = dispatchArgs(root, minutes(at));
      args.cfg.closerInconclusiveRetry = { surfaceAfterAttempts: 1, backoffBaseMs: 60_000 };
      return maybeDispatchAmaCloser({ ...args, ...deps });
    };
    assert.equal((await run(0)).dispatched, true);
    endCurrent();
    const { readAudit, cleanup } = recordControlledDeferral(root, state.ended);
    await cleanup(true);
    assert.equal((await run(1)).reason, 'closer-inconclusive-retry-backoff');
    assert.equal(readAudit().attempts.at(-1).continuation.kind, 'redrive');
    assert.equal((await run(2)).dispatched, true);
    assert.equal(state.launches, 2);
    assert.equal(state.alerts.filter(alert => alert.options?.event === 'ama_closer.deferred_source_decision').length, 0);
  });
}

test('unconfirmed controller cleanup supersedes the early redrive with an operator hold', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent } = harness(root, 'canonical-validation-deferred', 'succeeded');
  const run = at => maybeDispatchAmaCloser({ ...dispatchArgs(root, minutes(at)), ...deps });
  assert.equal((await run(0)).dispatched, true);
  endCurrent();
  const reasonDetail = 'canonical-validation-deferred:cleanup-unconfirmed';
  const overloadEvidence = { source: 'fixture', retryAfterSeconds: 30 };
  const { readAudit, cleanup } = recordControlledDeferral(root, state.ended, { reasonDetail, overloadEvidence });
  const beforeCleanup = readAudit().attempts;
  assert.equal(beforeCleanup.at(-1).continuation.kind, 'redrive');
  assert.equal(beforeCleanup.at(-1).reasonDetail, reasonDetail);
  assert.deepEqual(beforeCleanup.at(-1).overloadEvidence, overloadEvidence);
  await cleanup(false);
  const sweep = await run(1);
  assert.equal(sweep.dispatched, false);
  assert.equal(sweep.needsOperator, true);
  assert.equal(sweep.reason, 'canonical-validation-operator-decision');
  const attempts = readAudit().attempts;
  assert.deepEqual(attempts.slice(0, -1), beforeCleanup);
  assert.equal(attempts.at(-1).launchRequestId, state.ended);
  assert.equal(attempts.at(-1).continuation.kind, 'park');
  assert.equal(attempts.at(-1).continuation.owner, 'operator');
  assert.match(attempts.at(-1).continuation.operatorAction, new RegExp(sweep.reason));
  assert.equal(attempts.at(-1).reasonDetail, reasonDetail);
  assert.deepEqual(attempts.at(-1).overloadEvidence, overloadEvidence);
  assert.equal((await run(2)).reason, sweep.reason);
  assert.deepEqual(readAudit().attempts, attempts);
});

for (const holdHead of [HEAD, OTHER]) {
  test(`custody at ${holdHead === HEAD ? 'dispatch' : 'current'} head parks the same launch audit at the other head`, async t => {
    const root = scratch(t);
    const { state, deps, endCurrent } = harness(root, 'canonical-validation-deferred', 'succeeded');
    const run = (at, headSha = HEAD) => maybeDispatchAmaCloser({
      ...dispatchArgs(root, minutes(at), { prMetadata: { headSha } }), ...deps,
    });
    assert.equal((await run(0)).dispatched, true);
    endCurrent();
    const auditHead = holdHead === HEAD ? OTHER : HEAD;
    const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
      HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended };
    recordHammerEarlyFailure('canonical-validation-deferred', { env, headSha: auditHead });
    const readAudit = () => readAmaAuditEntry(env.HAM_HQ_ROOT, REPO, PR, auditHead);
    const before = readAudit().attempts;
    assert.equal(before.at(-1).continuation.kind, 'redrive');
    startDeferredSourceCustody({ env: { ...env, HAM_CLOSE_VALIDATION_REMOTE_HEAD: holdHead },
      launchRequestId: state.ended, sourceHead: holdHead, clean: false });
    await run(1, OTHER);
    const attempts = readAudit().attempts;
    assert.deepEqual(attempts.slice(0, -1), before);
    assert.equal(attempts.at(-1).launchRequestId, state.ended);
    assert.equal(attempts.at(-1).outcome, 'deferred');
    assert.equal(attempts.at(-1).continuation.kind, 'park');
    assert.equal(attempts.at(-1).continuation.owner, 'operator');
  });
}

test('a dirty validation source at the default head advertises the same operator hold the sweep observes', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent } = harness(root, 'canonical-validation-deferred', 'succeeded');
  const run = at => maybeDispatchAmaCloser({ ...dispatchArgs(root, minutes(at)), ...deps });
  assert.equal((await run(0)).dispatched, true);
  endCurrent();
  const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended };
  startDeferredSourceCustody({ env, launchRequestId: state.ended, sourceHead: HEAD, clean: false });
  recordHammerEarlyFailure('canonical-validation-deferred', { env });
  const continuation = readAmaAuditEntry(env.HAM_HQ_ROOT, REPO, PR, HEAD).attempts.at(-1).continuation;
  assert.equal(continuation.kind, 'park');
  const sweep = await run(1);
  assert.equal(sweep.dispatched, false);
  assert.equal(sweep.needsOperator, true);
  assert.equal(sweep.reason, 'canonical-validation-operator-decision');
  assert.match(continuation.operatorAction, new RegExp(sweep.reason));
});

test('a clean audit-head hold cannot hide dirty custody at the later validation remote head', t => {
  const root = scratch(t);
  const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HAM_CLOSE_VALIDATION_REMOTE_HEAD: OTHER,
    HQ_LAUNCH_REQUEST_ID: 'lrq_clean-first' };
  startDeferredSourceCustody({ env: { ...env, HAM_CLOSE_VALIDATION_REMOTE_HEAD: HEAD },
    launchRequestId: env.HQ_LAUNCH_REQUEST_ID, sourceHead: HEAD, clean: true });
  startDeferredSourceCustody({ env, launchRequestId: env.HQ_LAUNCH_REQUEST_ID, sourceHead: OTHER, clean: false });
  // Prove that the unfiltered lookup really encounters the clean hold first.
  assert.equal(findDeferredSourceHold(env, { hqRoot: env.HAM_HQ_ROOT, repo: REPO, prNumber: PR, headSha: HEAD }).clean, true);
  recordHammerEarlyFailure('canonical-validation-deferred', { env, headSha: HEAD });
  assert.equal(readAmaAuditEntry(env.HAM_HQ_ROOT, REPO, PR, HEAD).attempts.at(-1).continuation.kind, 'park');
});

test('a dirty validation source at the explicit audit head advertises the same operator hold the sweep observes', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent } = harness(root, 'canonical-validation-deferred', 'succeeded');
  const run = (at, headSha) => maybeDispatchAmaCloser({
    ...dispatchArgs(root, minutes(at), { prMetadata: { headSha } }), ...deps,
  });
  assert.equal((await run(0, HEAD)).dispatched, true);
  endCurrent();
  const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended };
  startDeferredSourceCustody({ env, launchRequestId: state.ended, sourceHead: HEAD, clean: true });
  startDeferredSourceCustody({ env: { ...env, HAM_CLOSE_VALIDATION_REMOTE_HEAD: OTHER },
    launchRequestId: state.ended, sourceHead: OTHER, clean: false });
  recordHammerEarlyFailure('canonical-validation-deferred', { env, headSha: OTHER });
  const audit = readAmaAuditEntry(env.HAM_HQ_ROOT, REPO, PR, OTHER);
  const continuation = audit.attempts.at(-1).continuation;
  assert.equal(continuation.kind, 'park');
  const sweep = await run(1, OTHER);
  assert.equal(sweep.dispatched, false);
  assert.equal(sweep.needsOperator, true);
  assert.equal(sweep.reason, 'canonical-validation-operator-decision');
  assert.match(continuation.operatorAction, new RegExp(sweep.reason));
});

for (const legacy of [false, true]) {
  test(`a ${legacy ? 'previously continued legacy' : 'typed'} inspection deferral holds a published head after cleanup`, async t => {
    const root = scratch(t);
    const { state, deps, endCurrent, identity } = harness(root, 'canonical-validation-deferred');
    const run = (at, headSha = HEAD) => maybeDispatchAmaCloser({
      ...dispatchArgs(root, minutes(at), { prMetadata: { headSha } }), ...deps,
    });
    assert.equal((await run(0)).dispatched, true);
    endCurrent();
    const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
      HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended };
    const evidence = startDeferredSourceCustody({ env, launchRequestId: state.ended, sourceHead: HEAD, clean: true });
    const hold = readDeferredSourceHold(env.HAM_HQ_ROOT, identity);
    if (legacy) assert.equal(continueDeferredSourceCustody(hold), true);
    const receipts = {
      'deferred.json': { head: HEAD, validation: 'unknown', status: legacy ? 76 : 75,
        reason: legacy ? 'canonical-mirror-environment-unavailable' : 'process-inspection-unavailable',
        ciAuthoritative: false, coverageComplete: false },
      'bounded-cleanup.json': { launchRequestId: state.ended, head: HEAD, cleanup: 'finished' },
      'validation.json': { head: HEAD, checks: [{ name: 'Telegram responder guard', status: 'failed',
        result: 'inconclusive', diagnostics: [{ exitStatus: 75 }],
        localReason: 'telegram guard lane node: ps unusable in this sandbox: no verdict; telegram guard lane python: ps unusable in this sandbox: no verdict' }] },
    };
    for (const [name, receipt] of Object.entries(receipts)) writeFileSync(join(evidence, name), JSON.stringify(receipt));
    assert.equal(findDeferredSourceHold(env)?.launchRequestId, state.ended);
    const marker = readFileSync(hold.path, 'utf8');
    recordHammerEarlyFailure('canonical-validation-deferred', { env });
    for (const at of [1, 120, 240]) {
      const result = await run(at);
      assert.equal(result.dispatched, false, JSON.stringify(result));
      assert.equal(result.reason, 'canonical-validation-operator-decision');
      assert.equal(result.needsOperator, true);
    }
    assert.equal(state.launches, 1);
    assert.equal(readHammerRetryCapLedger(root, identity).attemptCount, 0);
    assert.deepEqual(readCloserNoDeliveryLedger(root, identity).heads, {});
    const owned = readCloserInconclusiveRetries(root, identity).heads[HEAD];
    assert.equal(owned.attempt, 1);
    assert.equal(owned.launches[0].custodyRequired, true);
    const notices = state.alerts.filter(alert => alert.options?.event === 'ama_closer.deferred_source_decision');
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /cleanup recorded finished.*existing canonical validator in an approved environment/);
    assert.equal(readFileSync(hold.path, 'utf8'), marker);
    for (const [name, receipt] of Object.entries(receipts)) {
      assert.equal(readFileSync(join(evidence, name), 'utf8'), JSON.stringify(receipt));
    }
    const changed = await run(241, OTHER);
    assert.notEqual(changed.reason, 'canonical-validation-operator-decision', JSON.stringify(changed));
  });
}

test('corrupt retry evidence blocks repeated ended validation retries and pages once', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root, 'canonical-validation-deferred');
  const run = at => maybeDispatchAmaCloser({ ...dispatchArgs(root, minutes(at)), ...deps });
  const path = closerInconclusiveRetryFilePath(root, identity);
  mkdirSync(dirname(path), { recursive: true });
  assert.equal((await run(0)).dispatched, true);
  for (const firstPass of [1, 4]) {
    endCurrent();
    recordHammerEarlyFailure('canonical-validation-deferred', { env: { HAM_HQ_ROOT: join(root, 'hq'),
      HAM_REPO: REPO, HAM_PR_NUMBER: String(PR), HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended } });
    writeFileSync(path, '{broken');
    for (const at of [firstPass, firstPass + 1]) {
      const result = await run(at);
      assert.equal(result.reason, 'retry-record-unreadable');
      assert.equal(result.recoveryWait, true);
      assert.equal(readFileSync(path, 'utf8'), '{broken');
    }
    if (firstPass === 1) {
      rmSync(path);
      assert.equal((await run(3)).dispatched, true);
    }
  }
  assert.equal(state.launches, 2);
  assert.equal(state.alerts.filter(alert => alert.options?.event === 'ama_closer.inconclusive_retry_record_unreadable').length, 1);
});

test('a canonical validation deferral stops same-head dispatch and asks for one operator decision', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root, 'canonical-validation-deferred');
  const run = at => {
    const args = dispatchArgs(root, at);
    args.cfg.closerInconclusiveRetry = { surfaceAfterAttempts: 2, backoffBaseMs: 60_000, backoffMaxMs: 300_000 };
    return maybeDispatchAmaCloser({ ...args, ...deps });
  };
  assert.equal((await run(minutes(0))).dispatched, true);
  endCurrent();
  const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended };
  // The first write alone holds the successor. A crash before the cleanup
  // owner completed the package must never permit a second validator.
  startDeferredSourceCustody({ env, launchRequestId: state.ended, sourceHead: HEAD });
  recordHammerEarlyFailure('canonical-validation-deferred', { env });
  for (const at of [10, 11, 240]) {
    const result = await run(minutes(at));
    assert.equal(result.dispatched, false, JSON.stringify(result));
    assert.equal(result.reason, 'canonical-validation-operator-decision');
    assert.equal(result.needsOperator, true);
  }
  const owned = readCloserInconclusiveRetries(root, identity).heads[HEAD];
  assert.equal(owned.attempt, 1);
  assert.equal(owned.reason, 'canonical-validation-deferred');
  assert.equal(readHammerRetryCapLedger(root, identity).attemptCount, 0);
  assert.equal(state.launches, 1);
  const decisions = state.alerts.filter(alert => alert.options?.event === 'ama_closer.deferred_source_decision');
  assert.equal(decisions.length, 1);
  assert.match(decisions[0].message, /cleanup unconfirmed/);

  requestCloserSuccessor({ rootDir: root, ...identity, headSha: HEAD, source: 'fixture-pending-before-timeout' });
  let handoffCalls = 0;
  const successor = await settleCloserSuccessor({ rootDir: root, hqRoot: env.HAM_HQ_ROOT,
    ...identity, headSha: HEAD, now: minutes(241), handoffImpl: () => { handoffCalls++; },
    observeWaitImpl: args => observeClosureWait({ ...args, pageImpl: deps.deliverAlertImpl }) });
  assert.equal(successor.status, 'canonical-validation-operator-decision');
  assert.equal(handoffCalls, 0, 'orchestration cannot enroll an already-pending successor');
  assert.equal(state.alerts.length, decisions.length, 'the two routes share the same decision notice');
});

test('a validation deferral after publication schedules the live head and refunds the source launch', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root, 'canonical-validation-deferred');
  const run = (at, headSha) => {
    const args = dispatchArgs(root, at, { prMetadata: { headSha } });
    args.cfg.closerInconclusiveRetry = { surfaceAfterAttempts: 1, backoffBaseMs: 60_000 };
    return maybeDispatchAmaCloser({ ...args, ...deps });
  };
  assert.equal((await run(minutes(0), HEAD)).dispatched, true);
  endCurrent();
  const env = {
    HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended,
    HQ_WORKER_RUN_ID: `wrun_synthetic-${state.launches}`,
  };
  recordHammerProgress('remediation-pushed', { env, headSha: OTHER });
  recordHammerEarlyFailure('canonical-validation-deferred', { headSha: OTHER, env });
  const result = await run(minutes(1), OTHER);
  assert.equal(result.reason, 'closer-inconclusive-retry-backoff', JSON.stringify(result));
  const { heads } = readCloserInconclusiveRetries(root, identity);
  assert.equal(heads[OTHER].nextAttemptAt, minutes(2));
  assert.equal(heads[HEAD], undefined);
  assert.equal(readHammerRetryCapLedger(root, identity).attemptCount, 0);
});

test('validation deferral without matching publication proof leaves the externally advanced head unpaced', async t => {
  for (const auditHead of [HEAD, OTHER]) {
    const root = scratch(t);
    const { state, deps, endCurrent, identity } = harness(root, 'canonical-validation-deferred');
    const run = (at, headSha) => {
      const args = dispatchArgs(root, at, { prMetadata: { headSha } });
      args.cfg.closerInconclusiveRetry = { surfaceAfterAttempts: 1, backoffBaseMs: 60_000 };
      return maybeDispatchAmaCloser({ ...args, ...deps });
    };
    assert.equal((await run(minutes(0), HEAD)).dispatched, true);
    endCurrent();
    const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
      HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: state.ended,
      HQ_WORKER_RUN_ID: `wrun_synthetic-${state.launches}` };
    recordHammerEarlyFailure('canonical-validation-deferred', { headSha: auditHead, env });
    const result = await run(minutes(1), OTHER);
    assert.notEqual(result.reason, 'closer-inconclusive-retry-backoff', JSON.stringify(result));
    const { heads } = readCloserInconclusiveRetries(root, identity);
    assert.equal(heads[HEAD].nextAttemptAt, minutes(2));
    assert.equal(heads[OTHER], undefined);
  }
});

test('a validation retry records unsafe custody on the current remote head', async t => {
  const root = scratch(t);
  const { state, deps, endCurrent, identity } = harness(root, 'canonical-validation-deferred');
  const run = (at, headSha) => maybeDispatchAmaCloser({
    ...dispatchArgs(root, minutes(at), { prMetadata: { headSha } }), ...deps,
  });
  assert.equal((await run(0, HEAD)).dispatched, true);
  endCurrent();
  const env = { HAM_HQ_ROOT: join(root, 'hq'), HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: HEAD, HAM_CLOSE_VALIDATION_REMOTE_HEAD: OTHER,
    HQ_LAUNCH_REQUEST_ID: state.ended, HQ_WORKER_RUN_ID: `wrun_synthetic-${state.launches}` };
  startDeferredSourceCustody({ env, launchRequestId: state.ended, sourceHead: HEAD });
  recordHammerEarlyFailure('canonical-validation-deferred', { headSha: HEAD, env });
  assert.equal((await run(1, OTHER)).reason, 'canonical-validation-operator-decision');
  const { heads } = readCloserInconclusiveRetries(root, identity);
  assert.equal(heads[HEAD].launches[0].custodyRequired, true);
});

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
  const { state, deps, endCurrent } = harness(root, 'checkout-timeout');
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
    reason: 'checkout-timeout', now: minutes(0) });
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
    reason: 'checkout-timeout', now: minutes(0) });
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
  recordCloserInconclusiveRetry(root, identity, { headSha: HEAD, launchRequestId: 'lrq_x', reason: 'checkout-timeout', now: minutes(0) });
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
