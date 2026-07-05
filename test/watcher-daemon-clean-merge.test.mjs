import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaClosureFor } from '../src/watcher.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';

// Integration test for the MSM-03 wiring seam in `maybeDispatchAmaClosureFor`:
// the daemon clean-merge attempt runs BEFORE the AMA closer dispatch, and any
// disposition other than `not-taken` short-circuits (no closer/hammer spawn).

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'watcher-daemon-clean-merge-'));
}

function loadAmaEnabledConfig() {
  return {
    getMergeAuthorityConfig() {
      return { enabled: true, mergeMethod: 'squash' };
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
      review_body: '## Verdict\n\nComment only',
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
