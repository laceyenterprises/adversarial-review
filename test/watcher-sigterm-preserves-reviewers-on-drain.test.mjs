/* Routine SIGTERM must preserve in-flight reviewer
 * subprocesses. The next watcher reattaches them via
 * `reconcileReviewerSessions` (the `reviewer_reattach_alive` branch).
 *
 * A separate hard-shutdown command owns the intentional cancel-first path.
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

test('preserves reviewers when no drain marker is present (default SIGTERM bounce)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-sigterm-nodrain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    // Marker absent.
    const drainState = readWatcherDrainState({ drainFile });
    assert.equal(drainState.active, false);
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('preserves reviewers when drain marker has expired', () => {
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
    assert.equal(shouldPreserveReviewersOnSigterm(drainState), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('shouldPreserveReviewersOnSigterm tolerates missing or partial drain state', () => {
  assert.equal(shouldPreserveReviewersOnSigterm(undefined), true);
  assert.equal(shouldPreserveReviewersOnSigterm(null), true);
  assert.equal(shouldPreserveReviewersOnSigterm({}), true);
  assert.equal(shouldPreserveReviewersOnSigterm({ active: false }), true);
  assert.equal(shouldPreserveReviewersOnSigterm({ active: true }), true);
});
