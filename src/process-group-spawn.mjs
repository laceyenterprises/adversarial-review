import { spawn } from 'node:child_process';

import { resolveProgressTimeoutMs } from './reviewer-timeout.mjs';

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_FAILURE_TAIL_BYTES = 8 * 1024;

function tailText(value, maxBytes = DEFAULT_FAILURE_TAIL_BYTES) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result = char + result;
    bytes += charBytes;
  }
  return `[truncated to last ${maxBytes} bytes]\n${result}`;
}

function formatCapturedFailureDetails({ stdout, stderr, maxBytes = DEFAULT_FAILURE_TAIL_BYTES } = {}) {
  const sections = [];
  const stdoutTail = tailText(stdout, maxBytes).trim();
  const stderrTail = tailText(stderr, maxBytes).trim();
  if (stdoutTail) sections.push(`stdout tail:\n${stdoutTail}`);
  if (stderrTail) sections.push(`stderr tail:\n${stderrTail}`);
  return sections.join('\n');
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

function spawnCapturedProcessGroup(command, args, {
  env,
  cwd,
  input = null,
  timeout = 0,
  progressTimeout = resolveProgressTimeoutMs(env),
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  maxBuffer = 10 * 1024 * 1024,
  signal,
  failureTailBytes = DEFAULT_FAILURE_TAIL_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutReason = null;
    let killTimer = null;
    let wallTimer = null;
    let progressTimer = null;

    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (wallTimer) clearTimeout(wallTimer);
      if (progressTimer) clearTimeout(progressTimer);
      killTimer = null;
      wallTimer = null;
      progressTimer = null;
    };

    const requestKill = (reason) => {
      if (settled) return;
      if (!timeoutReason) timeoutReason = reason;
      signalProcessGroup(child, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => {
          signalProcessGroup(child, 'SIGKILL');
        }, killGraceMs);
      }
    };

    const armProgressTimer = () => {
      if (progressTimer) clearTimeout(progressTimer);
      if (progressTimeout > 0) {
        progressTimer = setTimeout(() => {
          requestKill(`no output for ${progressTimeout}ms`);
        }, progressTimeout);
      }
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    };

    const onAbort = () => {
      requestKill('aborted');
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (timeout > 0) {
      wallTimer = setTimeout(() => {
        requestKill(`timed out after ${timeout}ms`);
      }, timeout);
    }
    armProgressTimer();

    const appendChecked = (target, chunk) => {
      const next = target + chunk;
      if (next.length > maxBuffer) {
        requestKill(`maxBuffer exceeded (${maxBuffer} bytes)`);
        const err = new Error(`Command failed: maxBuffer exceeded (${maxBuffer} bytes)`);
        finishReject(err);
        return null;
      }
      return next;
    };

    child.stdout.on('data', (data) => {
      if (settled) return;
      armProgressTimer();
      const next = appendChecked(stdout, data.toString());
      if (next !== null) stdout = next;
    });

    child.stderr.on('data', (data) => {
      if (settled) return;
      armProgressTimer();
      const next = appendChecked(stderr, data.toString());
      if (next !== null) stderr = next;
    });

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      finishReject(err);
    });

    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      clearTimers();
      if (code === 0 && !timeoutReason) {
        resolve({ stdout, stderr, code, signal: closeSignal });
        return;
      }
      const details = formatCapturedFailureDetails({ stdout, stderr, maxBytes: failureTailBytes });
      const reason = timeoutReason || `failed with code ${code}${closeSignal ? ` signal ${closeSignal}` : ''}`;
      const err = new Error(`Command ${reason}${details ? `\n${details}` : ''}`);
      err.code = timeoutReason === 'aborted' ? 'ABORT_ERR' : code;
      err.exitCode = code;
      err.signal = closeSignal;
      err.killed = timeoutReason !== null;
      err.timedOut = timeoutReason?.startsWith('timed out') || false;
      err.progressTimedOut = timeoutReason?.startsWith('no output') || false;
      err.aborted = timeoutReason === 'aborted';
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    if (input !== null && child.stdin) {
      child.stdin.end(input);
    }
  });
}

export {
  DEFAULT_FAILURE_TAIL_BYTES,
  DEFAULT_KILL_GRACE_MS,
  formatCapturedFailureDetails,
  spawnCapturedProcessGroup,
};
