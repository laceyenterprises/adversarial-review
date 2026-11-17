// execFile-compatible runner whose timeout does not destroy the child's pipes.
// Node's execFile timeout closes stdout/stderr BEFORE signalling, so the child's
// final flush fails and everything it wrote afterwards is lost. Here expiry is
// SIGTERM, a grace period to exit and flush, then SIGKILL, reading until close.
//
// Resolves { stdout, stderr } on exit 0, and { stdout, stderr, timedOut: true,
// timeoutMs } on expiry (output kept; the caller names the reason). Rejects like
// execFile otherwise: code (exit status or error string), signal, stdout, stderr.
import { spawn } from 'node:child_process';

export const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const PIPE_DRAIN_MS = 2000;

export function runCommandKeepingOutput(command, argv, { timeout, killSignal = 'SIGTERM', killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxBuffer = DEFAULT_MAX_BUFFER, env } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = { stdout: [], stderr: [] }, size = { stdout: 0, stderr: 0 };
    const child = spawn(command, argv, { env });
    const timers = [];
    let timedOut = false, overflow = false, spawnError = null, done = false;
    let exitResult = null, pipeDrainTimer = null;
    const finish = (code, signal) => {
      if (done) return;
      done = true; timers.forEach(clearTimeout);
      const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
      if (timedOut) return resolve({ stdout, stderr, timedOut: true, timeoutMs: timeout });
      if (!spawnError && !overflow && code === 0) return resolve({ stdout, stderr });
      const message = spawnError?.message ?? (overflow ? 'stdout/stderr maxBuffer length exceeded' : `Command failed: ${command}\n${stderr}`);
      reject(Object.assign(new Error(message), { cmd: command, signal, killed: overflow, stdout, stderr,
        code: spawnError?.code ?? (overflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code) }));
    };
    const drainPipes = () => {
      if (!timedOut || !exitResult || pipeDrainTimer !== null) return;
      pipeDrainTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); finish(exitResult.code, exitResult.signal);
      }, PIPE_DRAIN_MS);
      timers.push(pipeDrainTimer);
    };
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      const remaining = maxBuffer - size[name];
      if (remaining > 0) chunks[name].push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
      size[name] += chunk.length;
      if (size[name] > maxBuffer && !overflow) { overflow = true; child.kill(killSignal); }
    });
    child.on('error', error => { spawnError = error; if (child.pid === undefined) finish(null, null); });
    child.on('close', finish);
    // A grandchild may hold the pipes open past the direct child's death.
    child.on('exit', (code, signal) => {
      exitResult = { code, signal };
      drainPipes();
    });
    if (timeout > 0) timers.push(setTimeout(() => {
      timedOut = true;
      if (exitResult) drainPipes();
      else {
        child.kill(killSignal);
        timers.push(setTimeout(() => child.kill('SIGKILL'), killGraceMs));
      }
    }, timeout));
  });
}
