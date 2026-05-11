import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnCapturedProcessGroup } from '../src/process-group-spawn.mjs';

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    throw err;
  }
}

async function waitFor(assertion, { timeoutMs = 5_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError || new Error('waitFor timed out');
}

test('progress watchdog escalates SIGTERM-ignoring children to process-group SIGKILL and preserves stderr', async () => {
  const progressTimeout = 250;
  const killGraceMs = 250;
  const startedAt = Date.now();

  await assert.rejects(
    () => spawnCapturedProcessGroup(
      'bash',
      ['-c', 'trap "" TERM; echo "auth probe failed: token expired" >&2; while :; do sleep 1; done'],
      {
        progressTimeout,
        killGraceMs,
        timeout: 10_000,
      }
    ),
    (err) => {
      const elapsed = Date.now() - startedAt;
      assert.equal(err.progressTimedOut, true);
      assert.equal(err.killed, true);
      assert.equal(err.signal, 'SIGKILL');
      assert.ok(elapsed < progressTimeout + killGraceMs + 1_500, `elapsed ${elapsed}ms exceeded watchdog budget`);
      assert.match(err.message, /no output/);
      assert.match(err.message, /auth probe failed: token expired/);
      assert.match(err.stderr, /auth probe failed: token expired/);
      return true;
    }
  );
});

test('pre-spawn abort still kills the detached process group once pid is available', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => spawnCapturedProcessGroup(
      'bash',
      ['-c', 'trap "" TERM; while :; do sleep 1; done'],
      {
        signal: controller.signal,
        killGraceMs: 100,
      }
    ),
    (err) => {
      assert.equal(err.aborted, true);
      assert.equal(err.code, 'ABORT_ERR');
      assert.equal(err.killed, true);
      assert.match(String(err.signal || ''), /SIGTERM|SIGKILL/);
      return true;
    }
  );
});

test('maxBuffer enforces a byte ceiling for multibyte output', async () => {
  await assert.rejects(
    () => spawnCapturedProcessGroup(
      process.execPath,
      ['-e', 'process.stdout.write("€".repeat(3));'],
      { maxBuffer: 8 }
    ),
    (err) => {
      assert.match(err.message, /maxBuffer exceeded \(8 bytes\)/);
      return true;
    }
  );
});

test('unsupported options fail loudly instead of being ignored', async () => {
  await assert.rejects(
    Promise.resolve().then(() => (
      spawnCapturedProcessGroup(process.execPath, ['-e', ''], { killSignal: 'SIGTERM' })
    )),
    /Unsupported spawnCapturedProcessGroup options: killSignal/
  );
});

test('onSpawn receives the detached reviewer process group id', async () => {
  const handles = [];

  await spawnCapturedProcessGroup(
    process.execPath,
    ['-e', ''],
    {
      onSpawn: (handle) => handles.push(handle),
    }
  );

  assert.equal(handles.length, 1);
  assert.equal(Number.isInteger(handles[0].pid), true);
  assert.equal(handles[0].pgid, handles[0].pid);
});

test('onSpawn failures kill the detached process group and reject', async () => {
  await assert.rejects(
    () => spawnCapturedProcessGroup(
      'bash',
      ['-c', 'trap "" TERM; while :; do sleep 1; done'],
      {
        killGraceMs: 100,
        onSpawn: () => {
          throw new Error('persist pgid failed');
        },
      }
    ),
    /onSpawn callback failed: persist pgid failed/
  );
});

test('exit-time cleanup kills detached grandchildren when the parent process exits abruptly', async () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'process-group-exit-'));
  const bashPidPath = path.join(fixtureDir, 'bash.pid');
  const sleepPidPath = path.join(fixtureDir, 'sleep.pid');

  try {
    const script = `
      import { spawnCapturedProcessGroup } from ${JSON.stringify(new URL('../src/process-group-spawn.mjs', import.meta.url).pathname)};
      import { existsSync } from 'node:fs';
      const [bashPidPath, sleepPidPath] = process.argv.slice(-2);
      spawnCapturedProcessGroup('bash', ['-c', \`sleep 30 & echo $! > "\${sleepPidPath}"; echo $$ > "\${bashPidPath}"; wait\`]);
      const ready = setInterval(() => {
        if (existsSync(bashPidPath) && existsSync(sleepPidPath)) {
          clearInterval(ready);
          process.exit(0);
        }
      }, 10);
      setTimeout(() => {
        clearInterval(ready);
        process.exit(2);
      }, 2_000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, bashPidPath, sleepPidPath], {
      stdio: 'ignore',
    });

    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });

    assert.equal(child.exitCode, 0);

    const bashPid = Number.parseInt(readFileSync(bashPidPath, 'utf8').trim(), 10);
    const sleepPid = Number.parseInt(readFileSync(sleepPidPath, 'utf8').trim(), 10);
    assert.equal(Number.isInteger(bashPid), true);
    assert.equal(Number.isInteger(sleepPid), true);

    await waitFor(() => {
      assert.equal(processExists(bashPid), false);
      assert.equal(processExists(sleepPid), false);
    }, { timeoutMs: 5_000, intervalMs: 50 });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
