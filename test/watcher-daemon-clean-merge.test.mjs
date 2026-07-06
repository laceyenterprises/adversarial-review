import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaClosureFor, runDaemonCleanMergeAttempt } from '../src/watcher.mjs';
import {
  DAEMON_MERGE_DISPOSITION,
  DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS,
} from '../src/ama/daemon-merge.mjs';

// Integration test for the MSM-03 wiring seam in `maybeDispatchAmaClosureFor`:
// the daemon clean-merge attempt runs BEFORE the AMA closer dispatch, and any
// disposition other than `not-taken` short-circuits (no closer/hammer spawn).

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'watcher-daemon-clean-merge-'));
}

function loadAmaEnabledConfig() {
  return {
    getMergeAuthorityConfig() {
      return {
        enabled: true,
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      };
    },
    getOrchestrationMode() {
      return 'native';
    },
  };
}

function loadAmaEnabledAutonomousDisabledConfig() {
  return {
    getMergeAuthorityConfig() {
      return {
        enabled: true,
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: false,
        strictMode: true,
      };
    },
    getOrchestrationMode() {
      return 'native';
    },
  };
}

function baseArgs(rootDir) {
  return {
    rootDir,
    reviewStateRow: {
      review_status: 'posted',
      review_body: [
        '## Blocking Issues',
        '',
        '- None.',
        '',
        '## Non-blocking Issues',
        '',
        '- None.',
        '',
        '## Verdict',
        '',
        'Comment only',
      ].join('\n'),
      reviewer_head_sha: 'head-live',
      reviewer: 'codex',
    },
    dispatchJob: { blockingFindingCount: 0, blockingFindingState: 'known' },
    candidate: {
      headSha: 'head-live',
      baseBranch: 'main',
      prState: 'open',
      isDraft: false,
      riskClass: 'low',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      prAuthor: 'builder',
    },
    labelNames: [],
    repoPath: 'acme/repo',
    prNumber: 300,
    currentRevisionRef: 'head-live',
    loadConfigImpl: loadAmaEnabledConfig,
    liveReviewRetryDelaysMs: [0, 0],
    logger: { warn() {}, log() {} },
  };
}

test('daemon merges the clean tick → skips closer dispatch (no agent spawn)', async () => {
  const rootDir = tempRoot();
  try {
    let closerCalls = 0;
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.MERGED,
        reason: 'merged',
        merged: true,
        attempts: 1,
      }),
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
    });

    assert.equal(closerCalls, 0, 'the closer/hammer must NOT be dispatched when the daemon merged');
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, `daemon-${DAEMON_MERGE_DISPOSITION.MERGED}`);
    assert.equal(result.daemonCleanMerge.merged, true);
    assert.equal(result.amaEnabled, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon fail-closed → skips closer dispatch; no hammer from the retry path', async () => {
  const rootDir = tempRoot();
  try {
    let closerCalls = 0;
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
        reason: 'permanent-merge-rejection',
        merged: false,
        attempts: 1,
      }),
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
    });

    assert.equal(closerCalls, 0, 'a daemon fail-closed must NOT spawn a hammer');
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, `daemon-${DAEMON_MERGE_DISPOSITION.FAILED_CLOSED}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon deferred (lease contention) → skips closer dispatch this tick', async () => {
  const rootDir = tempRoot();
  try {
    let closerCalls = 0;
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
        reason: 'lease-contended',
        merged: false,
      }),
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
    });

    assert.equal(closerCalls, 0);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, `daemon-${DAEMON_MERGE_DISPOSITION.DEFERRED}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon not-taken (findings present) → falls through to the closer/hammer dispatch', async () => {
  const rootDir = tempRoot();
  try {
    let closerCalls = 0;
    let seenReviewState = null;
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
        reason: 'blocking-findings-present',
      }),
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        closerCalls += 1;
        seenReviewState = reviewState;
        return { dispatched: true, reason: 'closer-took-over' };
      },
    });

    assert.equal(closerCalls, 1, 'not-taken must fall through to the existing closer/hammer path');
    assert.equal(result.dispatched, true);
    assert.equal(result.reason, 'closer-took-over');
    assert.ok(seenReviewState, 'closer received the reviewState');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('autonomous merge execution disabled → fail-closed audit; no daemon, closer, or old-path dispatch', async () => {
  const rootDir = tempRoot();
  try {
    let daemonCalls = 0;
    let closerCalls = 0;
    const audits = [];
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      loadConfigImpl: loadAmaEnabledAutonomousDisabledConfig,
      runDaemonCleanMergeAttemptImpl: async () => {
        daemonCalls += 1;
        return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, reason: 'should-not-run' };
      },
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
      writeAutonomousMergeDisabledAuditImpl: (entry) => {
        audits.push(entry);
        return { written: true };
      },
      env: { HQ_ROOT: '/tmp/hq-root-for-test' },
    });

    assert.equal(daemonCalls, 0, 'flag OFF must not execute daemon merge');
    assert.equal(closerCalls, 0, 'flag OFF must not dispatch hammer/old closer path');
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, 'autonomous-merge-execution-disabled');
    assert.equal(result.autonomousMergeDisabled.path, 'hammer-merge');
    assert.deepEqual(result.autonomousMergeDisabled.flagState, {
      autonomousMergeExecutionEnabled: false,
      strictMode: true,
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].path, 'hammer-merge');
    assert.equal(audits[0].flagState.autonomousMergeExecutionEnabled, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher passes strict_mode false into daemon merge attempt', async () => {
  const rootDir = tempRoot();
  try {
    let seenCfg = null;
    const cfgLoader = () => ({
      getMergeAuthorityConfig() {
        return {
          enabled: true,
          mergeMethod: 'squash',
          autonomousMergeExecutionEnabled: true,
          strictMode: false,
        };
      },
      getOrchestrationMode() {
        return 'native';
      },
    });
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      loadConfigImpl: cfgLoader,
      runDaemonCleanMergeAttemptImpl: async ({ cfg }) => {
        seenCfg = cfg;
        return {
          disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
          reason: 'not-eligible',
        };
      },
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, reason: 'not-eligible' }),
    });

    assert.equal(seenCfg.strictMode, false);
    assert.equal(result.amaEnabled, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher passes live HAM target separately from stable reviewed-head dispatch key', async () => {
  const rootDir = tempRoot();
  try {
    const reviewedHead = 'reviewed-head-before-ham';
    const liveHead = 'live-head-after-ham';
    const args = baseArgs(rootDir);
    let seenDispatchContext = null;
    let seenOptions = null;
    const result = await maybeDispatchAmaClosureFor({
      ...args,
      reviewStateRow: {
        ...args.reviewStateRow,
        review_body: [
          '## Blocking Issues',
          '',
          '- None.',
          '',
          '## Non-blocking Issues',
          '',
          '- None.',
          '',
          '## Verdict',
          '',
          'Comment only',
        ].join('\n'),
        reviewer_head_sha: reviewedHead,
        reviewer: 'codex',
      },
      dispatchJob: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      candidate: {
        ...args.candidate,
        headSha: liveHead,
      },
      currentRevisionRef: liveHead,
      resolveReviewCycleExhaustionImpl: () => ({
        reviewCycleExhausted: true,
        riskClass: 'low',
      }),
      resolveHeadCloserCommitSuppressionImpl: async () => ({
        suppressed: true,
        reason: 'closer-commit-trailer',
      }),
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
        reason: 'not-eligible',
      }),
      maybeDispatchAmaCloserImpl: async ({ dispatchContext, options }) => {
        seenDispatchContext = dispatchContext;
        seenOptions = options;
        return { dispatched: true, reason: 'closer-took-over' };
      },
    });

    assert.equal(result.dispatched, true);
    assert.equal(seenDispatchContext.reviewedSha, reviewedHead);
    assert.equal(seenDispatchContext.targetRemediationSha, liveHead);
    assert.equal(seenDispatchContext.dispatchRecordHeadSha, reviewedHead);
    assert.equal(seenDispatchContext.dispatchReason, 'exhausted-final-hammer');
    assert.equal(seenDispatchContext.allowStaleReviewHeadHammerResume, true);
    assert.ok(seenOptions, 'closer options are still passed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher retries transient HAM stale-head resume proof errors by failing the tick', async () => {
  const rootDir = tempRoot();
  try {
    const reviewedHead = 'reviewed-head-before-ham';
    const liveHead = 'live-head-after-human-push';
    const args = baseArgs(rootDir);
    let closerCalls = 0;
    await assert.rejects(
      maybeDispatchAmaClosureFor({
        ...args,
        reviewStateRow: {
          ...args.reviewStateRow,
          reviewer_head_sha: reviewedHead,
        },
        candidate: {
          ...args.candidate,
          headSha: liveHead,
        },
        currentRevisionRef: liveHead,
        resolveReviewCycleExhaustionImpl: () => ({
          reviewCycleExhausted: true,
          riskClass: 'low',
        }),
        resolveHeadCloserCommitSuppressionImpl: async () => {
          const err = new Error('TLS handshake timeout');
          err.stderr = 'TLS handshake timeout';
          throw err;
        },
        runDaemonCleanMergeAttemptImpl: async () => ({
          disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
          reason: 'not-eligible',
        }),
        maybeDispatchAmaCloserImpl: async () => {
          closerCalls += 1;
          return { dispatched: true };
        },
      }),
      /TLS handshake timeout/,
    );
    assert.equal(closerCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher fails closed on permanent HAM stale-head resume proof errors', async () => {
  const rootDir = tempRoot();
  try {
    const reviewedHead = 'reviewed-head-before-ham';
    const liveHead = 'live-head-after-human-push';
    const args = baseArgs(rootDir);
    let seenDispatchContext = null;
    const warnings = [];
    const result = await maybeDispatchAmaClosureFor({
      ...args,
      reviewStateRow: {
        ...args.reviewStateRow,
        reviewer_head_sha: reviewedHead,
      },
      candidate: {
        ...args.candidate,
        headSha: liveHead,
      },
      currentRevisionRef: liveHead,
      resolveReviewCycleExhaustionImpl: () => ({
        reviewCycleExhausted: true,
        riskClass: 'low',
      }),
      resolveHeadCloserCommitSuppressionImpl: async () => {
        const err = new Error('HTTP 404 Not Found');
        err.stderr = 'HTTP 404 Not Found';
        throw err;
      },
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
        reason: 'not-eligible',
      }),
      maybeDispatchAmaCloserImpl: async ({ dispatchContext }) => {
        seenDispatchContext = dispatchContext;
        return { dispatched: false, reason: 'not-eligible' };
      },
      logger: { warn: (message) => warnings.push(message), log() {} },
    });

    assert.equal(result.dispatched, false);
    assert.equal(seenDispatchContext.allowStaleReviewHeadHammerResume, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not allowing hammer resume/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon gh merge subprocess is bounded by the shared timeout', async () => {
  const rootDir = tempRoot();
  let capturedOptions = null;
  let capturedAttemptArgs = null;
  try {
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: false,
      },
      repoPath: 'acme/repo',
      prNumber: 300,
      candidate: {
        baseBranch: 'main',
        headSha: 'head-live',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'head-live',
        settledReview: { verdict: 'settled-success' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      reviewStateRow: { reviewer: 'codex' },
      currentPrHeadSha: 'head-live',
      execFileImpl: async (_command, _args, options) => {
        capturedOptions = options;
        return { stdout: '', stderr: '' };
      },
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'head-live',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      acquireMergeLeaseImpl: () => ({
        acquired: true,
        lease: {
          repo: 'acme/repo',
          base: 'main',
          leaseId: 'lease-1',
          holderPr: 300,
          holderHead: 'head-live',
          acquiredAt: '2026-07-05T00:00:00.000Z',
        },
      }),
      releaseMergeLeaseImpl: () => {},
      attemptDaemonCleanMergeImpl: async (attemptArgs) => {
        capturedAttemptArgs = attemptArgs;
        return attemptArgs.runMergeImpl({
        repo: 'acme/repo',
        prNumber: 300,
        head: 'head-live',
        mergeMethod: 'squash',
        });
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: '/tmp/hq' },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(capturedOptions.timeout, DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS);
    assert.deepEqual(capturedAttemptArgs.flags, {
      autonomousMergeExecutionEnabled: true,
      strictMode: false,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
