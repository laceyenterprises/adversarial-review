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
  resolveRemediationWorkerTokenMinLifetimeMs,
  reviewerTokenHandoffUnsafeRoles,
  runStoppedArchiveSweepIfDue,
  shouldConsumeAfterReviewerTokenRefresh,
  writeMaintenanceSweepState,
} from '../scripts/adversarial-follow-up-daemon.mjs';

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
    /minTokenLifetimeMs:\s*resolveRemediationWorkerTokenMinLifetimeMs\(process\.env\)/,
    'daemon must pass an explicit remediation-worker handoff floor',
  );
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
