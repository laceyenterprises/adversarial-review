import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseDaemonWaiterLifecycle } from './helpers/daemon-waiter-lifecycle.mjs';

for (const change of ['hold', 'head', 'terminal']) {
  for (const keepHolder of [false, true]) {
    test(`LAC-2087 ${change} bypasses next acquire with live watcher PID; holder=${keepHolder}`, async t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'daemon-waiter-lifecycle-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      await exerciseDaemonWaiterLifecycle(rootDir, change, { keepHolder });
    });
  }
}

test('LAC-2087 abandoned waiter cleanup preserves another live daemon and closer FIFO order', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'daemon-waiter-lifecycle-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  await exerciseDaemonWaiterLifecycle(rootDir, 'hold', { sibling: true });
});

test('LAC-2087 soft deadline preserves a concrete active closure; its eventual exit cleans up', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'daemon-waiter-lifecycle-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  await exerciseDaemonWaiterLifecycle(rootDir, 'deadline');
});
