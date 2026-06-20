import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireMergeLease,
  deriveLeaseKey,
  inspectMergeLease,
  mergeLeaseFilePath,
  mergeLeaseWaitersFilePath,
  readMergeLeaseWaiters,
  reclaimIfStale,
  releaseMergeLease,
  removeMergeLeaseWaiter,
  renewMergeLease,
  upsertMergeLeaseWaiter,
} from '../src/ama/merge-lease.mjs';

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
    upsertMergeLeaseWaiter({
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
      now: '2026-06-20T18:01:00Z',
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
    acquire(rootDir, {
      holderPid: 99996,
      holderHost: 'other-host',
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
    assert.equal(result.reclaimed, true);
    assert.equal(result.reason, 'past-deadline');
    assert.equal(inspectMergeLease({ rootDir, ...IDENTITY }).exists, false);
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
    assert.equal(status.deadlineSeconds, 120);
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
