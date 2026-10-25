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
  readMergeLeaseHistory,
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
  assert.equal(releaseMergeLease({ rootDir, ...holder.lease, now: afterExpiry, merged: true,
    requestWatcherWakeImpl: wake }).released, true);
  assert.equal(wakes, 0);
  const next = acquire(rootDir, { now: afterExpiry });
  acquire(rootDir, { holderPr: 103, waiterId: 'ordinary', registerWaiter: true, now: afterExpiry,
    holderPid: process.pid, holderHost: hostname() });
  assert.equal(releaseMergeLease({ rootDir, ...next.lease, now: afterExpiry, merged: true,
    requestWatcherWakeImpl: wake }).released, true);
  assert.equal(wakes, 0);
  const servedCloser = acquire(rootDir, { holderPr: 103, waiterId: 'ordinary', registerWaiter: true, now: afterExpiry,
    holderPid: process.pid, holderHost: hostname() });
  releaseMergeLease({ rootDir, ...servedCloser.lease, now: afterExpiry, merged: true });
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

test('arrival order across roles prevents a later daemon from overtaking ready closers', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const held = acquire(rootDir);
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: process.pid, holderHost: hostname(), now: '2026-06-20T18:00:01Z' };
  for (let i = 0; i < 3; i++) {
    acquire(rootDir, { holderPr: 200 + i, waiterId: `closer-${i}`, registerWaiter: true,
      holderPid: process.pid, holderHost: hostname() });
  }
  assert.equal(acquireDaemonMergeLease(request).queuePosition, 4);
  releaseMergeLease({ rootDir, ...held.lease, now: request.now, merged: true });
  for (let i = 0; i < 3; i++) {
    assert.equal(acquireDaemonMergeLease(request).acquired, false);
    const closer = acquire(rootDir, { holderPr: 200 + i, waiterId: `closer-${i}`, registerWaiter: true,
      holderPid: process.pid, holderHost: hostname(), now: request.now });
    assert.equal(closer.acquired, true);
    releaseMergeLease({ rootDir, ...closer.lease, now: request.now, merged: true });
  }
  assert.equal(acquireDaemonMergeLease(request).acquired, true);
});

test('an exited watcher reservation is pruned; a live watcher refresh retains its arrival', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const held = acquire(rootDir);
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: 6001, holderHost: 'test-host', pidAliveFn: () => true };
  acquireDaemonMergeLease({ ...request, now: '2026-06-20T18:00:01Z' });
  const closer = { holderPr: 103, holderPid: 6002, registerWaiter: true, waiterId: 'ready',
    now: '2026-06-20T18:00:02Z', pidAliveFn: pid => pid !== 6001 };
  acquire(rootDir, closer);
  releaseMergeLease({ rootDir, ...held.lease, now: closer.now, merged: true });
  assert.equal(acquire(rootDir, closer).acquired, true, 'dead daemon cannot block ready work');
  assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY).length, 0);
});

test('a live daemon refresh preserves its arrival behind an earlier closer across roles', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquire(rootDir);
  acquire(rootDir, { holderPr: 103, registerWaiter: true, waiterId: 'earlier', pidAliveFn: () => true });
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'daemon-head',
    holderPid: 6001, holderHost: 'test-host', pidAliveFn: () => true };
  const first = acquireDaemonMergeLease({ ...request, now: '2026-06-20T18:00:01Z' });
  const refreshed = acquireDaemonMergeLease({ ...request, now: '2026-06-20T18:01:30Z' });
  assert.equal(refreshed.queuePosition, 2);
  assert.equal(refreshed.waiter.arrivedAt, first.waiter.arrivedAt);
});

test('daemon no-merge holder rejoins behind waiting closer, backs off and parks repeated failures', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'failing-head',
    holderPid: process.pid, holderHost: hostname(), pidAliveFn: () => true };
  let held = acquireDaemonMergeLease({ ...request, now: at(0) });
  const closerArgs = { holderPr: 103, registerWaiter: true, waiterId: 'ready',
    holderPid: process.pid, holderHost: hostname(), now: at(1), pidAliveFn: () => true };
  acquire(rootDir, closerArgs);
  let seconds = 2;
  for (let count = 1; count <= 5; count++) {
    const released = releaseMergeLease({ rootDir, ...held.lease, now: at(seconds), reason: 'synthetic-pre-merge-failure' });
    assert.equal(released.retry.noMergeReleases, count);
    assert.equal(Date.parse(released.retry.nextEligibleAt) - Date.parse(at(seconds)), 1000 * 2 ** (count - 1));
    if (count === 1) {
      assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.pr), [103, 102]);
      assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY)[1].arrivedAt, at(seconds));
      assert.equal(released.retry.queueArrivedAt, undefined);
      const closer = acquire(rootDir, { ...closerArgs, now: at(seconds) });
      assert.equal(closer.acquired, true, 'ready closer is served within one failed holder cycle');
      releaseMergeLease({ rootDir, ...closer.lease, now: at(seconds), merged: true });
    }
    const blocked = acquireDaemonMergeLease({ ...request, now: at(seconds) });
    assert.equal(blocked.acquired, false);
    assert.equal(blocked.reason, count === 5 ? 'repeated-no-merge-release' : 'no-merge-backoff');
    seconds += 2 ** (count - 1);
    if (count < 5) held = acquireDaemonMergeLease({ ...request, now: at(seconds) });
    else {
      assert.equal(blocked.parked, true);
      assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
    }
  }
  assert.equal(acquireDaemonMergeLease({ ...request, holderHead: 'new-head', now: at(seconds) }).acquired, true);
  const history = readMergeLeaseHistory(rootDir, IDENTITY);
  assert.equal(history.filter(row => row.event === 'requeue').length, 4);
  assert.equal(history.find(row => row.event === 'park').reason,
    're-queued after no-merge release: synthetic-pre-merge-failure');
});

for (const newHead of [false, true]) {
  test(`closer retains its original arrival and backoff on ${newHead ? 'a new' : 'the same'} head`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
    const args = { registerWaiter: true, pidAliveFn: () => true };
    const blocker = acquire(rootDir);
    const queued = acquire(rootDir, { ...args, holderPr: 201, waiterId: 'original', now: at(1) });
    acquire(rootDir, { ...args, holderPr: 202, waiterId: 'later', now: at(2) });
    releaseMergeLease({ rootDir, ...blocker.lease, now: at(3), merged: true });
    const held = acquire(rootDir, { ...args, holderPr: 201, waiterId: 'original', now: at(4) });
    assert.equal(held.acquired, true);
    const released = releaseMergeLease({ rootDir, ...held.lease, now: at(4), yielded: true,
      reason: 'required-checks-wait' });
    assert.equal(released.retry.queueArrivedAt, queued.waiter.arrivedAt);
    assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY).map(w => w.pr), [202]);
    const resumedArgs = { ...args, holderPr: 201, holderHead: newHead ? 'rebased-head' : held.lease.holderHead,
      waiterId: 'fresh-invocation' };
    const delayed = acquire(rootDir, { ...resumedArgs, now: at(4) });
    assert.equal(delayed.acquired, false);
    assert.equal(delayed.reason, 'no-merge-backoff');
    assert.equal(delayed.waiter.arrivedAt, queued.waiter.arrivedAt);
    assert.equal(delayed.waiter.notBefore, released.retry.nextEligibleAt);
    const later = acquire(rootDir, { ...args, holderPr: 202, waiterId: 'later', now: at(4) });
    assert.equal(later.acquired, true, 'a delayed earlier arrival lets ready waiters proceed');
    acquire(rootDir, { ...args, holderPr: 203, waiterId: 'last', now: at(4.5) });
    releaseMergeLease({ rootDir, ...later.lease, now: at(5), merged: true });
    assert.equal(acquire(rootDir, { ...args, holderPr: 203, waiterId: 'last', now: at(5) }).acquired, false);
    const resumed = acquire(rootDir, { ...resumedArgs, now: at(5) });
    assert.equal(resumed.acquired, true, 'eligible closer resumes ahead of later arrivals');
    releaseMergeLease({ rootDir, ...resumed.lease, now: at(5), reason: 'published' });
    const records = readMergeLeaseAttempts(rootDir, IDENTITY).filter(r => r.pr === 201);
    assert.deepEqual(records.filter(r => r.queueArrivedAt).map(r => r.queueArrivedAt), [queued.waiter.arrivedAt]);
    assert.equal(records.find(r => r.head === resumed.lease.holderHead).consecutiveNoMergeReleases, 1);
  });
}

for (const legacy of [false, true]) {
  test(`long-absent closer rejoins behind a continuously queued waiter (${legacy ? 'legacy' : 'explicit'} deadline)`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
    const args = { registerWaiter: true, pidAliveFn: () => true };
    const first = acquire(rootDir, { ...args, waiterId: 'first' });
    const released = releaseMergeLease({ rootDir, ...first.lease, now: at(1), yielded: true,
      reason: 'required-checks-wait' });
    assert.ok(Date.parse(released.retry.queueArrivalExpiresAt) > Date.parse(released.retry.nextEligibleAt));
    if (legacy) {
      const path = mergeLeaseAttemptsFilePath(rootDir, IDENTITY);
      const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
      delete doc.attempts[0].queueArrivalExpiresAt;
      writeFileSync(path, JSON.stringify(doc));
    }
    const blocker = acquire(rootDir, { holderPr: 200, now: at(2 * 86400 - 2401), pidAliveFn: () => true,
      deadlineSeconds: 3600 });
    acquire(rootDir, { ...args, holderPr: 202, waiterId: 'continuous', now: at(2 * 86400 - 2400),
      waiterDeadlineSeconds: 3600 });
    releaseMergeLease({ rootDir, ...blocker.lease, now: at(2 * 86400), merged: true });
    const returned = acquire(rootDir, { ...args, waiterId: 'returned', now: at(2 * 86400) });
    assert.equal(returned.acquired, false);
    assert.equal(returned.waiter.arrivedAt, at(2 * 86400));
    assert.equal(acquire(rootDir, { ...args, holderPr: 202, waiterId: 'continuous',
      now: at(2 * 86400), waiterDeadlineSeconds: 3600 }).acquired, true);
  });
}

for (const sameHead of [true, false]) {
  test(`daemon release preserves closer memory without extending it on ${sameHead ? 'the same' : 'another'} head`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = { registerWaiter: true, pidAliveFn: () => true };
    const first = acquire(rootDir, { ...args, waiterId: 'first' });
    const released = releaseMergeLease({ rootDir, ...first.lease, now: first.lease.acquiredAt, yielded: true });
    const daemonArgs = { rootDir, ...IDENTITY, holderPr: first.lease.holderPr,
      holderHead: sameHead ? first.lease.holderHead : 'daemon-head', holderPid: process.pid,
      holderHost: hostname(), pidAliveFn: () => true };
    const daemon = acquireDaemonMergeLease({ ...daemonArgs, now: released.retry.nextEligibleAt });
    assert.equal(daemon.acquired, true);
    releaseMergeLease({ rootDir, ...daemon.lease, now: released.retry.nextEligibleAt, yielded: true });
    const memory = readMergeLeaseAttempts(rootDir, IDENTITY).find(r => r.queueArrivedAt);
    assert.equal(memory.queueArrivedAt, first.waiter.arrivedAt);
    assert.equal(memory.queueArrivalExpiresAt, released.retry.queueArrivalExpiresAt);
    removeMergeLeaseWaiter({ rootDir, ...IDENTITY, waiterId: daemon.waiter.waiterId });
    const restored = upsertMergeLeaseWaiter({ rootDir, ...IDENTITY, pr: first.lease.holderPr,
      head: first.lease.holderHead, waiterId: 'restored', updatedAt: '2026-06-20T18:00:04Z',
      holderPid: process.pid, holderHost: hostname() });
    assert.equal(restored.waiter.arrivedAt, first.waiter.arrivedAt);
    removeMergeLeaseWaiter({ rootDir, ...IDENTITY, waiterId: 'restored' });
    const fresh = upsertMergeLeaseWaiter({ rootDir, ...IDENTITY, pr: first.lease.holderPr,
      head: first.lease.holderHead, waiterId: 'expired', updatedAt: memory.queueArrivalExpiresAt,
      holderPid: process.pid, holderHost: hostname() });
    assert.equal(fresh.waiter.arrivedAt, memory.queueArrivalExpiresAt, 'daemon release cannot renew closer priority');
  });
}

test('restored delayed closer wakes and yields to a ready daemon, then regains FIFO order', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
  const args = { registerWaiter: true, holderPid: process.pid, holderHost: hostname() };
  const first = acquire(rootDir, { ...args, waiterId: 'first' });
  releaseMergeLease({ rootDir, ...first.lease, now: at(4), yielded: true });
  const blocker = acquire(rootDir, { ...args, holderPr: 200, waiterId: 'blocker', now: at(4) });
  const closer = { ...args, waiterId: 'restored' };
  assert.equal(acquire(rootDir, { ...closer, now: at(4) }).acquired, false);
  const daemonArgs = { rootDir, ...IDENTITY, holderPr: 202, holderHead: 'daemon-head',
    holderPid: process.pid, holderHost: hostname() };
  const reservation = acquireDaemonMergeLease({ ...daemonArgs, now: at(4) });
  const wakes = [];
  releaseMergeLease({ rootDir, ...blocker.lease, now: at(4), merged: true,
    requestWatcherWakeImpl: request => wakes.push(request) });
  assert.deepEqual(wakes.map(w => [w.prNumber, w.headSha]), [[202, reservation.waiter.head]]);
  const daemon = acquireDaemonMergeLease({ ...daemonArgs, now: at(4) });
  assert.equal(daemon.acquired, true);
  const laterDaemon = { ...daemonArgs, holderPr: 203, holderHead: 'later-daemon' };
  acquireDaemonMergeLease({ ...laterDaemon, now: at(4.5) });
  releaseMergeLease({ rootDir, ...daemon.lease, now: at(5), merged: true });
  assert.equal(acquireDaemonMergeLease({ ...laterDaemon, now: at(5) }).acquired, false);
  assert.equal(acquire(rootDir, { ...closer, now: at(5) }).acquired, true);
});

test('restored closer arrival does not expire a fresh invocation or extend its deadline on refresh', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { registerWaiter: true, waiterId: 'first', waiterDeadlineSeconds: 10, pidAliveFn: () => true };
  const held = acquire(rootDir, args);
  releaseMergeLease({ rootDir, ...held.lease, now: '2026-06-20T18:01:00Z', reason: 'published' });
  const next = acquire(rootDir, { ...args, waiterId: 'next', now: '2026-06-20T18:01:00Z' });
  assert.equal(next.waiter.arrivedAt, held.waiter.arrivedAt);
  assert.equal(next.waiter.registeredAt, '2026-06-20T18:01:00Z');
  assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY).length, 1);
  const refreshed = acquire(rootDir, { ...args, waiterId: 'next', now: '2026-06-20T18:01:00.500Z' });
  assert.equal(refreshed.waiter.registeredAt, next.waiter.registeredAt);
  assert.equal(acquire(rootDir, { holderPr: 202, pidAliveFn: () => true, now: next.waiter.notBefore }).acquired, false,
    'restored waiter remains queued until its own invocation deadline');
  assert.equal(acquire(rootDir, { holderPr: 202, pidAliveFn: () => true, now: '2026-06-20T18:01:10Z' }).acquired, true,
    'refresh does not extend the invocation deadline');
});

test('arrival memory is isolated by repository, base and PR and legacy holders use their acquisition time', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const held = acquire(rootDir);
  const released = releaseMergeLeaseForRetryableAbort({ rootDir, ...held.lease, now: held.lease.acquiredAt });
  assert.equal(released.retry.queueArrivedAt, held.lease.acquiredAt);
  const now = '2026-06-20T18:00:02Z';
  for (const identity of [{ repo: 'other/project' }, { base: 'release' }, { holderPr: 202 }]) {
    const fresh = acquire(rootDir, { ...identity, registerWaiter: true, now });
    assert.equal(fresh.acquired, true);
    assert.equal(fresh.waiter.arrivedAt, now);
  }
});

test('closer parks at the configured consecutive-release cap and forgets arrivals across heads', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const previousCap = process.env.AMG_MAX_GATE_ATTEMPTS;
  process.env.AMG_MAX_GATE_ATTEMPTS = '3';
  t.after(() => {
    if (previousCap === undefined) delete process.env.AMG_MAX_GATE_ATTEMPTS;
    else process.env.AMG_MAX_GATE_ATTEMPTS = previousCap;
  });
  let now = '2026-06-20T18:00:00Z';
  const args = { registerWaiter: true, pidAliveFn: () => true };
  const original = acquire(rootDir, { ...args, waiterId: 'first', now });
  let released = releaseMergeLease({ rootDir, ...original.lease, now, reason: 'published' });
  now = released.retry.nextEligibleAt;
  for (let count = 1; count <= 3; count++) {
    const held = acquire(rootDir, { ...args, holderHead: 'new-head', waiterId: `try-${count}`, now });
    assert.equal(held.acquired, true);
    released = releaseMergeLease({ rootDir, ...held.lease, now, reason: 'synthetic-failure' });
    assert.equal(released.retry.consecutiveNoMergeReleases, count);
    assert.equal(released.retry.queueArrivedAt, count < 3 ? original.waiter.arrivedAt : undefined);
    now = released.retry.nextEligibleAt;
  }
  assert.equal(released.retry.parkedReason, 'repeated-no-merge-release');
  assert.ok(readMergeLeaseAttempts(rootDir, IDENTITY).every(r => !r.queueArrivedAt));
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
  assert.equal(acquire(rootDir, { ...args, holderHead: 'new-head', now }).parked, true);
  const fresh = acquire(rootDir, { ...args, holderHead: 'fresh-head', now });
  assert.equal(fresh.acquired, true);
  assert.equal(fresh.waiter.arrivedAt, now);
});

for (const outcome of [{ merged: true }, { terminal: true }, { reason: 'holder-pr-closed' }]) {
  test(`terminal closer release clears remembered arrival across heads: ${JSON.stringify(outcome)}`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = { registerWaiter: true, pidAliveFn: () => true };
    const held = acquire(rootDir, { ...args, waiterId: 'first' });
    const released = releaseMergeLease({ rootDir, ...held.lease, now: held.lease.acquiredAt });
    const next = acquire(rootDir, { ...args, waiterId: 'next', holderHead: 'new-head', now: released.retry.nextEligibleAt });
    assert.equal(next.acquired, true);
    releaseMergeLease({ rootDir, ...next.lease, now: released.retry.nextEligibleAt, ...outcome });
    assert.ok(readMergeLeaseAttempts(rootDir, IDENTITY).every(r => !r.queueArrivedAt));
    const fresh = acquire(rootDir, { ...args, waiterId: 'fresh', holderHead: 'fresh-head',
      now: '2026-06-20T18:01:00Z' });
    assert.equal(fresh.waiter.arrivedAt, '2026-06-20T18:01:00Z');
  });
}

test('gate-attempt parking also clears remembered closer arrival', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const held = acquire(rootDir, { registerWaiter: true, waiterId: 'first' });
  releaseMergeLease({ rootDir, ...held.lease, now: held.lease.acquiredAt });
  const args = { rootDir, ...IDENTITY, pr: held.lease.holderPr, head: 'new-head',
    now: held.lease.acquiredAt, maxAttempts: 1 };
  recordMergeLeaseGateAttempt(args);
  assert.equal(recordMergeLeaseGateAttempt(args).parked, true);
  assert.ok(readMergeLeaseAttempts(rootDir, IDENTITY).every(r => !r.queueArrivedAt));
});

test('same-head retry state survives waiter withdrawal and a new acquiring process', async t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'failing-head',
    holderPid: process.pid, holderHost: hostname() };
  const held = acquireDaemonMergeLease({ ...request, now: '2026-06-20T18:00:00Z' });
  releaseMergeLease({ rootDir, ...held.lease, now: '2026-06-20T18:00:01Z', reason: 'synthetic-failure' });
  await withDaemonMergeReservation({ rootDir, ...IDENTITY, pr: 102, head: request.holderHead },
    async () => ({ reason: 'pr-is-draft' }));
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
  const blocked = acquire(rootDir, { holderPr: 102, holderHead: request.holderHead,
    registerWaiter: true, waiterId: 'new-process', now: '2026-06-20T18:00:01Z' });
  assert.equal(blocked.reason, 'no-merge-backoff');
});

test('a served CLI reservation is never requeued even when its acquisition PID is reused', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { holderHead: 'cli-head', registerWaiter: true, waiterId: 'old-cli',
    acquisitionPid: 12345, pidAliveFn: () => true, waiterDeadlineSeconds: 21601 };
  const held = acquire(rootDir, args);
  assert.equal(held.acquired, true);
  releaseMergeLease({ rootDir, ...held.lease, now: '2026-06-20T18:00:01Z' });
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
  const resumed = acquire(rootDir, { ...args, waiterId: 'new-cli', acquisitionPid: 12346,
    now: '2026-06-20T18:00:02Z' });
  assert.equal(resumed.acquired, true);
});

for (const kind of ['yield', 'retryable-abort']) {
  test(`six same-head ${kind} releases never park and interrupt consecutive failures`, t => {
    const rootDir = freshRoot();
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const at = seconds => new Date(Date.parse('2026-06-20T18:00:00Z') + seconds * 1000).toISOString();
    const request = { holderHead: 'transient-head' };
    let seconds = 0;
    let held = acquire(rootDir, { ...request, now: at(seconds) });
    releaseMergeLease({ rootDir, ...held.lease, now: at(seconds), reason: 'real-failure' });
    for (let i = 0; i < 6; i++) {
      seconds += 300;
      held = acquire(rootDir, { ...request, now: at(seconds) });
      assert.equal(held.acquired, true);
      recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: held.lease.holderPr,
        head: held.lease.holderHead, now: at(seconds), maxAttempts: 10 });
      const released = kind === 'yield'
        ? releaseMergeLease({ rootDir, ...held.lease, now: at(seconds), yielded: true, reason: 'required-checks-wait' })
        : releaseMergeLeaseForRetryableAbort({ rootDir, ...held.lease, now: at(seconds),
          retryableAbortReason: 'github-gate-read-failed' });
      assert.equal(released.released, true);
      assert.equal(released.retry.parkedReason, null);
      assert.equal(released.retry.consecutiveNoMergeReleases, 0);
    }
    held = acquire(rootDir, { ...request, now: at(seconds + 300) });
    assert.equal(held.acquired, true);
    assert.equal(releaseMergeLease({ rootDir, ...held.lease, now: at(seconds + 300), merged: true }).released, true);
    const [retry] = readMergeLeaseAttempts(rootDir, IDENTITY);
    assert.equal(retry.retryable, kind === 'yield' ? 0 : 6);
    assert.equal(retry.attempts, kind === 'yield' ? 6 : 0);
  });
}

test('retryable release retries after a history failure without refunding twice', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const held = acquire(rootDir, { holderHead: 'retry-refund' });
  for (let i = 0; i < 2; i++) recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY,
    pr: held.lease.holderPr, head: held.lease.holderHead });
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('.history.jsonl')) throw new Error('synthetic history write failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => releaseMergeLeaseForRetryableAbort({ rootDir, ...held.lease }), /synthetic history write failure/);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(releaseMergeLeaseForRetryableAbort({ rootDir, ...held.lease }).released, true);
  assert.deepEqual(readMergeLeaseAttempts(rootDir, IDENTITY).map(r => [r.attempts, r.retryable]), [[1, 1]]);
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

test('reset clears no-merge delay without restoring a former arrival position', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'retry-head',
    holderPid: process.pid, holderHost: hostname(), now: '2026-06-20T18:00:00Z' };
  const held = acquireDaemonMergeLease(args);
  releaseMergeLease({ rootDir, ...held.lease, now: args.now, reason: 'synthetic-step' });
  resetMergeLeaseGateAttempts({ rootDir, ...IDENTITY, pr: 102, head: 'retry-head', now: args.now });
  assert.equal(readMergeLeaseWaiters(rootDir, IDENTITY)[0].notBefore, undefined);
  const resumed = acquireDaemonMergeLease(args);
  assert.equal(resumed.acquired, true);
  releaseMergeLease({ rootDir, ...resumed.lease, now: args.now, terminal: true, reason: 'pr-closed' });
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
  assert.deepEqual(readMergeLeaseAttempts(rootDir, IDENTITY), []);
});

test('alternating chargeable failures cannot evade the same-head parking cap', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'retry-head',
    holderPid: process.pid, holderHost: hostname() };
  let now = '2026-06-20T18:00:00Z';
  for (let count = 1; count <= 5; count++) {
    const held = acquireDaemonMergeLease({ ...args, now });
    assert.equal(held.acquired, true);
    const released = releaseMergeLease({ rootDir, ...held.lease, now, reason: `step-${count % 2}` });
    assert.equal(released.retry.consecutiveNoMergeReleases, count);
    assert.equal(released.retry.parkedReason, count === 5 ? 'repeated-no-merge-release' : null);
    now = released.retry.nextEligibleAt;
  }
  const refused = acquireDaemonMergeLease({ ...args, now });
  assert.equal(refused.parked, true);
});

for (const occupied of [false, true]) test(`ready contention position excludes delayed arrivals (occupied=${occupied})`, t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const now = '2026-06-20T18:00:00Z';
  const held = acquireDaemonMergeLease({ rootDir, ...IDENTITY, holderPr: 102, holderHead: 'delayed',
    holderPid: process.pid, holderHost: hostname(), now });
  releaseMergeLease({ rootDir, ...held.lease, now, yielded: true });
  if (occupied) acquire(rootDir, { holderPr: 200, now, pidAliveFn: () => true });
  const options = { registerWaiter: true, holderPid: process.pid, holderHost: hostname(),
    now, pidAliveFn: () => true };
  if (occupied) acquire(rootDir, { ...options, holderPr: 103, waiterId: 'first-ready' });
  else upsertMergeLeaseWaiter({ rootDir, ...IDENTITY, pr: 103, head: 'first',
    waiterId: 'first-ready', holderPid: process.pid, holderHost: hostname(), arrivedAt: now });
  const result = acquire(rootDir, { ...options, holderPr: 104, waiterId: 'second-ready' });
  assert.equal(result.acquired, false);
  assert.equal(result.queuePosition, 2);
});

test('an explicitly parked head refuses behind a live holder without charging or queuing', t => {
  const rootDir = freshRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { rootDir, ...IDENTITY, holderPr: 102, holderHead: 'parked-head',
    holderPid: process.pid, holderHost: hostname() };
  let now = '2026-06-20T18:00:00Z';
  for (let i = 0; i < 5; i++) {
    const held = acquireDaemonMergeLease({ ...args, now });
    const released = releaseMergeLease({ rootDir, ...held.lease, now, reason: 'permanent-failure' });
    now = released.retry.nextEligibleAt;
  }
  const before = readMergeLeaseAttempts(rootDir, IDENTITY).find(r => r.pr === 102);
  assert.equal(before.attempts, 0);
  const other = acquire(rootDir, { holderPr: 200, now, pidAliveFn: () => true });
  assert.equal(other.acquired, true);
  const gate = recordMergeLeaseGateAttempt({ rootDir, ...IDENTITY, pr: 102, head: args.holderHead, now });
  assert.equal(gate.parked, true);
  assert.deepEqual(gate.attempt, before, 'parked acquisition must not charge or rewrite history');
  const refused = acquireDaemonMergeLease({ ...args, now });
  assert.equal(refused.parked, true);
  assert.equal(refused.reason, 'repeated-no-merge-release');
  assert.deepEqual(readMergeLeaseWaiters(rootDir, IDENTITY), []);
});

test('LVR-02 incident waiters lead FIFO across roles, preserving reservations and holders', t => {
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
  assert.deepEqual(ids(), ['incident-first', 'incident-second', 'daemon-incident', 'ordinary-first', 'ordinary-second', 'daemon-first']);
  // Renewal retains arrival and marker when no new body snapshot is supplied.
  queue('incident-first', 7);
  assert.deepEqual(ids(), ['incident-first', 'incident-second', 'daemon-incident', 'ordinary-first', 'ordinary-second', 'daemon-first']);
  releaseMergeLease({ rootDir, ...held.lease, now: at(8) });
  assert.equal(queue('daemon-incident', 9, { waiterPriority: 'daemon' }).acquired, false);
  assert.equal(queue('incident-first', 10).acquired, true);
});
