import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STUCK_REREVIEW_APPLY_ENABLED_ENV,
  runFollowUpDaemonIteration,
  resolveStuckRereviewApplyEnabled,
} from '../scripts/adversarial-follow-up-daemon.mjs';

// The `stuck-rereview-apply` tick step is the only part of the follow-up daemon
// tick that writes review-pipeline state on behalf of a stuck row. Every other
// comparably autonomous behavior in this pipeline (merge authority, strict
// mode) is arming-gated; this pins that the watchdog step has a sub-minute
// disarm too, and that the disarm is opt-in rather than a footgun that silently
// turns the watchdog off.

test('stuck-rereview watchdog step is armed by default', () => {
  assert.equal(resolveStuckRereviewApplyEnabled({}), true);
  assert.equal(resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: '' }), true);
  assert.equal(resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: '   ' }), true);
  assert.equal(resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: undefined }), true);
  assert.equal(resolveStuckRereviewApplyEnabled(undefined), true);
});

test('stuck-rereview watchdog step disarms on the documented falsey values', () => {
  for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
    assert.equal(
      resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: value }),
      false,
      `expected ${JSON.stringify(value)} to disarm the watchdog step`
    );
  }
});

test('stuck-rereview watchdog step stays armed for truthy and unrecognized values', () => {
  for (const value of ['1', 'true', 'yes', 'on', 'enabled', 'maybe']) {
    assert.equal(
      resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: value }),
      true,
      `expected ${JSON.stringify(value)} to leave the watchdog step armed`
    );
  }
});

test('kill switch env var name is stable', () => {
  assert.equal(STUCK_REREVIEW_APPLY_ENABLED_ENV, 'ADVERSARIAL_STUCK_REREVIEW_APPLY_ENABLED');
});

test('follow-up daemon iteration disarms stuck-rereview apply through injected env', async () => {
  const calls = [];

  await runFollowUpDaemonIteration({
    env: { [STUCK_REREVIEW_APPLY_ENABLED_ENV]: '0' },
    refreshFollowUpGithubTokenImpl: async () => {
      calls.push('github-token-refresh');
    },
    refreshReviewerBrokerTokensImpl: async () => ({ handoffSafe: [] }),
    reconcileInProgressFollowUpJobsImpl: async () => {
      calls.push('reconcile');
    },
    emitHeartbeatsForActiveJobsImpl: () => {
      calls.push('heartbeat');
      return { scanned: 0, touched: 0, skipped: 0 };
    },
    sweepStuckInProgressClaimsImpl: () => {
      calls.push('stale-claim-sweep');
      return {
        scanned: 0,
        reclaimed: 0,
        skipped: 0,
        thresholdMs: 1,
        signalled: 0,
        signalFailed: 0,
        signalSkipped: 0,
      };
    },
    reapFinishedPrFollowUpJobsImpl: () => {
      calls.push('reap-finished-pr');
      return {
        scanned: 0,
        reaped: 0,
        released: 0,
        amaScanned: 0,
        amaReleased: 0,
        skippedOpen: 0,
        skippedUnreadable: 0,
        skippedAliveWorker: 0,
        skippedFreshAmaDispatch: 0,
        skippedNoTarget: 0,
        skippedCapped: 0,
        prLookups: 0,
        lookupCapHit: false,
        reapedPrs: [],
        releasedPrs: [],
        amaReleasedPrs: [],
      };
    },
    diagnoseStuckRereviewImpl: () => {
      throw new Error('stuck-rereview apply should be skipped');
    },
    resolveMaxConcurrentJobsImpl: () => 1,
    writeConfigSignatureStatusImpl: () => null,
    consumeFollowUpJobsUntilCapacityImpl: async () => {
      calls.push('consume');
      return {
        maxConcurrent: 1,
        activeAtStart: 0,
        availableAtStart: 0,
        spawned: 0,
        stopped: 0,
        deferredSamePR: 0,
        capacityRemaining: 1,
      };
    },
    reapCloserHammerWorktreesImpl: async () => {
      calls.push('closer-worktree-reap');
      return {
        scanned: 0,
        reaped: 0,
        skipped: 0,
        terminal: 0,
        prunable: 0,
        halfRegistered: 0,
        open: 0,
        unknown: 0,
        deferredActiveWorker: 0,
        errors: 0,
        limit: 0,
      };
    },
    retryFailedCommentDeliveriesImpl: () => {
      calls.push('retry-comments');
    },
    runStoppedArchiveSweepIfDueImpl: async () => {
      calls.push('maintenance-sweep');
    },
    shouldStop: () => false,
  });

  assert.ok(calls.includes('reap-finished-pr'));
  assert.ok(calls.includes('consume'));
});
