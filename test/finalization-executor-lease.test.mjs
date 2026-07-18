// ARC-17 — the app-store executor lease (docs/SPEC-merge-authority-v2.md §4).
// Leases live in the app store (NOT GitHub labels): one writer per subject,
// fenced release/renew, expiry steal that cannot double-grant.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { openFinalizationExecutorLeaseStore } from '../src/finalization/executor-lease-store.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#17' };
const t = (n) => new Date(Date.parse('2026-07-19T00:00:00.000Z') + n * 60000).toISOString();

function memStore() {
  return openFinalizationExecutorLeaseStore({ db: new Database(':memory:') });
}

test('lease contention: exactly one holder acquires a free subject', () => {
  const store = memStore();
  const a = store.acquire({ subject: REF, holder: 'exec-A', leaseId: 'lease-A', now: t(0), deadline: t(5) });
  const b = store.acquire({ subject: REF, holder: 'exec-B', leaseId: 'lease-B', now: t(1), deadline: t(6) });

  assert.equal(a.acquired, true, 'first contender acquires');
  assert.equal(a.reason, 'inserted');
  assert.equal(b.acquired, false, 'second contender is refused');
  assert.equal(b.reason, 'held');
  assert.equal(b.existing.holder, 'exec-A', 'the live holder is surfaced');

  // The stored holder is unchanged by the losing contender.
  assert.equal(store.read(REF).leaseId, 'lease-A');
  store.close();
});

test('release is fenced on leaseId: a stale release never deletes a newer holder', () => {
  const store = memStore();
  store.acquire({ subject: REF, holder: 'exec-A', leaseId: 'lease-A', now: t(0), deadline: t(5) });

  // A stale holder (wrong fence token) cannot release.
  assert.equal(store.release({ subject: REF, leaseId: 'stale' }), false);
  assert.equal(store.read(REF).leaseId, 'lease-A', 'holder survives a stale release');

  // The real holder releases; the subject is free again.
  assert.equal(store.release({ subject: REF, leaseId: 'lease-A' }), true);
  assert.equal(store.read(REF), null, 'subject is free after fenced release');
  store.close();
});

test('expired lease is stolen exactly once, fenced on the observed holder', () => {
  const store = memStore();
  store.acquire({ subject: REF, holder: 'exec-A', leaseId: 'lease-A', now: t(0), deadline: t(5) });

  // Before expiry a contender is still refused.
  const early = store.acquire({ subject: REF, holder: 'exec-B', leaseId: 'lease-B', now: t(2), deadline: t(7) });
  assert.equal(early.acquired, false, 'unexpired lease is not stealable');

  // After the deadline, a contender steals it.
  const steal = store.acquire({ subject: REF, holder: 'exec-B', leaseId: 'lease-B', now: t(6), deadline: t(11) });
  assert.equal(steal.acquired, true);
  assert.equal(steal.reason, 'stolen');
  assert.equal(store.read(REF).holder, 'exec-B');

  // The evicted original holder can no longer release the (now newer) lease.
  assert.equal(store.release({ subject: REF, leaseId: 'lease-A' }), false, 'evicted holder cannot clobber the new lease');
  assert.equal(store.read(REF).leaseId, 'lease-B');
  store.close();
});

test('renew extends the deadline under the fence; a stale renew is a no-op', () => {
  const store = memStore();
  store.acquire({ subject: REF, holder: 'exec-A', leaseId: 'lease-A', now: t(0), deadline: t(5) });

  assert.equal(store.renew({ subject: REF, leaseId: 'stale', deadline: t(99), now: t(1) }), false);
  assert.equal(store.read(REF).deadline, t(5), 'stale renew does not extend');

  assert.equal(store.renew({ subject: REF, leaseId: 'lease-A', deadline: t(20), now: t(4) }), true);
  assert.equal(store.read(REF).deadline, t(20), 'legitimate renew extends the deadline');

  // A renewed (still-live) lease is not stealable at the original deadline.
  const steal = store.acquire({ subject: REF, holder: 'exec-B', leaseId: 'lease-B', now: t(6), deadline: t(30) });
  assert.equal(steal.acquired, false, 'renew defeats the expiry steal');
  store.close();
});

test('renew preserves revisionRef when the caller omits it', () => {
  const store = memStore();
  store.acquire({
    subject: REF,
    holder: 'exec-A',
    leaseId: 'lease-A',
    revisionRef: 'sha-A',
    now: t(0),
    deadline: t(5),
  });

  assert.equal(store.renew({ subject: REF, leaseId: 'lease-A', deadline: t(10), now: t(1) }), true);
  assert.equal(store.read(REF).revisionRef, 'sha-A', 'omitted revisionRef does not erase diagnostics');

  assert.equal(
    store.renew({ subject: REF, leaseId: 'lease-A', revisionRef: 'sha-B', deadline: t(20), now: t(2) }),
    true,
  );
  assert.equal(store.read(REF).revisionRef, 'sha-B', 'explicit revisionRef still updates the lease');
  store.close();
});

test('expiry steal handles mixed timestamp precision at the exact boundary', () => {
  const store = memStore();
  store.acquire({
    subject: REF,
    holder: 'exec-A',
    leaseId: 'lease-A',
    now: '2026-07-19T00:00:00.000Z',
    deadline: '2026-07-19T00:05:00Z',
  });

  const steal = store.acquire({
    subject: REF,
    holder: 'exec-B',
    leaseId: 'lease-B',
    now: '2026-07-19T00:05:00.000Z',
    deadline: '2026-07-19T00:10:00.000Z',
  });

  assert.equal(steal.acquired, true, 'same instant with different precision is stealable at the boundary');
  assert.equal(steal.reason, 'stolen');
  assert.equal(store.read(REF).leaseId, 'lease-B');
  store.close();
});
