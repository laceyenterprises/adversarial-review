import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  DEFAULT_WATCHER_STALL_EXIT_CODE,
  watcherHeartbeatPath,
} from '../src/watcher-heartbeat.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'watcher-heartbeat-test-'));
}

function cleanup(rootDir) {
  rmSync(rootDir, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('watcher heartbeat persists poll counter and review timestamps', () => {
  const rootDir = tempRoot();
  try {
    const times = [
      new Date('2026-07-04T10:00:00.000Z'),
      new Date('2026-07-04T10:00:05.000Z'),
    ];
    const heartbeat = createWatcherHeartbeat({
      rootDir,
      now: () => times.shift() || new Date('2026-07-04T10:00:10.000Z'),
      pid: 4242,
      logger: { warn() {} },
    });

    heartbeat.markPoll({ source: 'startup pollOnce' });
    let persisted = readJson(watcherHeartbeatPath(rootDir));
    assert.equal(persisted.schema_version, 1);
    assert.equal(persisted.watcher_pid, 4242);
    assert.equal(persisted.event, 'poll');
    assert.equal(persisted.last_poll_at, '2026-07-04T10:00:00.000Z');
    assert.equal(persisted.last_review_at, null);
    assert.equal(persisted.poll_counter, 1);
    assert.equal(persisted.source, 'startup pollOnce');

    heartbeat.markReview({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 3046,
      posted_at: '2026-07-04T10:00:05.000Z',
    });
    persisted = readJson(watcherHeartbeatPath(rootDir));
    assert.equal(persisted.event, 'review');
    assert.equal(persisted.last_poll_at, '2026-07-04T10:00:00.000Z');
    assert.equal(persisted.last_review_at, '2026-07-04T10:00:05.000Z');
    assert.equal(persisted.poll_counter, 1);
    assert.equal(persisted.repo, 'laceyenterprises/adversarial-review');
    assert.equal(persisted.pr_number, 3046);
  } finally {
    cleanup(rootDir);
  }
});

test('watcher heartbeat resumes monotonically from the prior durable counter', () => {
  const rootDir = tempRoot();
  try {
    const first = createWatcherHeartbeat({
      rootDir,
      now: () => new Date('2026-07-04T10:01:00.000Z'),
      logger: { warn() {} },
    });
    first.markPoll();
    first.markPoll();

    const second = createWatcherHeartbeat({
      rootDir,
      now: () => new Date('2026-07-04T10:02:00.000Z'),
      logger: { warn() {} },
    });
    second.markPoll();

    assert.equal(readJson(watcherHeartbeatPath(rootDir)).poll_counter, 3);
  } finally {
    cleanup(rootDir);
  }
});

test('watcher heartbeat catches asynchronous atomic write failures', async () => {
  const warnings = [];
  const heartbeat = createWatcherHeartbeat({
    filePath: join(tempRoot(), 'heartbeat.json'),
    now: () => new Date('2026-07-04T10:00:00.000Z'),
    writeFile() {
      return Promise.reject(new Error('disk full'));
    },
    readFile() {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    logger: { warn(message) { warnings.push(message); } },
  });

  heartbeat.markPoll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to persist heartbeat/);
  assert.match(warnings[0], /disk full/);
});

test('stall watchdog trips exit 75 when an idle watcher makes no poll progress', () => {
  const heartbeat = createWatcherHeartbeat({
    filePath: join(tempRoot(), 'heartbeat.json'),
    now: () => new Date('2026-07-04T10:00:00.000Z'),
    writeFile() {},
    readFile() {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    logger: { warn() {} },
  });
  heartbeat.markPoll();

  let now = 1_000;
  const stalls = [];
  const watchdog = createWatcherStallWatchdog({
    heartbeat,
    stallMs: 500,
    checkIntervalMs: 50,
    nowMs: () => now,
    onStall: (event) => stalls.push(event),
    logger: { error() {} },
  });

  assert.equal(watchdog.check(), false);
  now = 1_499;
  assert.equal(watchdog.check(), false);
  now = 1_500;
  assert.equal(watchdog.check(), true);
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].exitCode, DEFAULT_WATCHER_STALL_EXIT_CODE);
  assert.equal(stalls[0].heartbeat.poll_counter, 1);

  now = 2_500;
  assert.equal(watchdog.check(), false, 'watchdog should trip only once');
});

test('stall watchdog does not fire while a poll is in flight', () => {
  const heartbeat = createWatcherHeartbeat({
    filePath: join(tempRoot(), 'heartbeat.json'),
    now: () => new Date('2026-07-04T10:00:00.000Z'),
    writeFile() {},
    readFile() {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    logger: { warn() {} },
  });
  heartbeat.markPoll();

  let now = 1_000;
  const stalls = [];
  const watchdog = createWatcherStallWatchdog({
    heartbeat,
    stallMs: 500,
    nowMs: () => now,
    onStall: (event) => stalls.push(event),
    logger: { error() {} },
  });

  watchdog.beginPoll();
  now = 10_000;
  assert.equal(watchdog.check(), false);
  assert.deepEqual(stalls, []);
  watchdog.endPoll();
  assert.equal(watchdog.check(), false);
  assert.deepEqual(stalls, []);
  now = 10_499;
  assert.equal(watchdog.check(), false);
  now = 10_500;
  assert.equal(watchdog.check(), true);
});

test('healthy poll-counter progress resets the stall watchdog', () => {
  const rootDir = tempRoot();
  try {
    let heartbeatNow = Date.parse('2026-07-04T10:00:00.000Z');
    const heartbeat = createWatcherHeartbeat({
      rootDir,
      now: () => new Date(heartbeatNow),
      logger: { warn() {} },
    });
    heartbeat.markPoll();

    let now = 1_000;
    const stalls = [];
    const watchdog = createWatcherStallWatchdog({
      heartbeat,
      stallMs: 500,
      nowMs: () => now,
      onStall: (event) => stalls.push(event),
      logger: { error() {} },
    });

    now = 1_400;
    assert.equal(watchdog.check(), false);
    heartbeatNow += 1_000;
    heartbeat.markPoll();
    now = 1_800;
    assert.equal(watchdog.check(), false);
    now = 2_299;
    assert.equal(watchdog.check(), false);
    assert.deepEqual(stalls, []);
  } finally {
    cleanup(rootDir);
  }
});
