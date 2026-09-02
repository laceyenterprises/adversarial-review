import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  DEFAULT_WATCHER_STALL_EXIT_CODE,
  resolveWatcherHeartbeatOwnerGuardRoot,
  resolveWatcherHeartbeatPath,
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

test('watcher heartbeat persists poll counter and review timestamps', async () => {
  const rootDir = tempRoot();
  try {
    const times = [
      new Date('2026-07-04T10:00:00.000Z'),
      new Date('2026-07-04T10:00:05.000Z'),
      new Date('2026-07-04T10:00:06.000Z'),
      new Date('2026-07-04T10:00:07.000Z'),
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
    assert.equal(persisted.last_completed_poll_at, null);
    assert.equal(persisted.last_review_at, null);
    assert.equal(persisted.poll_counter, 1);
    assert.equal(persisted.completed_poll_counter, 0);
    assert.equal(persisted.source, 'startup pollOnce');

    heartbeat.markPollCompleted({ source: 'startup pollOnce', ok: true });
    persisted = readJson(watcherHeartbeatPath(rootDir));
    assert.equal(persisted.event, 'poll-completed');
    assert.equal(persisted.last_completed_poll_at, '2026-07-04T10:00:05.000Z');
    assert.equal(persisted.completed_poll_counter, 1);
    assert.equal(persisted.ok, true);

    heartbeat.markSpawnDecision({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 3046,
      decision: 'cascade-backoff-hold',
      next_retry_after: '2026-07-04T10:05:00.000Z',
    });
    persisted = readJson(watcherHeartbeatPath(rootDir));
    assert.equal(persisted.event, 'spawn-decision');
    assert.equal(persisted.last_spawn_decision_at, '2026-07-04T10:00:06.000Z');
    assert.equal(persisted.last_spawn_decision.decision, 'cascade-backoff-hold');
    assert.equal(persisted.last_spawn_decision.pr_number, 3046);

    heartbeat.markReview({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 3046,
      posted_at: '2026-07-04T10:00:07.000Z',
    });
    await heartbeat.flush();
    persisted = readJson(watcherHeartbeatPath(rootDir));
    assert.equal(persisted.event, 'review');
    assert.equal(persisted.last_poll_at, '2026-07-04T10:00:00.000Z');
    assert.equal(persisted.last_completed_poll_at, '2026-07-04T10:00:05.000Z');
    assert.equal(persisted.last_review_at, '2026-07-04T10:00:07.000Z');
    assert.equal(persisted.last_spawn_decision.decision, 'cascade-backoff-hold');
    assert.equal(persisted.poll_counter, 1);
    assert.equal(persisted.completed_poll_counter, 1);
    assert.equal(persisted.repo, 'laceyenterprises/adversarial-review');
    assert.equal(persisted.pr_number, 3046);
  } finally {
    cleanup(rootDir);
  }
});

test('watcher heartbeat debounces review persistence within a tick', async () => {
  const rootDir = tempRoot();
  const writes = [];
  const times = [
    new Date('2026-07-04T10:03:00.000Z'),
    new Date('2026-07-04T10:03:01.000Z'),
  ];
  try {
    const heartbeat = createWatcherHeartbeat({
      filePath: join(rootDir, 'heartbeat.json'),
      now: () => times.shift() || new Date('2026-07-04T10:03:02.000Z'),
      writeFile(_filePath, content) {
        writes.push(JSON.parse(content));
      },
      readFile() {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      pid: 4242,
      logger: { warn() {} },
    });

    heartbeat.markReview({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 492,
    });
    heartbeat.markReview({
      repo: 'laceyenterprises/adversarial-review',
      pr_number: 493,
    });

    assert.equal(writes.length, 0);
    await heartbeat.flush();

    assert.equal(writes.length, 1);
    assert.equal(writes[0].event, 'review');
    assert.equal(writes[0].watcher_pid, 4242);
    assert.equal(writes[0].pr_number, 493);
    assert.equal(writes[0].last_review_at, '2026-07-04T10:03:01.000Z');
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

test('watcher heartbeat refuses cross-user writes before invoking the writer', () => {
  const rootDir = '/Users/airlock/agent-os-hq';
  const filePath = join(rootDir, '.adversarial-watcher', 'heartbeat.json');
  const warnings = [];
  const writes = [];
  const heartbeat = createWatcherHeartbeat({
    rootDir,
    filePath,
    now: () => new Date('2026-07-04T10:00:00.000Z'),
    writeFile() {
      writes.push(filePath);
    },
    readFile() {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    ownerGuardRootDir: rootDir,
    ownerGuardOptions: {
      currentUid: () => 502,
      exists: (path) => path === rootDir,
      stat: (path) => {
        assert.equal(path, rootDir);
        return { uid: 501 };
      },
    },
    logger: { warn(message) { warnings.push(message); } },
  });

  heartbeat.markPoll();

  assert.deepEqual(writes, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /refusing cross-user watcher heartbeat write/);
  assert.match(warnings[0], /caller uid 502, canonical owner uid 501/);
});

test('watcher heartbeat recovers a wrong-owned existing file for the canonical owner', () => {
  const rootDir = '/Users/airlock/agent-os-hq';
  const filePath = join(rootDir, '.adversarial-watcher', 'heartbeat.json');
  const targetDir = join(rootDir, '.adversarial-watcher');
  const warnings = [];
  const writes = [];
  const unlinks = [];
  let heartbeatExists = true;
  const heartbeat = createWatcherHeartbeat({
    rootDir,
    filePath,
    now: () => new Date('2026-07-04T10:00:00.000Z'),
    writeFile(path, content) {
      writes.push({ path, content: JSON.parse(content) });
    },
    readFile() {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    unlinkFile(path) {
      assert.equal(path, filePath);
      unlinks.push(path);
      heartbeatExists = false;
    },
    ownerGuardRootDir: rootDir,
    ownerGuardOptions: {
      currentUid: () => 501,
      exists: (path) => path === targetDir || (path === filePath && heartbeatExists),
      stat: (path) => {
        if (path === targetDir) return { uid: 501 };
        if (path === filePath) return { uid: 502 };
        assert.fail(`unexpected stat path ${path}`);
      },
    },
    logger: { warn(message) { warnings.push(message); } },
  });

  heartbeat.markPoll();

  assert.deepEqual(unlinks, [filePath]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, filePath);
  assert.equal(writes[0].content.event, 'poll');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recovering wrong-owned heartbeat/);
  assert.match(warnings[0], /unlinking and retrying/);
});

test('watcher heartbeat ignores concurrent ENOENT during wrong-owned file recovery', () => {
  const rootDir = '/Users/airlock/agent-os-hq';
  const filePath = join(rootDir, '.adversarial-watcher', 'heartbeat.json');
  const targetDir = join(rootDir, '.adversarial-watcher');
  const warnings = [];
  const writes = [];
  let statAttempts = 0;
  const heartbeat = createWatcherHeartbeat({
    rootDir,
    filePath,
    now: () => new Date('2026-07-04T10:00:00.000Z'),
    writeFile(path, content) {
      writes.push({ path, content: JSON.parse(content) });
    },
    readFile() {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    unlinkFile(path) {
      assert.equal(path, filePath);
      throw Object.assign(new Error('already removed'), { code: 'ENOENT' });
    },
    ownerGuardRootDir: rootDir,
    ownerGuardOptions: {
      currentUid: () => 501,
      exists: (path) => path === targetDir || (path === filePath && statAttempts === 0),
      stat: (path) => {
        if (path === targetDir) return { uid: 501 };
        if (path === filePath) {
          statAttempts += 1;
          return { uid: 502 };
        }
        assert.fail(`unexpected stat path ${path}`);
      },
    },
    logger: { warn(message) { warnings.push(message); } },
  });

  heartbeat.markPoll();

  assert.equal(statAttempts, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, filePath);
  assert.equal(writes[0].content.event, 'poll');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recovering wrong-owned heartbeat/);
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

test('stall watchdog parses positive config values and falls back for blanks', () => {
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
  assert.doesNotThrow(() => createWatcherStallWatchdog({
    heartbeat,
    stallMs: '500',
    checkIntervalMs: '',
    nowMs: () => now,
    onStall: (event) => stalls.push(event),
    logger: { error() {} },
  }));

  const watchdog = createWatcherStallWatchdog({
    heartbeat,
    stallMs: '500',
    checkIntervalMs: '',
    nowMs: () => now,
    onStall: (event) => stalls.push(event),
    logger: { error() {} },
  });
  now = 1_500;
  assert.equal(watchdog.check(), true);
  assert.equal(stalls.length, 1);
});

test('resolveWatcherHeartbeatPath honours the explicit env override first', () => {
  const path = resolveWatcherHeartbeatPath({
    env: {
      ADVERSARIAL_WATCHER_HEARTBEAT_PATH: '/custom/heartbeat.json',
      HQ_ROOT: '/Users/airlock/agent-os-hq',
    },
    rootDir: '/deploy/tools/adversarial-review',
  });
  assert.equal(path, '/custom/heartbeat.json');
});

test('resolveWatcherHeartbeatPath defaults to the stable HQ_ROOT path', () => {
  const path = resolveWatcherHeartbeatPath({
    env: { HQ_ROOT: '/Users/airlock/agent-os-hq' },
    rootDir: '/deploy/tools/adversarial-review',
  });
  assert.equal(path, join('/Users/airlock/agent-os-hq', '.adversarial-watcher', 'heartbeat.json'));
});

test('resolveWatcherHeartbeatOwnerGuardRoot uses HQ_ROOT for the stable HQ heartbeat path', () => {
  const filePath = join('/Users/airlock/agent-os-hq', '.adversarial-watcher', 'heartbeat.json');
  const ownerGuardRoot = resolveWatcherHeartbeatOwnerGuardRoot({
    env: { HQ_ROOT: '/Users/airlock/agent-os-hq' },
    rootDir: '/deploy/tools/adversarial-review',
    filePath,
  });
  assert.equal(ownerGuardRoot, '/Users/airlock/agent-os-hq');
});

test('resolveWatcherHeartbeatOwnerGuardRoot uses rootDir for explicit overrides', () => {
  const ownerGuardRoot = resolveWatcherHeartbeatOwnerGuardRoot({
    env: {
      ADVERSARIAL_WATCHER_HEARTBEAT_PATH: '/custom/heartbeat.json',
      HQ_ROOT: '/Users/airlock/agent-os-hq',
    },
    rootDir: '/deploy/tools/adversarial-review',
    filePath: '/custom/heartbeat.json',
  });
  assert.equal(ownerGuardRoot, '/deploy/tools/adversarial-review');
});

test('resolveWatcherHeartbeatPath falls back to the rootDir data dir when HQ_ROOT is unset', () => {
  const path = resolveWatcherHeartbeatPath({
    env: {},
    rootDir: '/deploy/tools/adversarial-review',
  });
  assert.equal(path, watcherHeartbeatPath('/deploy/tools/adversarial-review'));
});

test('resolveWatcherHeartbeatPath ignores a blank override and blank HQ_ROOT', () => {
  const path = resolveWatcherHeartbeatPath({
    env: { ADVERSARIAL_WATCHER_HEARTBEAT_PATH: '   ', HQ_ROOT: '' },
    rootDir: '/deploy/tools/adversarial-review',
  });
  assert.equal(path, watcherHeartbeatPath('/deploy/tools/adversarial-review'));
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
