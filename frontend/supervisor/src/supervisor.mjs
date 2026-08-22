/**
 * ARF's process manager (ARF-08, SPEC §9).
 *
 * Standalone ARF has to come up with no launchd, no systemd, no session-ledger,
 * and no broker. This is the piece that makes that true: a supervisor that
 * spawns a declared set of children, restarts them when they die, backs off
 * when they die fast, publishes what it is doing, and shuts them down cleanly.
 *
 * It is deliberately small. It is not trying to be launchd — it does not do
 * sockets, calendar intervals, or system boot. It does the one thing a
 * standalone app needs, which is keeping its own processes alive.
 *
 * ## Restart policy, and why it has a cutoff
 *
 * A killed child restarts. A child that *keeps* dying immediately is a
 * different situation: a bad command, a port already bound, a config error at
 * import time. Restarting it forever pins a core and buries the one useful
 * error under thousands of identical ones, so consecutive fast failures back
 * off exponentially and then stop, with the program marked `failed` and the
 * last exit recorded.
 *
 * "Fast" is the distinction that makes this safe: a child that stayed up longer
 * than `healthyAfterMs` has its backoff and its failure count reset, so a
 * process that crashes once an hour is restarted promptly every time rather
 * than eventually being treated as a crash loop.
 *
 * ## Why the status file exists
 *
 * `<runDir>/supervisor.json` records, per child, the pid and the time it
 * started. That is not telemetry: ARF-04's Screen B has to answer "has this
 * daemon restarted since the governance config changed", and the reason it
 * normally cannot is that nothing knows when the daemon started. A supervisor
 * does know. Under standalone ARF, that file settles the question.
 *
 * ## Shutdown
 *
 * SIGTERM to every child, then SIGKILL to whatever is still alive when the
 * shutdown timeout expires. The escalation is not optional: a child ignoring
 * SIGTERM would otherwise leave the supervisor hanging forever, and an operator
 * would reach for `kill -9` on the supervisor — orphaning exactly the processes
 * this exists to manage.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tempPathFor } from '../../server/src/standup/atomic-file.mjs';
import { childEnvironment } from './programs.mjs';

/** Filenames under the run directory. */
export const STATUS_FILENAME = 'supervisor.json';
export const PIDFILE_NAME = 'supervisor.pid';

/**
 * A program's lifecycle.
 *
 * `backoff` is a separate state from `stopped` on purpose: "waiting to be
 * restarted" and "not coming back" look identical in a status file that
 * collapses them, and the difference is whether an operator needs to act.
 */
export const PROGRAM_STATES = Object.freeze([
  'pending', 'running', 'backoff', 'stopping', 'stopped', 'failed',
]);

export class SupervisorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SupervisorError';
    this.code = code;
  }
}

/** Whether `pid` is live. `EPERM` means live and owned by somebody else. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

export class Supervisor extends EventEmitter {
  /**
   * @param {object} options
   * @param {object[]} options.programs from `resolveProgramSet`
   * @param {object} options.config resolved ARF config (for the child environment)
   * @param {() => number} [options.now]
   * @param {typeof spawn} [options.spawnImpl] injectable, for tests
   */
  constructor({ programs, config, now = Date.now, spawnImpl = spawn }) {
    super();
    this.config = config;
    this.now = now;
    this.spawnImpl = spawnImpl;
    this.policy = config.supervisor.restart;
    this.logDir = config.supervisor.logDir;
    this.runDir = config.supervisor.runDir;
    this.shutdownTimeoutMs = config.supervisor.shutdownTimeoutMs;
    this.startedAt = null;
    this.stopping = false;
    this.pidfileHeld = false;
    this.programs = new Map(programs.map((spec) => [spec.id, {
      spec,
      state: 'pending',
      child: null,
      pid: null,
      startedAt: null,
      restarts: 0,
      consecutiveFailures: 0,
      backoffMs: 0,
      lastExit: null,
      timer: null,
      // One generation per spawn. An `error` and an `exit` can both arrive for a
      // single failed spawn, and without this the second one would be counted as
      // a whole extra crash and double the backoff.
      generation: 0,
      settled: true,
      logFile: join(config.supervisor.logDir, `${spec.id}.log`),
    }]));
  }

  /**
   * Claim the run directory, so two supervisors cannot manage one state root.
   *
   * Two supervisors would each spawn an ARF server on the same port (one of them
   * failing, crash-looping, and burying the reason) and each spawn their own
   * pipeline daemons. The pidfile is created exclusively; an existing one whose
   * process is gone is taken over, and an existing one whose process is alive is
   * a refusal that names the pid.
   */
  acquireInstanceLock() {
    mkdirSync(this.runDir, { recursive: true, mode: 0o755 });
    const pidfile = join(this.runDir, PIDFILE_NAME);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(pidfile, 'wx', 0o644);
        writeFileSync(fd, `${process.pid}\n`);
        closeSync(fd);
        this.pidfileHeld = true;
        return;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') {
          throw new SupervisorError('pidfile_unwritable', `cannot write ${pidfile}: ${err?.message ?? err}`);
        }
      }
      let held = NaN;
      try {
        held = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10);
      } catch {
        // Unreadable pidfile: treat as abandoned rather than blocking every
        // future boot on a file nobody can interpret.
      }
      if (processAlive(held)) {
        throw new SupervisorError(
          'already_running',
          `an ARF supervisor is already running as pid ${held} for ${this.runDir}`,
        );
      }
      try {
        unlinkSync(pidfile);
      } catch {
        // Raced with another starter; the second attempt settles it.
      }
    }
    throw new SupervisorError('already_running', `could not claim ${pidfile}`);
  }

  releaseInstanceLock() {
    if (!this.pidfileHeld) return;
    try {
      unlinkSync(join(this.runDir, PIDFILE_NAME));
    } catch {
      // Already removed. Nothing to undo.
    }
    this.pidfileHeld = false;
  }

  /** Start every program. */
  start() {
    this.startedAt = this.now();
    mkdirSync(this.logDir, { recursive: true, mode: 0o755 });
    mkdirSync(this.runDir, { recursive: true, mode: 0o755 });
    for (const record of this.programs.values()) this.#spawn(record);
    this.publishStatus();
  }

  #spawn(record) {
    record.generation += 1;
    record.settled = false;
    const generation = record.generation;

    let stdio;
    let logFd = null;
    try {
      // Append, so a restart does not truncate the log that explains why the
      // previous run died — which is the log an operator is about to read.
      logFd = openSync(record.logFile, 'a', 0o644);
      stdio = ['ignore', logFd, logFd];
    } catch {
      // An unwritable log directory must not stop the process from running.
      stdio = ['ignore', 'ignore', 'ignore'];
    }

    let child;
    try {
      child = this.spawnImpl(record.spec.command, record.spec.args, {
        cwd: record.spec.cwd ?? undefined,
        env: {
          ...process.env,
          ...childEnvironment(this.config, record.spec.id),
          ...record.spec.env,
        },
        stdio,
        // Same process group as the supervisor, so an operator's Ctrl-C in the
        // foreground reaches the children too and a `kill` of the supervisor
        // does not leave them running.
        detached: false,
      });
    } catch (err) {
      if (logFd !== null) closeSync(logFd);
      this.#onExit(record, generation, { code: null, signal: null, error: String(err?.message ?? err) });
      return;
    }

    // The child holds its own duplicate of the descriptor; this one is ours to
    // release, and not releasing it leaks one per restart until the process
    // hits its descriptor limit — a slow leak that only ever shows up on the
    // long-running deployment.
    if (logFd !== null) closeSync(logFd);

    record.child = child;
    record.pid = child.pid ?? null;
    record.state = 'running';
    record.startedAt = this.now();
    this.emit('started', { id: record.spec.id, pid: record.pid, at: record.startedAt });

    child.on('error', (err) => {
      this.#onExit(record, generation, { code: null, signal: null, error: String(err?.message ?? err) });
    });
    child.on('exit', (code, signal) => {
      this.#onExit(record, generation, { code, signal, error: null });
    });
    this.publishStatus();
  }

  #onExit(record, generation, exit) {
    // A stale generation is the second event for a spawn already accounted for.
    if (generation !== record.generation || record.settled) return;
    record.settled = true;

    const at = this.now();
    const uptimeMs = record.startedAt === null ? 0 : at - record.startedAt;
    record.lastExit = {
      code: exit.code, signal: exit.signal, error: exit.error, at, uptimeMs,
    };
    record.child = null;
    record.pid = null;
    this.emit('exited', { id: record.spec.id, ...record.lastExit });

    if (this.stopping || record.state === 'stopping') {
      record.state = 'stopped';
      this.publishStatus();
      return;
    }
    if (!record.spec.autoRestart) {
      record.state = 'stopped';
      this.publishStatus();
      return;
    }

    if (uptimeMs >= this.policy.healthyAfterMs) {
      // It ran long enough to count as having worked. This failure is its own
      // event, not the continuation of a crash loop.
      record.consecutiveFailures = 0;
      record.backoffMs = 0;
    }
    record.consecutiveFailures += 1;

    if (record.consecutiveFailures > this.policy.maxConsecutiveFailures) {
      record.state = 'failed';
      this.emit('failed', {
        id: record.spec.id,
        consecutiveFailures: record.consecutiveFailures,
        lastExit: record.lastExit,
      });
      this.publishStatus();
      return;
    }

    const delay = record.backoffMs === 0
      ? this.policy.initialDelayMs
      : Math.min(record.backoffMs * 2, this.policy.maxDelayMs);
    record.backoffMs = delay;
    record.state = 'backoff';
    record.restarts += 1;
    this.publishStatus();

    record.timer = setTimeout(() => {
      record.timer = null;
      if (this.stopping) return;
      this.#spawn(record);
    }, delay);
    // Not unref'd: this timer IS the reason the supervisor is still alive
    // between a crash and the restart, and an unref'd one would let the event
    // loop drain and the supervisor exit mid-backoff.
  }

  /**
   * Stop every program, escalating to SIGKILL after the shutdown timeout.
   *
   * @returns {Promise<void>}
   */
  async stop({ timeoutMs = this.shutdownTimeoutMs } = {}) {
    this.stopping = true;
    const waits = [];

    for (const record of this.programs.values()) {
      if (record.timer) {
        clearTimeout(record.timer);
        record.timer = null;
      }
      const child = record.child;
      if (!child) {
        record.state = 'stopped';
        continue;
      }
      record.state = 'stopping';
      waits.push(new Promise((resolveWait) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(killTimer);
          resolveWait();
        };
        child.once('exit', finish);
        child.once('error', finish);
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone between the timeout firing and the signal.
          }
          // Do not resolve here: the SIGKILL still produces an `exit`, and
          // resolving early would let the supervisor exit while a child is
          // mid-teardown.
        }, timeoutMs);
        try {
          child.kill('SIGTERM');
        } catch {
          finish();
        }
      }));
    }

    await Promise.all(waits);
    this.publishStatus();
    this.releaseInstanceLock();
  }

  /** A snapshot of every program, for the status file and `arf status`. */
  status() {
    return {
      updatedAt: new Date(this.now()).toISOString(),
      supervisor: {
        pid: process.pid,
        startedAt: this.startedAt === null ? null : new Date(this.startedAt).toISOString(),
        stateRoot: this.config.stateRoot,
        mode: this.config.mode,
        // Recorded so an operator reading the status file knows which gate the
        // children were pointed at, without inferring it from the config.
        gatePath: this.config.governance.gatePath,
        runDir: this.runDir,
        logDir: this.logDir,
      },
      programs: [...this.programs.values()].map((record) => ({
        id: record.spec.id,
        role: record.spec.role,
        builtIn: Boolean(record.spec.builtIn),
        state: record.state,
        pid: record.pid,
        // The field ARF-04's adoption check needs: when this process started.
        startedAt: record.startedAt === null ? null : new Date(record.startedAt).toISOString(),
        restarts: record.restarts,
        consecutiveFailures: record.consecutiveFailures,
        backoffMs: record.backoffMs,
        autoRestart: record.spec.autoRestart,
        command: record.spec.command,
        args: record.spec.args,
        logFile: record.logFile,
        lastExit: record.lastExit === null ? null : {
          ...record.lastExit,
          at: new Date(record.lastExit.at).toISOString(),
        },
      })),
    };
  }

  /** Write the status file atomically. Never throws: status is not the job. */
  publishStatus() {
    const target = join(this.runDir, STATUS_FILENAME);
    try {
      mkdirSync(this.runDir, { recursive: true, mode: 0o755 });
      const temp = tempPathFor(target);
      writeFileSync(temp, `${JSON.stringify(this.status(), null, 2)}\n`, { mode: 0o644 });
      renameSync(temp, target);
    } catch (err) {
      // A supervisor that died because it could not write a status file would
      // take the processes it manages with it, which is strictly worse than an
      // operator having a stale status file.
      this.emit('status-error', err);
    }
  }
}

/** Read a supervisor status file, or `null` when there is none. */
export function readStatusFile(runDir) {
  try {
    return JSON.parse(readFileSync(join(runDir, STATUS_FILENAME), 'utf8'));
  } catch {
    return null;
  }
}
