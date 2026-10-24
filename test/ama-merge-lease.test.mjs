import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireMergeLease,
  acquireDaemonMergeLease,
  daemonMergeReservationSeconds,
  withDaemonMergeReservation,
  deriveLeaseKey,
  inspectMergeLease,
  mergeLeaseAttemptsFilePath,
  mergeLeaseFilePath,
  mergeLeaseWaitersFilePath,
  readMergeLeaseAttempts,
  readMergeLeaseWaiters,
  recordMergeLeaseGateAttempt,
  reconcileMergeLeases,
  reclaimIfStale,
  releaseMergeLease,
  releaseMergeLeaseForRetryableAbort,
  removeMergeLeaseWaiter,
  resetMergeLeaseGateAttempts,
  renewMergeLease,
  upsertMergeLeaseWaiter,
} from '../src/ama/merge-lease.mjs';
import { MAX_TIMER_DELAY_MS, timerDelayMs } from '../src/load-aware-timeout.mjs';
import { createWatcherWakeSource } from '../src/watcher-wake.mjs';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-merge-lease-'));
}

const IDENTITY = Object.freeze({
  repo: 'owner/name',
  base: 'main',
});

function acquire(rootDir, overrides = {}) {
  return acquireMergeLease({
    rootDir,
    ...IDENTITY,
    holderPr: 101,
    holderHead: 'abc123',
    holderPid: 4242,
    holderHost: 'test-host',
    now: '2026-06-20T18:00:00Z',
    ...overrides,
  });
}

test('LEASEFAIR-04 a 300s poll reservation survives closer cycling until the next tick', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
  const held = acquire(rootDir);
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: process.pid, holderHost: hostname(), now: at(0), pollIntervalMs: 300_000 };
  const reserved = acquireDaemonMergeLease(request);
  assert.equal(reserved.waiter.deadlineSeconds, 600);
  releaseMergeLease({ rootDir, ...held.lease, now: at(200) });
  for (const seconds of [200, 299]) {
    const closer = acquire(rootDir, { holderPr: 103, registerWaiter: true, waiterId: 'closer',
      now: at(seconds), pidAliveFn: () => true });
    assert.equal(closer.acquired, false);
    assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY)[0].waiterId, reserved.waiter.waiterId);
  }
  assert.equal(acquireDaemonMergeLease({ ...request, now: at(300) }).acquired, true);
});

test('LEASEFAIR-04 sizing applies the maximum configured load multiplier once and caps timers', () => {
  const load = { loadAvg1m: 100, cpuCount: 1, cpuBusyPercent: 100, enabled: true, maxMultiplier: 20 };
  assert.equal(daemonMergeReservationSeconds(300_000, load), 600 * 20);
  assert.equal(daemonMergeReservationSeconds(900_000, load), 1800 * 20);
  const seconds = daemonMergeReservationSeconds(MAX_TIMER_DELAY_MS, load);
  assert.equal(seconds, Math.floor(MAX_TIMER_DELAY_MS / 1000));
  assert.ok(seconds * 1000 <= MAX_TIMER_DELAY_MS);
  assert.ok(timerDelayMs(seconds * 1000) <= MAX_TIMER_DELAY_MS);
});

for (const release of [releaseMergeLease, releaseMergeLeaseForRetryableAbort]) {
  test(`${release.name} fences waiter registration during release-wake pruning`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const held = acquire(rootDir);
    const request = { rootDir, ...IDENTITY, pr: 102, head: 'expired',
      holderPid: process.pid, holderHost: hostname(), priority: 'daemon',
      arrivedAt: held.lease.acquiredAt, effectiveDeadlineSeconds: 10 };
    upsertMergeLeaseWaiter({ ...request, waiterId: 'expired' });
    const now = new Date(Date.parse(held.lease.acquiredAt) + 20_000).toISOString();
    upsertMergeLeaseWaiter({ ...request, pr: 103, head: 'live', waiterId: 'live', arrivedAt: now });
    const waitersPath = mergeLeaseWaitersFilePath(rootDir, IDENTITY);
    const contender = { ...request, pr: 104, head: 'contender', waiterId: 'contender', arrivedAt: now };
    const read = fs.readFileSync;
    let inspected = false;
    let registrationError;
    const mocked = t.mock.method(fs, 'readFileSync', (path, ...args) => {
      const snapshot = read(path, ...args);
      if (path === waitersPath && !inspected) {
        inspected = true;
        // Interleave registration after the release reads its waiter snapshot,
        // before pruning persists it. Both writers must use the same lock.
        try { upsertMergeLeaseWaiter(contender); } catch (error) { registrationError = error; }
      }
      return snapshot;
    });
    syncBuiltinESMExports();
    const wakes = [];
    try {
      assert.equal(release({ rootDir, ...held.lease, now,
        requestWatcherWakeImpl: wake => wakes.push(wake) }).released, true);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(inspected, true, 'release inspected the waiter store');
    assert.match(registrationError?.message || '', /mutation lock busy while updating waiters/);
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.waiterId), ['live']);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].headSha, 'live');
    upsertMergeLeaseWaiter(contender);
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.waiterId), ['live', 'contender']);
  });

  test(`LEASEFAIR-04 ${release.name} wakes exactly the first daemon at its reserved head`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const held = acquire(rootDir);
    const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'reserved-head',
      now: held.lease.acquiredAt, holderPid: process.pid, holderHost: hostname() };
    acquireDaemonMergeLease(request);
    acquireDaemonMergeLease({ ...request, holderPr: 103, holderHead: 'second-head' });
    const wakes = [];
    const args = { rootDir, ...held.lease, now: request.now, requestWatcherWakeImpl: wake => wakes.push(wake) };
    assert.equal(release({ ...args, leaseId: 'wrong-fence' }).released, false);
    assert.equal(release(args).released, true);
    assert.equal(release(args).released, false);
    assert.deepEqual(wakes, [{ rootDir, repo: IDENTITY.repo, prNumber: 102,
      headSha: 'reserved-head', reason: 'daemon-merge-lease-released' }]);
  });
}

test('LEASEFAIR-04 release wake delivery obeys the existing watcher per-head cap', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const source = createWatcherWakeSource({ rootDir, consumeExistingOnStart: true,
    loadConfigImpl: () => ({ getHandoffConfig: () => ({ maxPerPrHead: 1 }) }), logger: { warn() {} } });
  t.after(() => source.close());
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'reserved-head', holderPid: process.pid, holderHost: hostname() };
  const held = acquireMergeLease({ ...request, holderPr: 101 });
  acquireDaemonMergeLease(request);
  releaseMergeLease({ rootDir, ...held.lease });
  const wake = source.consumeCurrent();
  assert.equal(wake.pr_number, 102);
  assert.equal(wake.head_sha, 'reserved-head');
  const daemon = acquireDaemonMergeLease(request);
  acquireDaemonMergeLease(request);
  releaseMergeLease({ rootDir, ...daemon.lease });
  assert.equal(source.consumeCurrent(), null, 'second wake for the same head is capped');
});

test('LEASEFAIR-04 expired and ordinary waiters do not wake; a wake failure cannot undo release', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const holder = acquire(rootDir);
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'abandoned',
    holderPid: process.pid, holderHost: hostname(), now: holder.lease.acquiredAt };
  const reserved = acquireDaemonMergeLease(request);
  const afterExpiry = new Date(Date.parse(request.now) + reserved.waiter.deadlineSeconds * 1000).toISOString();
  let wakes = 0;
  const wake = () => wakes++;
  assert.equal(releaseMergeLease({ rootDir, ...holder.lease, now: afterExpiry,
    requestWatcherWakeImpl: wake }).released, true);
  assert.equal(wakes, 0);
  const next = acquire(rootDir, { now: afterExpiry });
  acquire(rootDir, { holderPr: 103, registerWaiter: true, now: afterExpiry,
    holderPid: process.pid, holderHost: hostname() });
  assert.equal(releaseMergeLease({ rootDir, ...next.lease, now: afterExpiry,
    requestWatcherWakeImpl: wake }).released, true);
  assert.equal(wakes, 0);
  const daemon = acquireDaemonMergeLease({ ...request, now: afterExpiry });
  acquireDaemonMergeLease({ ...request, holderPr: 104, now: afterExpiry });
  assert.equal(releaseMergeLease({ rootDir, ...daemon.lease, now: afterExpiry,
    requestWatcherWakeImpl: () => { throw new Error('synthetic wake failure'); } }).released, true);
  assert.equal(existsSync(daemon.leasePath), false);
  assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY)[0].pr, 104);
});

test('LEASEFAIR-04 only contention retains a reservation; head moves and ineligibility drop it immediately', async t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquire(rootDir);
  const identity = { rootDir, ...IDENTITY, pr: 102, head: 'old' };
  const reserve = head => acquireDaemonMergeLease({ rootDir, ...IDENTITY,
    holderPr: 102, holderHead: head, holderPid: process.pid, holderHost: hostname(), now: '2026-06-20T18:00:00Z' });
  reserve('old');
  await withDaemonMergeReservation({ ...identity, head: 'new' }, async () => {
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), [], 'old head gone before gates run');
    reserve('new');
    return { reason: 'lease-contended' };
  });
  assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY)[0].head, 'new');
  for (const reason of ['not-eligible', 'head-moved', 'already-merged', 'merged']) {
    reserve('new');
    await withDaemonMergeReservation({ ...identity, head: 'new' }, async () => ({ reason }));
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), [], reason);
  }
  reserve('new');
  await assert.rejects(withDaemonMergeReservation({ ...identity, head: 'new' }, async () => {
    throw new Error('synthetic failure');
  }), /synthetic failure/);
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
});

test('daemon waiter deadlines honor explicit and already-scaled overrides', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, ...IDENTITY, pr: 102, head: 'reserved',
    holderPid: process.pid, priority: 'daemon', waiterId: 'daemon' };
  assert.equal(upsertMergeLeaseWaiter({ ...request, deadlineSeconds: 42 }).waiter.deadlineSeconds, 42);
  assert.equal(upsertMergeLeaseWaiter({ ...request, deadlineSeconds: 42,
    effectiveDeadlineSeconds: 84 }).waiter.deadlineSeconds, 84);
  assert.equal(upsertMergeLeaseWaiter(request).waiter.deadlineSeconds, daemonMergeReservationSeconds());
});

test('reservation cleanup without a resolved head preserves existing exact-head waiters', async t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, ...IDENTITY, pr: 102, head: 'reserved',
    holderPid: process.pid, priority: 'daemon', waiterId: 'daemon' };
  upsertMergeLeaseWaiter(request);
  const before = fs.readFileSync(mergeLeaseWaitersFilePath(rootDir, IDENTITY), 'utf8');
  for (const head of [undefined, null, '']) {
    let attempted = false;
    const result = await withDaemonMergeReservation({ ...request, head }, async () => {
      attempted = true;
      return { reason: 'head-unresolved' };
    });
    assert.equal(attempted, true);
    assert.equal(result.reason, 'head-unresolved');
    assert.equal(fs.readFileSync(mergeLeaseWaitersFilePath(rootDir, IDENTITY), 'utf8'), before);
  }
});

test('served daemon reservation is removed before another mutation lock can intervene', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: process.pid, holderHost: hostname() };
  const daemon = acquireDaemonMergeLease({ ...request,
    _afterHolderWrite: ({ leasePath }) => {
      writeFileSync(`${leasePath}.mutation.lock`, JSON.stringify({
        holderPid: process.pid, holderHost: hostname(), acquiredAt: new Date().toISOString(),
      }));
    },
  });
  assert.equal(daemon.acquired, true);
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), [], 'served reservation cannot survive lock contention');
  rmSync(`${daemon.leasePath}.mutation.lock`);
  assert.equal(releaseMergeLease({ rootDir, ...daemon.lease }).released, true);
  assert.equal(acquire(rootDir, { ...request, holderPr: 103, registerWaiter: true }).acquired, true,
    'closer proceeds immediately after daemon release');
});

test('failed served-waiter write rolls back the holder and retains the reservation for retry', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const waitersPath = mergeLeaseWaitersFilePath(rootDir, IDENTITY);
  const leasePath = mergeLeaseFilePath(rootDir, IDENTITY);
  const rename = fs.renameSync;
  const failure = new Error('injected waiter persistence failure');
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === waitersPath && existsSync(leasePath)) throw failure;
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireDaemonMergeLease({ rootDir, ...IDENTITY,
      holderPr: 102, holderHead: 'daemon-head', holderPid: process.pid, holderHost: hostname(),
    }), err => err === failure);
    assert.equal(existsSync(leasePath), false);
    assert.equal(existsSync(`${leasePath}.mutation.lock`), false);
    assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY)[0].priority, 'daemon');
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(acquireDaemonMergeLease({ rootDir, ...IDENTITY,
    holderPr: 102, holderHead: 'daemon-head', holderPid: process.pid, holderHost: hostname(),
  }).acquired, true);
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
});

for (const requester of ['queued', 'pruned', 'unregistered']) {
  test(`lease creation collision reports queue position for ${requester} requester`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const leasePath = mergeLeaseFilePath(rootDir, IDENTITY);
    const competingLease = { leaseId: 'competing-holder', holderPr: 999 };
    const link = fs.linkSync;
    let collisions = 0;
    const mocked = t.mock.method(fs, 'linkSync', (from, to) => {
      if (to === leasePath) {
        // Another writer wins after the initial holder read, before atomic create.
        writeFileSync(to, JSON.stringify(competingLease));
        collisions++;
      }
      return link(from, to);
    });
    syncBuiltinESMExports();
    try {
      const result = acquire(rootDir, { registerWaiter: requester !== 'unregistered',
        waiterId: 'requester', pidAliveFn: () => requester !== 'pruned' });
      assert.equal(collisions, 1, 'exercise the atomic EEXIST path');
      assert.equal(result.acquired, false);
      assert.deepEqual(result.existingLease, competingLease);
      assert.deepEqual(result.lease, competingLease);
      assert.equal(result.queuePosition, requester === 'queued' ? 1 : null);
      assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.waiterId),
        requester === 'queued' ? ['requester'] : [], 'collision never removes a queued request');
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

for (const holderPresent of [false, true]) {
  test(`pruned requester reports unknown queue position with holder ${holderPresent ? 'present' : 'absent'}`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    if (holderPresent) acquire(rootDir);
    upsertMergeLeaseWaiter({ rootDir, ...IDENTITY, pr: 102, head: 'queued',
      waiterId: 'live', holderPid: 4242, holderHost: 'test-host',
      arrivedAt: '2026-06-20T18:00:00Z' });
    const result = acquire(rootDir, { holderPid: 9999, registerWaiter: true,
      waiterId: 'dead', pidAliveFn: pid => pid !== 9999 });
    assert.equal(result.acquired, false);
    assert.equal(result.queuePosition, null);
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.waiterId), ['live']);
  });
}

test('LEASEFAIR-01 daemon reservation wins the next acquisition over repeated closers', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const closer = acquire(rootDir, { holderPid: process.pid, holderHost: hostname() });
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: process.pid, holderHost: hostname(), now: '2026-06-20T18:00:01Z' };
  for (let i = 0; i < 8; i++) {
    acquire(rootDir, { holderPr: 200 + i, waiterId: `closer-${i}`, registerWaiter: true,
      holderPid: process.pid, holderHost: hostname() });
  }
  const deferred = acquireDaemonMergeLease(request);
  assert.equal(deferred.acquired, false);
  assert.equal(deferred.queuePosition, 1);
  assert.equal(deferred.existingLease.leaseId, closer.lease.leaseId, 'never preempt the current holder');
  assert.equal(releaseMergeLease({ rootDir, ...closer.lease, now: '2026-06-20T18:00:02Z' }).released, true);
  for (let i = 0; i < 8; i++) {
    assert.equal(acquire(rootDir, { holderPr: 200 + i, waiterId: `closer-${i}`, registerWaiter: true,
      holderPid: process.pid, holderHost: hostname(), now: '2026-06-20T18:00:02Z' }).acquired, false);
  }
  const resumed = acquireDaemonMergeLease({ ...request, now: '2026-06-20T18:00:03Z' });
  assert.equal(resumed.acquired, true, 'served on first eligible poll after holder release');
  assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY).length, 8, 'one reservation across retries');
});

test('LEASEFAIR-01 daemon FIFO survives watcher restart and renews without losing its place', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const closer = acquire(rootDir);
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: 6001, holderHost: 'test-host', pidAliveFn: () => true };
  acquireDaemonMergeLease({ ...request, now: '2026-06-20T18:00:01Z' });
  acquireDaemonMergeLease({ ...request, holderPr: 103, now: '2026-06-20T18:00:01Z' });
  const first = readMergeLeaseWaiters(rootDir, IDENTITY)[0];
  acquireDaemonMergeLease({ ...request, holderPid: 6002, now: '2026-06-20T18:01:30Z' });
  assert.equal(releaseMergeLease({ rootDir, ...closer.lease, now: '2026-06-20T18:01:31Z' }).released, true);
  const next = acquireDaemonMergeLease({ ...request, holderPr: 103, now: '2026-06-20T18:02:30Z',
    pidAliveFn: () => false });
  assert.equal(next.acquired, false, 'dead watcher PID does not discard the first reservation');
  assert.equal(next.queuePosition, 2);
  const resumed = acquireDaemonMergeLease({ ...request, holderPid: 6002, now: '2026-06-20T18:02:31Z' });
  assert.equal(resumed.acquired, true);
  assert.equal(resumed.waiter.arrivedAt, first.arrivedAt);
  assert.equal(resumed.waiter.holderPid, 6002);
});

test('LEASEFAIR-01 an abandoned daemon reservation expires, letting closers proceed', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const closer = acquire(rootDir);
  acquireDaemonMergeLease({ rootDir, ...IDENTITY, holderPr: 102, holderHead: 'abandoned',
    holderPid: 6001, holderHost: 'test-host', now: '2026-06-20T18:00:00Z', pidAliveFn: () => true });
  releaseMergeLease({ rootDir, ...closer.lease, now: '2026-06-20T18:00:00Z' });
  const later = new Date(Date.parse('2026-06-20T18:00:00Z') + daemonMergeReservationSeconds() * 1000).toISOString();
  const result = acquire(rootDir, { now: later, pidAliveFn: () => true });
  assert.equal(result.acquired, true);
  assert.equal(result.prunedWaiters[0].staleReason, 'expired-waiter');
});

test('LEASEFAIR-01 an expired request rejoins after equal-timestamp live requests', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, ...IDENTITY, head: 'head', holderPid: process.pid,
    holderHost: hostname(), priority: 'daemon' };
  upsertMergeLeaseWaiter({ ...request, pr: 1, waiterId: 'old', arrivedAt: '2026-06-20T18:00:00Z' });
  upsertMergeLeaseWaiter({ ...request, pr: 2, waiterId: 'live', arrivedAt: '2026-06-20T18:10:00Z' });
  upsertMergeLeaseWaiter({ ...request, pr: 1, waiterId: 'old', arrivedAt: '2026-06-20T18:10:00Z' });
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.waiterId), ['live', 'old']);
});

test('key/path derivation uses owner__name__main lease and waiters files', () => {
  const rootDir = freshRoot();
  try {
    const key = deriveLeaseKey(IDENTITY);
    assert.equal(key.key, 'owner/name::main');
    assert.equal(key.repoSlug, 'owner__name');
    assert.equal(key.baseSlug, 'main');
    assert.equal(key.fileSlug, 'owner__name__main');
    assert.equal(
      mergeLeaseFilePath(rootDir, IDENTITY),
      join(rootDir, 'data', 'merge-leases', 'owner__name__main.json'),
    );
    assert.equal(
      mergeLeaseWaitersFilePath(rootDir, IDENTITY),
      join(rootDir, 'data', 'merge-leases', 'owner__name__main.waiters.json'),
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('concurrent acquire for one repo/base yields exactly one holder', () => {
  const rootDir = freshRoot();
  try {
    const results = [];
    for (let i = 0; i < 16; i += 1) {
      results.push(acquire(rootDir, {
        holderPr: 200 + i,
        holderHead: `head-${i}`,
        holderPid: 5000 + i,
        now: `2026-06-20T18:00:${String(i).padStart(2, '0')}Z`,
        pidAliveFn: () => true,
      }));
    }
    const winners = results.filter((r) => r.acquired);
    const losers = results.filter((r) => !r.acquired);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 15);
    for (const loser of losers) {
      assert.equal(loser.existingLease.leaseId, winners[0].lease.leaseId);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reset attempts refuses the current head while it holds the lease', () => {
  const rootDir = freshRoot();
  try {
    const held = acquire(rootDir);
    assert.equal(held.acquired, true);
    recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: 101, head: 'abc123' });
    assert.throws(
      () => resetMergeLeaseGateAttempts({ rootDir, ...IDENTITY, pr: 101, head: 'abc123' }),
      /cannot reset gate attempts while this head holds the merge lease/,
    );
    assert.equal(readMergeLeaseAttempts(rootDir, IDENTITY)[0].attempts, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('FIFO waiter order is durable, visible, and honored before acquire', () => {
  const rootDir = freshRoot();
  try {
    upsertMergeLeaseWaiter({
      rootDir,
      ...IDENTITY,
      pr: 11,
      head: 'aaa',
      holderPid: 5011,
      holderHost: 'test-host',
      waiterId: 'w-later',
      arrivedAt: '2026-06-20T18:00:02Z',
      attempt: 1,
    });
    upsertMergeLeaseWaiter({
      rootDir,
      ...IDENTITY,
      pr: 10,
      head: 'bbb',
      holderPid: 5010,
      holderHost: 'test-host',
      waiterId: 'w-earlier',
      arrivedAt: '2026-06-20T18:00:01Z',
      attempt: 2,
    });

    assert.deepEqual(
      readMergeLeaseWaiters(rootDir, IDENTITY).map((w) => w.waiterId),
      ['w-earlier', 'w-later'],
    );
    assert.deepEqual(
      inspectMergeLease({ rootDir, ...IDENTITY }).waiters.map((w) => w.pr),
      [10, 11],
    );

    const blocked = acquire(rootDir, {
      holderPr: 11,
      holderHead: 'aaa',
      waiterId: 'w-later',
      registerWaiter: true,
      now: '2026-06-20T18:00:03Z',
      pidAliveFn: () => true,
    });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.waiters[0].waiterId, 'w-earlier');

    const acquired = acquire(rootDir, {
      holderPr: 10,
      holderHead: 'bbb',
      waiterId: 'w-earlier',
      registerWaiter: true,
      now: '2026-06-20T18:00:04Z',
      pidAliveFn: () => true,
    });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.lease.holderPr, 10);
    assert.deepEqual(
      readMergeLeaseWaiters(rootDir, IDENTITY).map((w) => w.waiterId),
      ['w-later'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('dead or expired FIFO waiters are pruned before head-of-queue acquire', () => {
  const rootDir = freshRoot();
  try {
    upsertMergeLeaseWaiter({
      rootDir,
      ...IDENTITY,
      pr: 20,
      head: 'dead-head',
      holderPid: 5020,
      holderHost: 'test-host',
      deadlineSeconds: 900,
      waiterId: 'w-dead',
      arrivedAt: '2026-06-20T18:00:01Z',
    });
    const expired = upsertMergeLeaseWaiter({
      rootDir,
      ...IDENTITY,
      pr: 21,
      head: 'expired-head',
      holderPid: 5021,
      holderHost: 'other-host',
      deadlineSeconds: 10,
      waiterId: 'w-expired',
      arrivedAt: '2026-06-20T18:00:02Z',
    });

    const acquired = acquire(rootDir, {
      holderPr: 22,
      holderHead: 'next-head',
      holderPid: 5022,
      holderHost: 'test-host',
      waiterId: 'w-next',
      registerWaiter: true,
      deadlineSeconds: 900,
      now: new Date(Date.parse(expired.waiter.arrivedAt) + (expired.waiter.deadlineSeconds + 1) * 1000).toISOString(),
      pidAliveFn: (pid) => pid !== 5020,
    });

    assert.equal(acquired.acquired, true);
    assert.deepEqual(
      acquired.prunedWaiters.map((w) => w.waiterId),
      ['w-dead', 'w-expired'],
    );
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('release with matching lease identity frees it and subsequent acquire succeeds', () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir);
    assert.equal(first.acquired, true);
    const released = releaseMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
    });
    assert.equal(released.released, true);
    assert.equal(existsSync(first.leasePath), false);

    const second = acquire(rootDir, {
      holderPr: 202,
      holderHead: 'def456',
      holderPid: 5252,
      now: '2026-06-20T18:01:00Z',
    });
    assert.equal(second.acquired, true);
    assert.equal(second.lease.holderPr, 202);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('release with matching lease identity preserves gate attempts for retry caps', () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir, {
      holderHead: 'attempt-head',
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: first.lease.holderPr,
      head: first.lease.holderHead,
      now: '2026-06-20T18:00:10Z',
      maxAttempts: 5,
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: 999,
      head: 'other-head',
      now: '2026-06-20T18:00:11Z',
      maxAttempts: 5,
    });

    const released = releaseMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
    });

    assert.equal(released.released, true);
    assert.deepEqual(
      readMergeLeaseAttempts(rootDir, IDENTITY).map((attempt) => `${attempt.pr}:${attempt.head}`),
      ['101:attempt-head', '999:other-head'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retryable-abort release refunds only the current matching holder attempt', () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir, {
      holderHead: 'transient-head',
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: first.lease.holderPr,
      head: first.lease.holderHead,
      now: '2026-06-20T18:00:10Z',
      maxAttempts: 5,
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: 999,
      head: 'other-head',
      now: '2026-06-20T18:00:11Z',
      maxAttempts: 5,
    });

    const released = releaseMergeLeaseForRetryableAbort({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
      retryableAbortReason: 'github-gate-read-failed',
      now: '2026-06-20T18:00:12Z',
    });

    assert.equal(released.released, true);
    assert.equal(released.retryableAbort, true);
    assert.equal(released.retryableAbortReason, 'github-gate-read-failed');
    assert.equal(released.attemptPrune.removed, true);
    assert.deepEqual(
      readMergeLeaseAttempts(rootDir, IDENTITY).map((attempt) => `${attempt.pr}:${attempt.head}:${attempt.attempts}:${attempt.retryable}`),
      ['101:transient-head:0:1', '999:other-head:1:0'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retryable abort preserves earlier non-retryable failures on the same head', () => {
  const rootDir = freshRoot();
  try {
    const head = 'mixed-failure-head';
    recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: 101, head, maxAttempts: 2 });
    const held = acquire(rootDir, { holderHead: head });
    recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: 101, head, maxAttempts: 2 });
    const released = releaseMergeLeaseForRetryableAbort({
      rootDir, ...IDENTITY, leaseId: held.lease.leaseId,
      holderPr: 101, holderHead: head, acquiredAt: held.lease.acquiredAt,
      retryableAbortReason: 'gate-read-http-404',
    });
    assert.equal(released.released, true);
    assert.deepEqual(readMergeLeaseAttempts(rootDir, IDENTITY).map(({ attempts, retryable }) => [attempts, retryable]), [[1, 1]]);
    const next = recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: 101, head, maxAttempts: 2 });
    assert.equal(next.parked, false);
    assert.equal(next.attempt.attempts, 2);
    const capped = recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: 101, head, maxAttempts: 2 });
    assert.equal(capped.parked, true);
    assert.equal(capped.attempt.retryable, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('retryable-abort release does not mutate attempts or drop lease when attempts lock is busy', () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir, {
      holderHead: 'transient-head',
    });
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: first.lease.holderPr,
      head: first.lease.holderHead,
      now: '2026-06-20T18:00:10Z',
      maxAttempts: 5,
    });
    const attemptsPath = mergeLeaseAttemptsFilePath(rootDir, IDENTITY);
    writeFileSync(`${attemptsPath}.mutation.lock`, `${JSON.stringify({
      schemaVersion: 1,
      lockId: 'test-held-attempts-lock',
      holderPid: process.pid,
      holderHost: hostname(),
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const released = releaseMergeLeaseForRetryableAbort({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
      retryableAbortReason: 'github-gate-read-failed',
      now: '2026-06-20T18:00:12Z',
    });

    assert.equal(released.released, false);
    assert.equal(released.reason, 'mutation-lock-busy');
    assert.equal(existsSync(mergeLeaseFilePath(rootDir, IDENTITY)), true);
    assert.deepEqual(
      readMergeLeaseAttempts(rootDir, IDENTITY).map((attempt) => `${attempt.pr}:${attempt.head}`),
      ['101:transient-head'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('recordMergeLeaseGateAttempt honors legacy waiter mutation lock during rollout', () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir);
    const leasePath = mergeLeaseFilePath(rootDir, IDENTITY);
    writeFileSync(`${leasePath}.mutation.lock`, `${JSON.stringify({
      schemaVersion: 1,
      lockId: 'test-held-legacy-waiter-lock',
      holderPid: process.pid,
      holderHost: hostname(),
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`);

    assert.throws(
      () => recordMergeLeaseGateAttempt({
        rootDir,
        ...IDENTITY,
        pr: 501,
        head: 'rollout-head',
        now: '2026-06-20T18:00:00Z',
        maxAttempts: 5,
      }),
      /mutation lock busy while updating waiters/,
    );
    assert.deepEqual(readMergeLeaseAttempts(rootDir, IDENTITY), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('recordMergeLeaseGateAttempt prunes expired attempt records before counting', () => {
  const rootDir = freshRoot();
  try {
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: 501,
      head: 'old-head',
      now: '2026-05-01T18:00:00Z',
      maxAttempts: 5,
    });
    const current = recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: 501,
      head: 'old-head',
      now: '2026-06-20T18:00:00Z',
      maxAttempts: 5,
    });

    assert.equal(current.attempt.attempts, 1);
    assert.deepEqual(
      readMergeLeaseAttempts(rootDir, IDENTITY).map((attempt) => ({
        pr: attempt.pr,
        head: attempt.head,
        attempts: attempt.attempts,
        firstAttemptAt: attempt.firstAttemptAt,
      })),
      [{
        pr: 501,
        head: 'old-head',
        attempts: 1,
        firstAttemptAt: '2026-06-20T18:00:00Z',
      }],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stale release with old lease id and identity does not delete a newer lease', () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir);
    releaseMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
    });
    const newer = acquire(rootDir, {
      holderPr: 303,
      holderHead: 'new-head',
      holderPid: 6262,
      now: '2026-06-20T18:02:00Z',
    });
    const stale = releaseMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
    });
    assert.equal(stale.released, false);
    assert.equal(stale.existingLease.leaseId, newer.lease.leaseId);
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).holder.leaseId, newer.lease.leaseId);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('release rechecks the holder fence immediately before deleting', () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir);
    let newer = null;
    const stale = releaseMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: first.lease.leaseId,
      holderPr: first.lease.holderPr,
      holderHead: first.lease.holderHead,
      acquiredAt: first.lease.acquiredAt,
      _afterFenceRead: () => {
        releaseMergeLease({
          rootDir,
          ...IDENTITY,
          leaseId: first.lease.leaseId,
          holderPr: first.lease.holderPr,
          holderHead: first.lease.holderHead,
          acquiredAt: first.lease.acquiredAt,
        });
        newer = acquire(rootDir, {
          holderPr: 304,
          holderHead: 'newer-release-head',
          holderPid: 6363,
          now: '2026-06-20T18:02:30Z',
        });
      },
    });
    assert.equal(newer.acquired, true);
    assert.equal(stale.released, false);
    assert.equal(stale.existingLease.leaseId, newer.lease.leaseId);
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).holder.leaseId, newer.lease.leaseId);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reclaimIfStale reclaims dead same-host owner pid holder', () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, { holderPid: 99999, holderHost: 'test-host' });
    const reclaimed = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => false,
    });
    assert.equal(reclaimed.reclaimed, true);
    assert.equal(reclaimed.reason, 'dead-holder-pid');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reclaimIfStale breaks stale mutation lock before reclaiming holder', () => {
  const rootDir = freshRoot();
  try {
    const acquired = acquire(rootDir, { holderPid: 99999, holderHost: 'test-host' });
    const lockPath = `${acquired.leasePath}.mutation.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        lockId: 'mll_stale_dead_pid',
        holderPid: 99998,
        holderHost: hostname(),
        acquiredAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );

    const reclaimed = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => false,
    });

    assert.equal(reclaimed.reclaimed, true);
    assert.equal(reclaimed.reason, 'dead-holder-pid');
    assert.equal(existsSync(lockPath), false);
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('acquireMergeLease reclaims dead holder before acquiring', () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, { holderPid: 99999, holderHost: 'test-host' });

    const acquired = acquire(rootDir, {
      holderPr: 202,
      holderHead: 'new-after-reclaim',
      holderPid: 5202,
      holderHost: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => false,
    });

    assert.equal(acquired.acquired, true);
    assert.equal(acquired.reclaim.reclaimed, true);
    assert.equal(acquired.lease.holderPr, 202);
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).holder.holderHead, 'new-after-reclaim');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reclaimIfStale preserves mutation-lock-busy reason for live lock', () => {
  const rootDir = freshRoot();
  try {
    const acquired = acquire(rootDir, { holderPid: 99999, holderHost: 'test-host' });
    const lockPath = `${acquired.leasePath}.mutation.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        lockId: 'mll_live',
        holderPid: process.pid,
        holderHost: hostname(),
        acquiredAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );

    const result = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => false,
    });

    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, 'mutation-lock-busy');
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reclaimIfStale does not reclaim live within-deadline holder', () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, {
      holderPid: 99998,
      holderHost: 'test-host',
      deadlineSeconds: 900,
      now: '2026-06-20T18:00:00Z',
    });
    const result = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:10:00Z',
      pidAliveFn: () => true,
    });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, 'live-within-deadline');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reclaimIfStale does not reclaim a live same-host past-deadline holder', () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, {
      holderPid: 99997,
      holderHost: 'test-host',
      deadlineSeconds: 10,
      now: '2026-06-20T18:00:00Z',
    });
    const result = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:00:11Z',
      pidAliveFn: () => true,
    });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, 'live-within-deadline');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reclaimIfStale can reclaim a past-deadline cross-host holder', () => {
  const rootDir = freshRoot();
  try {
    const acquired = acquire(rootDir, {
      holderPid: 99996,
      holderHost: 'other-host',
      deadlineSeconds: 10,
      now: '2026-06-20T18:00:00Z',
    });
    const result = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: new Date(Date.parse(acquired.lease.acquiredAt) + (acquired.lease.deadlineSeconds + 1) * 1000).toISOString(),
      pidAliveFn: () => true,
    });
    assert.equal(result.reclaimed, true);
    assert.equal(result.reason, 'past-deadline');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reconcileMergeLeases releases a dead-owner-pid holder', async () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, { holderPid: 99996, holderHost: 'test-host' });
    const reconciled = await reconcileMergeLeases({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => false,
      execFileImpl: () => {
        throw new Error('gh should not be called for stale holder reclaim');
      },
    });
    assert.equal(reconciled.released, true);
    assert.equal(reconciled.reason, 'dead-holder-pid');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reconcileMergeLeases releases a holder whose PR is already merged', async () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, { holderPid: 99995, holderHost: 'test-host' });
    const reconciled = await reconcileMergeLeases({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => true,
      execFileImpl: (file, args, options, callback) => {
        assert.equal(file, 'gh');
        assert.deepEqual(args, ['pr', 'view', '101', '--repo', 'owner/name', '--json', 'state']);
        assert.ok(Number.isInteger(options.timeout) && options.timeout >= 30000 && options.timeout <= 180000);
        assert.equal(options.maxBuffer, 10 * 1024 * 1024);
        callback(null, '{"state":"MERGED"}\n', '');
      },
    });
    assert.equal(reconciled.released, true);
    assert.equal(reconciled.reason, 'holder-pr-merged');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reconcileMergeLeases keeps going when attempt prune lock is busy after release', async () => {
  const rootDir = freshRoot();
  try {
    acquire(rootDir, { holderPid: 99995, holderHost: 'test-host' });
    recordMergeLeaseGateAttempt({
      rootDir,
      ...IDENTITY,
      pr: 101,
      head: 'abc123',
      now: '2026-06-20T18:00:10Z',
      maxAttempts: 5,
    });
    const attemptsPath = mergeLeaseAttemptsFilePath(rootDir, IDENTITY);
    writeFileSync(`${attemptsPath}.mutation.lock`, `${JSON.stringify({
      schemaVersion: 1,
      lockId: 'test-held-attempts-lock',
      holderPid: process.pid,
      holderHost: hostname(),
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`);

    const reconciled = await reconcileMergeLeases({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => true,
      execFileImpl: (file, args, options, callback) => {
        assert.equal(file, 'gh');
        assert.deepEqual(args, ['pr', 'view', '101', '--repo', 'owner/name', '--json', 'state']);
        assert.ok(Number.isInteger(options.timeout) && options.timeout >= 30000 && options.timeout <= 180000);
        assert.equal(options.maxBuffer, 10 * 1024 * 1024);
        callback(null, '{"state":"MERGED"}\n', '');
      },
    });

    assert.equal(reconciled.released, true);
    assert.equal(reconciled.reason, 'holder-pr-merged');
    assert.equal(reconciled.attemptPrune.skipped, true);
    assert.equal(reconciled.attemptPrune.reason, 'attempt-mutation-lock-busy');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
    assert.deepEqual(
      readMergeLeaseAttempts(rootDir, IDENTITY).map((attempt) => `${attempt.pr}:${attempt.head}`),
      ['101:abc123'],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reconcileMergeLeases stale identity does not delete a newer holder', async () => {
  const rootDir = freshRoot();
  try {
    const first = acquire(rootDir);
    let newer = null;
    const reconciled = await reconcileMergeLeases({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => true,
      execFileImpl: (file, args, options, callback) => {
        releaseMergeLease({
          rootDir,
          ...IDENTITY,
          leaseId: first.lease.leaseId,
          holderPr: first.lease.holderPr,
          holderHead: first.lease.holderHead,
          acquiredAt: first.lease.acquiredAt,
        });
        newer = acquire(rootDir, {
          holderPr: 909,
          holderHead: 'newer-reconcile-head',
          holderPid: 9909,
          now: '2026-06-20T18:01:01Z',
        });
        assert.ok(Number.isInteger(options.timeout) && options.timeout >= 30000 && options.timeout <= 180000);
        callback(null, '{"state":"MERGED"}\n', '');
      },
    });
    assert.equal(newer.acquired, true);
    assert.equal(reconciled.released, false);
    assert.equal(reconciled.reason, 'identity-changed');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).holder.leaseId, newer.lease.leaseId);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('renewMergeLease extends a holder-fenced deadline', () => {
  const rootDir = freshRoot();
  try {
    const acquired = acquire(rootDir, {
      holderPid: 99995,
      holderHost: 'test-host',
      deadlineSeconds: 10,
      now: '2026-06-20T18:00:00Z',
    });
    const renewed = renewMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: acquired.lease.leaseId,
      holderPr: acquired.lease.holderPr,
      holderHead: acquired.lease.holderHead,
      acquiredAt: acquired.lease.acquiredAt,
      now: '2026-06-20T18:00:09Z',
    });
    assert.equal(renewed.renewed, true);
    assert.equal(renewed.lease.acquiredAt, '2026-06-20T18:00:09Z');

    const result = reclaimIfStale({
      rootDir,
      ...IDENTITY,
      host: 'other-host',
      now: '2026-06-20T18:00:18Z',
      pidAliveFn: () => false,
    });
    assert.equal(result.reclaimed, false);
    assert.equal(result.reason, 'live-within-deadline');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('renew rechecks the holder fence immediately before overwriting', () => {
  const rootDir = freshRoot();
  try {
    const acquired = acquire(rootDir, {
      holderPid: 99994,
      holderHost: 'test-host',
      deadlineSeconds: 10,
      now: '2026-06-20T18:00:00Z',
    });
    let newer = null;
    const staleRenew = renewMergeLease({
      rootDir,
      ...IDENTITY,
      leaseId: acquired.lease.leaseId,
      holderPr: acquired.lease.holderPr,
      holderHead: acquired.lease.holderHead,
      acquiredAt: acquired.lease.acquiredAt,
      now: '2026-06-20T18:00:09Z',
      _afterFenceRead: () => {
        releaseMergeLease({
          rootDir,
          ...IDENTITY,
          leaseId: acquired.lease.leaseId,
          holderPr: acquired.lease.holderPr,
          holderHead: acquired.lease.holderHead,
          acquiredAt: acquired.lease.acquiredAt,
        });
        newer = acquire(rootDir, {
          holderPr: 505,
          holderHead: 'newer-renew-head',
          holderPid: 9505,
          now: '2026-06-20T18:00:05Z',
        });
      },
    });
    assert.equal(newer.acquired, true);
    assert.equal(staleRenew.renewed, false);
    assert.equal(staleRenew.existingLease.leaseId, newer.lease.leaseId);
    const inspected = inspectMergeLease({ rootDir, ...IDENTITY });
    assert.equal(inspected.holder.leaseId, newer.lease.leaseId);
    assert.equal(inspected.holder.holderPr, 505);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('inspectMergeLease returns stored holder, age, deadline, and waiters', () => {
  const rootDir = freshRoot();
  try {
    const acquired = acquire(rootDir, {
      holderPr: 404,
      holderHead: 'inspect-head',
      holderPid: 7777,
      holderProcessGroup: 7000,
      deadlineSeconds: 120,
      now: '2026-06-20T18:00:00Z',
    });
    upsertMergeLeaseWaiter({
      rootDir,
      ...IDENTITY,
      pr: 405,
      head: 'wait-head',
      holderPid: 7405,
      holderHost: 'test-host',
      waiterId: 'w-inspect',
      arrivedAt: '2026-06-20T18:00:05Z',
    });
    const status = inspectMergeLease({
      rootDir,
      ...IDENTITY,
      host: 'test-host',
      now: '2026-06-20T18:01:00Z',
      pidAliveFn: () => true,
    });
    assert.equal(status.exists, true);
    assert.equal(status.holder.leaseId, acquired.lease.leaseId);
    assert.equal(status.holder.holderProcessGroup, 7000);
    assert.equal(status.ageSeconds, 60);
    assert.equal(status.deadlineSeconds, acquired.lease.deadlineSeconds);
    assert.ok(status.deadlineSeconds >= 120 && status.deadlineSeconds <= 720);
    assert.equal(status.pastDeadline, false);
    assert.equal(status.holderPidLive, true);
    assert.equal(status.waiters.length, 1);
    assert.equal(status.waiters[0].waiterId, 'w-inspect');
    removeMergeLeaseWaiter({ rootDir, ...IDENTITY, waiterId: 'w-inspect' });
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('holder identity validation rejects null empty and non-positive numeric values', () => {
  const rootDir = freshRoot();
  try {
    assert.throws(() => acquire(rootDir, { holderPid: 0 }), /holderPid must be a positive integer/);
    assert.throws(() => acquire(rootDir, { holderPid: '' }), /holderPid must be a positive integer/);
    assert.throws(() => acquire(rootDir, { holderPr: null }), /holderPr must be a positive integer/);
    assert.throws(() => acquire(rootDir, { holderPr: false }), /holderPr must be a positive integer/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('LVR-02 incident waiters lead FIFO within their class, preserving daemon reservations and holders', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const held = acquire(rootDir);
  const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
  const queue = (id, seconds, extra = {}) => acquire(rootDir, {
    holderPr: 100 + seconds, holderHead: 'b'.repeat(40), registerWaiter: true,
    waiterId: id, now: at(seconds), pidAliveFn: () => true, ...extra,
  });
  queue('ordinary-first', 1);
  queue('ordinary-second', 2);
  queue('incident-first', 3, { prBody: '<!-- deploy-incident:v1 id=incident-1 -->' });
  queue('incident-second', 4, { prBody: '<!-- deploy-incident:v1 id=incident-2 -->' });
  queue('daemon-first', 5, { waiterPriority: 'daemon' });
  queue('daemon-incident', 6, { waiterPriority: 'daemon', prBody: '<!-- deploy-incident:v1 id=incident-3 -->' });
  assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).lease.leaseId, held.lease.leaseId);
  const ids = () => readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.waiterId);
  assert.deepEqual(ids(), ['daemon-incident', 'daemon-first', 'incident-first', 'incident-second', 'ordinary-first', 'ordinary-second']);
  // Renewal retains arrival and marker when no new body snapshot is supplied.
  queue('incident-first', 7);
  assert.deepEqual(ids(), ['daemon-incident', 'daemon-first', 'incident-first', 'incident-second', 'ordinary-first', 'ordinary-second']);
  releaseMergeLease({ rootDir, ...held.lease, now: at(8) });
  assert.equal(queue('incident-first', 9).acquired, false);
  assert.equal(queue('daemon-incident', 10, { waiterPriority: 'daemon' }).acquired, true);
});
