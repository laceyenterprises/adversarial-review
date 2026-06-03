import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  readMaintenanceSweepState,
  resolveInitialStoppedArchiveSweepMs,
  writeMaintenanceSweepState,
} from '../scripts/adversarial-follow-up-daemon.mjs';

test('maintenance sweep state round-trips through the persisted restart cursor', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
  const statePath = path.join(rootDir, 'data', 'follow-up-jobs', 'maintenance-sweeps.json');
  const lastStoppedArchiveSweepMs = Date.parse('2026-06-03T12:00:00.000Z');

  writeMaintenanceSweepState({
    lastStoppedArchiveSweepMs,
    lastStoppedArchiveSweepAt: '2026-06-03T12:00:00.000Z',
  }, statePath);

  assert.deepEqual(readMaintenanceSweepState(statePath), {
    lastStoppedArchiveSweepMs,
    lastStoppedArchiveSweepAt: '2026-06-03T12:00:00.000Z',
  });
  assert.equal(resolveInitialStoppedArchiveSweepMs(statePath), lastStoppedArchiveSweepMs);
  assert.match(readFileSync(statePath, 'utf8'), /lastStoppedArchiveSweepMs/);
});

test('maintenance sweep state falls back to zero when the persisted cursor is unreadable', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-daemon-'));
  const statePath = path.join(rootDir, 'maintenance-sweeps.json');
  writeFileSync(statePath, '{not-json}\n', 'utf8');

  assert.deepEqual(readMaintenanceSweepState(statePath), {});
  assert.equal(resolveInitialStoppedArchiveSweepMs(statePath), 0);
});
