import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWatcherWakeSource,
  requestWatcherWake,
  watcherWakePath,
} from '../src/watcher-wake.mjs';

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
