import { spawn } from 'node:child_process';

import { resolveProgressTimeoutMs } from './reviewer-timeout.mjs';

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_FAILURE_TAIL_BYTES = 8 * 1024;
const SUPPORTED_OPTIONS = new Set([
  'cwd',
  'env',
  'failureTailBytes',
  'input',
  'killGraceMs',
  'maxBuffer',
  'onSpawn',
  'progressTimeout',
  'signal',
  'timeout',
]);
const activeChildren = new Set();

let installedExitCleanup = false;

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

function installExitCleanup() {
  if (installedExitCleanup) return;
  installedExitCleanup = true;
  process.on('exit', () => {
    for (const child of activeChildren) {
      signalProcessGroup(child, 'SIGKILL');
    }
  });
}

function validateOptions(options = {}) {
  const unknown = Object.keys(options).filter((key) => !SUPPORTED_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unsupported spawnCapturedProcessGroup options: ${unknown.join(', ')}`);
  }
}

function spawnCapturedProcessGroup(command, args, options = {}) {
  validateOptions(options);
  const {
    env,
    cwd,
    input = null,
    timeout = 0,
    progressTimeout = resolveProgressTimeoutMs(env),
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxBuffer = 10 * 1024 * 1024,
    onSpawn,
    signal,
    failureTailBytes = DEFAULT_FAILURE_TAIL_BYTES,
  } = options;

  return new Promise((resolve, reject) => {
    installExitCleanup();
    const child = spawn(command, args, {
      env,
      cwd,
      detached: true,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeoutReason = null;
    let pendingKill = false;
    let killTimer = null;
    let wallTimer = null;
    let progressTimer = null;
    let abortListenerAttached = false;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (wallTimer) clearTimeout(wallTimer);
      if (progressTimer) clearTimeout(progressTimer);
      killTimer = null;
      wallTimer = null;
      progressTimer = null;
      if (signal && abortListenerAttached) {
        signal.removeEventListener('abort', onAbort);
        abortListenerAttached = false;
      }
      activeChildren.delete(child);
    };

    const requestKill = (reason) => {
      if (settled) return;
      if (!timeoutReason) timeoutReason = reason;
      if (!child.pid) {
        pendingKill = true;
        return;
      }
      pendingKill = false;
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
      cleanup();
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    };

    const onAbort = () => {
      requestKill('aborted');
    };

    child.on('spawn', () => {
      if (typeof onSpawn === 'function') {
        try {
          onSpawn({ pid: child.pid, pgid: child.pid });
        } catch (err) {
          requestKill(`onSpawn callback failed: ${err?.message || err}`);
        }
      }
      if (pendingKill) requestKill(timeoutReason || 'aborted');
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        abortListenerAttached = true;
      }
    }

    if (timeout > 0) {
      wallTimer = setTimeout(() => {
        requestKill(`timed out after ${timeout}ms`);
      }, timeout);
    }
    armProgressTimer();

    const appendChecked = (target, targetBytes, chunk) => {
      const text = dataToText(chunk);
      const nextBytes = targetBytes + Buffer.byteLength(text, 'utf8');
      if (nextBytes > maxBuffer) {
        requestKill(`maxBuffer exceeded (${maxBuffer} bytes)`);
        const err = new Error(`Command failed: maxBuffer exceeded (${maxBuffer} bytes)`);
        finishReject(err);
        return null;
      }
      return { text: target + text, bytes: nextBytes };
    };

    const dataToText = (chunk) => (
      typeof chunk === 'string' ? chunk : chunk.toString()
    );

    child.stdout.on('data', (data) => {
      if (settled) return;
      armProgressTimer();
      const next = appendChecked(stdout, stdoutBytes, data);
      if (next !== null) {
        stdout = next.text;
        stdoutBytes = next.bytes;
      }
    });

    child.stderr.on('data', (data) => {
      if (settled) return;
      armProgressTimer();
      const next = appendChecked(stderr, stderrBytes, data);
      if (next !== null) {
        stderr = next.text;
        stderrBytes = next.bytes;
      }
    });

    child.on('error', (err) => {
      finishReject(err);
    });

    child.on('close', (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
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
      err.killed = closeSignal != null || timeoutReason !== null;
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
