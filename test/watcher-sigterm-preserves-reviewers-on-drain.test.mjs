/* SIGTERM during an active drain marker must preserve in-flight reviewer
 * subprocesses. The next watcher reattaches them via
 * `reconcileReviewerSessions` (the `reviewer_reattach_alive` branch).
 *
 * Without this, every routine deploy (main-catchup writes
 * `watcher-drain.json`, then `launchctl bootout` sends SIGTERM) would
 * kill in-flight reviews — which is exactly what made main-catchup's
 * drain wait block for the full duration of long-running code reviews.
 * See `projects/daemon-bounce-safety/SPEC.md` §6a for the contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  shouldPreserveReviewersOnSigterm,
  readWatcherDrainState,
} from '../src/watcher.mjs';

test('preserves reviewers when drain marker is active', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-drain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeFileSync(drainFile, JSON.stringify({
      reason: 'main-catchup deploy 2026-05-16',
      requestedBy: 'main-catchup',
      expiresAt: farFuture,
    }));

    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, true);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cancels reviewers when no drain marker is present (default SIGTERM)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-nodrain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    // Marker absent.
    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, false);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cancels reviewers when drain marker has expired', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-expired-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    // Past expiresAt — marker is on disk but logically inert.
    writeFileSync(drainFile, JSON.stringify({
      reason: 'old drain',
      requestedBy: 'main-catchup',
      expiresAt: '2024-01-01T00:00:00.000Z',
    }));

    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, false);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shouldPreserveReviewersOnSigterm tolerates missing or partial drain state', () => {
  // Defensive: future shape changes to readWatcherDrainState shouldn't
  // turn an undefined return into "preserve" (which would silently leak
  // zombie reviewers on every SIGTERM).
  assert.equal(shouldPreserveReviewersOnSigterm(undefined), false);
  assert.equal(shouldPreserveReviewersOnSigterm(null), false);
  assert.equal(shouldPreserveReviewersOnSigterm({}), false);
  assert.equal(shouldPreserveReviewersOnSigterm({ active: false }), false);
  assert.equal(shouldPreserveReviewersOnSigterm({ active: true }), true);
});
