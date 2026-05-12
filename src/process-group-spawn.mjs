import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { resolveProgressTimeoutMs } from './reviewer-timeout.mjs';

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_FAILURE_TAIL_BYTES = 8 * 1024;
const SPAWN_DETACHED = true;
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
  'stderrPath',
  'stdoutPath',
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

function readTailText(filePath, maxBytes = DEFAULT_FAILURE_TAIL_BYTES) {
  if (!filePath || maxBytes <= 0) return '';
  let fd = null;
  try {
    const { size } = statSync(filePath);
    if (size <= 0) return '';
    const truncated = size > maxBytes;
    const banner = `[truncated to last ${maxBytes} bytes]\n`;
    if (truncated && Buffer.byteLength(banner, 'utf8') >= maxBytes) {
      return banner.slice(0, maxBytes);
    }
    const payloadMaxBytes = truncated
      ? maxBytes - Buffer.byteLength(banner, 'utf8')
      : maxBytes;
    const bytesToRead = Math.min(size, payloadMaxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) {
      start += 1;
    }
    const text = buffer.subarray(start).toString('utf8');
    return truncated ? `${banner}${text}` : text;
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
    stdoutPath = null,
    stderrPath = null,
  } = options;

  return new Promise((resolve, reject) => {
    installExitCleanup();
    const stdoutFd = stdoutPath ? openSync(stdoutPath, 'w') : null;
    const stderrFd = stderrPath ? openSync(stderrPath, 'w') : null;
    const child = spawn(command, args, {
      env,
      cwd,
      detached: SPAWN_DETACHED,
      stdio: [
        input === null ? 'ignore' : 'pipe',
        stdoutFd === null ? 'pipe' : stdoutFd,
        stderrFd === null ? 'pipe' : stderrFd,
      ],
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
    let fileProgressTimer = null;
    let lastStdoutSize = 0;
    let lastStderrSize = 0;
    let abortListenerAttached = false;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (wallTimer) clearTimeout(wallTimer);
      if (progressTimer) clearTimeout(progressTimer);
      if (fileProgressTimer) clearInterval(fileProgressTimer);
      killTimer = null;
      wallTimer = null;
      progressTimer = null;
      fileProgressTimer = null;
      if (signal && abortListenerAttached) {
        signal.removeEventListener('abort', onAbort);
        abortListenerAttached = false;
      }
      activeChildren.delete(child);
      if (stdoutFd !== null) closeSync(stdoutFd);
      if (stderrFd !== null) closeSync(stderrFd);
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

    const statSize = (filePath) => {
      if (!filePath) return 0;
      try {
        return statSync(filePath).size;
      } catch {
        return 0;
      }
    };

    const readSideChannelOutput = () => {
      if (stdoutPath) {
        stdoutBytes = statSize(stdoutPath);
        stdout = readTailText(stdoutPath, Math.min(maxBuffer, failureTailBytes));
      }
      if (stderrPath) {
        stderrBytes = statSize(stderrPath);
        stderr = readTailText(stderrPath, Math.min(maxBuffer, failureTailBytes));
      }
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      readSideChannelOutput();
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
          assert.equal(SPAWN_DETACHED, true, 'onSpawn pgid=pid assumes detached process groups');
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
    if (stdoutPath || stderrPath) {
      const intervalMs = progressTimeout > 0
        ? Math.max(25, Math.min(1_000, Math.floor(progressTimeout / 4)))
        : 250;
      fileProgressTimer = setInterval(() => {
        if (settled) return;
        const stdoutSize = statSize(stdoutPath);
        const stderrSize = statSize(stderrPath);
        if (stdoutSize > maxBuffer || stderrSize > maxBuffer) {
          const exceeded = stdoutSize > maxBuffer ? stdoutSize : stderrSize;
          requestKill(`maxBuffer exceeded (${maxBuffer} bytes; saw ${exceeded} bytes)`);
          return;
        }
        if (stdoutSize !== lastStdoutSize || stderrSize !== lastStderrSize) {
          lastStdoutSize = stdoutSize;
          lastStderrSize = stderrSize;
          armProgressTimer();
        }
      }, intervalMs);
    }

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

    child.stdout?.on('data', (data) => {
      if (settled) return;
      armProgressTimer();
      const next = appendChecked(stdout, stdoutBytes, data);
      if (next !== null) {
        stdout = next.text;
        stdoutBytes = next.bytes;
      }
    });

    child.stderr?.on('data', (data) => {
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
      readSideChannelOutput();
      cleanup();
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        const exceeded = stdoutBytes > maxBuffer ? stdoutBytes : stderrBytes;
        const err = new Error(`Command failed: maxBuffer exceeded (${maxBuffer} bytes; saw ${exceeded} bytes)`);
        err.code = code;
        err.exitCode = code;
        err.signal = closeSignal;
        err.killed = closeSignal != null || timeoutReason !== null;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
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
