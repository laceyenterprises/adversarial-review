import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnCapturedProcessGroup } from '../src/process-group-spawn.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

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

test('progress watchdog producer output classifies as reviewer-timeout', async () => {
  await assert.rejects(
    () => spawnCapturedProcessGroup(
      'bash',
      ['-c', 'trap "" TERM; echo "stalled reviewer" >&2; while :; do sleep 1; done'],
      {
        progressTimeout: 250,
        killGraceMs: 250,
        timeout: 10_000,
      }
    ),
    (err) => {
      assert.equal(
        classifyReviewerFailure(
          err.message,
          err.exitCode ?? err.code,
          err.code
        ),
        'reviewer-timeout'
      );
      assert.equal(
        classifyReviewerFailure(
          `LiteLLM retry pool: all upstream attempts failed; ${err.message}`,
          err.exitCode ?? err.code,
          err.code
        ),
        'cascade'
      );
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

test('maxBuffer kills stdout side-channel writers before reading the full file', async () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'process-group-side-channel-'));
  const stdoutPath = path.join(fixtureDir, 'reviewer.stdout');
  const stderrPath = path.join(fixtureDir, 'reviewer.stderr');

  try {
    await assert.rejects(
      () => spawnCapturedProcessGroup(
        process.execPath,
        [
          '-e',
          [
            'const chunk = "x".repeat(4096);',
            'setInterval(() => { process.stdout.write(chunk); }, 1);',
            'setInterval(() => {}, 1000);',
          ].join(''),
        ],
        {
          stdoutPath,
          stderrPath,
          maxBuffer: 8 * 1024,
          progressTimeout: 0,
          killGraceMs: 100,
        }
      ),
      (err) => {
        assert.match(err.message, /maxBuffer exceeded \(8192 bytes; saw \d+ bytes\)/);
        assert.equal(err.killed, true);
        assert.ok(Buffer.byteLength(err.stdout || '', 'utf8') <= (8 * 1024));
        assert.match(err.stdout || '', /^\[truncated to last 8192 bytes\]/);
        return true;
      }
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
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
  assert.notEqual(handles[0].pgid, process.pid);
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

test('detached reviewer process group survives parent SIGTERM for daemon bounce adoption', async () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'process-group-exit-'));
  const bashPidPath = path.join(fixtureDir, 'bash.pid');
  const sleepPidPath = path.join(fixtureDir, 'sleep.pid');
  const stdoutPath = path.join(fixtureDir, 'stdout.log');
  const stderrPath = path.join(fixtureDir, 'stderr.log');
  let bashPid = null;

  try {
    const script = `
      import { spawnCapturedProcessGroup } from ${JSON.stringify(new URL('../src/process-group-spawn.mjs', import.meta.url).pathname)};
      import { existsSync } from 'node:fs';
      const [bashPidPath, sleepPidPath, stdoutPath, stderrPath] = process.argv.slice(-4);
      spawnCapturedProcessGroup(
        'bash',
        ['-c', \`trap "" HUP TERM; sleep 30 & echo $! > "\${sleepPidPath}"; echo $$ > "\${bashPidPath}"; wait\`],
        { stdoutPath, stderrPath, progressTimeout: 0, timeout: 0 }
      );
      const ready = setInterval(() => {
        if (existsSync(bashPidPath) && existsSync(sleepPidPath)) {
          clearInterval(ready);
        }
      }, 10);
      setTimeout(() => {
        clearInterval(ready);
        process.exit(2);
      }, 2_000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, bashPidPath, sleepPidPath, stdoutPath, stderrPath], {
      stdio: 'ignore',
    });

    await waitFor(() => {
      assert.equal(existsSync(bashPidPath), true);
      assert.equal(existsSync(sleepPidPath), true);
    }, { timeoutMs: 5_000, intervalMs: 25 });

    bashPid = Number.parseInt(readFileSync(bashPidPath, 'utf8').trim(), 10);
    const sleepPid = Number.parseInt(readFileSync(sleepPidPath, 'utf8').trim(), 10);
    assert.equal(Number.isInteger(bashPid), true);
    assert.equal(Number.isInteger(sleepPid), true);
    await waitFor(() => {
      assert.equal(processExists(bashPid), true);
      assert.equal(processExists(sleepPid), true);
    }, { timeoutMs: 5_000, intervalMs: 50 });

    child.kill('SIGTERM');
    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });

    await waitFor(() => {
      assert.equal(processExists(bashPid), true);
      assert.equal(processExists(sleepPid), true);
    }, { timeoutMs: 5_000, intervalMs: 50 });
  } finally {
    if (Number.isInteger(bashPid)) {
      try {
        process.kill(-bashPid, 'SIGKILL');
      } catch (err) {
        if (err?.code !== 'ESRCH') throw err;
      }
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
