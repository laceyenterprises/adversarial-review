import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { writeSync } from 'node:fs';

// Retain a bounded tail. Child bytes, never CPU usage or heartbeats, reset idle.
export async function runBounded(command, args, {
  timeoutMs = 900_000, idleMs = 120_000, tailBytes = 4096, graceMs = 5000,
  env = process.env, stdout = process.stdout, stderr = process.stderr,
  spawnImpl = spawn, killImpl = (pid, signal) => process.kill(pid, signal),
} = {}) {
  // A registered closer owns one group for shell + validators + test children.
  // Keeping validators in it closes the nested-detach cancellation escape.
  const controlled = Boolean(env.HAM_CONTROLLER_RECORD);
  let confirmControllerValidation;
  if (controlled) {
    const controller = await import('./hammer-controller.mjs');
    const { assertHammerController } = controller;
    assertHammerController(env);
    confirmControllerValidation = controller.confirmControllerValidation;
  }
  return new Promise(resolve => {
    const started = performance.now();
    let lastOutput = started;
    let totalBytes = 0;
    let tail = Buffer.alloc(0);
    let outcome;
    let exitCode;
    let closed = false;
    let escalation;
    let cleanupDeadline;
    let escalated = false;
    let finished = false;
    let finishing = false;
    let cleanupFailed = false;
    const child = spawnImpl(command, args, { env, detached: !controlled, stdio: ['inherit', 'pipe', 'pipe'] });
    stderr.write(`run-bounded: started absolute=${timeoutMs}ms idle=${idleMs}ms\n`);
    function signalGroup(signal) {
      if (!child.pid) return;
      if (controlled && (child.exitCode !== null || child.signalCode !== null)) return;
      try { killImpl(controlled ? child.pid : -child.pid, signal); }
      catch (error) {
        if (error.code !== 'ESRCH') {
          cleanupFailed = true;
          stderr.write(`run-bounded: cleanup ${error.code}\n`);
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill(signal); }
            catch (cause) { stderr.write(`run-bounded: direct cleanup ${cause.code}\n`); }
          }
        }
      }
    }
    function groupPresent() {
      if (!child.pid) return false;
      if (controlled) return child.exitCode === null && child.signalCode === null;
      try { killImpl(-child.pid, 0); return true; }
      catch (error) { return error.code !== 'ESRCH'; }
    }
    function escalate() {
      escalated = true;
      signalGroup('SIGKILL');
      if (closed) finish();
      else cleanupDeadline = setTimeout(() => {
        // Permission failures cannot turn an idle bound into an infinite lease
        // hold. Report unknown cleanup as failure; canonical worker teardown
        // remains responsible for any process we could not terminate.
        cleanupFailed = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish();
      }, 1000);
    }
    async function finish() {
      if (finished || finishing) return;
      finishing = true;
      if (controlled && !outcome) {
        if (!await confirmControllerValidation()) {
          cleanupFailed = true;
          stop('validation-drain-unconfirmed', 125);
        }
      }
      finished = true;
      clearInterval(deadline);
      clearTimeout(escalation);
      clearTimeout(cleanupDeadline);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (cleanupFailed) exitCode = 125;
      stdout.write(tail);
      stdout.write('\n');
      stderr.write(`run-bounded: ${outcome || 'exited'} elapsed=${Math.round(performance.now() - started)}ms idle=${Math.round(performance.now() - lastOutput)}ms bytes=${totalBytes} cleanup=${cleanupFailed ? 'unconfirmed' : 'finished'} status=${exitCode}\n`);
      resolve(exitCode);
    }
    function stop(reason, code) {
      if (outcome) return;
      outcome = reason;
      exitCode = code;
      if (controlled) {
        // FD 4 is a private inherited pipe to the owning controller, not a PID
        // supplied by PR code. Failure cannot authorize continued validation.
        try { writeSync(Number(env.HAM_CONTROLLER_FD), 'stop\n'); }
        catch { cleanupFailed = true; }
      }
      signalGroup('SIGTERM');
      // Keep escalation after leader exit: pipe closure is not group closure.
      escalation ??= setTimeout(escalate, graceMs);
    }
    const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM'].map(signal => {
      const handler = () => stop(signal === 'SIGALRM' ? 'external-timeout:SIGALRM' : `canceled:${signal}`,
        signal === 'SIGALRM' ? 124 : 128 + constants.signals[signal]);
      process.on(signal, handler);
      return [signal, handler];
    });
    const deadline = setInterval(() => {
      if (closed && escalation && !groupPresent()) {
        finish();
        return;
      }
      const now = performance.now();
      if (now - started >= timeoutMs) stop('absolute-timeout', 124);
      else if (now - lastOutput >= idleMs) stop('no-progress-timeout', 124);
    }, Math.min(100, idleMs, timeoutMs));
    const capture = chunk => {
      lastOutput = performance.now();
      totalBytes += chunk.length;
      tail = Buffer.concat([tail, chunk.subarray(-tailBytes)]).subarray(-tailBytes);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', error => {
      stderr.write(`run-bounded: spawn ${error.code}\n`);
      exitCode = 127;
    });
    child.on('exit', (code, signal) => {
      if (finished) return;
      if (!outcome) exitCode = code ?? 128 + constants.signals[signal];
      signalGroup('SIGTERM');
      if (!escalation) escalation = setTimeout(escalate, graceMs);
    });
    child.on('close', () => {
      if (finished) return;
      closed = true;
      if (!escalation || escalated || !groupPresent()) finish();
    });
  });
}
