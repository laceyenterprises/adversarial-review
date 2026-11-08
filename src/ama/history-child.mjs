import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const executors = new WeakMap();

// Preserve the async executor seam. Native promisified execFile exposes .child;
// injected read-only transports need not spawn one.
export function historyChildExecutor(impl = execute) {
  if (impl === execHistoryFile || impl === execute) return execHistoryFile;
  if (!executors.has(impl)) executors.set(impl, (command, args, options) => run(impl, command, args, options));
  return executors.get(impl);
}

export function execHistoryFile(command, args, options) {
  // execFile silently drops `detached`; spawn is required to own the group.
  const { signal, timeout, maxBuffer = 1024 * 1024, encoding = 'utf8',
    cwd, env, windowsHide, windowsVerbatimArguments } = options || {};
  signal?.throwIfAborted();
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, { cwd, env, windowsHide, windowsVerbatimArguments,
    detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure, timer;
  const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  const kill = () => {
    try {
      if (grouped) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  };
  const abort = () => { failure = signal.reason; kill(); };
  const pending = new Promise((resolve, reject) => {
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
      if (sizes[stream] + bytes.length > maxBuffer) {
        failure ??= Object.assign(new Error(`history child ${stream} maxBuffer exceeded`),
          { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        kill();
      } else { sizes[stream] += bytes.length; chunks[stream].push(bytes); }
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', (code, terminatedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const output = Object.fromEntries(Object.entries(chunks).map(([stream, bytes]) => {
        const buffer = Buffer.concat(bytes);
        return [stream, encoding && encoding !== 'buffer' ? buffer.toString(encoding) : buffer];
      }));
      if (failure) reject(Object.assign(failure, output));
      else if (code !== 0) reject(Object.assign(new Error(`history child ${command} exited with ${code ?? terminatedBy}`),
        { code, signal: terminatedBy, killed: Boolean(terminatedBy), ...output }));
      else resolve(output);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (Number.isFinite(timeout) && timeout > 0) timer = setTimeout(() => {
      failure ??= Object.assign(new Error('history child timed out'), { killed: true, signal: 'SIGKILL' });
      kill();
    }, timeout);
  });
  return Object.assign(pending, { child });
}

// Register group abort before execFile's abort handler, which can reject before
// child close. A wrapper's descendants must not survive with inherited pipes.
function run(impl, command, args, options = {}) {
  const { signal, timeout } = options;
  signal?.throwIfAborted();
  const grouped = process.platform !== 'win32';
  let child, timer, execution;
  const kill = () => {
    if (!child?.pid) return;
    try {
      if (grouped) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill('SIGKILL');
    }
  };
  signal?.addEventListener('abort', kill, { once: true });
  try {
    execution = impl(command, args, { ...options, detached: grouped, killSignal: 'SIGKILL' });
    child = execution.child;
    if (signal?.aborted) kill();
    if (Number.isFinite(timeout) && timeout > 0) timer = setTimeout(kill, timeout);
  } catch (error) {
    signal?.removeEventListener('abort', kill);
    throw error;
  }
  const pending = Promise.resolve(execution).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  });
  return Object.assign(pending, { child });
}
