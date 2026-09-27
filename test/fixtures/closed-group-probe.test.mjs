import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('closed detached leader is not probed or signalled', async () => {
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  const originalKill = process.kill;
  process.kill = (target, signal) => {
    if (target !== -pid) return originalKill(target, signal);
    throw new Error(`unsafe group ${signal === 0 ? 'probe' : 'kill'} attempted`);
  };
  test.after(() => { process.kill = originalKill; });
  await once(child, 'close');
});
