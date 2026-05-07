import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWatcherDrainState, WATCHER_DRAIN_MAX_MS } from '../src/watcher.mjs';

test('watcher drain marker blocks new review spawns until expiry', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-drain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    writeFileSync(drainFile, JSON.stringify({
      reason: 'main-catchup bouncing adversarial-review',
      requestedBy: 'main-catchup',
      expiresAt: '2026-05-07T05:30:00.000Z',
    }));

    const active = readWatcherDrainState({
      drainFile,
      now: new Date('2026-05-07T05:00:00.000Z'),
    });
    assert.equal(active.active, true);
    assert.equal(active.reason, 'main-catchup bouncing adversarial-review');
    assert.equal(active.requestedBy, 'main-catchup');
    assert.equal(active.expiresAt, '2026-05-07T05:30:00.000Z');

    const expired = readWatcherDrainState({
      drainFile,
      now: new Date('2026-05-07T05:30:00.001Z'),
    });
    assert.equal(expired.active, false);
    assert.equal(expired.expired, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher drain marker fails closed when corrupt', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-drain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    writeFileSync(drainFile, '{not-json');

    const state = readWatcherDrainState({ drainFile });
    assert.equal(state.active, true);
    assert.match(state.reason, /invalid drain marker/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher drain marker has a hard max lifetime when expiresAt is invalid', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-drain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    mkdirSync(path.dirname(drainFile), { recursive: true });
    writeFileSync(drainFile, JSON.stringify({ reason: 'missing expiry' }));
    const markerTime = new Date('2026-05-07T05:00:00.000Z');
    utimesSync(drainFile, markerTime, markerTime);

    const active = readWatcherDrainState({
      drainFile,
      now: new Date(markerTime.getTime() + WATCHER_DRAIN_MAX_MS - 1),
    });
    assert.equal(active.active, true);
    assert.match(active.reason, /missing\/invalid expiresAt/);

    const expired = readWatcherDrainState({
      drainFile,
      now: new Date(markerTime.getTime() + WATCHER_DRAIN_MAX_MS + 1),
    });
    assert.equal(expired.active, false);
    assert.equal(expired.expired, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher drain marker treats delete races as inactive', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-drain-'));
  try {
    const drainFile = path.join(rootDir, 'data', 'watcher-drain.json');
    const state = readWatcherDrainState({ drainFile });
    assert.equal(state.active, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
