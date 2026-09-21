import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWatcherWakeSource,
  requestWatcherWake,
  watcherWakeMatchesSubject,
  watcherWakePath,
} from '../src/watcher-wake.mjs';
import { createHandoffRateLimiter } from '../src/handoff-rate-cap.mjs';

test('watcher wake interrupts scheduled wait in under five seconds', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-'));
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
  });

  try {
    const startedAt = Date.now();
    const waitPromise = wakeSource.wait(300_000);
    setTimeout(() => {
      requestWatcherWake({
        rootDir,
        reason: 'remediation-to-rereview',
        repo: 'laceyenterprises/clio',
        prNumber: 7,
        requestedAt: '2026-04-21T10:05:00.000Z',
        requestId: 'test-wake',
      });
    }, 50);

    const result = await waitPromise;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.woken, true);
    assert.equal(result.reason, 'wake-file');
    assert.equal(result.payload.reason, 'remediation-to-rereview');
    assert.equal(result.payload.repo, 'laceyenterprises/clio');
    assert.equal(result.payload.pr_number, 7);
    assert.ok(elapsedMs < 5000, `expected wake under 5s, got ${elapsedMs}ms`);
    assert.equal(watcherWakePath(rootDir), path.join(rootDir, 'data', 'watcher-wake.json'));
  } finally {
    wakeSource.close();
  }
});

test('watcher wake wait preserves normal timeout path when no wake is written', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-'));
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
  });

  try {
    const result = await wakeSource.wait(20);
    assert.deepEqual(result, { woken: false, reason: 'timeout' });
  } finally {
    wakeSource.close();
  }
});

test('watcher wake can consume the latest file on daemon startup', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-'));
  requestWatcherWake({
    rootDir,
    reason: 'hammer-pr-eligible',
    repo: 'laceyenterprises/agent-os',
    prNumber: 6654,
    headSha: 'head-a',
    requestId: 'startup-wake',
  });
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
    consumeExistingOnStart: true,
  });

  try {
    const result = await wakeSource.wait(50);
    assert.equal(result.woken, true);
    assert.equal(result.payload.request_id, 'startup-wake');
    assert.equal(result.payload.repo, 'laceyenterprises/agent-os');
    assert.equal(result.payload.pr_number, 6654);
  } finally {
    wakeSource.close();
  }
});

test('watcher wake dedupes by request_id instead of file mtime and size', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-'));
  requestWatcherWake({
    rootDir,
    reason: 'remediation-to-rereview',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    requestedAt: '2026-04-21T10:05:00.000Z',
    requestId: 'wake-a',
  });
  const filePath = watcherWakePath(rootDir);
  const originalStat = statSync(filePath);
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
  });

  try {
    requestWatcherWake({
      rootDir,
      reason: 'remediation-to-rereview',
      repo: 'laceyenterprises/clio',
      prNumber: 7,
      requestedAt: '2026-04-21T10:05:00.000Z',
      requestId: 'wake-b',
    });
    utimesSync(filePath, originalStat.atime, originalStat.mtime);

    const result = await wakeSource.wait(50);
    assert.equal(result.woken, true);
    assert.equal(result.reason, 'wake-file');
    assert.equal(result.payload.request_id, 'wake-b');
  } finally {
    wakeSource.close();
  }
});

test('watcher wake subject matching is repo, PR, and optional head scoped', () => {
  const payload = {
    repo: 'laceyenterprises/agent-os',
    pr_number: 6654,
    head_sha: 'head-a',
  };

  assert.equal(
    watcherWakeMatchesSubject(payload, {
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 6654,
      headSha: 'head-a',
    }),
    true,
  );
  assert.equal(
    watcherWakeMatchesSubject(payload, {
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 6654,
      headSha: 'head-b',
    }),
    false,
  );
  assert.equal(
    watcherWakeMatchesSubject({ repo: 'laceyenterprises/agent-os', pr_number: 6654 }, {
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 6654,
      headSha: 'head-b',
    }),
    true,
  );
  assert.equal(
    watcherWakeMatchesSubject(payload, {
      repoPath: 'laceyenterprises/adversarial-review',
      prNumber: 6654,
      headSha: 'head-a',
    }),
    false,
  );
});

test('watcher wake dedupes request_id-less payloads by content hash', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-'));
  const filePath = watcherWakePath(rootDir);
  requestWatcherWake({
    rootDir,
    reason: 'remediation-to-rereview',
    repo: 'laceyenterprises/clio',
    prNumber: 7,
    requestedAt: '2026-04-21T10:05:00.000Z',
    requestId: 'wake-a',
  });
  const originalStat = statSync(filePath);
  writeFileSync(
    filePath,
    JSON.stringify({
      schema_version: 1,
      requested_at: '2026-04-21T10:05:00.000Z',
      reason: 'remediation-to-rereview',
      repo: 'laceyenterprises/clio',
      pr_number: 8,
    }),
    'utf8',
  );
  utimesSync(filePath, originalStat.atime, originalStat.mtime);
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
  });

  try {
    writeFileSync(
      filePath,
      JSON.stringify({
        schema_version: 1,
        requested_at: '2026-04-21T10:05:00.000Z',
        reason: 'remediation-to-rereview',
        repo: 'laceyenterprises/clio',
        pr_number: 9,
      }),
      'utf8',
    );
    utimesSync(filePath, originalStat.atime, originalStat.mtime);

    const result = await wakeSource.wait(50);
    assert.equal(result.woken, true);
    assert.equal(result.reason, 'wake-file');
    assert.equal(result.payload.pr_number, 9);
  } finally {
    wakeSource.close();
  }
});

test('watcher wake caps one PR head without starving another PR head', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-'));
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
    rateLimiter: createHandoffRateLimiter({
      rootDir,
      maxPerPrHead: 1,
      logger: { warn() {} },
    }),
    loadConfigImpl: () => ({
      getHandoffConfig: () => ({ enabled: true, maxPerPrHead: 1 }),
    }),
  });

  try {
    requestWatcherWake({
      rootDir,
      reason: 'remediation-to-rereview',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 57,
      headSha: 'head-a',
      requestId: 'storm-a-1',
    });
    assert.equal((await wakeSource.wait(50)).woken, true);

    requestWatcherWake({
      rootDir,
      reason: 'remediation-to-rereview',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 57,
      headSha: 'head-a',
      requestId: 'storm-a-2',
    });
    assert.deepEqual(await wakeSource.wait(20), { woken: false, reason: 'timeout' });

    requestWatcherWake({
      rootDir,
      reason: 'remediation-to-rereview',
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 58,
      headSha: 'head-b',
      requestId: 'first-pass-other-pr',
    });
    const other = await wakeSource.wait(50);
    assert.equal(other.woken, true);
    assert.equal(other.payload.pr_number, 58);
    assert.equal(other.payload.head_sha, 'head-b');
  } finally {
    wakeSource.close();
  }
});

test('watcher main loop does not gate wake-file sleeps behind handoff config', () => {
  const watcherSource = readFileSync(
    new URL('../src/watcher.mjs', import.meta.url),
    'utf8',
  );

  assert.match(watcherSource, /const wake = await watcherWakeSource\.wait\(sleepMs\);/);
  assert.doesNotMatch(
    watcherSource,
    /if\s*\(\s*resolveWatcherHandoffEnabled\([^)]*\)\s*\)\s*{\s*const wake = await watcherWakeSource\.wait\(sleepMs\);/s,
  );
});

// The poll loop computes its sleep as `Math.max(0, nextStart - Date.now())`, so a
// poll that overruns the poll interval makes every subsequent call `wait(0)`. If a
// zero-length wait returns without reading the wake file, a slow poll blinds the
// wake path permanently: the file is never opened, `lastSeen` never advances, and
// pending subjects accumulate forever. Observed on the reference host as 64
// stranded subjects with zero `wake pollOnce` entries in the watcher log.
test('a zero-length wait still observes a pending wake (overrunning poll must not blind the wake path)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-zero-'));
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
  });

  try {
    requestWatcherWake({
      rootDir,
      reason: 'clean-verdict-to-hammer',
      repo: 'laceyenterprises/agent-os',
      prNumber: 6943,
      requestedAt: '2026-09-21T02:49:38.501Z',
      requestId: 'zero-timeout-wake',
    });

    const result = await wakeSource.wait(0);

    assert.equal(result.woken, true, 'wait(0) must still observe a pending wake');
    assert.equal(result.reason, 'wake-file');
    assert.equal(result.payload?.pr_number, 6943);
  } finally {
    wakeSource.close();
  }
});

test('a zero-length wait does not block when there is no pending wake', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'watcher-wake-zero-none-'));
  const wakeSource = createWatcherWakeSource({
    rootDir,
    logger: { warn() {} },
    pollMs: 100,
  });

  try {
    const startedAt = Date.now();
    const result = await wakeSource.wait(0);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.woken, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(elapsedMs < 1_000, `wait(0) must not block, took ${elapsedMs}ms`);
  } finally {
    wakeSource.close();
  }
});
