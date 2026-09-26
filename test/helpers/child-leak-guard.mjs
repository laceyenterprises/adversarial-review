// Preloaded in each node:test worker. Track children at spawn time so a test
// failure cannot silently leave a detached fixture running after the file ends.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import test from 'node:test';

function describeSpawn(stack) {
  const frames = stack?.split('\n').slice(2) || [];
  const frame = frames.find((line) => line.includes('.test.mjs'))
    || frames.find((line) => line.includes('/test/')) || 'unknown test';
  const match = frame.match(/(\/[^():]+\.test\.mjs):(\d+):\d+/);
  if (!match) return frame.trim();
  try {
    const source = readFileSync(match[1], 'utf8').split('\n').slice(0, Number(match[2]));
    const declaration = source.reverse().find((line) => /\btest\(['"`]/.test(line));
    const name = declaration?.match(/\btest\(['"`]([^'"`]+)/)?.[1];
    return `${name || 'test'} at ${match[1]}:${match[2]}`;
  } catch {
    return frame.trim();
  }
}

if (process.env.NODE_TEST_CONTEXT) {
  const children = new Map();
  function recordChild(child, args, stack) {
    if (!child?.pid) return;
    const detached = args.some((arg) => arg?.detached === true);
    children.set(child.pid, { child, detached, stack });
    child.once('close', () => {
      if (!detached) children.delete(child.pid);
    });
  }

  for (const method of ['spawn', 'fork', 'exec', 'execFile']) {
    const original = childProcess[method];
    function trackedChild(...args) {
      const stack = describeSpawn(new Error().stack);
      const child = original.apply(this, args);
      recordChild(child, args, stack);
      return child;
    }
    // exec and execFile expose a custom promisify adapter that resolves to
    // { stdout, stderr }. Keep it when replacing the builtin ESM export.
    if (original[promisify.custom]) {
      trackedChild[promisify.custom] = function trackedPromise(...args) {
        const stack = describeSpawn(new Error().stack);
        const result = original[promisify.custom].apply(this, args);
        recordChild(result.child, args, stack);
        return result;
      };
    }
    childProcess[method] = trackedChild;
  }
  syncBuiltinESMExports();

  test.after(async () => {
    const leaked = [];
    for (const [pid, entry] of children) {
      const { child, detached, stack } = entry;
      // Some adapters reject on a buffer limit before their SIGKILL has
      // delivered the child's close event. Let in-flight teardown finish.
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise((resolve) => child.once('close', resolve)),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      let alive = false;
      try {
        process.kill(detached ? -pid : pid, 0);
        alive = true;
      } catch (error) {
        if (error.code === 'EPERM') alive = child.exitCode === null && child.signalCode === null;
        else if (error.code !== 'ESRCH') throw error;
      }
      if (!alive) continue;
      leaked.push(`${pid} (${detached ? 'process group' : 'process'}) spawned at ${stack.trim()}`);
      const closed = child.exitCode === null && child.signalCode === null
        ? new Promise((resolve) => child.once('close', resolve))
        : Promise.resolve();
      try {
        process.kill(detached ? -pid : pid, 'SIGKILL');
      } catch (error) {
        if (error.code === 'EPERM' && detached) child.kill('SIGKILL');
        else if (error.code !== 'ESRCH') throw error;
      }
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    if (leaked.length) throw new Error(`Leaked test children:\n${leaked.join('\n')}`);
  });
}
