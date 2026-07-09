import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

test('handoff wake marker carries PR head metadata for rate limiting', async (t) => {
  const rootDir = makeTempRoot(t);
  const sleepPromise = sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    10_000,
    { enabled: true },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp, {
    reason: 'review-to-remediation',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    headSha: 'head-a',
  });
  assert.equal(signalResult.signaled, true);
  const markerPayload = JSON.parse(readFileSync(signalResult.path, 'utf8'));
  assert.equal(markerPayload.reason, 'review-to-remediation');
  assert.equal(markerPayload.repo, 'laceyenterprises/adversarial-review');
  assert.equal(markerPayload.pr_number, 57);
  assert.equal(markerPayload.head_sha, 'head-a');

  const result = await sleepPromise;
  assert.equal(result.reason, 'wake');
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

test('handoff wake sleep rejects with AbortError on shutdown signal', async (t) => {
  const rootDir = makeTempRoot(t);
  const ac = new AbortController();
  const sleepPromise = sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    10_000,
    { enabled: true, signal: ac.signal },
  );

  ac.abort();

  await assert.rejects(sleepPromise, { name: 'AbortError' });
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

test('handoff wake signaling delegates to the canonical owner instead of creating state as a non-owner', (t) => {
  const rootDir = makeTempRoot(t);
  const ownerUid = statSync(rootDir).uid;
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push({ command, args });
    if (command === 'id') {
      assert.deepEqual(args, ['-un', String(ownerUid)]);
      return { status: 0, stdout: 'daemon-owner\n', stderr: '' };
    }
    if (command === 'sudo') {
      assert.deepEqual(args.slice(0, 4), ['-A', '-H', '-u', 'daemon-owner']);
      assert.equal(args[4], process.execPath);
      assert.equal(args.at(-5), rootDir);
      assert.equal(args.at(-4), HANDOFF_WAKE_DAEMONS.followUp);
      assert.equal(JSON.parse(args.at(-1)).schema_version, 1);
      const delegated = spawnSync(args[4], args.slice(5), { encoding: 'utf8' });
      assert.equal(delegated.status, 0, delegated.stderr);
      assert.match(String(delegated.stdout || ''), /follow-up\..+\.wake$/);
      const evalArgvDelegated = spawnSync(
        args[4],
        [...args.slice(5, 8), '[eval]', ...args.slice(8)],
        { encoding: 'utf8' },
      );
      assert.equal(evalArgvDelegated.status, 0, evalArgvDelegated.stderr);
      assert.match(String(evalArgvDelegated.stdout || ''), /follow-up\..+\.wake$/);
      return delegated;
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp, {
    currentUidImpl: () => ownerUid + 1,
    spawnSyncImpl,
  });

  assert.equal(signalResult.signaled, true);
  assert.equal(signalResult.ownerUser, 'daemon-owner');
  assert.equal(calls.length, 2);
  const markers = readdirSync(join(rootDir, 'data', 'handoff-wake'));
  assert.equal(markers.length, 2);
  assert.ok(markers.every((marker) => /^follow-up\..+\.wake$/.test(marker)));
});

test('handoff wake signaling fails open when owner-routed signaling is unavailable', (t) => {
  const rootDir = makeTempRoot(t);
  const ownerUid = statSync(rootDir).uid;
  const spawnSyncImpl = (command) => {
    if (command === 'id') return { status: 0, stdout: 'daemon-owner\n', stderr: '' };
    if (command === 'sudo') return { status: 1, stdout: '', stderr: 'sudo: no askpass program specified\n' };
    throw new Error(`unexpected command: ${command}`);
  };

  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp, {
    currentUidImpl: () => ownerUid + 1,
    spawnSyncImpl,
  });

  assert.equal(signalResult.signaled, false);
  assert.match(signalResult.error.message, /owner signal failed|askpass/i);
  assert.throws(() => readdirSync(join(rootDir, 'data', 'handoff-wake')), /ENOENT/);
});

test('handoff wake signaling treats an existing data directory as the canonical owner anchor', (t) => {
  const rootDir = makeTempRoot(t);
  mkdirSync(join(rootDir, 'data'));
  const dataUid = statSync(join(rootDir, 'data')).uid;
  const spawnSyncImpl = (command, args) => {
    if (command === 'id') {
      assert.deepEqual(args, ['-un', String(dataUid)]);
      return { status: 0, stdout: 'data-owner\n', stderr: '' };
    }
    if (command === 'sudo') return { status: 0, stdout: 'delegated.wake', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  };

  const signalResult = signalHandoffWake(rootDir, HANDOFF_WAKE_DAEMONS.followUp, {
    currentUidImpl: () => dataUid + 1,
    spawnSyncImpl,
  });

  assert.equal(signalResult.signaled, true);
  assert.equal(signalResult.ownerUser, 'data-owner');
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

test('handoff wake accepts renamed marker events even when mtime predates sleep', async (t) => {
  const rootDir = makeTempRoot(t);
  const now = Date.parse('2026-07-09T16:00:00.000Z');
  let eventHandler = null;

  const resultPromise = sleepUntilTimerOrHandoffWake(
    rootDir,
    HANDOFF_WAKE_DAEMONS.followUp,
    10_000,
    {
      enabled: true,
      nowMs: () => now,
      watchImpl: (_dir, _options, onEvent) => {
        eventHandler = onEvent;
        const watcher = new EventEmitter();
        watcher.close = () => {};
        return watcher;
      },
    },
  );

  await new Promise((resolve) => setImmediate(resolve));
  const wakeDir = join(rootDir, 'data', 'handoff-wake');
  const marker = join(wakeDir, 'follow-up.old-mtime.wake');
  writeFileSync(marker, 'wake\n');
  const oldDate = new Date(now - 60_000);
  utimesSync(marker, oldDate, oldDate);
  eventHandler('rename', 'follow-up.old-mtime.wake');

  const result = await resultPromise;
  assert.equal(result.reason, 'wake');
  assert.equal(result.path, marker);
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
