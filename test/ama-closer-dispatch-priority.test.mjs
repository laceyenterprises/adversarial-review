import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  maybeDispatchAmaCloser,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { acquireAmaCloserLease } from '../src/ama/closer-lease.mjs';

// LCR — AMA closer dispatch admission-priority routing.
//
// The reserved critical admission lane (cwp_dispatch `admission.priority_lane`)
// grants a load-cap BYPASS to `critical` rows only, so a clean pipeline-critical
// merge is not stalled by the dynamic CPU-load dispatch cap. These tests pin the
// routing predicate the closer uses when it builds `hq dispatch --priority`:
//
//   - a no-terminal-remediation validate-gate-and-click / mechanical-gate close
//     resolves to `critical` (lane-eligible);
//   - a terminal-remediation hammer (post-exhaustion blocking/non-blocking
//     findings, forced red CI, or mergeability repair) stays `normal` so it
//     cannot hog the single reserved slot for the minutes it spends remediating;
//   - the `--priority` flag actually carries the resolved value on the dispatch;
//   - an older/forked `hq` without `--priority` degrades cleanly (retry once
//     without the flag) instead of failing the dispatch.
//
// A fully-clean, eligible, green, mergeable PR never reaches this dispatch
// surface — the daemon clean-route closes it inline (`daemon-clean-route`) — so
// every dispatch here is either a terminal remediation (normal) or a
// no-terminal-remediation mechanical-gate repair (critical). This is admission
// routing ONLY: priority never changes merge eligibility.

const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';
const HEAD = 'a'.repeat(40);
const REQUIRED_GATE = 'agent-os/adversarial-gate';

function testDeps() {
  const calls = [];
  return {
    calls,
    execFileImpl: async (cmd, args, options = {}) => {
      calls.push({ cmd, args, options });
      return { stdout: JSON.stringify({ dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

function baseArgs(rootDir, overrides = {}) {
  return {
    reviewState: {
      verdict: 'request changes',
      headSha: HEAD,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      ...overrides.reviewState,
    },
    prMetadata: {
      prNumber: 404,
      headSha: HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
      ],
      branchProtection: { requiredContexts: [REQUIRED_GATE] },
      author: 'builder',
      ...overrides.prMetadata,
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      branchProtection: { required: true },
      ...overrides.cfg,
    },
    options: { env: { ADV_GATE_STATUS_CONTEXT: REQUIRED_GATE } },
    dispatchContext: {
      rootDir,
      repo: 'acme/repo',
      prUrl: 'https://github.com/acme/repo/pull/404',
      reviewedSha: HEAD,
      riskClass: 'low',
      requiredGateContext: REQUIRED_GATE,
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt: '2026-07-20T12:00:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/live' }),
      ...overrides.dispatchContext,
    },
  };
}

// An exhausted review cycle WITH blocking findings — the hammer is dispatched to
// terminal-remediate them in code as the final rescue lane.
function findingsRemediationArgs(rootDir, overrides = {}) {
  return baseArgs(rootDir, {
    reviewState: {
      reviewCycleExhausted: true,
      ...overrides.reviewState,
    },
    ...overrides,
  });
}

// A CLEAN review (zero findings) that still reaches the closer dispatch surface
// because a required check is still pending. This is a no-terminal-remediation
// mechanical validate-gate-and-click close, so it rides the reserved critical
// lane.
function cleanValidateAndClickArgs(rootDir, overrides = {}) {
  return baseArgs(rootDir, {
    reviewState: {
      verdict: 'comment-only',
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      ...overrides.reviewState,
    },
    prMetadata: {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'ci/test', status: 'IN_PROGRESS' },
      ],
      branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
      ...overrides.prMetadata,
    },
    ...overrides,
  });
}

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

test('LCR: findings-remediation hammer dispatches with --priority normal', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-remediation-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, 'a findings hammer must dispatch');
  assert.equal(deps.calls.length, 1);
  const args = deps.calls[0].args;
  assert.equal(flagValue(args, '--completion-shape'), 'decision-only');
  assert.equal(flagValue(args, '--task-kind'), 'merge');
  assert.equal(
    flagValue(args, '--priority'),
    'normal',
    'findings-remediation hammer must NOT take the reserved critical lane',
  );
});

test('LCR: hq dispatch caps worker provision watchdog at the AMA dispatch timeout', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-provision-timeout-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const previousProvisionTimeout = process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
  const previousProvisionSubprocessTimeout = process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
  delete process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
  delete process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
  t.after(() => {
    if (previousProvisionTimeout === undefined) {
      delete process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS = previousProvisionTimeout;
    }
    if (previousProvisionSubprocessTimeout === undefined) {
      delete process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS = previousProvisionSubprocessTimeout;
    }
  });
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { cfg: { dispatchTimeoutMs: 240_000 } }),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].options.timeout, 240_000);
  assert.equal(deps.calls[0].options.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS, '150');
  assert.equal(deps.calls[0].options.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS, '195');
});

test('LCR: hq dispatch preserves an already stricter worker provision timeout', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-provision-timeout-strict-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const previousProvisionTimeout = process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
  const previousProvisionSubprocessTimeout = process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
  process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS = '45';
  process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS = '30';
  t.after(() => {
    if (previousProvisionTimeout === undefined) {
      delete process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS = previousProvisionTimeout;
    }
    if (previousProvisionSubprocessTimeout === undefined) {
      delete process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS = previousProvisionSubprocessTimeout;
    }
  });
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { cfg: { dispatchTimeoutMs: 240_000 } }),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].options.timeout, 240_000);
  assert.equal(deps.calls[0].options.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS, '45');
  assert.equal(deps.calls[0].options.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS, '30');
});

test('LCR: no-LRQ AMA launch in progress defers another hammer dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-active-launch-defers-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(rootDir, {
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'b'.repeat(40),
  }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'b'.repeat(40),
    state: 'dispatching',
    lastAttemptedAt: '2026-07-20T12:00:00Z',
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: null,
    dispatchTimeoutMs: 300_000,
  }));
  acquireAmaCloserLease({
    rootDir,
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'b'.repeat(40),
    watcherPid: process.pid,
    now: '2026-07-20T12:00:00Z',
  });
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, {
      dispatchContext: {
        dispatchedAt: '2026-07-20T12:05:00Z',
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'ama-closer-launch-in-progress');
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.activeLaunch.prNumber, 999);
  assert.equal(deps.calls.length, 0, 'do not start another hq dispatch before the first has an lrq');
});

test('LCR: dead no-LRQ AMA launch lease does not globally hold hammer dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-dead-active-launch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(rootDir, {
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'c'.repeat(40),
  }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'c'.repeat(40),
    state: 'dispatching',
    lastAttemptedAt: '2026-07-20T12:00:00Z',
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: null,
    dispatchTimeoutMs: 600_000,
  }));
  acquireAmaCloserLease({
    rootDir,
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'c'.repeat(40),
    watcherPid: 999999,
    now: '2026-07-20T12:00:00Z',
  });
  const deps = testDeps();
  const gone = new Error('pid is gone');
  gone.code = 'ESRCH';

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, {
      dispatchContext: {
        dispatchedAt: '2026-07-20T12:20:00Z',
      },
    }),
    ...deps,
    processKillImpl: () => {
      throw gone;
    },
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_hammer_1');
  assert.equal(deps.calls.length, 1, 'dead no-LRQ launches must not block later PRs');
});

test('LCR: non-exhausted request-changes findings do not dispatch hammer before Codex remediation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-request-changes-codex-first-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({ ...baseArgs(rootDir), ...deps });

  assert.equal(result.dispatched, false, 'hammer must not answer first on a request-changes findings head');
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('blocking-findings-present'), JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('verdict-not-settled-success'), JSON.stringify(result.reasons));
  assert.equal(deps.calls.length, 0, 'no hq hammer dispatch');
});

test('LCR: rereview-only exhaustion does not dispatch hammer before Codex remediation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-rereview-only-codex-first-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...baseArgs(rootDir, {
      reviewState: {
        verdict: 'request changes',
        remediationPending: false,
        blockingFindingState: 'unknown',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        reviewCycleExhausted: true,
        completedRemediationRounds: 0,
        completedRereviewRounds: 3,
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false, 'rereview-only exhaustion must not mint a terminal hammer');
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('blocking-findings-unknown'), JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('verdict-not-settled-success'), JSON.stringify(result.reasons));
  assert.equal(deps.calls.length, 0, 'no hq hammer dispatch');
});

test('LCR: comment-only exhaustion can dispatch terminal hammer without a remediation round', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-comment-only-exhaustion-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...baseArgs(rootDir, {
      reviewState: {
        verdict: 'comment-only',
        blockingFindingState: 'known',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 1,
        reviewCycleExhausted: true,
        completedRemediationRounds: 0,
        completedRereviewRounds: 2,
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true, 'comment-only cycles do not spawn Codex remediators');
  assert.equal(deps.calls.length, 1, 'terminal hammer remains available after rereview budget exhaustion');
});

test('LCR: clean mechanical-gate closer dispatches with --priority critical', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-clean-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({ ...cleanValidateAndClickArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, 'a clean mechanical-gate close reaching the dispatch surface must dispatch');
  assert.equal(deps.calls.length, 1);
  const args = deps.calls[0].args;
  assert.equal(flagValue(args, '--completion-shape'), 'decision-only');
  assert.equal(flagValue(args, '--task-kind'), 'merge');
  assert.equal(
    flagValue(args, '--priority'),
    'critical',
    'clean mechanical-gate closer must take the reserved critical lane',
  );
});

test('LCR: forced terminal-remediation prompt dispatches with --priority normal even with a clean verdict', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-forced-terminal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...cleanValidateAndClickArgs(rootDir, {
      prMetadata: {
        statusCheckRollup: [
          { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'ci/test', conclusion: 'FAILURE' },
        ],
        branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true, 'a clean verdict with red required CI should auto-hammer');
  assert.equal(deps.calls.length, 1);
  const args = deps.calls[0].args;
  assert.equal(flagValue(args, '--completion-shape'), 'decision-only');
  assert.equal(flagValue(args, '--task-kind'), 'merge');
  assert.equal(
    flagValue(args, '--priority'),
    'normal',
    'forced terminal-remediation prompt must not take the reserved critical lane',
  );
});

test('LCR: auto-hammer log gate keys on PR metadata repo before dispatch context fallback', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-auto-hammer-gate-key-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const gateNotes = [];

  const result = await maybeDispatchAmaCloser({
    ...cleanValidateAndClickArgs(rootDir, {
      prMetadata: {
        repoPath: 'acme/pr-metadata-repo',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'ci/test', conclusion: 'FAILURE' },
        ],
        branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
      },
      dispatchContext: {
        repo: 'acme/dispatch-context-repo',
      },
    }),
    ...deps,
    logGate: {
      note(key, signature) {
        gateNotes.push({ key, signature });
        return { changed: true, count: 1, suppressedSincePrevious: 0 };
      },
    },
  });

  assert.equal(result.dispatched, true, 'a clean verdict with red required CI should auto-hammer');
  assert.equal(gateNotes[0]?.key, 'acme/pr-metadata-repo#404');
});

test('LCR: --priority precedes the base dispatch args and is emitted exactly once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-shape-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  await maybeDispatchAmaCloser({ ...cleanValidateAndClickArgs(rootDir), ...deps });

  const args = deps.calls[0].args;
  assert.equal(args[0], 'dispatch');
  assert.equal(args.filter((a) => a === '--priority').length, 1, 'exactly one --priority flag');
  assert.deepEqual(args.slice(0, 3), ['dispatch', '--priority', 'critical']);
});

test('LCR: unsupported --priority hq degrades to a flag-less retry (no dispatch regression)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-unsupported-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const calls = [];
  deps.calls = calls;
  deps.execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('--priority')) {
      throw Object.assign(new Error("error: unrecognized argument '--priority'"), {
        code: 2,
        stderr: "error: unrecognized argument '--priority'",
      });
    }
    return { stdout: JSON.stringify({ dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
  };

  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, 'closer must still dispatch when hq lacks --priority');
  assert.equal(calls.length, 2, 'one failed priority attempt + one flag-less retry');
  assert.ok(calls[0].args.includes('--priority'), 'first attempt carries --priority');
  assert.ok(!calls[1].args.includes('--priority'), 'retry drops --priority');
  assert.equal(flagValue(calls[1].args, '--task-kind'), 'merge', 'retry preserves the merge dispatch');
});
