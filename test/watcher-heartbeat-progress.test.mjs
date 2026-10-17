import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeFileAtomic } from '../src/atomic-write.mjs';
import { createWatcherHeartbeat } from '../src/watcher-heartbeat.mjs';

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'heartbeat-progress-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const startedMs = Date.parse('2026-01-01T00:00:00.000Z');
  let clockMs = startedMs;
  const writes = [];
  const heartbeat = createWatcherHeartbeat({
    rootDir,
    now: () => new Date(clockMs),
    writeFile(path, content) {
      writeFileAtomic(path, content);
      writes.push({ atMs: clockMs, payload: JSON.parse(content) });
    },
    logger: { warn(message) { assert.fail(message); } },
  });
  heartbeat.markPoll();
  return {
    heartbeat,
    writes,
    startedMs,
    advanceTo(elapsedMs) { clockMs = startedMs + elapsedMs; },
    persisted() { return JSON.parse(readFileSync(heartbeat.filePath, 'utf8')); },
  };
}

test('progress during a 45-minute poll persists a fresh heartbeat at most once per minute', async (t) => {
  const f = fixture(t);
  for (let elapsedMs = 1000; elapsedMs <= 45 * 60_000; elapsedMs += 1000) {
    f.advanceTo(elapsedMs);
    f.heartbeat.markPollProgress();
    await f.heartbeat.flush();
    const persisted = f.persisted();
    assert.ok(f.startedMs + elapsedMs - Date.parse(persisted.updated_at) <= 60_000,
      'persisted heartbeat must remain within one minute of progress');
    assert.equal(persisted.last_poll_at, new Date(f.startedMs).toISOString());
    assert.equal(persisted.poll_counter, 1);
  }
  assert.ok(f.writes.length > 40, 'a long poll must persist its progress repeatedly');
  assert.ok(f.writes.length <= 46, 'at most 45 additional writes in 45 minutes');
  for (let i = 1; i < f.writes.length; i += 1) {
    assert.ok(f.writes[i].atMs - f.writes[i - 1].atMs >= 60_000);
    assert.equal(f.writes[i].payload.updated_at, f.writes[i].payload.last_poll_progress_at);
    assert.ok(f.writes[i].payload.poll_progress_counter > f.writes[i - 1].payload.poll_progress_counter);
  }
  const persisted = f.persisted();
  const lastProgress = f.heartbeat.snapshot().last_poll_progress_at;
  assert.ok(Date.parse(lastProgress) - Date.parse(persisted.updated_at) <= 60_000);
  assert.ok(Date.parse(lastProgress) - Date.parse(persisted.last_poll_progress_at) <= 60_000);
});

test('a progress refresh stops writing when the poll stops advancing', async (t) => {
  const f = fixture(t);
  f.advanceTo(10 * 60_000);
  await f.heartbeat.flush();
  assert.equal(f.writes.length, 1, 'elapsed time alone must not refresh the heartbeat');
  f.heartbeat.markPollProgress();
  await f.heartbeat.flush();
  assert.equal(f.writes.length, 2, 'real progress must refresh an overdue heartbeat');
  const persisted = f.persisted();
  for (let minute = 11; minute <= 55; minute += 1) {
    f.advanceTo(minute * 60_000);
    await f.heartbeat.flush();
    assert.equal(f.writes.length, 2, 'no extra write without new progress');
    assert.deepEqual(f.persisted(), persisted);
  }
});

for (const event of ['markReview', 'markSpawnDecision', 'markPollCompleted', 'persist']) {
  test(`progress persistence is deferred by an ordinary ${event} heartbeat`, async (t) => {
    const f = fixture(t);
    f.advanceTo(59_000);
    if (event === 'persist') f.heartbeat.persist('fixture-event');
    else f.heartbeat[event]();
    await f.heartbeat.flush();
    assert.equal(f.writes.length, 2);
    f.advanceTo(60_001);
    f.heartbeat.markPollProgress();
    await f.heartbeat.flush();
    assert.equal(f.writes.length, 2, 'recent ordinary writes reset the throttle');
    f.advanceTo(119_001);
    f.heartbeat.markPollProgress();
    await f.heartbeat.flush();
    assert.equal(f.writes.length, 3);
    assert.equal(f.persisted().last_poll_at, new Date(f.startedMs).toISOString());
  });
}

test('progress writes honor the exact one-minute boundary and coalesce bursts', async (t) => {
  const f = fixture(t);
  f.advanceTo(59_999);
  f.heartbeat.markPollProgress();
  assert.equal(f.writes.length, 1);
  f.advanceTo(60_000);
  for (let i = 0; i < 100; i += 1) f.heartbeat.markPollProgress();
  await f.heartbeat.flush();
  assert.equal(f.writes.length, 2);
  assert.equal(f.persisted().updated_at, '2026-01-01T00:01:00.000Z');
  f.advanceTo(119_999);
  f.heartbeat.markPollProgress();
  assert.equal(f.writes.length, 2);
  f.advanceTo(120_000);
  f.heartbeat.markPollProgress();
  assert.equal(f.writes.length, 3);
  assert.equal(f.persisted().poll_progress_counter, 103);
});

for (const failure of ['ownership', 'sync-write', 'async-write']) {
  test(`progress persistence throttles and logs ${failure} failures`, async () => {
    let clockMs = 0;
    let attempts = 0;
    const warnings = [];
    const heartbeat = createWatcherHeartbeat({
      rootDir: '/fixture',
      now: () => new Date(clockMs),
      readFile() { throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' }); },
      ownerGuardOptions: {
        currentUid: () => 101,
        exists: () => true,
        stat() {
          if (failure === 'ownership') attempts += 1;
          return { uid: failure === 'ownership' ? 102 : 101 };
        },
      },
      writeFile() {
        assert.notEqual(failure, 'ownership', 'ownership refusal must prevent writes');
        attempts += 1;
        const error = new Error('fixture write refused');
        if (failure === 'sync-write') throw error;
        return Promise.reject(error);
      },
      logger: { warn(message) { warnings.push(message); } },
    });
    heartbeat.markPoll();
    await heartbeat.flush();
    assert.equal(attempts, 1);
    for (clockMs = 60_000; clockMs < 120_000; clockMs += 1000) {
      heartbeat.markPollProgress();
      await heartbeat.flush();
      assert.equal(attempts, 2, 'failed progress writes must be rate limited');
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /failed to persist heartbeat/);
    heartbeat.markPollProgress();
    await heartbeat.flush();
    assert.equal(attempts, 3, 'persistence retries on later progress');
  });
}
