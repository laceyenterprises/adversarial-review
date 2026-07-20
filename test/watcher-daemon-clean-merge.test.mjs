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
import { __testables__ as daemonCleanMergeTestables } from '../src/daemon-clean-merge.mjs';

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
        lha: { consumeAttestations: false },
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
        lha: { consumeAttestations: false },
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

test('daemon loads merge-authority config with the adversarial config.yaml module (not shell-env-only)', async () => {
  // Regression for the 2026-07-16 outage: the shell agent_os_config_export
  // mis-resolves nested lha.consume_attestations (emits true even when
  // config.yaml sets false), so the daemon must read merge-authority config
  // from the reviewed config.yaml MODULE, not from the shell env alone.
  const rootDir = tempRoot();
  try {
    let receivedArgs;
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      loadConfigImpl: (args) => { receivedArgs = args; return loadAmaEnabledConfig(); },
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.MERGED,
        reason: 'merged',
        merged: true,
        attempts: 1,
      }),
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: true }),
    });

    assert.ok(receivedArgs?.modulePaths?.length, 'loadConfigImpl must be called with modulePaths');
    assert.ok(
      receivedArgs.modulePaths.some((p) => String(p).endsWith('/config.yaml')),
      'modulePaths must include the adversarial config.yaml module',
    );
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

test('daemon clean merge resolves worker identity via head-independent pr_opened retry when the head moved', async () => {
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
        // The single pr_opened row is pinned to the OPEN head, so the strict
        // current-head read misses after remediation; the head-independent
        // retry (headSha null) recovers the worker identity.
        if (args.headSha === 'head-after-remediation') {
          return { ok: false, reason: 'missing-build-completion-signal' };
        }
        return {
          ok: true,
          row: { launch_request_id: 'lrq-opener', worker_class: 'codex', head_sha: 'head-at-open' },
        };
      },
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
      logger: { warn() {}, log() {} },
      env: { HQ_ROOT: rootDir },
    });

    assert.notEqual(
      result.reason,
      'worker-identity-unresolved',
      'a moved head must resolve identity from the head-independent pr_opened row, not fail closed',
    );
    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.equal(result.merged, true);
    assert.ok(mergeCalls >= 1, 'the merge proceeds once identity resolves');
    assert.equal(leaseReleased, true);
    assert.deepEqual(
      readCalls.map((call) => call.headSha ?? null),
      ['head-after-remediation', null],
      'strict current-head read first, then the head-independent retry',
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveDaemonWorkerIdentityForPr surfaces a failed head-independent retry', async () => {
  const readCalls = [];
  const identity = await resolveDaemonWorkerIdentityForPr({
    repo: 'acme/repo',
    prNumber: 561,
    currentHeadSha: 'head-after-remediation',
    currentBranch: 'feature',
    hqRoot: '/nonexistent-hq-root',
    rootDir: '/nonexistent-root',
    env: {},
    consumeHeadAttestations: false,
    readBuildCompletionSignalForPrImpl: (args) => {
      readCalls.push(args.headSha ?? null);
      if (args.headSha === 'head-after-remediation') {
        return { ok: false, reason: 'missing-build-completion-signal' };
      }
      throw new Error('database unavailable');
    },
  });
  assert.deepEqual(identity, {
    ok: false,
    reason: 'build-completion-read-failed',
    error: 'database unavailable',
  });
  assert.deepEqual(readCalls, ['head-after-remediation', null]);
});

test('resolveDaemonWorkerIdentityForPr resolves a moved head from the head-independent pr_opened row', async () => {
  const readCalls = [];
  const identity = await resolveDaemonWorkerIdentityForPr({
    repo: 'acme/repo',
    prNumber: 561,
    currentHeadSha: 'head-after-remediation',
    currentBranch: 'feature',
    hqRoot: '/nonexistent-hq-root',
    rootDir: '/nonexistent-root',
    env: {},
    consumeHeadAttestations: false,
    readBuildCompletionSignalForPrImpl: (args) => {
      readCalls.push(args.headSha ?? null);
      if (args.headSha === 'head-after-remediation') {
        return { ok: false, reason: 'missing-build-completion-signal' };
      }
      return {
        ok: true,
        row: { launch_request_id: 'lrq-opener', worker_class: 'codex', head_sha: 'head-at-open' },
      };
    },
  });
  assert.equal(identity.ok, true);
  assert.equal(identity.launchRequestId, 'lrq-opener');
  assert.equal(identity.workerClass, 'codex');
  assert.equal(identity.resolvedBy, 'pr-opened-head-moved');
  assert.equal(identity.headMovedAfterBuildCompletion, true);
  assert.deepEqual(readCalls, ['head-after-remediation', null]);
});

test('resolveDaemonWorkerIdentityForPr keeps the current-head fast path when the head has not moved', async () => {
  const readCalls = [];
  const identity = await resolveDaemonWorkerIdentityForPr({
    repo: 'acme/repo',
    prNumber: 562,
    currentHeadSha: 'head-at-open',
    currentBranch: 'feature',
    hqRoot: '/nonexistent-hq-root',
    rootDir: '/nonexistent-root',
    env: {},
    consumeHeadAttestations: false,
    readBuildCompletionSignalForPrImpl: (args) => {
      readCalls.push(args.headSha ?? null);
      return {
        ok: true,
        row: { launch_request_id: 'lrq-opener', worker_class: 'codex', head_sha: 'head-at-open' },
      };
    },
  });
  assert.equal(identity.ok, true);
  assert.equal(identity.resolvedBy, 'current-head');
  assert.equal(identity.headMovedAfterBuildCompletion, false);
  assert.deepEqual(readCalls, ['head-at-open'], 'no head-independent retry when the strict read resolves');
});

test('daemon clean merge with LHA enforcement blocks missing produced attestation at live head', async () => {
  const rootDir = tempRoot();
  try {
    let buildCompletionReads = 0;
    let mergeCalls = 0;
    let leaseCalls = 0;
    const result = await runDaemonCleanMergeAttempt({
      rootDir,
      cfg: {
        mergeMethod: 'squash',
        autonomousMergeExecutionEnabled: true,
        strictMode: true,
        lha: { consumeAttestations: true },
      },
      repoPath: 'acme/repo',
      prNumber: 563,
      candidate: {
        baseBranch: 'main',
        headSha: 'lha-live-head',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        prState: 'open',
      },
      gateSnapshot: {
        reviewedHeadSha: 'lha-live-head',
        settledReview: { verdict: 'comment-only' },
      },
      mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
      reviewState: {
        blockingFindingCount: 0,
        blockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        nonBlockingFindingState: 'known',
      },
      currentPrHeadSha: 'lha-live-head',
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headSha: 'lha-live-head',
        headRefName: 'codex-lha-06/LHA-06',
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      readHeadAttestationChainForPrImpl: async () => [],
      readBuildCompletionSignalForPrImpl: async () => {
        buildCompletionReads += 1;
        return {
          ok: true,
          row: {
            launch_request_id: 'lrq_branch_only_guess',
            worker_class: 'codex',
            head_sha: 'lha-live-head',
          },
        };
      },
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
      env: { HQ_ROOT: rootDir },
    });

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
    assert.equal(result.reason, 'worker-identity-unresolved');
    assert.equal(result.workerIdentity.reason, 'missing-produced-head-attestation');
    assert.equal(buildCompletionReads, 0, 'LHA enforcement must not fall back to pr_opened reconstruction');
    assert.equal(leaseCalls, 0, 'missing attestation must block before acquiring a merge lease');
    assert.equal(mergeCalls, 0);
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
        prNumber: 3464,
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
        prRepo: 'acme/repo',
        prNumber: 9999,
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
        prNumber: 1572,
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

test('resolveDaemonWorkerIdentityForPr resolves identity from launch provenance in the CANONICAL hq shape (short-form repo, no prNumber) when the pr_opened row is absent', async () => {
  // Regression for the systemic worker-identity-unresolved park (2026-07-19).
  // hq writes launch-provenance `repo`/`prRepo` in SHORT form (`agent-os`) and
  // omits `prNumber` for ~95% of records, but the daemon resolves identity with
  // the FULL `<owner>/<name>` form it reads from the live GitHub rollup. The old
  // matcher required an exact repo-string match AND a prNumber match, so it
  // matched ZERO real records — the fallback was dead, and every dispatched-worker
  // PR whose pr_opened ledger row had not yet landed parked fail-closed each tick.
  const rootDir = tempRoot();
  try {
    const workerDir = join(rootDir, 'workers', 'codex-shw-05');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'launch-provenance.json'),
      JSON.stringify({
        repo: 'agent-os',
        prRepo: 'agent-os',
        branch: 'codex-shw-05/SHW-05',
        launchRequestId: 'lrq_fdf9602a-60d2-4c5f-af77-bbb7bb6db2ab',
        workerClass: 'codex',
        prHeadSha: 'head-at-dispatch',
      }),
    );
    const identity = await resolveDaemonWorkerIdentityForPr({
      repo: 'laceyenterprises/agent-os',
      prNumber: 4011,
      currentHeadSha: 'live-head-after-remediation',
      currentBranch: 'codex-shw-05/SHW-05',
      hqRoot: rootDir,
      rootDir: '/nonexistent-root',
      env: {},
      consumeHeadAttestations: false,
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    });
    assert.equal(identity.ok, true);
    assert.equal(identity.resolvedBy, 'launch-provenance');
    assert.equal(identity.launchRequestId, 'lrq_fdf9602a-60d2-4c5f-af77-bbb7bb6db2ab');
    assert.equal(identity.workerClass, 'codex');
    assert.equal(identity.buildCompletionReason, 'missing-build-completion-signal');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveDaemonWorkerIdentityForPr still fails closed for a PR whose live branch matches NO launch provenance (operator-opened PR — security preserved)', async () => {
  // A dispatched worker for a DIFFERENT branch exists on disk, but the PR under
  // evaluation was opened by hand on a branch no worker was dispatched to build.
  // Identity must NOT resolve: the gate exists so every autonomous merge is
  // attributable to a launching worker. The repo/prNumber relaxations must not
  // manufacture identity for an unattributable PR.
  const rootDir = tempRoot();
  try {
    const workerDir = join(rootDir, 'workers', 'codex-shw-05');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'launch-provenance.json'),
      JSON.stringify({
        repo: 'agent-os',
        branch: 'codex-shw-05/SHW-05',
        launchRequestId: 'lrq_dispatched_worker',
        workerClass: 'codex',
      }),
    );
    const identity = await resolveDaemonWorkerIdentityForPr({
      repo: 'laceyenterprises/agent-os',
      prNumber: 4012,
      currentHeadSha: 'live-head',
      currentBranch: 'claude-code/op-read-reject-empty-live',
      hqRoot: rootDir,
      rootDir: '/nonexistent-root',
      env: {},
      consumeHeadAttestations: false,
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    });
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'missing-build-completion-signal');
    assert.equal(identity.launchProvenanceReason, 'missing-launch-provenance');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveDaemonWorkerIdentityForPr skips a launch-provenance record explicitly tagged to a DIFFERENT pr number even when repo+branch match (no cross-PR misattribution)', async () => {
  const rootDir = tempRoot();
  try {
    const workerDir = join(rootDir, 'workers', 'codex-shw-05');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'launch-provenance.json'),
      JSON.stringify({
        repo: 'agent-os',
        branch: 'codex-shw-05/SHW-05',
        prNumber: 9999,
        launchRequestId: 'lrq_other_pr',
        workerClass: 'codex',
      }),
    );
    const identity = await resolveDaemonWorkerIdentityForPr({
      repo: 'laceyenterprises/agent-os',
      prNumber: 4011,
      currentHeadSha: 'live-head',
      currentBranch: 'codex-shw-05/SHW-05',
      hqRoot: rootDir,
      rootDir: '/nonexistent-root',
      env: {},
      consumeHeadAttestations: false,
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    });
    assert.equal(identity.ok, false);
    assert.equal(identity.launchProvenanceReason, 'missing-launch-provenance');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveDaemonWorkerIdentityForPr repo-form bridge cannot cross repositories (short-form name must be the owner/name segment)', async () => {
  // Provenance for a worker in a DIFFERENT repo that happens to share the branch
  // name must never be attributed to an agent-os PR. The short<->full bridge only
  // accepts `<name>` == the `<owner>/<name>` name segment, never a foreign name.
  const rootDir = tempRoot();
  try {
    const workerDir = join(rootDir, 'workers', 'codex-shared-branch');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(
      join(workerDir, 'launch-provenance.json'),
      JSON.stringify({
        repo: 'adversarial-review',
        branch: 'codex-shared/SHARED',
        launchRequestId: 'lrq_other_repo',
        workerClass: 'codex',
      }),
    );
    const identity = await resolveDaemonWorkerIdentityForPr({
      repo: 'laceyenterprises/agent-os',
      prNumber: 4011,
      currentHeadSha: 'live-head',
      currentBranch: 'codex-shared/SHARED',
      hqRoot: rootDir,
      rootDir: '/nonexistent-root',
      env: {},
      consumeHeadAttestations: false,
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    });
    assert.equal(identity.ok, false);
    assert.equal(identity.launchProvenanceReason, 'missing-launch-provenance');
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
    consumeHeadAttestations: false,
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

test('resolveDaemonWorkerIdentityForPr fails closed only when no pr_opened row exists at any head', async () => {
  const seenHeadShas = [];
  let chainReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: "agent-os",
    prNumber: 3491,
    currentHeadSha: "live-head-after-remediation",
    currentBranch: "codex-rrp-06/RRP-06",
    hqRoot: "/tmp/hq-root-nonexistent-daemon-headmove",
    env: {},
    consumeHeadAttestations: false,
    readBuildCompletionSignalForPrImpl: async (args) => {
      seenHeadShas.push(args.headSha ?? null);
      assert.equal(args.signalKind, "pr_opened");
      // Identity is a stable property of PR origin (WHICH worker opened it), so
      // the resolver first reads the current-head row, then retries head-independent
      // when the head moved. Authorization of the moved head is enforced downstream
      // (verdict pinned to commit_id===head, CI-green, LHA), NOT by refusing identity.
      // Here NO pr_opened row exists at any head → genuinely unresolved → fail closed.
      return { ok: false, reason: "missing-build-completion-signal" };
    },
    readHeadAttestationChainForPrImpl: async () => {
      chainReads += 1;
      return [];
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-build-completion-signal');
  assert.deepEqual(seenHeadShas, ['live-head-after-remediation', null], 'strict current-head read, then the head-independent retry');
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
    env: {},
    // LHA-06 remediation: consumption is enabled by the explicitly-resolved
    // config flag that callers pass from the canonical AgentOSConfig (which
    // honors YAML rollback), NOT a raw env var read inside the resolver.
    consumeHeadAttestations: true,
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

test('LHA enforcement blocks when the live head has no produced attestation', async () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-produced-head-attestation');
  assert.equal(buildCompletionReads, 0, 'LHA enforcement must not reach legacy provenance');
});

test('rollback flag restores current-head build-completion fallback when produced attestation is absent', async () => {
  let buildCompletionReads = 0;
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head',
    consumeHeadAttestations: false,
    readHeadAttestationChainForPrImpl: async () => {
      throw new Error('rollback must not read attestations');
    },
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

test('LHA consumption degrades to pr_opened on an attestation-INFRA (chain read) failure', async () => {
  // HAMMER-CLOSE-MODEL (2026-07-16): an unprovisioned/short LHA HMAC key makes
  // `hq attest chain` raise HCPHeadAttestationConfigurationError -> the chain
  // read fails. Previously that parked the PR worker-identity-unresolved and
  // zeroed autonomous merge fleet-wide (2026-07-15). It must now DEGRADE to the
  // pr_opened ledger identity so the PR still lands, stamped + logged.
  let buildCompletionReads = 0;
  const warnings = [];
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head',
    consumeHeadAttestations: true,
    logger: { warn: (m) => warnings.push(String(m)), log() {} },
    readHeadAttestationChainForPrImpl: async () => {
      throw Object.assign(new Error('hq attest chain failed'), { code: 'ENOENT' });
    },
    readBuildCompletionSignalForPrImpl: async () => {
      buildCompletionReads += 1;
      return {
        ok: true,
        row: {
          launch_request_id: 'lrq_degrade_recover',
          worker_class: 'codex',
          head_sha: 'live-head',
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.launchRequestId, 'lrq_degrade_recover');
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.attestationDegraded, true);
  assert.equal(result.attestationDegradeReason, 'head-attestation-chain-read-failed');
  assert.equal(buildCompletionReads, 1, 'an attestation-infra failure MUST reach the pr_opened path');
  assert.match(warnings.join('\n'), /attestation_degraded_to_pr_opened/);
});

test('LHA infra degrade cannot manufacture identity: fails closed (stamped) when no pr_opened row exists', async () => {
  // The degrade is not a bypass. With the attestation layer down AND no ledger
  // row, the resolver still fails closed — but records the degrade attempt so a
  // systemic version is observable (GPR-01 Sentinel aggregates the reason).
  const result = await resolveDaemonWorkerIdentityForPr({
    repo: 'agent-os',
    prNumber: 3491,
    currentHeadSha: 'live-head',
    currentBranch: '', // launch-provenance short-circuits on empty branch (hermetic)
    consumeHeadAttestations: true,
    logger: { warn() {}, log() {} },
    readHeadAttestationChainForPrImpl: async () => {
      throw Object.assign(new Error('hq attest chain failed'), { code: 'ENOENT' });
    },
    readBuildCompletionSignalForPrImpl: async () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.attestationDegraded, true);
  assert.equal(result.attestationDegradeReason, 'head-attestation-chain-read-failed');
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
    consumeHeadAttestations: false,
    readBuildCompletionSignalForPrImpl: async () => ({ ok: false, reason: "missing-build-completion-signal" }),
  });
  assert.equal(result.ok, false);
});

// ── DCA-01: `fetchPullRequestRollup` field-contract regression ───────────────
// `fetchPullRequestRollup` (src/github-api.mjs) normalizes checks onto `checks`
// and the head onto `headRefOid` — NOT `statusCheckRollup`/`headSha`. The daemon
// clean-route used to read `rollup.statusCheckRollup`, which was always
// `undefined` → an empty required-checks array → a spurious `ci-not-green` that
// parked EVERY zero-finding clean PR on the in-loop re-fetch. These tests pin
// the real fetch contract so the field name cannot silently drift again.

function realRollupHelpers({ rootDir, prNumber = 700, head = 'clean-head' }) {
  return {
    rootDir,
    cfg: {
      mergeMethod: 'squash',
      autonomousMergeExecutionEnabled: true,
      strictMode: true,
    },
    repoPath: 'acme/repo',
    prNumber,
    // The watcher candidate snapshot uses the raw `gh pr view --json
    // statusCheckRollup` name and is deliberately EMPTY here, so the pre-lease
    // gate cannot pass by falling back to a candidate green rollup — the fix
    // must resolve greenness from the live `checks` field itself.
    candidate: {
      baseBranch: 'main',
      headSha: head,
      statusCheckRollup: [],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      prState: 'open',
    },
    gateSnapshot: {
      reviewedHeadSha: head,
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
    currentPrHeadSha: head,
    acquireMergeLeaseImpl: () => ({
      acquired: true,
      lease: {
        repo: 'acme/repo',
        base: 'main',
        leaseId: `lease-${prNumber}`,
        holderPr: prNumber,
        holderHead: head,
        acquiredAt: '2026-07-19T00:00:00.000Z',
      },
    }),
    releaseMergeLeaseImpl: () => {},
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: { launch_request_id: 'lrq-clean', worker_class: 'codex', head_sha: head },
    }),
    logger: { warn() {}, log() {} },
    env: { HQ_ROOT: rootDir },
  };
}

test('DCA-01: clean PR with real-contract `checks` rollup now MERGES (was parked ci-not-green)', async () => {
  const rootDir = tempRoot();
  let mergeCalls = 0;
  try {
    const result = await runDaemonCleanMergeAttempt({
      ...realRollupHelpers({ rootDir, prNumber: 700, head: 'clean-head' }),
      // The authentic fetchPullRequestRollup contract: `checks` + `headRefOid`,
      // NO `statusCheckRollup`, NO `headSha`. Pre-fix this read as zero checks.
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headRefOid: 'clean-head',
        checks: [
          { name: 'repo-guards', conclusion: 'SUCCESS' },
          { name: 'shellcheck', conclusion: 'SUCCESS' },
        ],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.equal(result.merged, true);
    assert.ok(mergeCalls >= 1, 'the merge button is actually clicked once eligible');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DCA-01: a check that goes RED between pre-lease and the in-loop re-fetch parks (never merges) with ci-not-green + surfaced reasons', async () => {
  const rootDir = tempRoot();
  let mergeCalls = 0;
  let fetchCalls = 0;
  try {
    const result = await runDaemonCleanMergeAttempt({
      ...realRollupHelpers({ rootDir, prNumber: 701, head: 'flip-head' }),
      // Green on the first (pre-lease) fetch, red on the in-loop re-read — the
      // exact production park shape (in-loop `gate-not-eligible`).
      fetchRollupImpl: async () => {
        fetchCalls += 1;
        const conclusion = fetchCalls === 1 ? 'SUCCESS' : 'FAILURE';
        return {
          state: 'OPEN',
          headRefOid: 'flip-head',
          checks: [{ name: 'repo-guards', conclusion }],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
        };
      },
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(result.merged, false, 'a red gate must NEVER merge');
    assert.equal(mergeCalls, 0, 'the merge button is never clicked on a red gate');
    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
    assert.equal(result.reason, 'gate-not-eligible');
    assert.equal(result.manualCloseRequired, true, 'a zero-finding clean park needs a manual-close signal');
    assert.deepEqual(result.reasons, ['ci-not-green'], 'the exact tripping gate is surfaced on the result');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('DCA-01: a live rollup with ZERO checks never merges (LAC-1559 empty-rollup invariant preserved)', async () => {
  const rootDir = tempRoot();
  let mergeCalls = 0;
  try {
    const result = await runDaemonCleanMergeAttempt({
      ...realRollupHelpers({ rootDir, prNumber: 702, head: 'nocheck-head' }),
      fetchRollupImpl: async () => ({
        state: 'OPEN',
        headRefOid: 'nocheck-head',
        checks: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(result.merged, false, 'no checks reported is not green — must not merge');
    assert.equal(mergeCalls, 0, 'the merge button is never clicked with zero checks');
    // Empty live checks are caught at the pre-lease gate (declines cleanly to the
    // hammer route) rather than reaching the in-loop park.
    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'not-eligible');
    assert.deepEqual(result.reasons, ['ci-not-green']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('resolveRollupRequiredChecks prefers `checks`, falls back to `statusCheckRollup`, and returns null when neither is present', () => {
  const { resolveRollupRequiredChecks } = daemonCleanMergeTestables;
  const checks = [{ name: 'ci', conclusion: 'SUCCESS' }];
  const legacy = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  // Authentic fetchPullRequestRollup contract wins.
  assert.strictEqual(resolveRollupRequiredChecks({ checks }), checks);
  // An empty live `checks` array is returned as-is (never masked) so an empty
  // live head reads NOT green.
  const empty = [];
  assert.strictEqual(resolveRollupRequiredChecks({ checks: empty }), empty);
  // `checks` wins even when a legacy field is also present.
  assert.strictEqual(resolveRollupRequiredChecks({ checks, statusCheckRollup: legacy }), checks);
  // Back-compat: snapshot/mocks that only carry the raw name still resolve.
  assert.strictEqual(resolveRollupRequiredChecks({ statusCheckRollup: legacy }), legacy);
  // Neither field present → null so the caller applies its own default.
  assert.strictEqual(resolveRollupRequiredChecks({}), null);
  assert.strictEqual(resolveRollupRequiredChecks(null), null);
});

test('DCA-01: watcher park event + warn line surface the tripping gate reasons[]', async () => {
  const rootDir = tempRoot();
  try {
    const logs = [];
    const warns = [];
    await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      logger: { log: (m) => logs.push(String(m)), warn: (m) => warns.push(String(m)) },
      runDaemonCleanMergeAttemptImpl: async () => ({
        disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
        reason: 'gate-not-eligible',
        merged: false,
        attempts: 1,
        manualCloseRequired: true,
        reasons: ['ci-not-green'],
      }),
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: true }),
    });

    const parkEvent = logs
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((doc) => doc?.event === 'ama.daemon_clean_park.manual_close_required');
    assert.ok(parkEvent, 'a structured manual-close-required event must be emitted');
    assert.deepEqual(parkEvent.reasons, ['ci-not-green'], 'the exact gate reasons[] are in the pageable event');
    assert.equal(parkEvent.reason, 'gate-not-eligible');
    assert.match(warns.join('\n'), /gates=ci-not-green/, 'the human park line names the tripping gate');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
