import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';

// LCR — AMA closer dispatch admission-priority routing.
//
// The reserved critical admission lane (cwp_dispatch `admission.priority_lane`)
// grants a load-cap BYPASS to `critical` rows only, so a clean pipeline-critical
// merge is not stalled by the dynamic CPU-load dispatch cap. These tests pin the
// routing predicate the closer uses when it builds `hq dispatch --priority`:
//
//   - a no-terminal-remediation validate-gate-and-click / mechanical-gate close
//     resolves to `critical` (lane-eligible);
//   - a terminal-remediation hammer (blocking/non-blocking findings, forced red
//     CI, or mergeability repair) stays `normal` so it cannot hog the single
//     reserved slot for the minutes it spends remediating;
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
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
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

// A settled review WITH blocking findings — the hammer is dispatched to
// terminal-remediate them in code (standing findings present).
function findingsRemediationArgs(rootDir, overrides = {}) {
  return baseArgs(rootDir, overrides);
}

// A CLEAN review (zero findings) that still reaches the closer dispatch surface
// because a required check is not green yet. This forces the terminal-remediation
// prompt even though no findings are standing, so it must stay out of the
// reserved critical lane.
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

test('LCR: clean forced terminal-remediation closer dispatches with --priority normal', async (t) => {
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
    'normal',
    'clean forced terminal-remediation closer must not take the reserved critical lane',
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

test('LCR: --priority precedes the base dispatch args and is emitted exactly once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-shape-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  await maybeDispatchAmaCloser({ ...cleanValidateAndClickArgs(rootDir), ...deps });

  const args = deps.calls[0].args;
  assert.equal(args[0], 'dispatch');
  assert.equal(args.filter((a) => a === '--priority').length, 1, 'exactly one --priority flag');
  assert.deepEqual(args.slice(0, 3), ['dispatch', '--priority', 'normal']);
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
