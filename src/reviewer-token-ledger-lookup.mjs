import { fork } from 'node:child_process';

// Bound accounting memory even when ledger outages outlast several reviews.
let activeWorkers = 0;
const waiting = [];
async function acquireWorker() {
  if (activeWorkers < 2) { activeWorkers++; return; }
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
export async function readReviewerEvidenceInWorker(args, {
  workerUrl = new URL('./reviewer-token-ledger-worker.mjs', import.meta.url),
  timeoutMs = 180_000,
  onReady = () => {},
} = {}) {
  await acquireWorker();
  try { return await runLookup(args, { workerUrl, timeoutMs, onReady }); }
  finally { releaseWorker(); }
}

function runLookup(args, { workerUrl, timeoutMs, onReady }) {
  return new Promise((resolve, reject) => {
    const worker = fork(workerUrl, [], {
      execArgv: [], serialization: 'advanced', detached: process.platform !== 'win32',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const closed = new Promise(done => worker.once('close', done));
    let settled = false;
    const timer = setTimeout(() => finish(new Error('reviewer token ledger worker timed out')), timeoutMs);
    async function finish(error, usage) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (process.platform !== 'win32' && worker.pid) process.kill(-worker.pid, 'SIGKILL');
        else worker.kill('SIGKILL');
      } catch (killError) {
        if (killError.code !== 'ESRCH') error ||= killError;
      }
      await closed;
      if (error) reject(error);
      else resolve(usage);
    }
    worker.on('message', result => {
      if (result?.kind === 'ready') {
        try { onReady(); } catch (error) { void finish(error); }
        return;
      }
      if (result?.ok === true) void finish(null, result.usage);
      else void finish(Object.assign(new Error(result?.error || 'reviewer token ledger worker failed'), { code: result?.code }));
    });
    worker.once('error', error => { void finish(error); });
    worker.once('close', code => {
      if (!settled) void finish(new Error(`reviewer token ledger worker exited without evidence (code=${code})`));
    });
    try { worker.send(args, error => { if (error) void finish(error); }); }
    catch (error) { void finish(error); }
  });
}
