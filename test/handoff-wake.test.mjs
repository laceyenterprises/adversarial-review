import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HANDOFF_WAKE_DAEMONS,
  HANDOFF_WAKE_DIR_MODE,
  HANDOFF_WAKE_MARKER_MODE,
  inspectHandoffWakePermissions,
  signalHandoffWake,
  sleepUntilTimerOrHandoffWake,
} from '../src/handoff-wake.mjs';

function makeTempRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'handoff-wake-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('handoff wake interrupts a listening sleep within two seconds', async (t) => {
  const rootDir = makeTempRoot(t);
  const started = Date.now();
  const sleepPromise = sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    10_000,
    { enabled: true },
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp);
  assert.equal(signalResult.signaled, true);

  const result = await sleepPromise;
  const elapsedMs = Date.now() - started;
  assert.equal(result.reason, 'wake');
  assert.ok(elapsedMs < 2_000, `wake took ${elapsedMs}ms`);
});

test('handoff wake with no listener is a harmless no-op for a later sleep', async (t) => {
  const rootDir = makeTempRoot(t);
  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.watcher);
  assert.equal(signalResult.signaled, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.watcher,
    50,
    { enabled: true },
  );

  assert.equal(result.reason, 'timer');
});

test('handoff wake directory and marker modes support a shared service group', (t) => {
  const rootDir = makeTempRoot(t);
  const info = inspectHandoffWakePermissions(rootDir);

  assert.equal(info.dirMode, HANDOFF_WAKE_DIR_MODE);
  assert.equal(info.markerMode, HANDOFF_WAKE_MARKER_MODE);
  assert.equal(info.expectedDirMode, 0o775);
  assert.equal(info.expectedMarkerMode, 0o664);
});

test('timer still fires normally after prior wakes', async (t) => {
  const rootDir = makeTempRoot(t);
  const firstSleep = sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    10_000,
    { enabled: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp);
  assert.equal((await firstSleep).reason, 'wake');

  const started = Date.now();
  const second = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    60,
    { enabled: true },
  );
  const elapsedMs = Date.now() - started;

  assert.equal(second.reason, 'timer');
  assert.ok(elapsedMs >= 45, `timer fired too early after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2_000, `timer did not fire promptly: ${elapsedMs}ms`);
});

test('disabled handoff sleep path does not create or watch the wake directory', async (t) => {
  const rootDir = makeTempRoot(t);
  let watched = false;

  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.watcher,
    5,
    {
      enabled: false,
      watchImpl: () => {
        watched = true;
        throw new Error('watch should not be called when handoff is disabled');
      },
    },
  );

  assert.equal(result.reason, 'timer');
  assert.equal(watched, false);
  assert.throws(() => readdirSync(join(rootDir, 'data', 'handoff-wake')), /ENOENT/);
});

test('handoff wake signaling is best-effort when directory setup fails', (t) => {
  const rootDir = makeTempRoot(t);
  writeFileSync(join(rootDir, 'data'), 'not a directory');

  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp);

  assert.equal(signalResult.signaled, false);
  assert.match(signalResult.error.message, /ENOTDIR|not a directory/i);
});

test('handoff wake sleep falls back to timer when directory setup fails', async (t) => {
  const rootDir = makeTempRoot(t);
  writeFileSync(join(rootDir, 'data'), 'not a directory');

  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    5,
    { enabled: true },
  );

  assert.equal(result.reason, 'timer');
});

test('handoff wake sleep falls back to timer when watcher setup fails', async (t) => {
  const rootDir = makeTempRoot(t);

  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    5,
    {
      enabled: true,
      watchImpl: () => {
        throw new Error('too many watchers');
      },
    },
  );

  assert.equal(result.reason, 'timer');
});

test('handoff wake sleep falls back to timer when watcher emits an error', async (t) => {
  const rootDir = makeTempRoot(t);
  let closed = false;

  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    5,
    {
      enabled: true,
      watchImpl: () => {
        const watcher = new EventEmitter();
        watcher.close = () => {
          closed = true;
        };
        setTimeout(() => watcher.emit('error', new Error('watch failed')), 0);
        return watcher;
      },
    },
  );

  assert.equal(result.reason, 'timer');
  assert.equal(closed, true);
});

test('handoff wake ignores temporary marker files', async (t) => {
  const rootDir = makeTempRoot(t);

  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    5,
    {
      enabled: true,
      watchImpl: (_dir, _options, onEvent) => {
        const watcher = new EventEmitter();
        watcher.close = () => {};
        onEvent('rename', 'follow-up.123.tmp');
        onEvent('rename', 'follow-up.123.wake.tmp');
        return watcher;
      },
    },
  );

  assert.equal(result.reason, 'timer');
});

test('handoff wake sleep sweeps for markers created during watcher setup', async (t) => {
  const rootDir = makeTempRoot(t);

  const result = await sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    10_000,
    {
      enabled: true,
      watchImpl: () => {
        const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp);
        assert.equal(signalResult.signaled, true);
        const watcher = new EventEmitter();
        watcher.close = () => {};
        return watcher;
      },
    },
  );

  assert.equal(result.reason, 'wake');
  assert.match(result.path, /\.wake$/);
});
