import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS,
  REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS_ENV,
  normalizeMaintenanceSweepState,
  readMaintenanceSweepState,
  runFollowUpDaemonIteration,
  resolveRemediationWorkerTokenMinLifetimeMs,
  resolveTelemetryListenerStartTimeoutMs,
  reviewerTokenHandoffUnsafeRoles,
  runStoppedArchiveSweepIfDue,
  shouldConsumeAfterReviewerTokenRefresh,
  sleepForNextFollowUpDaemonIteration,
  startFollowUpTelemetryListener,
  writeMaintenanceSweepState,
} from '../scripts/adversarial-follow-up-daemon.mjs';
import { createHandoffRateLimiter, HANDOFF_RATE_CAP_AUDIT_EVENT } from '../src/handoff-rate-cap.mjs';

function makeTempDir(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('maintenance sweep state round-trips through the persisted restart cursor', (t) => {
  const rootDir = makeTempDir(t);
  const statePath = path.join(rootDir, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');
  const lastArchiveStoppedSweepMs = Date.parse('2026-06-03T12:00:00.000Z');
  const lastReapTerminalWorkspacesSweepMs = Date.parse('2026-06-03T12:05:00.000Z');

  assert.equal(writeMaintenanceSweepState({
    lastArchiveStoppedSweepMs,
    lastArchiveStoppedSweepAt: '2026-06-03T12:00:00.000Z',
    lastReapTerminalWorkspacesSweepMs,
    lastReapTerminalWorkspacesSweepAt: '2026-06-03T12:05:00.000Z',
  }, statePath), true);

  assert.deepEqual(readMaintenanceSweepState(statePath), {
    lastArchiveStoppedSweepMs,
    lastArchiveStoppedSweepAt: '2026-06-03T12:00:00.000Z',
    lastReapTerminalWorkspacesSweepMs,
    lastReapTerminalWorkspacesSweepAt: '2026-06-03T12:05:00.000Z',
  });
  assert.equal(
    normalizeMaintenanceSweepState(readMaintenanceSweepState(statePath)).lastArchiveStoppedSweepMs,
    lastArchiveStoppedSweepMs,
  );
  assert.match(readFileSync(statePath, 'utf8'), /lastArchiveStoppedSweepMs/);
});

test('maintenance sweep state migrates the legacy single cursor for both split steps', () => {
  const legacySweepMs = Date.parse('2026-06-03T12:00:00.000Z');

  assert.deepEqual(normalizeMaintenanceSweepState({
    lastStoppedArchiveSweepMs: legacySweepMs,
    lastStoppedArchiveSweepAt: '2026-06-03T12:00:00.000Z',
  }), {
    lastStoppedArchiveSweepMs: legacySweepMs,
    lastStoppedArchiveSweepAt: '2026-06-03T12:00:00.000Z',
    lastArchiveStoppedSweepMs: legacySweepMs,
    lastReapTerminalWorkspacesSweepMs: legacySweepMs,
    lastArchiveStoppedSweepFailedMs: 0,
    lastReapTerminalWorkspacesSweepFailedMs: 0,
  });
});

test('maintenance sweep state returns false when persistence fails', (t) => {
  const rootDir = makeTempDir(t);

  assert.equal(writeMaintenanceSweepState({
    lastArchiveStoppedSweepMs: Date.parse('2026-06-03T12:00:00.000Z'),
  }, rootDir), false);
});

test('maintenance sweep state falls back to zero when the persisted cursor is unreadable', (t) => {
  const rootDir = makeTempDir(t);
  const statePath = path.join(rootDir, 'maintenance-sweeps.json');
  writeFileSync(statePath, '{not-json}\n', 'utf8');

  assert.deepEqual(readMaintenanceSweepState(statePath), {});
  assert.equal(
    normalizeMaintenanceSweepState(readMaintenanceSweepState(statePath)).lastArchiveStoppedSweepMs,
    0,
  );
});

test('maintenance sweep cursors are persisted after archive and reap complete', async (t) => {
  const rootDir = makeTempDir(t);
  const statePath = path.join(rootDir, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');
  const nowMs = Date.parse('2026-06-03T13:00:00.000Z');
  const calls = { archive: 0, reap: 0 };

  await runStoppedArchiveSweepIfDue({
    nowMs,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 1, skipped: 0, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      return {
        scanned: 1,
        reaped: 1,
        skipped: 0,
        missingTerminalJob: 0,
        missingTerminalTimestamp: 0,
        missingTerminalTimestampPaths: [],
        recentTerminalJob: 0,
        unreadableJobRecords: 0,
        errors: 0,
      };
    },
  });

  assert.deepEqual(calls, { archive: 1, reap: 1 });
  assert.deepEqual(readMaintenanceSweepState(statePath), {
    lastArchiveStoppedSweepMs: nowMs,
    lastArchiveStoppedSweepAt: '2026-06-03T13:00:00.000Z',
    lastReapTerminalWorkspacesSweepMs: nowMs,
    lastReapTerminalWorkspacesSweepAt: '2026-06-03T13:00:00.000Z',
  });

  await runStoppedArchiveSweepIfDue({
    nowMs: nowMs + 1000,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 0, skipped: 1, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      return {
        scanned: 1,
        reaped: 0,
        skipped: 1,
        missingTerminalJob: 0,
        missingTerminalTimestamp: 0,
        missingTerminalTimestampPaths: [],
        recentTerminalJob: 1,
        unreadableJobRecords: 0,
        errors: 0,
      };
    },
  });
  assert.deepEqual(calls, { archive: 1, reap: 1 });
});

test('maintenance sweep cursors advance independently and throttle failed reap retries', async (t) => {
  const rootDir = makeTempDir(t);
  const statePath = path.join(rootDir, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');
  const nowMs = Date.parse('2026-06-03T14:00:00.000Z');
  const calls = { archive: 0, reap: 0 };

  await runStoppedArchiveSweepIfDue({
    nowMs,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 1, skipped: 0, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      throw new Error('workspace root unavailable');
    },
  });

  assert.deepEqual(calls, { archive: 1, reap: 1 });
  assert.deepEqual(readMaintenanceSweepState(statePath), {
    lastArchiveStoppedSweepMs: nowMs,
    lastArchiveStoppedSweepAt: '2026-06-03T14:00:00.000Z',
    lastReapTerminalWorkspacesSweepFailedMs: nowMs,
    lastReapTerminalWorkspacesSweepFailedAt: '2026-06-03T14:00:00.000Z',
  });

  await runStoppedArchiveSweepIfDue({
    nowMs: nowMs + 1000,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 0, skipped: 1, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      return {
        scanned: 1,
        reaped: 1,
        skipped: 0,
        missingTerminalJob: 0,
        missingTerminalTimestamp: 0,
        missingTerminalTimestampPaths: [],
        recentTerminalJob: 0,
        unreadableJobRecords: 0,
        errors: 0,
      };
    },
  });

  assert.deepEqual(calls, { archive: 1, reap: 1 });

  await runStoppedArchiveSweepIfDue({
    nowMs: nowMs + (5 * 60 * 1000),
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 0, skipped: 1, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      return {
        scanned: 1,
        reaped: 1,
        skipped: 0,
        missingTerminalJob: 0,
        missingTerminalTimestamp: 0,
        missingTerminalTimestampPaths: [],
        recentTerminalJob: 0,
        unreadableJobRecords: 0,
        errors: 0,
      };
    },
  });

  assert.deepEqual(calls, { archive: 1, reap: 2 });
  assert.deepEqual(readMaintenanceSweepState(statePath), {
    lastArchiveStoppedSweepMs: nowMs,
    lastArchiveStoppedSweepAt: '2026-06-03T14:00:00.000Z',
    lastReapTerminalWorkspacesSweepMs: nowMs + (5 * 60 * 1000),
    lastReapTerminalWorkspacesSweepAt: '2026-06-03T14:05:00.000Z',
  });
});

test('maintenance failed-step retry cooldown can be tuned by env', async (t) => {
  const previousCooldown = process.env.STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS;
  process.env.STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS = '1';
  let daemonModule;
  try {
    daemonModule = await import(
      `../scripts/adversarial-follow-up-daemon.mjs?cooldown=${Date.now()}-${Math.random()}`
    );
  } finally {
    if (previousCooldown === undefined) {
      delete process.env.STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS;
    } else {
      process.env.STOPPED_ARCHIVE_FAILURE_RETRY_SECONDS = previousCooldown;
    }
  }

  const rootDir = makeTempDir(t);
  const statePath = path.join(rootDir, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');
  const nowMs = Date.parse('2026-06-03T15:00:00.000Z');
  const calls = { archive: 0, reap: 0 };

  await daemonModule.runStoppedArchiveSweepIfDue({
    nowMs,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 1, skipped: 0, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      throw new Error('workspace root unavailable');
    },
  });

  await daemonModule.runStoppedArchiveSweepIfDue({
    nowMs: nowMs + 500,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 0, skipped: 1, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      return {
        scanned: 1,
        reaped: 1,
        skipped: 0,
        missingTerminalJob: 0,
        missingTerminalTimestamp: 0,
        missingTerminalTimestampPaths: [],
        recentTerminalJob: 0,
        unreadableJobRecords: 0,
        errors: 0,
      };
    },
  });

  await daemonModule.runStoppedArchiveSweepIfDue({
    nowMs: nowMs + 1000,
    statePath,
    archiveStoppedFollowUpJobsImpl: () => {
      calls.archive += 1;
      return { scanned: 1, archived: 0, skipped: 1, collisions: 0 };
    },
    resolveRemediationWorkspaceRootImpl: () => path.join(rootDir, 'workers'),
    reapTerminalFollowUpWorkspacesImpl: () => {
      calls.reap += 1;
      return {
        scanned: 1,
        reaped: 1,
        skipped: 0,
        missingTerminalJob: 0,
        missingTerminalTimestamp: 0,
        missingTerminalTimestampPaths: [],
        recentTerminalJob: 0,
        unreadableJobRecords: 0,
        errors: 0,
      };
    },
  });

  assert.deepEqual(calls, { archive: 1, reap: 2 });
  assert.equal(
    daemonModule.readMaintenanceSweepState(statePath).lastReapTerminalWorkspacesSweepMs,
    nowMs + 1000,
  );
});

test('follow-up daemon drops and audits wakes beyond max_per_pr_head', async (t) => {
  const rootDir = makeTempDir(t);
  const auditPath = path.join(rootDir, 'data', 'handoff-wake', 'rate-cap-audit.jsonl');
  const limiter = createHandoffRateLimiter({
    rootDir,
    auditPath,
    maxPerPrHead: 2,
    logger: { warn() {} },
    now: () => '2026-07-09T12:00:00.000Z',
  });
  const accepted = [];

  const result = await sleepForNextFollowUpDaemonIteration({
    rootDir,
    intervalMs: 10,
    rateLimiter: limiter,
    loadConfigImpl: () => ({
      getHandoffConfig: () => ({ enabled: true, maxPerPrHead: 2 }),
    }),
    sleepUntilTimerOrHandoffWakeImpl: async (_root, _daemon, _delay, options) => {
      const payload = {
        repo: 'laceyenterprises/adversarial-review',
        pr_number: 57,
        head_sha: 'head-a',
      };
      accepted.push(options.shouldAcceptWake({ payload }));
      accepted.push(options.shouldAcceptWake({ payload }));
      accepted.push(options.shouldAcceptWake({ payload }));
      return { reason: 'timer' };
    },
  });

  assert.equal(result.reason, 'timer');
  assert.deepEqual(accepted, [true, true, false]);
  const audit = JSON.parse(readFileSync(auditPath, 'utf8').trim());
  assert.equal(audit.event, HANDOFF_RATE_CAP_AUDIT_EVENT);
  assert.equal(audit.repo, 'laceyenterprises/adversarial-review');
  assert.equal(audit.pr_number, 57);
  assert.equal(audit.head_sha, 'head-a');
  assert.equal(audit.count, 3);
  assert.equal(audit.max_per_pr_head, 2);
});

test('follow-up daemon kill-switch disabled uses timer sleep instead of wake wait', async (t) => {
  const rootDir = makeTempDir(t);
  let timerSleepMs = null;

  const result = await sleepForNextFollowUpDaemonIteration({
    rootDir,
    intervalMs: 123,
    loadConfigImpl: () => ({
      getHandoffConfig: () => ({ enabled: false, maxPerPrHead: 2 }),
    }),
    sleepUntilTimerOrHandoffWakeImpl: async () => {
      throw new Error('wake wait should not run when handoff is disabled');
    },
    sleepImpl: async (ms) => {
      timerSleepMs = ms;
    },
  });

  assert.deepEqual(result, { reason: 'timer', handoffEnabled: false });
  assert.equal(timerSleepMs, 123);
});

test('follow-up daemon iteration preserves reconcile and closer reaper on wake-driven passes', async () => {
  const calls = [];

  await runFollowUpDaemonIteration({
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
      return { scanned: 0, reclaimed: 0, skipped: 0, thresholdMs: 1 };
    },
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

  assert.ok(calls.indexOf('reconcile') > -1);
  assert.ok(calls.indexOf('closer-worktree-reap') > calls.indexOf('consume'));
  assert.ok(calls.indexOf('retry-comments') > calls.indexOf('closer-worktree-reap'));
});

test('follow-up wake storm on one head does not starve another PR head', async (t) => {
  const rootDir = makeTempDir(t);
  const limiter = createHandoffRateLimiter({
    rootDir,
    maxPerPrHead: 2,
    logger: { warn() {} },
  });
  const accepted = [];

  const result = await sleepForNextFollowUpDaemonIteration({
    rootDir,
    intervalMs: 10,
    rateLimiter: limiter,
    loadConfigImpl: () => ({
      getHandoffConfig: () => ({ enabled: true, maxPerPrHead: 2 }),
    }),
    sleepUntilTimerOrHandoffWakeImpl: async (_root, _daemon, _delay, options) => {
      const storm = {
        repo: 'laceyenterprises/adversarial-review',
        pr_number: 57,
        head_sha: 'head-a',
      };
      const other = {
        repo: 'laceyenterprises/adversarial-review',
        pr_number: 58,
        head_sha: 'head-b',
      };
      accepted.push(options.shouldAcceptWake({ payload: storm }));
      accepted.push(options.shouldAcceptWake({ payload: storm }));
      accepted.push(options.shouldAcceptWake({ payload: storm }));
      accepted.push(options.shouldAcceptWake({ payload: other }));
      return { reason: accepted.at(-1) ? 'wake' : 'timer', payload: other };
    },
  });

  assert.deepEqual(accepted, [true, true, false, true]);
  assert.equal(result.reason, 'wake');
});

// Regression guard for the per-tick reviewer-token refresh wiring. The tick
// loop lives in main() (not exported), so we assert at the source level that
// the refresh runs as the FIRST tick step — ahead of `consume` (which spawns
// remediation workers that snapshot process.env) and `retry-comments` (which
// posts directly). Without it, the daemon's broker App token expires ~1h after
// (re)start and remediation reply comments silently 401 (2026-06-14 incident).
test('tick loop refreshes the reviewer broker token before any GitHub step', () => {
  const src = readFileSync(
    new URL('../scripts/adversarial-follow-up-daemon.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    src,
    /import \{ refreshReviewerBrokerTokens \} from '\.\.\/src\/reviewer-broker-refresh\.mjs'/,
    'daemon must import refreshReviewerBrokerTokens',
  );
  const refreshIdx = src.indexOf("runStep('reviewer-token-refresh'");
  const consumeIdx = src.indexOf("runStep('consume'");
  const retryIdx = src.indexOf("runStep('retry-comments'");
  assert.ok(refreshIdx > 0, 'tick loop must run the reviewer-token-refresh step');
  assert.ok(consumeIdx > refreshIdx, 'refresh must run before consume (worker spawn)');
  assert.ok(retryIdx > refreshIdx, 'refresh must run before retry-comments (direct post)');
  assert.match(
    src,
    /minTokenLifetimeMs:\s*resolveRemediationWorkerTokenMinLifetimeMs\(env\)/,
    'daemon must pass an explicit remediation-worker handoff floor',
  );
});

test('daemon telemetry listener startup is best-effort and keeps the tick loop available', async (t) => {
  const rootDir = makeTempDir(t);
  const logs = [];
  const log = {
    log(message) { logs.push(String(message)); },
    error(message) { logs.push(String(message)); },
  };

  const listener = await startFollowUpTelemetryListener({
    rootDir,
    log,
    connectFollowUpTelemetryListenerImpl: async ({ rootDir: calledRoot }) => {
      assert.equal(calledRoot, rootDir);
      return { subscriptions: ['health.worker.*'], dispose() {} };
    },
  });

  assert.deepEqual(listener.subscriptions, ['health.worker.*']);
  assert.ok(logs.some((entry) => entry.includes('telemetry listener registered')));

  const failed = await startFollowUpTelemetryListener({
    rootDir,
    log,
    connectFollowUpTelemetryListenerImpl: async () => {
      throw new Error('broker unavailable');
    },
  });

  assert.equal(failed, null);
  assert.ok(logs.some((entry) => entry.includes('telemetry listener disabled: broker unavailable')));

  const timedOut = await startFollowUpTelemetryListener({
    rootDir,
    env: { ADVERSARIAL_REVIEW_TELEMETRY_LISTENER_START_TIMEOUT_MS: '5' },
    log,
    connectFollowUpTelemetryListenerImpl: async () => new Promise(() => {}),
  });

  assert.equal(timedOut, null);
  assert.ok(logs.some((entry) => entry.includes('telemetry listener startup timed out after 5ms')));
});

test('resolves remediation worker token handoff lifetime from the dedicated env knob', () => {
  assert.equal(
    resolveRemediationWorkerTokenMinLifetimeMs({}),
    DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS,
  );
  assert.equal(
    resolveRemediationWorkerTokenMinLifetimeMs({
      [REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS_ENV]: '2700000',
    }),
    2700000,
  );
  assert.equal(
    resolveRemediationWorkerTokenMinLifetimeMs({
      [REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS_ENV]: 'not-a-number',
    }),
    DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS,
  );
  // The default floor must stay SATISFIABLE against the broker's served token
  // lifetime. GitHub App tokens live at most 60min and the broker re-mints
  // within its ~25min refresh window, so it serves >=25min tokens. A floor above
  // that range (the old 50min) made the consume step skip remediation spawns
  // almost every tick and stalled the pipeline. Pin the value so a regression to
  // an unsatisfiable floor fails loudly here.
  assert.equal(DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS, 22 * 60 * 1000);
  assert.ok(
    DEFAULT_REMEDIATION_WORKER_TOKEN_MIN_LIFETIME_MS < 25 * 60 * 1000,
    'remediation handoff floor must stay below the broker default refresh window (~25min) to be satisfiable',
  );
});

test('resolves telemetry listener startup timeout from env', () => {
  assert.equal(resolveTelemetryListenerStartTimeoutMs({}), 5000);
  assert.equal(
    resolveTelemetryListenerStartTimeoutMs({ ADVERSARIAL_REVIEW_TELEMETRY_LISTENER_START_TIMEOUT_MS: '17' }),
    17,
  );
  assert.equal(
    resolveTelemetryListenerStartTimeoutMs({ ADVERSARIAL_REVIEW_TELEMETRY_LISTENER_START_TIMEOUT_MS: 'nope' }),
    5000,
  );
});

test('consume gate blocks only unsafe reviewer token handoff summaries', () => {
  assert.equal(shouldConsumeAfterReviewerTokenRefresh({ handoffSafe: [] }), true);
  assert.equal(
    shouldConsumeAfterReviewerTokenRefresh({
      handoffSafe: [
        { role: 'claude-reviewer', envVar: 'GH_CLAUDE_REVIEWER_TOKEN', safe: true },
      ],
    }),
    true,
  );

  const unsafeSummary = {
    handoffSafe: [
      { role: 'claude-reviewer', envVar: 'GH_CLAUDE_REVIEWER_TOKEN', safe: true },
      {
        role: 'codex-reviewer',
        envVar: 'GH_CODEX_REVIEWER_TOKEN',
        safe: false,
        reason: 'token-below-handoff-floor',
      },
    ],
  };
  assert.equal(shouldConsumeAfterReviewerTokenRefresh(unsafeSummary), false);
  assert.deepEqual(reviewerTokenHandoffUnsafeRoles(unsafeSummary), [unsafeSummary.handoffSafe[1]]);
});
