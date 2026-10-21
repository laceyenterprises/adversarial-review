import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { fork } from 'node:child_process';

// Each reader owns its accounting queue; production shares the default reader.
// Tests and embedded runtimes can create an isolated pool without borrowing seats.
export function createReviewerEvidenceReader({ maxConcurrent = 2 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }
  let activeWorkers = 0;
  const waiting = [];
  async function acquireWorker() {
    if (activeWorkers < maxConcurrent) { activeWorkers++; return; }
    await new Promise(resolve => waiting.push(resolve));
  }
  function releaseWorker() {
    const next = waiting.shift();
    if (next) next();
    else activeWorkers--;
  }

  // The unchanged reader uses synchronous psql/transcript I/O and native addons
  // that are not worker-thread safe. Give it a separate event loop and process
  // group so neither normal accounting nor timeout cleanup can block admission.
  return async function readReviewerEvidenceInWorker(args, {
    workerUrl = new URL('./reviewer-token-ledger-worker.mjs', import.meta.url),
    timeoutMs = loadAwareTimeoutMs(180_000),
    onReady = () => {},
    killProcessGroup = (pid, signal) => process.kill(pid, signal),
  } = {}) {
    await acquireWorker();
    try { return await runLookup(args, { workerUrl, timeoutMs, onReady, killProcessGroup }); }
    finally { releaseWorker(); }
  };
}

// Bound accounting memory even when ledger outages outlast several reviews.
export const readReviewerEvidenceInWorker = createReviewerEvidenceReader();

function runLookup(args, { workerUrl, timeoutMs, onReady, killProcessGroup }) {
  return new Promise((resolve, reject) => {
    const worker = fork(workerUrl, [], {
      execArgv: [], serialization: 'advanced', detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let received = false, stopping = false, usage, failure = null;
    const timer = setTimeout(() => stop(new Error('reviewer token ledger worker timed out')), timeoutMs);
    function stop(error) {
      failure ||= error;
      if (stopping) return;
      stopping = true;
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && worker.pid) killProcessGroup(-worker.pid, 'SIGKILL');
        else worker.kill('SIGKILL');
      } catch (killError) {
        // The group may already have exited. If group signalling is refused,
        // still reap our direct child; never turn a completed reply into a kill.
        if (killError.code !== 'ESRCH') worker.kill('SIGKILL');
      }
    }
    worker.on('message', result => {
      if (result?.kind === 'ready') {
        try { onReady(); } catch (error) { stop(error); }
        return;
      }
      received = true;
      if (result?.ok === true) usage = result.usage;
      else failure ||= Object.assign(new Error(result?.error || 'reviewer token ledger worker failed'), { code: result?.code });
      // The reader exits after flushing its reply. Keep the timeout armed
      // until close, but do not signal a successful, naturally exiting group.
    });
    worker.on('error', stop);
    worker.once('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (!received) reject(new Error(`reviewer token ledger worker exited without evidence (code=${code})`));
      else resolve(usage);
    });
    try { worker.send(args, error => { if (error) stop(error); }); }
    catch (error) { stop(error); }
  });
}
