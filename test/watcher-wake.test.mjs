import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
