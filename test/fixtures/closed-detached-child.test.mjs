import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('closed detached groups are removed before teardown', async () => {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'close');

  const originalKill = process.kill;
  const recycledGroupSignals = [];
  process.kill = (target, signal) => {
    if (target === -pid) {
      recycledGroupSignals.push(signal);
      return true;
    }
    return originalKill(target, signal);
  };
  test.after(() => {
    process.kill = originalKill;
    assert.deepEqual(recycledGroupSignals, []);
  });
});
