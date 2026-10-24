import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  acquireMergeLease, inspectMergeLease, readMergeLeaseWaiters, upsertMergeLeaseWaiter,
  mergeLeaseFilePath, readMergeLeaseAttempts, releaseMergeLease,
} from '../src/ama/merge-lease.mjs';

import { main } from '../bin/merge-lease.mjs';

const lane = { repo: 'owner/repo', base: 'main' };
const now = '2026-10-24T03:52:00.000Z';
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cli-waiter-lifecycle-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, ...lane };
}
function abandoned(args, extra = {}) {
  return upsertMergeLeaseWaiter({ ...args, pr: 9082, head: 'old-head',
    holderPid: 84379, holderHost: 'local', waiterId: 'cli_1189_1792813709282_9082',
    arrivedAt: '2026-10-24T03:48:29.386Z', updatedAt: '2026-10-24T03:51:25.516Z',
    effectiveDeadlineSeconds: 124558, attempt: 535, ...extra });
}
function following(args, extra = {}) {
  return acquireMergeLease({ ...args, holderPr: 9086, holderHead: 'next-head',
    holderPid: 34151, holderHost: 'local', waiterId: 'next', registerWaiter: true,
    now, pidAliveFn: pid => pid !== 1189, ...extra });
}

test('LAC-2098 dead CLI with live parent cannot block an empty lane', t => {
  const args = fixture(t);
  abandoned(args, { acquisitionPid: 1189 });
  assert.equal(inspectMergeLease({ ...args }).holder, null);
  const result = following(args);
  assert.equal(result.acquired, true);
  assert.equal(result.lease.holderPid, 34151);
  assert.equal(result.prunedWaiters[0].waiterId, 'cli_1189_1792813709282_9082');
  assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), []);
});

for (const status of ['live', 'reused', 'null', 'undefined', 'throws', 'foreign', 'missing-host', 'invalid-pid', 'null-pid', 'boolean-pid', 'string-pid']) {
  test(`LAC-2098 explicit ${status} acquisition retains FIFO position`, t => {
    const args = fixture(t);
    const extra = { waiterId: 'unique-request', acquisitionPid: 1189 };
    if (status === 'foreign') extra.holderHost = 'remote';
    if (status === 'invalid-pid') extra.acquisitionPid = 'unknown';
    if (status === 'null-pid') extra.acquisitionPid = null;
    if (status === 'boolean-pid') extra.acquisitionPid = true;
    if (status === 'string-pid') extra.acquisitionPid = '1189';
    // Persist malformed/old records directly only inside this disposable fixture.
    const request = abandoned(args, { ...extra, acquisitionPid: undefined });
    request.waiter.acquisitionPid = extra.acquisitionPid;
    if (status === 'missing-host') delete request.waiter.holderHost;
    writeFileSync(request.waitersPath, JSON.stringify({ waiters: [request.waiter] }));
    const probe = pid => {
      if (pid !== 1189) return true;
      if (status === 'throws') throw Error('unreadable');
      if (status === 'null') return null;
      if (status === 'undefined') return undefined;
      return ['live', 'reused'].includes(status);
    };
    const result = following(args, { pidAliveFn: probe });
    assert.equal(result.acquired, false);
    assert.equal(result.queuePosition, 2);
    assert.equal(inspectMergeLease(args).holder, null);
    assert.equal(readMergeLeaseWaiters(args.rootDir, lane)[0].waiterId, request.waiter.waiterId);
  });
}

test('LAC-2098 explicit dead acquirer prunes only its request while preserving the holder fence', t => {
  const args = fixture(t);
  const holder = following(args, { registerWaiter: false, holderPr: 100 }).lease;
  abandoned(args, { waiterId: 'unique-old', acquisitionPid: 1189 });
  const result = following(args);
  assert.equal(result.acquired, false);
  assert.deepEqual(inspectMergeLease(args).holder, holder);
  assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane).map(w => w.waiterId), ['next']);
  assert.equal(releaseMergeLease({ ...args, ...holder, leaseId: 'foreign-fence' }).released, false);
  assert.equal(releaseMergeLease({ ...args, ...holder }).released, true);
  assert.equal(following(args).acquired, true);
});

test('LAC-2098 daemon and unrecognized legacy IDs retain their existing ownership rules', t => {
  const args = fixture(t);
  abandoned(args, { waiterId: 'cli_1189_1792813709282_9083' });
  abandoned(args, { waiterId: 'daemon-request', priority: 'daemon', holderPid: 1189 });
  assert.equal(following(args).acquired, false);
  assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane).map(w => w.waiterId),
    ['daemon-request', 'cli_1189_1792813709282_9083', 'next']);
});

function cliArgs(args) {
  return ['acquire', '--root-dir', args.rootDir, '--repo', lane.repo, '--base', lane.base,
    '--pr', '9082', '--head', 'old-head', '--owner-pid', '84379', '--wait', '1'];
}
function cliDeps(extra = {}) {
  let ms = Date.parse(now);
  let output = '';
  let errors = '';
  const signalSource = new EventEmitter();
  return { signalSource, stdout: { write: s => { output += s; } },
    stderr: { write: s => { errors += s; } },
    selfPid: 1189, host: 'local', pidAliveFn: () => true,
    nowMs: () => ms, nowIso: () => new Date(ms).toISOString(),
    sleep: async n => { ms += n; }, ...extra,
    output: () => output, errors: () => errors };
}

for (const mode of ['SIGINT', 'SIGTERM', 'SIGHUP', 'timeout', 'exception']) {
  test(`LAC-2098 ${mode} cleans up only its own waiter and preserves live same-parent acquisition`, async t => {
    const args = fixture(t);
    const first = abandoned(args, { acquisitionPid: 1190 }).waiter;
    const deps = cliDeps();
    let elapsed = 0;
    deps.nowMs = () => Date.parse(now) + elapsed;
    deps.sleep = async () => {
      const queue = readMergeLeaseWaiters(args.rootDir, lane);
      assert.equal(queue.length, 2);
      assert.equal(queue[1].acquisitionPid, 1189);
      assert.notEqual(queue[1].waiterId, first.waiterId);
      if (mode === 'exception') throw Error('injected runtime failure');
      if (mode !== 'timeout') deps.signalSource.emit(mode);
      else elapsed += 1000;
    };
    assert.equal(await main(cliArgs(args), deps), 75);
    assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), [first]);
    assert.equal(inspectMergeLease(args).holder, null);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(deps.signalSource.listenerCount(signal), 0);
    if (mode === 'exception') assert.match(deps.errors(), /injected runtime failure/);
    else {
      assert.equal(readMergeLeaseAttempts(args.rootDir, lane)[0].attempts, 0);
      if (mode !== 'timeout') assert.equal(JSON.parse(deps.output()).signal, mode);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`LAC-2098 ${signal} aborts a pending poll timer before refund and cleanup`, { timeout: 3000 }, async t => {
    const args = fixture(t);
    const first = abandoned(args, { acquisitionPid: 1190 }).waiter;
    const deps = cliDeps();
    let sleeps = 0;
    deps.sleep = async (_ms, value, options) => {
      sleeps++;
      assert.ok(options?.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      const pending = sleep(60000, value, { ...options, ref: false });
      queueMicrotask(() => {
        deps.signalSource.emit(signal);
        deps.signalSource.emit('SIGTERM'); // Preserve the first signal.
      });
      return pending;
    };
    assert.equal(await main(cliArgs(args), deps), 75);
    assert.equal(sleeps, 1);
    assert.equal(JSON.parse(deps.output()).signal, signal);
    assert.equal(JSON.parse(deps.output()).reason, 'lease-wait-interrupted');
    assert.equal(readMergeLeaseAttempts(args.rootDir, lane)[0].attempts, 0);
    assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), [first]);
    assert.doesNotMatch(deps.errors(), /warning:|retryable runtime failure|AbortError/);
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(deps.signalSource.listenerCount(name), 0);
  });
}

test('LAC-2098 cleanup retries a contended mutation lock within a fixed bound', async t => {
  const args = fixture(t);
  abandoned(args, { acquisitionPid: 1190 });
  const lockPath = `${mergeLeaseFilePath(args.rootDir, lane)}.mutation.lock`;
  const deps = cliDeps();
  let sleeps = 0;
  deps.sleep = async (ms, _value, options) => {
    sleeps++;
    if (sleeps === 1) {
      writeFileSync(lockPath, JSON.stringify({ holderPid: process.pid, holderHost: hostname(), acquiredAt: '2999-01-01T00:00:00.000Z' }));
      throw Error('injected failure while lock held');
    }
    assert.equal(ms, 250);
    assert.equal(options, undefined); // Cleanup must not inherit poll cancellation.
    rmSync(lockPath);
  };
  assert.equal(await main(cliArgs(args), deps), 75);
  assert.equal(sleeps, 2);
  assert.equal(readMergeLeaseWaiters(args.rootDir, lane).length, 1);
});

// Real signals target only fixture children, with a registration handshake.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL']) {
  test(`LAC-2098 real child ${signal} cleans up or is reclaimed without touching the parent`, { timeout: 10000 }, async t => {
    const args = fixture(t);
    const host = hostname();
    const holder = acquireMergeLease({ ...args, holderPr: 100, holderHead: 'holder',
      holderPid: process.pid, holderHost: host }).lease;
    const child = spawn(process.execPath, [new URL('../bin/merge-lease.mjs', import.meta.url).pathname,
      ...cliArgs(args).map(v => v === '84379' ? String(process.pid) : v === '1' ? '60' : v)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const closed = once(child, 'close');
    let errors = '';
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.stderr.on('data', data => {
        errors += data;
        if (errors.includes('HAM merge lease wait:')) resolve();
      });
      child.once('exit', () => reject(Error(`child exited before registration: ${errors}`)));
    });
    assert.equal(readMergeLeaseWaiters(args.rootDir, lane)[0].acquisitionPid, child.pid);
    child.kill(signal);
    const [code, exitSignal] = await closed;
    assert.deepEqual(inspectMergeLease(args).holder, holder);
    if (signal === 'SIGKILL') {
      assert.equal(exitSignal, signal);
      assert.equal(readMergeLeaseWaiters(args.rootDir, lane).length, 1);
    } else {
      assert.equal(code, 75);
      assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), []);
    }
    assert.equal(releaseMergeLease({ ...args, ...holder }).released, true);
    const next = following(args, { holderHost: host, holderPid: process.pid, now: new Date().toISOString(),
      pidAliveFn: pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } } });
    assert.equal(next.acquired, true);
    assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), []);
  });
}

test('LAC-2098 live acquisition survives its parent PID being absent', t => {
  const args = fixture(t);
  abandoned(args, { acquisitionPid: 1189 });
  assert.equal(following(args, { pidAliveFn: pid => pid !== 84379 }).acquired, false);
  assert.equal(readMergeLeaseWaiters(args.rootDir, lane)[0].acquisitionPid, 1189);
});

test('LAC-2098 failed cleanup is bounded and dead-acquirer pruning recovers its exact request', async t => {
  const args = fixture(t);
  const holder = following(args, { registerWaiter: false, holderPr: 100 }).lease;
  const lockPath = `${mergeLeaseFilePath(args.rootDir, lane)}.mutation.lock`;
  const deps = cliDeps();
  let sleeps = 0;
  deps.sleep = async (ms, _value, options) => {
    sleeps++;
    if (sleeps === 1) {
      writeFileSync(lockPath, JSON.stringify({ holderPid: process.pid, holderHost: hostname(), acquiredAt: '2999-01-01T00:00:00.000Z' }));
      throw Error('runtime failure');
    }
    assert.equal(ms, 250);
    assert.equal(options, undefined);
  };
  assert.equal(await main(cliArgs(args), deps), 75);
  assert.equal(sleeps, 3); // initial wait plus exactly two cleanup retry waits
  assert.match(deps.errors(), /waiter cleanup failed/);
  assert.equal(readMergeLeaseWaiters(args.rootDir, lane).length, 1);
  assert.deepEqual(inspectMergeLease(args).holder, holder);
  rmSync(lockPath);
  assert.equal(releaseMergeLease({ ...args, ...holder, now }).released, true);
  const next = following(args);
  assert.equal(next.acquired, true);
  assert.equal(next.prunedWaiters[0].acquisitionPid, 1189);
});

test('LAC-2098 default library liveness preserves unreadable acquisition PIDs', t => {
  const args = fixture(t);
  abandoned(args, { holderHost: hostname(), acquisitionPid: 1189 });
  const original = process.kill;
  try {
    process.kill = () => { throw Object.assign(Error('unreadable'), { code: 'EIO' }); };
    assert.equal(following(args, { holderHost: hostname(), pidAliveFn: undefined }).acquired, false);
    assert.equal(readMergeLeaseWaiters(args.rootDir, lane)[0].acquisitionPid, 1189);
  } finally { process.kill = original; }
});

for (const host of ['local', 'remote']) {
  test(`LAC-2098 uncertain ${host} acquisition still has its bounded expiry`, t => {
    const args = fixture(t);
    abandoned(args, { holderHost: host, acquisitionPid: 1189 });
    const result = following(args, { now: '2026-10-26T03:52:00.000Z', pidAliveFn: () => null });
    assert.equal(result.acquired, true);
    assert.equal(result.prunedWaiters[0].staleReason, 'expired-waiter');
  });
}


test('LAC-2098 legacy ID may have been adopted by a live CLI and cannot prove acquisition death', t => {
  const args = fixture(t);
  const legacy = abandoned(args).waiter;
  // The pre-fix CLI reused this ID through parent/PR/head matching. PID1189
  // may have exited, while a different CLI now refreshes this exact request.
  const adopted = upsertMergeLeaseWaiter({ ...args, ...legacy, holderPid: 84379,
    updatedAt: now, attempt: 536 }).waiter;
  assert.equal(following(args).acquired, false);
  assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane)[0], adopted);
});


test('LAC-2098 matching-holder recovery still cleans its own unserved waiter', async t => {
  const args = fixture(t);
  const holder = acquireMergeLease({ ...args, holderPr: 9082, holderHead: 'old-head',
    holderPid: 84379, holderHost: 'local', now }).lease;
  const deps = cliDeps({ acquireMergeLease: options => {
    const result = acquireMergeLease(options);
    assert.equal(result.acquired, false);
    assert.equal(readMergeLeaseWaiters(args.rootDir, lane).length, 1);
    throw Error('merge lease: mutation lock busy during injected selection');
  } });
  assert.equal(await main(cliArgs(args), deps), 0);
  assert.equal(JSON.parse(deps.output()).leaseId, holder.leaseId);
  assert.deepEqual(inspectMergeLease(args).holder, holder);
  assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), []);
});


for (const rebound of ['legacy-adoption', 'other-pid', 'other-host']) {
  test(`LAC-2098 finally cleanup preserves a request with ${rebound} ownership`, async t => {
    const args = fixture(t);
    const holder = following(args, { registerWaiter: false, holderPr: 100 }).lease;
    let replacement;
    const deps = cliDeps({ sleep: async () => {
      const row = readMergeLeaseWaiters(args.rootDir, lane)[0];
      replacement = upsertMergeLeaseWaiter({ ...args, ...row,
        acquisitionPid: rebound === 'legacy-adoption' ? undefined : rebound === 'other-pid' ? 1190 : 1189,
        holderHost: rebound === 'other-host' ? 'remote' : 'local', updatedAt: now }).waiter;
      throw Error('interrupted after ownership changed');
    } });
    assert.equal(await main(cliArgs(args), deps), 75);
    assert.deepEqual(readMergeLeaseWaiters(args.rootDir, lane), [replacement]);
    assert.deepEqual(inspectMergeLease(args).holder, holder);
  });
}
