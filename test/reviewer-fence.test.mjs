import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test__ as reviewerTest } from '../src/reviewer.mjs';
import {
  clearReviewerFence,
  DEFAULT_SIGTERM_FENCE_GRACE_SECONDS,
  EXIT_TIMEOUT_SAFETY_SECONDS,
  inspectWatcherExitTimeout,
  listCleanupJobs,
  openReviewerFence,
  parseExitTimeOutFromPlist,
  probeFenceLock,
  readFenceDirAuditEvents,
  resolveFencePaths,
  validateFenceConfig,
  validateWatcherExitTimeout,
  upsertSpawnRecord,
} from '../src/reviewer-fence.mjs';
import {
  processQueuedFenceCleanupJobs,
  sweepReviewerFencesOnStartup,
  waitForActiveReviewerFencesOnSigterm,
} from '../src/watcher.mjs';

const { postGitHubReview } = reviewerTest;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

function makeRootDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('reviewer-side fence is present during gh review post and deleted after success', async () => {
  const rootDir = makeRootDir('reviewer-fence-success-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '11111111-1111-4111-8111-111111111111';
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghp_test',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await postGitHubReview(
        'laceyenterprises/adversarial-review',
        177,
        'body',
        'GH_CLAUDE_REVIEWER_TOKEN',
        async () => {
          const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
          assert.equal(existsSync(jsonPath), true);
          assert.equal(existsSync(lockPath), true);
          assert.equal(probeFenceLock(lockPath).status, 'held');
        },
        {
          rootDir,
          reviewerSpawnToken: spawnToken,
          reviewerIdentity: 'claude-reviewer-lacey',
          prepareReviewWrite: async () => ({ cleared: 0 }),
        },
      );
    });
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(lockPath), false);
    const events = readFenceDirAuditEvents(stateDir).map((entry) => entry.event);
    assert.deepEqual(events, ['fence_open', 'fence_clear']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reviewer-side fence is deleted after failed gh review post without draft handoff', async () => {
  const rootDir = makeRootDir('reviewer-fence-failure-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '22222222-2222-4222-8222-222222222222';
    await withEnv({
      GH_CLAUDE_REVIEWER_TOKEN: 'ghp_test',
      ADVERSARIAL_REVIEW_STATE_DIR: stateDir,
    }, async () => {
      await assert.rejects(
        () => postGitHubReview(
          'laceyenterprises/adversarial-review',
          177,
          'body',
          'GH_CLAUDE_REVIEWER_TOKEN',
          async () => {
            const { jsonPath } = resolveFencePaths(stateDir, spawnToken);
            assert.equal(existsSync(jsonPath), true);
            throw new Error('boom');
          },
          {
            rootDir,
            reviewerSpawnToken: spawnToken,
            reviewerIdentity: 'claude-reviewer-lacey',
            prepareReviewWrite: async () => ({ cleared: 0 }),
          },
        ),
        /boom/,
      );
    });
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    assert.equal(existsSync(jsonPath), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('fs-ext flock integration: EX-held lock blocks SH|NB in another process and SH|NB succeeds after exit', async () => {
  const rootDir = makeRootDir('reviewer-fence-flock-');
  try {
    const lockPath = path.join(rootDir, 'sentinel.lock');
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fsExt = require('fs-ext');
      const fd = fs.openSync(${JSON.stringify(lockPath)}, 'w', 0o600);
      fsExt.flockSync(fd, fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB);
      process.send?.('ready');
      setTimeout(() => process.exit(0), 750);
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });

    await new Promise((resolve) => holder.once('message', resolve));
    assert.equal(probeFenceLock(lockPath).status, 'held');

    await new Promise((resolve) => holder.once('exit', resolve));
    assert.equal(probeFenceLock(lockPath).status, 'free');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM fence wait clears normally when active fence disappears within grace', async () => {
  const rootDir = makeRootDir('watcher-fence-grace-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '33333333-3333-4333-8333-333333333333',
      repo: 'laceyenterprises/adversarial-review',
      pr: 177,
      identity: 'claude-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
    ]]);
    setTimeout(() => fence.clear(), 100);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
    });
    assert.equal(result.status, 'cleared');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM fence wait queues cleanup after grace expires', async () => {
  const rootDir = makeRootDir('watcher-fence-expire-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '44444444-4444-4444-8444-444444444444',
      repo: 'laceyenterprises/adversarial-review',
      pr: 188,
      identity: 'codex-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    ]]);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      sleepImpl: async () => {},
    });
    assert.equal(result.status, 'grace-exceeded');
    assert.equal(listCleanupJobs(stateDir).length, 1);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM preserve mode emits audit without queueing cleanup after grace expires', async () => {
  const rootDir = makeRootDir('watcher-fence-preserve-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '44444444-4444-4444-8444-555555555555',
      repo: 'laceyenterprises/adversarial-review',
      pr: 189,
      identity: 'codex-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN' },
    ]]);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      queueCleanupOnGraceExpiry: false,
      sleepImpl: async () => {},
    });
    assert.equal(result.status, 'grace-exceeded');
    assert.equal(listCleanupJobs(stateDir).length, 0);
    assert.equal(readFenceDirAuditEvents(stateDir).at(-1)?.cleanupQueued, false);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher SIGTERM fence wait treats wall-clock openedAt as stale', async () => {
  const rootDir = makeRootDir('watcher-fence-stale-');
  try {
    const stateDir = path.join(rootDir, 'data');
    openReviewerFence({
      stateDir,
      spawnToken: '55555555-5555-4555-8555-555555555555',
      repo: 'laceyenterprises/adversarial-review',
      pr: 199,
      identity: 'claude-reviewer-lacey',
      openedAt: '2026-05-30T00:00:00.000Z',
    });
    const activeSpawnMap = new Map([[
      '55555555-5555-4555-8555-555555555555',
      {
        spawnToken: '55555555-5555-4555-8555-555555555555',
        repo: 'laceyenterprises/adversarial-review',
        pr: 199,
        identity: 'claude-reviewer-lacey',
        botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
      },
    ]]);
    const result = await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 30,
      staleTtlSeconds: 90,
      activeSpawnMap,
    });
    assert.equal(result.status, 'stale');
    assert.equal(listCleanupJobs(stateDir).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('startup orphan sweep reaps flock-free fences and skips flock-held fences', async () => {
  const rootDir = makeRootDir('watcher-fence-sweep-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const freeToken = '66666666-6666-4666-8666-666666666666';
    const heldFence = openReviewerFence({
      stateDir,
      spawnToken: '88888888-8888-4888-8888-888888888888',
      repo: 'laceyenterprises/adversarial-review',
      pr: 212,
      identity: 'claude-reviewer-lacey',
    });
    const { jsonPath: freeJson, lockPath: freeLock } = resolveFencePaths(stateDir, freeToken);
    writeFileSync(freeLock, '', 'utf8');
    writeFileSync(
      freeJson,
      `${JSON.stringify({
        schemaVersion: 1,
        spawnToken: freeToken,
        repo: 'laceyenterprises/adversarial-review',
        pr: 210,
        identity: 'codex-reviewer-lacey',
        openedAt: new Date().toISOString(),
        expectedClearBy: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );
    upsertSpawnRecord(stateDir, {
      spawnToken: heldFence.record.spawnToken,
      repo: 'laceyenterprises/adversarial-review',
      pr: 212,
      identity: 'claude-reviewer-lacey',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    });

    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 1);
    assert.equal(existsSync(freeJson), false);
    assert.equal(probeFenceLock(resolveFencePaths(stateDir, heldFence.record.spawnToken).lockPath).status, 'held');
    assert.equal(listCleanupJobs(stateDir).length, 1);
    assert.equal(readFenceDirAuditEvents(stateDir).length > 0, true);
    heldFence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('removing fence json before unlock prevents concurrent sweep from queueing cleanup', async () => {
  const rootDir = makeRootDir('watcher-fence-clear-order-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '67676767-6767-4767-8767-676767676767',
      repo: 'laceyenterprises/adversarial-review',
      pr: 214,
      identity: 'claude-reviewer-lacey',
    });
    const { jsonPath } = resolveFencePaths(stateDir, fence.record.spawnToken);
    rmSync(jsonPath, { force: true });
    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 0);
    assert.equal(listCleanupJobs(stateDir).length, 0);
    clearReviewerFence({
      stateDir,
      spawnToken: fence.record.spawnToken,
      lockFd: fence.lockFd,
      record: fence.record,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('processQueuedFenceCleanupJobs drains queued cleanup jobs', async () => {
  const rootDir = makeRootDir('watcher-fence-cleanup-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const fence = openReviewerFence({
      stateDir,
      spawnToken: '77777777-7777-4777-8777-777777777777',
      repo: 'laceyenterprises/adversarial-review',
      pr: 211,
      identity: 'claude-reviewer-lacey',
    });
    const activeSpawnMap = new Map([[
      fence.record.spawnToken,
      { ...fence.record, repo: 'laceyenterprises/adversarial-review', botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN' },
    ]]);
    await waitForActiveReviewerFencesOnSigterm({
      stateDir,
      graceSeconds: 1,
      staleTtlSeconds: 90,
      activeSpawnMap,
      sleepImpl: async () => {},
    });
    const calls = [];
    await processQueuedFenceCleanupJobs({
      stateDir,
      clearPendingReviewsImpl: async (args) => {
        calls.push(args);
        return { cleared: 1 };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].repo, 'laceyenterprises/adversarial-review');
    assert.equal(listCleanupJobs(stateDir).length, 0);
    fence.clear();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('fence config validation rejects stale_TTL below 2 * grace', () => {
  assert.throws(
    () => validateFenceConfig({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS: '35',
      ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS: '60',
    }),
    /must be >= 2 \*/,
  );
});

test('watcher startup plist validation rejects ExitTimeOut below grace + 15', () => {
  const rootDir = makeRootDir('watcher-fence-plist-');
  try {
    const plistPath = path.join(rootDir, 'watcher.plist');
    writeFileSync(
      plistPath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<plist version="1.0"><dict>',
        '<key>ExitTimeOut</key><integer>40</integer>',
        '</dict></plist>',
      ].join('\n'),
      'utf8',
    );
    assert.throws(
      () => validateWatcherExitTimeout({
        ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS: '30',
        ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS: '90',
        ADVERSARIAL_REVIEW_WATCHER_PLIST_PATH: plistPath,
      }),
      /must be >= 45/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('watcher startup plist inspection warns instead of hard-failing when plist path is unavailable', () => {
  const result = inspectWatcherExitTimeout({
    ADVERSARIAL_REVIEW_SIGTERM_FENCE_GRACE_SECONDS: '30',
    ADVERSARIAL_REVIEW_FENCE_STALE_TTL_SECONDS: '90',
  });
  assert.equal(result.ok, false);
  assert.match(result.warning, /cannot self-validate ExitTimeOut/);
});

test('shipped watcher plist ExitTimeOut covers default grace + safety margin', () => {
  const plistPath = path.join(TEST_DIR, '..', 'launchd', 'ai.laceyenterprises.adversarial-watcher.airlock.plist');
  const exitTimeout = parseExitTimeOutFromPlist(readFileSync(plistPath, 'utf8'));
  const grace = validateFenceConfig({}).graceSeconds;
  assert.equal(exitTimeout >= Math.max(45, grace + EXIT_TIMEOUT_SAFETY_SECONDS), true);
  assert.equal(exitTimeout >= (DEFAULT_SIGTERM_FENCE_GRACE_SECONDS + EXIT_TIMEOUT_SAFETY_SECONDS), true);
});

test('token-known scope across restart uses persisted spawn-record union', async () => {
  const rootDir = makeRootDir('watcher-fence-known-scope-');
  try {
    const stateDir = path.join(rootDir, 'data');
    const spawnToken = '99999999-9999-4999-8999-999999999999';
    const { jsonPath, lockPath } = resolveFencePaths(stateDir, spawnToken);
    writeFileSync(lockPath, '', 'utf8');
    writeFileSync(
      jsonPath,
      `${JSON.stringify({
        schemaVersion: 1,
        spawnToken,
        repo: 'laceyenterprises/adversarial-review',
        pr: 213,
        identity: 'claude-reviewer-lacey',
        openedAt: new Date().toISOString(),
        expectedClearBy: new Date(Date.now() + 60_000).toISOString(),
      }, null, 2)}\n`,
      'utf8',
    );
    upsertSpawnRecord(stateDir, {
      spawnToken,
      repo: 'laceyenterprises/adversarial-review',
      pr: 213,
      identity: 'claude-reviewer-lacey',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    });
    const orphaned = await sweepReviewerFencesOnStartup({
      stateDir,
      staleTtlSeconds: 90,
      activeSpawnMap: new Map(),
    });
    assert.equal(orphaned, 1);
    assert.equal(listCleanupJobs(stateDir).length, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
