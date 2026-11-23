import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Run one command at a time per child. Each contender keeps its own process
// and native module instance, while the caller controls the barrier per round.
export async function withFixtureProcesses(script, inputs, run, { timeoutMs } = {}) {
  const workers = [];
  try {
    for (const input of inputs) {
      workers.push(startWorker(script, input, timeoutMs));
    }
    assert.deepEqual(await Promise.all(workers.map(worker => worker.exchange())), inputs.map(() => 'ready'));
    const result = await run(workers.map(worker => worker.exchange));
    for (const worker of workers) worker.disconnect();
    for (const worker of workers) assert.deepEqual(await worker.exited, [0, null]);
    return result;
  } finally {
    await Promise.all(workers.map(async worker => {
      worker.kill();
      await worker.exited;
    }));
  }
}

function startWorker(script, input, timeoutMs) {
  const child = fork(fileURLToPath(script), [JSON.stringify(input)], {
    execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'],
    env: { ...process.env, NODE_TEST_CONTEXT: '' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const lifetime = new AbortController();
  child.on('error', error => lifetime.abort(error));
  child.on('disconnect', () => lifetime.abort(new Error('Fixture process disconnected')));
  const exited = new Promise(resolve => {
    // On Node 22, a parent-initiated IPC disconnect can omit 'close'.
    // There are no private stdio pipes to drain after the process exits.
    child.once('exit', (code, signal) => {
      lifetime.abort(new Error(`Fixture process exited (${code ?? signal})`));
      resolve([code, signal]);
    });
    child.once('error', () => { if (!child.pid) resolve([null, null]); });
  });
  async function exchange(command) {
    lifetime.signal.throwIfAborted();
    const signal = timeoutMs === undefined ? lifetime.signal
      : AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs)]);
    const response = once(child, 'message', { signal });
    if (command !== undefined) child.send(command, error => { if (error) lifetime.abort(error); });
    const [value] = await response;
    return value;
  }
  return {
    exchange,
    exited,
    disconnect: () => { if (child.connected) child.disconnect(); },
    kill: () => { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); },
  };
}
