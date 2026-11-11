import './helpers/load-aware-timeout-fixture.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { execHistoryFile, historyChildExecutor } from '../src/ama/history-child.mjs';
import { withHistoryReadBudget } from '../src/ama/history-read-policy.mjs';
import { loadAwareTimeoutMs } from '../src/load-aware-timeout.mjs';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { currentGitHubBudgetScope, withGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

const base = 'a'.repeat(40), head = 'c'.repeat(40);
const prPath = 'repos/fixture/repo/pulls/42';
const rootDir = mkdtempSync(join(tmpdir(), 'history-budget-suite-'));
after(() => rmSync(rootDir, { recursive: true, force: true }));
const args = { repo: 'fixture/repo', prNumber: 42, headSha: head, rootDir };
const never = () => new Promise(() => {});
const compare = { status: 'ahead', total_commits: 0, commits: [], merge_base_commit: { sha: base } };

function value(path) {
  if (path.includes('/reviews?')) return [];
  if (path === prPath) return { head: { sha: head }, base: { sha: base } };
  if (path.includes('/compare/')) return compare;
  if (path.includes('/git/trees/')) return { tree: path.endsWith(base) ? [] : [
    { path: 'source.mjs', type: 'blob', mode: '100644', sha: head },
  ], truncated: false };
  if (path.includes('/git/blobs/')) return { encoding: 'base64', content: 'eAo=', size: 2 };
  assert.fail(`unexpected read ${path}`);
}

test('HAMHISTORYBUDGET-01: an injected reader ignoring cancellation returns a classified whole-verification timeout', { timeout: 2000 }, async () => {
  let reads = 0;
  const evidence = await fetchPrimaryChange({ ...args, get: () => { reads++; return never(); } },
    { contextTimeoutMs: 25 });
  assert.equal(evidence.historyReadTimedOut, true);
  assert.equal(evidence.historyReadFailed, true);
  assert.equal(evidence.readFailed, true);
  assert.equal(evidence.headSha, head);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'history-read-failed');
  assert.equal(reads, 1);
});

test('the idle production whole-verification deadline is 90 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finished = false;
  const pending = fetchPrimaryChange({ ...args, get: never }).then(result => { finished = true; return result; });
  t.mock.timers.tick(89_999);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.equal((await pending).historyReadTimedOut, true);
});

test('HISTREADLOAD-01: collector and nested reader honor a load-scaled budget above 90 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeoutMs = loadAwareTimeoutMs(90_000, {
    loadAvg1m: 108, cpuCount: 18, cpuBusyPercent: 100, enabled: true, maxMultiplier: 6,
  });
  assert.equal(timeoutMs, 540_000);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let finished = false;
  const get = createHistoryReader({ contextTimeoutMs: timeoutMs, nowMs: () => 0,
    execGhWithRetryImpl: () => { started(); return never(); } });
  const pending = fetchPrimaryChange({ ...args, get }, { contextTimeoutMs: timeoutMs })
    .then(value => { finished = true; return value; });
  await ready;
  t.mock.timers.tick(90_001);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(timeoutMs - 90_001);
  assert.equal((await pending).historyReadTimedOut, true);
});

test('a shorter reader deadline retains timeout classification in collected evidence', { timeout: 2000 }, async () => {
  const get = createHistoryReader({ contextTimeoutMs: 25, execGhWithRetryImpl: never });
  const evidence = await fetchPrimaryChange({ ...args, get });
  assert.equal(evidence.historyReadTimedOut, true);
  assert.equal(checkPrimaryChange(evidence, head).reason, 'history-read-failed');
});

test('synchronous deadline exhaustion retains its code through the history error wrapper', async () => {
  let samples = 0, reads = 0;
  const get = createHistoryReader({ contextTimeoutMs: 25,
    nowMs: () => ++samples <= 2 ? 0 : 50,
    execGhWithRetryImpl: async () => { reads++; return { stdout: '{}' }; } });
  await assert.rejects(get(prPath), error => {
    assert.match(error.message, /history read failed: repos\/fixture\/repo\/pulls\/42/);
    assert.equal(error.code, 'HISTORY_READ_TIMEOUT');
    assert.equal(error.cause.code, 'HISTORY_READ_TIMEOUT');
    return true;
  });
  assert.equal(reads, 0, 'an expired budget must not start a transport');
});

test('binding collection cancellation cannot reset an already consumed reader budget', async () => {
  let now = 0, calls = 0;
  const get = createHistoryReader({ contextTimeoutMs: 1000, nowMs: () => now,
    execGhWithRetryImpl: async () => { calls++; return { stdout: '{}' }; } });
  await get(prPath);
  now = 1000;
  const evidence = await fetchPrimaryChange({ ...args, get });
  assert.equal(evidence.historyReadTimedOut, true);
  assert.equal(calls, 1);
});

test('timed-out stored history does not strand the next exact-head collection', { timeout: 2000 }, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'history-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let stalled = true;
  const get = Object.assign(async path => path.includes('/compare/') && stalled ? never() : value(path),
    { persistPrimaryChange: true, metadata: async () => compare });
  const options = { contextTimeoutMs: 25, fetchCiCostImpl: async () => ({ headSha: head, ok: true }) };
  const failed = await fetchPrimaryChange({ ...args, get, rootDir }, options);
  assert.equal(failed.historyReadTimedOut, true);
  await delay(0);
  stalled = false;
  const recovered = await fetchPrimaryChange({ ...args, get, rootDir }, { ...options, contextTimeoutMs: 1000 });
  assert.equal(checkPrimaryChange(recovered, head).ok, true);
});

test('the budget includes optional proof stages after history has succeeded', { timeout: 2000 }, async () => {
  let proofSignal, laterProofs = 0, finish;
  const evidence = await fetchPrimaryChange({ ...args, get: async path => value(path) }, {
    contextTimeoutMs: 25,
    fetchCiCostImpl: ({ signal }) => {
      proofSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    },
    proveDerivedArtifactsImpl: async () => { laterProofs++; return []; },
  });
  assert.equal(evidence.historyReadTimedOut, true);
  assert.equal(proofSignal.aborted, true);
  finish({ headSha: head, ok: true });
  await delay(0);
  assert.equal(laterProofs, 0, 'a late success must not continue verification');
});

for (const stage of ['metadata', 'tree', 'blob']) {
  test(`standalone rescue-shaped reader bounds a stalled ${stage} transport`, { timeout: 2000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let transportSignal, markTransportStarted;
    const transportStarted = new Promise(resolve => { markTransportStarted = resolve; });
    const get = createHistoryReader({ contextTimeoutMs: 25, nowMs: () => 0,
      execGhWithRetryImpl: async ({ args, signal }) => {
        assert.ok(currentGitHubBudgetScope(), 'standalone CLI must defer exhausted quota');
        const path = args[1];
        if (stage === 'metadata' || path.includes(`/git/${stage === 'tree' ? 'trees' : 'blobs'}/`)) {
          transportSignal = signal;
          markTransportStarted();
          return never();
        }
        return { stdout: JSON.stringify(value(path)) };
      } });
    const expired = assert.rejects(get(`repos/fixture/repo/compare/${base}...${head}`),
      { code: 'HISTORY_READ_TIMEOUT' });
    await transportStarted;
    t.mock.timers.tick(25);
    await expired;
    assert.equal(transportSignal.aborted, true);
  });
}

test('native closer budget scope is retained and a successful reader stays usable', async () => {
  await withGitHubBudgetScope({ urgent: true }, async scope => {
    const get = createHistoryReader({ execGhWithRetryImpl: async ({ args }) => {
      assert.equal(currentGitHubBudgetScope(), scope);
      return { stdout: JSON.stringify(value(args[1])) };
    } });
    const evidence = await fetchPrimaryChange({ ...args, get }, {
      fetchCiCostImpl: async () => ({ headSha: head, ok: true }),
    });
    assert.equal(checkPrimaryChange(evidence, head).ok, true);
    assert.deepEqual(await get(prPath), value(prPath));
  });
});

test('caller cancellation interrupts an injected reader without waiting for the context deadline', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const pending = fetchPrimaryChange({ ...args, signal: controller.signal,
    get: () => { controller.abort(new Error('caller cancelled')); return never(); } });
  const evidence = await pending;
  assert.equal(checkPrimaryChange(evidence, head).reason, 'history-read-failed');
  assert.match(evidence.reason, /caller cancelled/);
  assert.equal(evidence.historyReadTimedOut, undefined);
});

test('native budget composites do not accumulate parent listeners across repeated reads', async () => {
  const controller = new AbortController();
  const failure = new Error('read failed');
  for (let i = 0; i < 25; i++) {
    assert.equal(await withHistoryReadBudget(signal => {
      assert.equal(signal.aborted, false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      return 'ok';
    }, { signal: controller.signal }), 'ok');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(withHistoryReadBudget(() => { throw failure; },
      { signal: controller.signal }), error => error === failure);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('budget composites clean up after timeout and propagate parent cancellation', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  await assert.rejects(withHistoryReadBudget(never, { signal: controller.signal, timeoutMs: 10 }),
    { code: 'HISTORY_READ_TIMEOUT' });
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const reason = new Error('caller cancelled');
  await assert.rejects(withHistoryReadBudget(signal => {
    controller.abort(reason);
    assert.equal(signal.reason, reason);
    return never();
  }, { signal: controller.signal }), error => error === reason);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  let calls = 0;
  await assert.rejects(withHistoryReadBudget(() => { calls++; },
    { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('concurrent budget composites avoid parent listener warnings and clean up local listeners', async () => {
  const controller = new AbortController();
  const signals = [];
  const pending = Array.from({ length: 25 }, () => withHistoryReadBudget(signal => {
    signals.push(signal);
    return never();
  }, { signal: controller.signal }));
  await Promise.resolve();
  assert.equal(signals.length, 25);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const reason = new Error('cancel concurrent reads');
  controller.abort(reason);
  for (const result of await Promise.allSettled(pending)) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, reason);
  }
  for (const signal of signals) assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('production child executor accepts omitted args and honors the options overload', async () => {
  assert.deepEqual(await execHistoryFile(process.execPath), { stdout: '', stderr: '' });
  const output = await execHistoryFile(process.execPath, { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(output.stdout));
  assert.ok(Buffer.isBuffer(output.stderr));
  assert.equal(output.stdout.length, 0);
  assert.equal(output.stderr.length, 0);
});

test('cancelling a failed spawn never signals a missing PID', async t => {
  const kill = t.mock.method(process, 'kill', () => {});
  const controller = new AbortController();
  const pending = execHistoryFile(join(rootDir, 'missing-command'), [], { signal: controller.signal });
  assert.equal(pending.child.pid, undefined);
  const reason = new Error('caller cancelled');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(kill.mock.callCount(), 0);
});

test('production child executor preserves stdout, diff exit 1 and bounded output failures', async () => {
  assert.equal(historyChildExecutor(promisify(execFile)), execHistoryFile);
  assert.deepEqual(await execHistoryFile(process.execPath, ['-e', "process.stdout.write('ok')"]), { stdout: 'ok', stderr: '' });
  await assert.rejects(execHistoryFile(process.execPath, ['-e',
    "process.stdout.write('patch'); process.exitCode = 1"]), error => error.code === 1 && error.stdout === 'patch');
  await assert.rejects(execHistoryFile(process.execPath, ['-e',
    "process.stdout.write('x'.repeat(1024))"], { maxBuffer: 10 }),
  { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  await assert.rejects(execHistoryFile(process.execPath, ['-e',
    'setInterval(() => {}, 1000)'], { timeout: 50 }), error => error.killed && error.signal === 'SIGKILL');
});

test('an injected diff ignoring abort cannot strand scratch cleanup', { timeout: 5000 }, async () => {
  let directory;
  const get = createHistoryReader({ contextTimeoutMs: 1000,
    execGhWithRetryImpl: async ({ args }) => ({ stdout: JSON.stringify(value(args[1])) }),
    diffImpl: (_command, _args, options) => { directory = options.cwd; return never(); } });
  await assert.rejects(get(`repos/fixture/repo/compare/${base}...${head}`), { code: 'HISTORY_READ_TIMEOUT' });
  assert.ok(directory);
  for (let i = 0; i < 100 && existsSync(directory); i++) await delay(5);
  assert.equal(existsSync(directory), false);
});

test('deadline kills a real stalled diff child and removes its scratch directory', { timeout: 3000 }, async t => {
  let child, directory, closed;
  const get = createHistoryReader({ contextTimeoutMs: 250,
    execGhWithRetryImpl: async ({ args }) => ({ stdout: JSON.stringify(value(args[1])) }),
    diffImpl: (_command, _argv, options) => {
      assert.equal(options.killSignal, 'SIGKILL');
      directory = options.cwd;
      const pending = execHistoryFile(process.execPath, ['-e',
        "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], options);
      child = pending.child;
      closed = new Promise(resolve => child.once('close', (_code, signal) => resolve(signal)));
      return pending;
    } });
  t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await assert.rejects(get(`repos/fixture/repo/compare/${base}...${head}`), { code: 'HISTORY_READ_TIMEOUT' });
  assert.ok(child, 'fixture reached local diff');
  assert.equal(await Promise.race([closed, delay(500).then(() => 'child did not close')]), 'SIGKILL');
  for (let i = 0; i < 100 && existsSync(directory); i++) await delay(5);
  assert.equal(existsSync(directory), false);
});
