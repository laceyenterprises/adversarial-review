import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// Run one command at a time per child. Each contender keeps its own process
// and native module instance, while the caller controls the barrier per round.
export async function withFixtureProcesses(script, inputs, run, { timeoutMs = 15_000 } = {}) {
  const workers = [];
  try {
    for (const input of inputs) {
      workers.push(startWorker(script, input, timeoutMs, workers.length));
    }
    assert.deepEqual(await Promise.all(workers.map(worker => worker.exchange())), inputs.map(() => 'ready'));
    const result = await run(workers.map(worker => worker.exchange));
    for (const worker of workers) worker.disconnect();
    for (const worker of workers) assert.deepEqual(await worker.waitForExit(), [0, null]);
    return result;
  } finally {
    await Promise.all(workers.map(async worker => {
      worker.kill();
      await worker.waitForExit();
    }));
  }
}

function startWorker(script, input, timeoutMs, index) {
  const child = fork(fileURLToPath(script), [JSON.stringify(input)], {
    execArgv: ['--preserve-symlinks', '--preserve-symlinks-main'],
    env: { ...process.env, NODE_TEST_CONTEXT: '' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const identity = `${fileURLToPath(script)} worker ${index} (pid ${child.pid})`;
  const kill = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
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
  let exchangeNumber = 0;
  async function exchange(command) {
    lifetime.signal.throwIfAborted();
    const controller = new AbortController();
    const currentExchange = exchangeNumber++;
    const timer = setTimeout(() => controller.abort(new Error(
      `${identity}: exchange ${currentExchange} timed out after ${timeoutMs}ms`,
    )), timeoutMs);
    try {
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      const response = once(child, 'message', { signal });
      if (command !== undefined) child.send(command, error => { if (error) lifetime.abort(error); });
      const [value] = await response;
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  async function waitForExit() {
    let timer;
    try {
      return await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => {
          kill();
          reject(new Error(`${identity}: exit timed out after ${timeoutMs}ms; sent SIGKILL`));
        }, timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    exchange,
    waitForExit,
    disconnect: () => { if (child.connected) child.disconnect(); },
    kill,
  };
}
