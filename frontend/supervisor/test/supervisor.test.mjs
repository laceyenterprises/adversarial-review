/**
 * ARF-08: the process manager.
 *
 * These spawn real processes and kill them. A supervisor tested against a
 * spawn double proves the bookkeeping and nothing about the thing that
 * matters — whether a child that is actually gone actually comes back — so the
 * restart cases here send real signals to real pids and read the pid log the
 * children write.
 *
 * The properties:
 *
 *  - a killed child is restarted, as a *new* process;
 *  - a child that dies fast, repeatedly, backs off and then stops, rather than
 *    spinning forever and burying the one useful error;
 *  - a child that has been up a while has its backoff forgiven;
 *  - shutdown terminates everything, escalating to SIGKILL for a child that
 *    ignores SIGTERM;
 *  - the status file records the pid and start time per child, which is the
 *    fact ARF-04's "has this daemon restarted since the config changed" check
 *    has no other way to get;
 *  - two supervisors cannot manage one state root.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { loadConfig } from '../../server/src/config.mjs';
import { Supervisor, readStatusFile } from '../src/supervisor.mjs';
import { resolveProgramSet } from '../src/programs.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Poll until `predicate` holds, or fail with what it was still seeing. */
async function until(predicate, { timeoutMs = 8000, describeState = () => '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      assert.fail(`condition not met within ${timeoutMs}ms ${describeState()}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function pids(pidLog) {
  try {
    return readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * A supervisor over one fixture program, with the ARF server switched off so
 * the test is about the supervision and not about booting an HTTP service.
 */
function harness(fixture, { restart = {}, programOverrides = {} } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'arf-sup-'));
  const pidLog = join(stateRoot, 'pids.log');
  writeFileSync(join(stateRoot, 'config.json'), JSON.stringify({
    supervisor: {
      serverEnabled: false,
      restart: { initialDelayMs: 20, maxDelayMs: 80, healthyAfterMs: 500, maxConsecutiveFailures: 3, ...restart },
      programs: [{
        id: 'child',
        role: 'aux',
        command: process.execPath,
        args: [join(FIXTURES, fixture)],
        env: { PID_LOG: pidLog },
        ...programOverrides,
      }],
    },
  }));
  const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot } });
  const supervisor = new Supervisor({ programs: resolveProgramSet({ config }), config });
  return { stateRoot, pidLog, config, supervisor };
}

describe('supervisor: restarting a killed child', () => {
  it('brings back a child killed with SIGKILL, as a new process', async () => {
    const { supervisor, pidLog } = harness('long-lived.mjs');
    supervisor.start();
    try {
      await until(() => pids(pidLog).length === 1);
      const [first] = pids(pidLog);

      // SIGKILL, not SIGTERM: an uncatchable signal is the honest test. A child
      // that exits cleanly on SIGTERM could be "restarted" by a supervisor that
      // merely never noticed it was gone.
      process.kill(first, 'SIGKILL');

      await until(() => pids(pidLog).length === 2, { describeState: () => `pids=${pids(pidLog)}` });
      const [, second] = pids(pidLog);
      assert.notEqual(second, first, 'the restart must be a new process, not a re-reported old pid');

      const status = supervisor.status().programs[0];
      assert.equal(status.state, 'running');
      assert.equal(status.pid, second);
      assert.equal(status.restarts, 1);
      assert.equal(status.lastExit.signal, 'SIGKILL');
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('keeps restarting across repeated kills', async () => {
    const { supervisor, pidLog } = harness('long-lived.mjs');
    supervisor.start();
    try {
      for (let round = 1; round <= 3; round += 1) {
        await until(() => pids(pidLog).length === round);
        process.kill(pids(pidLog)[round - 1], 'SIGKILL');
      }
      await until(() => pids(pidLog).length === 4);
      assert.equal(new Set(pids(pidLog)).size, 4, 'every restart is a distinct process');
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('does not restart a child declared autoRestart: false', async () => {
    const { supervisor, pidLog } = harness('long-lived.mjs', {
      programOverrides: { autoRestart: false },
    });
    supervisor.start();
    try {
      await until(() => pids(pidLog).length === 1);
      process.kill(pids(pidLog)[0], 'SIGKILL');
      await until(() => supervisor.status().programs[0].state === 'stopped');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(pids(pidLog).length, 1);
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });
});

describe('supervisor: crash loops', () => {
  it('gives up after the configured consecutive failures, and says so', async () => {
    // Restarting a misconfigured binary forever pins a core and buries the one
    // useful error under thousands of identical ones.
    // `healthyAfterMs` is set past any plausible spawn cost: a cold Node start
    // that happened to exceed it would be counted as a healthy run, reset the
    // failure count, and buy one extra restart — making the assertion below
    // flaky for a reason that has nothing to do with the property under test.
    const { supervisor, pidLog } = harness('crashes.mjs', { restart: { healthyAfterMs: 60_000 } });
    const failures = [];
    supervisor.on('failed', (event) => failures.push(event));
    supervisor.start();
    try {
      await until(() => failures.length === 1, {
        describeState: () => `state=${supervisor.status().programs[0].state} pids=${pids(pidLog).length}`,
      });
      const status = supervisor.status().programs[0];
      assert.equal(status.state, 'failed');
      assert.equal(status.lastExit.code, 7, 'the exit code that explains it is retained');
      // maxConsecutiveFailures=3 means three restarts, then the fourth failure
      // is the one that gives up.
      assert.equal(pids(pidLog).length, 4);

      await new Promise((r) => setTimeout(r, 200));
      assert.equal(pids(pidLog).length, 4, 'a failed program stays failed');
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('backs off exponentially, bounded by maxDelayMs', async () => {
    const { supervisor } = harness('crashes.mjs', {
      restart: { initialDelayMs: 10, maxDelayMs: 40, maxConsecutiveFailures: 6, healthyAfterMs: 60_000 },
    });
    const delays = [];
    supervisor.on('exited', () => delays.push(supervisor.status().programs[0].backoffMs));
    supervisor.start();
    try {
      await until(() => supervisor.status().programs[0].state === 'failed');
      const observed = delays.filter((ms) => ms > 0);
      assert.deepEqual(observed.slice(0, 4), [10, 20, 40, 40], `saw ${observed}`);
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('forgives the backoff for a child that stayed up', async () => {
    // A process that crashes once an hour is not a crash loop, and treating it
    // as one would leave it waiting the maximum delay for an unrelated failure.
    const { supervisor, pidLog } = harness('long-lived.mjs', {
      restart: { initialDelayMs: 10, maxDelayMs: 40, healthyAfterMs: 50, maxConsecutiveFailures: 3 },
    });
    supervisor.start();
    try {
      await until(() => pids(pidLog).length === 1);
      await new Promise((r) => setTimeout(r, 120));
      process.kill(pids(pidLog)[0], 'SIGKILL');
      await until(() => pids(pidLog).length === 2);
      assert.equal(supervisor.status().programs[0].consecutiveFailures, 1);

      await new Promise((r) => setTimeout(r, 120));
      process.kill(pids(pidLog)[1], 'SIGKILL');
      await until(() => pids(pidLog).length === 3);
      assert.equal(
        supervisor.status().programs[0].consecutiveFailures, 1,
        'a healthy run resets the count, so this is a first failure again',
      );
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('treats a command that cannot be spawned as a failure, not a hang', async () => {
    const { supervisor } = harness('long-lived.mjs', {
      programOverrides: { command: join(FIXTURES, 'no-such-binary') },
    });
    const failures = [];
    supervisor.on('failed', (event) => failures.push(event));
    supervisor.start();
    try {
      await until(() => failures.length === 1);
      assert.match(supervisor.status().programs[0].lastExit.error, /ENOENT|spawn/i);
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });
});

describe('supervisor: shutdown', () => {
  it('stops a well-behaved child on SIGTERM', async () => {
    const { supervisor, pidLog } = harness('long-lived.mjs');
    supervisor.start();
    await until(() => pids(pidLog).length === 1);
    const [pid] = pids(pidLog);

    await supervisor.stop({ timeoutMs: 2000 });
    assert.equal(supervisor.status().programs[0].state, 'stopped');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const { supervisor, pidLog } = harness('ignores-sigterm.mjs');
    supervisor.start();
    await until(() => pids(pidLog).length === 1);
    const [pid] = pids(pidLog);

    const started = Date.now();
    await supervisor.stop({ timeoutMs: 200 });
    assert.ok(Date.now() - started >= 200, 'SIGTERM is given its chance first');
    assert.equal(supervisor.status().programs[0].lastExit.signal, 'SIGKILL');
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  it('does not restart a child it stopped on purpose', async () => {
    const { supervisor, pidLog } = harness('long-lived.mjs');
    supervisor.start();
    await until(() => pids(pidLog).length === 1);

    await supervisor.stop({ timeoutMs: 2000 });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(pids(pidLog).length, 1);
  });

  it('cancels a pending restart rather than spawning after shutdown', async () => {
    // A child killed while the supervisor is coming down would otherwise be
    // restarted by a timer that outlived the shutdown, leaving an orphan.
    const { supervisor, pidLog } = harness('long-lived.mjs', {
      restart: { initialDelayMs: 300, maxDelayMs: 300 },
    });
    supervisor.start();
    await until(() => pids(pidLog).length === 1);
    process.kill(pids(pidLog)[0], 'SIGKILL');
    await until(() => supervisor.status().programs[0].state === 'backoff');

    await supervisor.stop({ timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pids(pidLog).length, 1, 'the pending restart did not fire after shutdown');
  });
});

describe('supervisor: the status file', () => {
  it('records the pid and start time per child', async () => {
    // This is the fact ARF-04's adoption check has no other source for: whether
    // a daemon started before or after the governance config changed.
    const { supervisor, config, pidLog } = harness('long-lived.mjs');
    supervisor.start();
    try {
      await until(() => pids(pidLog).length === 1);
      await until(() => readStatusFile(config.supervisor.runDir)?.programs?.[0]?.pid);

      const status = readStatusFile(config.supervisor.runDir);
      assert.equal(status.supervisor.pid, process.pid);
      assert.equal(status.supervisor.gatePath, config.governance.gatePath);
      const child = status.programs[0];
      assert.equal(child.id, 'child');
      assert.equal(child.pid, pids(pidLog)[0]);
      assert.ok(Date.parse(child.startedAt) > 0);
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('moves the start time forward on a restart', async () => {
    const { supervisor, config, pidLog } = harness('long-lived.mjs');
    supervisor.start();
    try {
      await until(() => pids(pidLog).length === 1);
      const first = readStatusFile(config.supervisor.runDir).programs[0].startedAt;

      await new Promise((r) => setTimeout(r, 20));
      process.kill(pids(pidLog)[0], 'SIGKILL');
      await until(() => pids(pidLog).length === 2);
      await until(() => readStatusFile(config.supervisor.runDir).programs[0].startedAt !== first);

      const second = readStatusFile(config.supervisor.runDir).programs[0];
      assert.ok(Date.parse(second.startedAt) > Date.parse(first));
      assert.equal(second.restarts, 1);
    } finally {
      await supervisor.stop({ timeoutMs: 1000 });
    }
  });

  it('returns null rather than throwing when there is no status file', () => {
    assert.equal(readStatusFile(mkdtempSync(join(tmpdir(), 'arf-nostatus-'))), null);
  });
});

describe('supervisor: one supervisor per state root', () => {
  it('refuses to start beside a live supervisor', async () => {
    const { supervisor, config } = harness('long-lived.mjs');
    supervisor.acquireInstanceLock();
    try {
      const second = new Supervisor({ programs: resolveProgramSet({ config }), config });
      assert.throws(
        () => second.acquireInstanceLock(),
        (err) => err.code === 'already_running' && err.message.includes(String(process.pid)),
      );
    } finally {
      supervisor.releaseInstanceLock();
    }
  });

  it('takes over a pidfile whose process is gone', async () => {
    // A machine that lost power mid-run must not need a manual file removal
    // before ARF will start again.
    const { supervisor, config } = harness('long-lived.mjs');
    mkdirSync(config.supervisor.runDir, { recursive: true });
    // pid 2^22 is above every real pid on macOS and Linux.
    writeFileSync(join(config.supervisor.runDir, 'supervisor.pid'), '4194304\n');
    supervisor.acquireInstanceLock();
    supervisor.releaseInstanceLock();
  });

  it('releases the lock on shutdown', async () => {
    const { supervisor, config } = harness('long-lived.mjs');
    supervisor.acquireInstanceLock();
    supervisor.start();
    await supervisor.stop({ timeoutMs: 1000 });

    const next = new Supervisor({ programs: resolveProgramSet({ config }), config });
    next.acquireInstanceLock();
    next.releaseInstanceLock();
  });
});
