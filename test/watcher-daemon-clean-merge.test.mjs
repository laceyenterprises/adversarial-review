import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  maybeDispatchAmaClosureFor,
  readHeadAttestationChainForPr,
  runDaemonCleanMergeAttempt,
  resolveDaemonWorkerIdentityForPr,
  resolveDaemonWorkerIdentityFromHeadAttestation,
} from '../src/watcher.mjs';
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

test('daemon clean-park fail-closed emits an operator-visible manual-close signal (LAC-1559)', async () => {
  const rootDir = tempRoot();
  try {
    const logs = [];
    const warns = [];
    let closerCalls = 0;
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      logger: { log: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) },
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
        reason: 'merge-retry-budget-exhausted',
        merged: false,
        attempts: 4,
        // The daemon only takes clean reviews, so a fail-closed park is a
        // zero-finding clean PR that needs a manual close.
        manualCloseRequired: true,
      }),
      maybeDispatchAmaCloserImpl: async () => {
        closerCalls += 1;
        return { dispatched: true };
      },
    });

    // Decision is unchanged: still skip the closer/hammer and the merge-agent.
    assert.equal(closerCalls, 0, 'a daemon fail-closed must NOT spawn a hammer');
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, `daemon-${DAEMON_MERGE_DISPOSITION.FAILED_CLOSED}`);

    // The park is now observable: a structured pageable event plus a human line.
    const parkEvent = logs
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((doc) => doc?.event === 'ama.daemon_clean_park.manual_close_required');
    assert.ok(parkEvent, 'a structured manual-close-required event must be emitted');
    assert.equal(parkEvent.repo, 'acme/repo');
    assert.equal(parkEvent.pr, 300);
    assert.equal(parkEvent.reason, 'merge-retry-budget-exhausted');
    assert.equal(parkEvent.hammerFallback, false);
    assert.match(warns.join('\n'), /manual close required/i);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon fail-closed with findings present does NOT emit the clean-park signal', async () => {
  const rootDir = tempRoot();
  try {
    const logs = [];
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      logger: { log: (m) => logs.push(String(m)), warn() {} },
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
        reason: 'permanent-merge-rejection',
        merged: false,
        attempts: 1,
        // Not a clean park (daemon reported it did not qualify as manual-close).
        manualCloseRequired: false,
      }),
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: true }),
    });

    assert.equal(result.skipMergeAgent, true);
    const parkEvent = logs
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((doc) => doc?.event === 'ama.daemon_clean_park.manual_close_required');
    assert.equal(parkEvent, undefined, 'no clean-park signal when manualCloseRequired is false');
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
      env: { HQ_ROOT: rootDir },
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
        hammerLifetimeDispatchCeiling: 3,
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
      readBuildCompletionSignalForPrImpl: () => ({
        ok: true,
        row: {
          launch_request_id: 'lrq_test_worker',
          worker_class: 'codex',
          head_sha: 'head-live',
        },
      }),
      attemptDaemonCleanMergeImpl: async (attemptArgs) => {
        capturedAttemptArgs = attemptArgs;
        assert.deepEqual(attemptArgs.liveGate.requiredChecks, []);
        const refreshedGate = await attemptArgs.fetchLiveGateImpl();
        assert.deepEqual(refreshedGate.requiredChecks, []);
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
    assert.equal(capturedAttemptArgs.retryCap, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge fail-closes when the head moved past worker build-completion provenance', async () => {
  const rootDir = tempRoot();
  try {
    const readCalls = [];
    let mergeCalls = 0;
    let leaseReleased = false;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 561,
      candidate: {
        baseBranch: 'main',
        headSha: 'head-after-remediation',
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'head-after-remediation',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      reviewStateRow: { reviewer: 'codex' },
      currentPrHeadSha: 'head-after-remediation',
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'head-after-remediation',
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      acquireMergeLeaseImpl: () => ({
        acquired: true,
        lease: {
          repo: 'acme/repo',
          base: 'main',
          leaseId: 'lease-head-after-remediation',
          holderPr: 561,
          holderHead: 'head-after-remediation',
          acquiredAt: '2026-07-11T00:00:00.000Z',
        },
      }),
      releaseMergeLeaseImpl: () => {
        leaseReleased = true;
      },
      readBuildCompletionSignalForPrImpl: (args) => {
        readCalls.push(args);
        assert.equal(args.signalKind, 'pr_opened');
        assert.equal(args.headSha, 'head-after-remediation');
        return { ok: false, reason: 'missing-build-completion-signal' };
      },
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: rootDir },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
    assert.equal(result.merged, false);
    assert.equal(mergeCalls, 0);
    assert.equal(leaseReleased, false, 'identity must fail closed before taking the merge lease');
    assert.deepEqual(
      readCalls.map((call) => call.headSha || null),
      ['head-after-remediation'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge awaits async worker identity reads and preserves zero launch IDs', async () => {
  const rootDir = tempRoot();
  try {
    let mergeAttempted = false;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 562,
      candidate: {
        baseBranch: 'main',
        headSha: 'async-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'async-head',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'async-head',
      readBuildCompletionSignalForPrImpl: async (args) => {
        assert.equal(args.headSha, 'async-head');
        return {
          ok: true,
          row: {
            launch_request_id: 0,
            worker_class: 'codex',
            head_sha: 'async-head',
          },
        };
      },
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'async-head',
        headRefName: 'worker/async-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      attemptDaemonCleanMergeImpl: async () => {
        mergeAttempted = true;
        return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: rootDir },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.equal(result.merged, true);
    assert.equal(mergeAttempted, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge fail-closes when worker LRQ identity cannot be resolved', async () => {
  const rootDir = tempRoot();
  try {
    let leaseCalls = 0;
    let mergeCalls = 0;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 562,
      candidate: {
        baseBranch: 'main',
        headSha: 'session-opened-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'session-opened-head',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'session-opened-head',
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'session-opened-head',
        headRefName: 'operator/session-opened',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      acquireMergeLeaseImpl: () => {
        leaseCalls += 1;
        return { acquired: true, lease: {} };
      },
      releaseMergeLeaseImpl: () => {},
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: '/tmp/hq-root-for-test' },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
    assert.equal(result.reason, 'worker-identity-unresolved');
    assert.equal(result.workerIdentity.reason, 'missing-build-completion-signal');
    assert.equal(leaseCalls, 0, 'unidentified PRs must fail before acquiring a merge lease');
    assert.equal(mergeCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge strict mode declines a PR with a standing blocking finding', async () => {
  const rootDir = tempRoot();
  try {
    let leaseCalls = 0;
    let mergeCalls = 0;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 563,
      candidate: {
        baseBranch: 'main',
        headSha: 'finding-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'finding-head',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 1,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'finding-head',
      readBuildCompletionSignalForPrImpl: () => ({
        ok: true,
        row: {
          launch_request_id: 'lrq_with_finding',
          worker_class: 'codex',
          head_sha: 'finding-head',
        },
      }),
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'finding-head',
        headRefName: 'worker/finding-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      acquireMergeLeaseImpl: () => {
        leaseCalls += 1;
        return { acquired: true, lease: {} };
      },
      releaseMergeLeaseImpl: () => {},
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: '/tmp/hq-root-for-test' },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'blocking-findings-present');
    assert.equal(leaseCalls, 0, 'strict-mode finding refusal must happen before the lease');
    assert.equal(mergeCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge defers when the live PR head moved after the tick snapshot', async () => {
  const rootDir = tempRoot();
  try {
    let identityReads = 0;
    let mergeAttempted = false;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 564,
      candidate: {
        baseBranch: 'main',
        headSha: 'stale-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'stale-head',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'stale-head',
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'live-head',
        headRefName: 'worker/live-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      readBuildCompletionSignalForPrImpl: () => {
        identityReads += 1;
        return { ok: false, reason: 'missing-build-completion-signal' };
      },
      attemptDaemonCleanMergeImpl: async () => {
        mergeAttempted = true;
        return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: rootDir },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.DEFERRED);
    assert.equal(result.reason, 'pr-head-moved');
    assert.equal(result.snapshotHead, 'stale-head');
    assert.equal(result.liveHead, 'live-head');
    assert.equal(identityReads, 0, 'stale heads must not reach worker identity resolution');
    assert.equal(mergeAttempted, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge resolves worker identity from HQ launch provenance when build completion is absent', async () => {
  const rootDir = tempRoot();
  try {
    const workerDir = join(rootDir, 'workers', 'claude-code-hcc-02-14a16b9d');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'launch-provenance.json'),
      JSON.stringify({
        repo: 'acme/repo',
        prRepo: 'acme/repo',
        branch: 'claude-code-hcc-02-14a16b9d/HCC-02',
        launchRequestId: 'lrq_8f7fc45e-3c3b-40f7-907d-9ab83635ed26',
        workerClass: 'claude-code',
        prHeadSha: 'superseded-worker-head',
      }),
    );
    const collisionDir = join(rootDir, 'workers', 'cross-org-collision');
    mkdirSync(collisionDir, { recursive: true });
    const collisionPath = join(collisionDir, 'launch-provenance.json');
    writeFileSync(
      collisionPath,
      JSON.stringify({
        prRepo: 'malicious-org/repo',
        branch: 'claude-code-hcc-02-14a16b9d/HCC-02',
        launchRequestId: 'lrq_wrong_cross_org_identity',
        workerClass: 'codex',
      }),
    );
    const now = new Date();
    utimesSync(join(workerDir, 'launch-provenance.json'), new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000));
    utimesSync(collisionPath, now, now);

    let mergeAttempted = false;
    let capturedIdentity = null;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 3464,
      candidate: {
        baseBranch: 'main',
        headSha: 'live-head-after-force-push',
        headRefName: 'claude-code-hcc-02-14a16b9d/HCC-02',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'live-head-after-force-push',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'live-head-after-force-push',
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'live-head-after-force-push',
        headRefName: 'claude-code-hcc-02-14a16b9d/HCC-02',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
      attemptDaemonCleanMergeImpl: async (attemptArgs) => {
        mergeAttempted = true;
        capturedIdentity = attemptArgs.workerIdentity;
        return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: rootDir },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.equal(mergeAttempted, true);
    assert.equal(capturedIdentity?.resolvedBy, 'launch-provenance');
    assert.equal(capturedIdentity?.launchRequestId, 'lrq_8f7fc45e-3c3b-40f7-907d-9ab83635ed26');
    assert.equal(capturedIdentity?.workerClass, 'claude-code');
    assert.equal(capturedIdentity?.buildCompletionReason, 'missing-build-completion-signal');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon clean merge launch provenance skips missing candidate files without aborting lookup', async () => {
  const rootDir = tempRoot();
  try {
    const staleWorkerDir = join(rootDir, 'workers', 'stale-cleanup-race');
    mkdirSync(staleWorkerDir, { recursive: true });
    const workerDir = join(rootDir, 'workers', 'codex-valid-provenance');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'launch-provenance.json'),
      JSON.stringify({
        prRepo: 'acme/repo',
        branch: 'codex-valid-provenance/LAC-1572',
        launchRequestId: 'lrq_valid_after_missing_candidates',
        workerClass: 'codex',
        prHeadSha: 'live-head',
      }),
    );

    let capturedIdentity = null;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
      },
      repoPath: 'acme/repo',
      prNumber: 1572,
      candidate: {
        baseBranch: 'main',
        headSha: 'live-head',
        headRefName: 'codex-valid-provenance/LAC-1572',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'live-head',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'live-head',
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'live-head',
        headRefName: 'codex-valid-provenance/LAC-1572',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
      attemptDaemonCleanMergeImpl: async (attemptArgs) => {
        capturedIdentity = attemptArgs.workerIdentity;
        return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: rootDir },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.equal(capturedIdentity?.launchRequestId, 'lrq_valid_after_missing_candidates');
    assert.equal(capturedIdentity?.workerClass, 'codex');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveDaemonWorkerIdentityForPr scopes the pr_opened signal to the current head', async () => {
  // 2026-07-11 root cause: the resolver queried signal_kind='merged' (the read
  // adapter default), but an OPEN worker PR only has a 'pr_opened' build-
  // completion row — the 'merged' row is written AFTER merge. So identity never
  // resolved pre-merge and every daemon-clean-merge fail-closed
  // worker-identity-unresolved (#3473/#3476/#3478 all had pr_opened, zero merged).
  const calls = [];
  const mockRead = async (args) => {
    calls.push(args);
    // Emulate the ledger: only the current head has worker provenance.
    if (args.signalKind === 'pr_opened' && args.headSha === 'abc123') {
      return { ok: true, row: { launch_request_id: 'lrq_test', worker_class: 'codex', head_sha: args.headSha } };
    }
    return { ok: false, reason: 'missing-build-completion-signal' };
  };
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3473,
    currentHeadSha: 'abc123',
    hqRoot: '/tmp/hq',
    rootDir: '/tmp/root',
    env: {},
    readBuildCompletionSignalForPrImpl: mockRead,
  });
  assert.equal(result.ok, true, `identity must resolve from the pr_opened signal; got ${JSON.stringify(result)}`);
  assert.equal(result.launchRequestId, 'lrq_test');
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.resolvedBy, 'current-head');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headSha, 'abc123');
  assert.ok(calls.length > 0 && calls.every((c) => c.signalKind === 'pr_opened'),
    `every build-completion read must use signalKind 'pr_opened'; got ${JSON.stringify(calls.map((c) => c.signalKind))}`);
});

test('resolveDaemonWorkerIdentityForPr fails closed when current head is missing', async () => {
  const calls = [];
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'laceyenterprises/agent-os',
    prNumber: 3473,
    currentHeadSha: '   ',
    hqRoot: '/tmp/hq',
    rootDir: '/tmp/root',
    env: {},
    readBuildCompletionSignalForPrImpl: async (args) => {
      calls.push(args);
      return {
        ok: true,
        row: { launch_request_id: 'lrq_stale', worker_class: 'codex', head_sha: 'oldhead' },
      };
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'missing-current-head-sha' });
  assert.equal(calls.length, 0, 'missing current head must not degrade into a PR-level provenance query');
});

test('resolveDaemonWorkerIdentityForPr rejects a moved-head pr_opened row', async () => {
  const seenHeadShas = [];
  let chainReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: "agent-os",
    prNumber: 3491,
    currentHeadSha: "live-head-after-remediation",
    currentBranch: "codex-rrp-06/RRP-06",
    hqRoot: "/tmp/hq-root-nonexistent-daemon-headmove",
    env: {},
    readBuildCompletionSignalForPrImpl: async (args) => {
      seenHeadShas.push(args.headSha);
      assert.equal(args.signalKind, "pr_opened");
      // The opener's identity is not provenance for a later head. An unscoped
      // lookup would find this stale row, so the resolver must never issue one.
      return { ok: false, reason: "missing-build-completion-signal" };
    },
    readHeadAttestationChainForPrImpl: async () => {
      chainReads += 1;
      return [];
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-build-completion-signal');
  assert.deepEqual(seenHeadShas, ['live-head-after-remediation']);
  assert.equal(chainReads, 0, 'flag-off path must not read the attestation chain');
});

test('resolveDaemonWorkerIdentityForPr resolves moved live head from produced attestation when LHA consumption is enabled', async () => {
  let buildCompletionReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head-after-remediation',
    currentBranch: 'codex-lha-05/LHA-05',
    hqRoot: '/tmp/hq-root-unused',
    env: {
      AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_LHA_CONSUME_ATTESTATIONS: 'true',
    },
    readBuildCompletionSignalForPrImpl: async () => {
      buildCompletionReads += 1;
      return { ok: false, reason: 'should-not-read-build-completion-after-attestation-hit' };
    },
    readHeadAttestationChainForPrImpl: async () => [
      {
        valid: true,
        kind: 'produced',
        head_sha: 'open-head-before-remediation',
        parent_head_sha: null,
        producer_identity: 'codex:worker:lha-02',
        payload: { launch_request_id: 'lrq_old', worker_class: 'codex' },
        ts: '2026-07-12T01:00:00Z',
      },
      {
        valid: true,
        kind: 'produced',
        head_sha: 'live-head-after-remediation',
        parent_head_sha: 'open-head-before-remediation',
        producer_identity: 'codex:worker:lha-05',
        payload: { launch_request_id: 'lrq_lha_05', worker_class: 'codex' },
        attestation_id: 'lha_attest_live',
        ts: '2026-07-12T02:00:00Z',
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'head-attestation');
  assert.equal(result.launchRequestId, 'lrq_lha_05');
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.rowHeadSha, 'live-head-after-remediation');
  assert.equal(result.headMovedAfterBuildCompletion, true);
  assert.equal(result.attestationId, 'lha_attest_live');
  assert.equal(buildCompletionReads, 0, 'attested live head should replace reconstruction reads');
});

test('LHA consumption falls back only when the live head has no produced attestation', async () => {
  let buildCompletionReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head',
    consumeHeadAttestations: true,
    readHeadAttestationChainForPrImpl: async () => [],
    readBuildCompletionSignalForPrImpl: async () => {
      buildCompletionReads += 1;
      return {
        ok: true,
        row: {
          launch_request_id: 'lrq_legacy_rollout',
          worker_class: 'codex',
          head_sha: 'live-head',
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolvedBy, 'current-head');
  assert.equal(buildCompletionReads, 1);
});

test('LHA consumption fails closed on chain read errors instead of downgrading', async () => {
  let buildCompletionReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head',
    consumeHeadAttestations: true,
    readHeadAttestationChainForPrImpl: async () => {
      throw Object.assign(new Error('hq attest chain failed'), { code: 'ENOENT' });
    },
    readBuildCompletionSignalForPrImpl: async () => {
      buildCompletionReads += 1;
      return { ok: true, row: {} };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'head-attestation-chain-read-failed');
  assert.equal(buildCompletionReads, 0, 'hard attestation errors must not reach legacy provenance');
});

test('LHA consumption fails closed on malformed produced provenance', async () => {
  let buildCompletionReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head',
    consumeHeadAttestations: true,
    readHeadAttestationChainForPrImpl: async () => [{
      valid: true,
      kind: 'produced',
      head_sha: 'live-head',
      payload: { worker_class: 'codex' },
      ts: '2026-07-12T02:00:00Z',
    }],
    readBuildCompletionSignalForPrImpl: async () => {
      buildCompletionReads += 1;
      return { ok: true, row: {} };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-launch-request-id');
  assert.equal(buildCompletionReads, 0, 'malformed attestations must not reach legacy provenance');
});

test('head attestation resolver rejects a missing current head before reading the chain', async () => {
  let chainReads = 0;
  const result = await resolveDaemonWorkerIdentityFromHeadAttestation({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: '  ',
    readHeadAttestationChainForPrImpl: async () => {
      chainReads += 1;
      return [];
    },
  });

  assert.deepEqual(result, { ok: false, reason: 'missing-current-head-sha' });
  assert.equal(chainReads, 0);
});

test('head attestation chain read retries transient hq failures with bounded backoff', async () => {
  let attempts = 0;
  const delays = [];
  const rows = await readHeadAttestationChainForPr({
    repo: 'agent-os',
    prNumber: 3491,
    retryDelaysMs: [5, 10],
    sleepImpl: async (ms) => delays.push(ms),
    logger: { warn() {} },
    execFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EIO' });
      }
      return { stdout: '[{"kind":"produced"}]' };
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 10]);
  assert.deepEqual(rows, [{ kind: 'produced' }]);
});

test("resolveDaemonWorkerIdentityForPr still fails closed when no pr_opened row exists at any head", async () => {
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: "agent-os",
    prNumber: 9999,
    currentHeadSha: "some-live-head",
    currentBranch: "codex-x/X-01",
    hqRoot: "/tmp/hq-root-nonexistent-daemon-headmove",
    readBuildCompletionSignalForPrImpl: async () => ({ ok: false, reason: "missing-build-completion-signal" }),
  });
  assert.equal(result.ok, false);
});
