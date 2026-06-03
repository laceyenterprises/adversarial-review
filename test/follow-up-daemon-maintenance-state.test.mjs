import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  normalizeMaintenanceSweepState,
  readMaintenanceSweepState,
  runStoppedArchiveSweepIfDue,
  writeMaintenanceSweepState,
} from '../scripts/adversarial-follow-up-daemon.mjs';

test('maintenance sweep state round-trips through the persisted restart cursor', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
  const statePath = path.join(rootDir, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');
  const lastArchiveStoppedSweepMs = Date.parse('2026-06-03T12:00:00.000Z');
  const lastReapTerminalWorkspacesSweepMs = Date.parse('2026-06-03T12:05:00.000Z');

  writeMaintenanceSweepState({
    lastArchiveStoppedSweepMs,
    lastArchiveStoppedSweepAt: '2026-06-03T12:00:00.000Z',
    lastReapTerminalWorkspacesSweepMs,
    lastReapTerminalWorkspacesSweepAt: '2026-06-03T12:05:00.000Z',
  }, statePath);

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

test('maintenance sweep state falls back to zero when the persisted cursor is unreadable', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
  const statePath = path.join(rootDir, 'maintenance-sweeps.json');
  writeFileSync(statePath, '{not-json}\n', 'utf8');

  assert.deepEqual(readMaintenanceSweepState(statePath), {});
  assert.equal(
    normalizeMaintenanceSweepState(readMaintenanceSweepState(statePath)).lastArchiveStoppedSweepMs,
    0,
  );
});

test('maintenance sweep cursors are persisted after archive and reap complete', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
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

test('maintenance sweep cursors advance independently and throttle failed reap retries', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
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
