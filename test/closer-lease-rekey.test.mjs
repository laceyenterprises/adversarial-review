import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireAmaCloserLease,
  amaCloserLeaseFilePath,
  readAmaCloserLease,
  findLiveAmaCloserLease,
  rekeyAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';

// The lease is keyed by (repo, prNumber, headSha), so a rebase performed BY the closer
// orphans its own lease. Seen on adversarial-review#825, 2026-08-11: the hammer rebased
// the head, the lease sat at status=dispatched on a discarded commit, and the watcher
// looped review-queued -> skip-re-review (terminal closer commit) -> release claim
// forever. CI green, review clean, nothing could merge it, and no operator CLI exists.

const ID = { repo: 'laceyenterprises/adversarial-review', prNumber: 825 };
const FROM = '5fdfb3bf1ef4bf18b0eca30be078b8f6bf72fbf7';
const TO = 'ab9aafb04398000000000000000000000000aaaa';
const NOW = '2026-08-12T05:00:00.000Z';

function root() {
  return mkdtempSync(join(tmpdir(), 'closer-lease-rekey-'));
}

test('a live lease is carried forward to the new head', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 4242, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_x', now: NOW });

  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, true);

  const moved = readAmaCloserLease(rootDir, { ...ID, headSha: TO });
  assert.ok(moved, 'lease must exist at the new head');
  assert.equal(moved.headSha, TO);
  assert.equal(moved.status, 'dispatched', 'status is carried, not reset');
  assert.equal(moved.lrqId, 'lrq_x', 'the dispatched worker reference survives');
  assert.equal(moved.watcherPid, 4242, 'ownership audit survives');
  assert.equal(moved.rekeyedFromHeadSha, FROM, 'the move is auditable');

  assert.equal(existsSync(amaCloserLeaseFilePath(rootDir, { ...ID, headSha: FROM })), false,
    'the orphaned lease must not linger at the old head');
});

test('refuses to resurrect a terminal lease onto a new head', () => {
  // A finished close must not be replayed against different code.
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({
    rootDir, ...ID, headSha: FROM, status: 'terminal', terminalOutcome: 'succeeded', now: NOW,
  });
  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, false);
  assert.equal(res.reason, 'refusing-to-rekey-terminal-lease');
  assert.ok(existsSync(amaCloserLeaseFilePath(rootDir, { ...ID, headSha: FROM })), 'terminal lease stays put');
});

test('refuses to clobber a live owner at the destination head', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  acquireAmaCloserLease({ rootDir, ...ID, headSha: TO, watcherPid: 2, now: NOW });
  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, false);
  assert.equal(res.reason, 'lease-already-exists-at-to-head');
  const kept = readAmaCloserLease(rootDir, { ...ID, headSha: TO });
  assert.equal(kept.watcherPid, 2, 'the existing owner is untouched');
});

test('no lease at the source head is a no-op, not an error', () => {
  const rootDir = root();
  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, false);
  assert.equal(res.reason, 'no-lease-at-from-head');
});

test('a same-head rekey is a no-op', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: FROM, now: NOW });
  assert.equal(res.rekeyed, false);
  assert.equal(res.reason, 'same-head');
  assert.ok(readAmaCloserLease(rootDir, { ...ID, headSha: FROM }), 'lease untouched');
});

test('missing head arguments are rejected outright', () => {
  const rootDir = root();
  assert.throws(() => rekeyAmaCloserLease({ rootDir, ...ID, toHeadSha: TO }), /fromHeadSha and toHeadSha are required/);
  assert.throws(() => rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM }), /fromHeadSha and toHeadSha are required/);
});

test('findLiveAmaCloserLease locates the lease regardless of which head it sits on', () => {
  // The caller usually knows the CURRENT head, not the head the closer was dispatched
  // for. On #825 those differed (dispatch 5fdfb3bf, reviewer ebd6c55, branch ab9aafb),
  // which is exactly why a head-specific lookup could not find the strand.
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 7, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_y', now: NOW });

  const found = findLiveAmaCloserLease(rootDir, ID);
  assert.ok(found, 'must find the live lease without knowing its head');
  assert.equal(found.headSha, FROM);
  assert.equal(found.lease.lrqId, 'lrq_y');
});

test('findLiveAmaCloserLease ignores terminal leases and other PRs', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({
    rootDir, ...ID, headSha: FROM, status: 'terminal', terminalOutcome: 'succeeded', now: NOW,
  });
  assert.equal(findLiveAmaCloserLease(rootDir, ID), null, 'a finished close is not a live lease');

  acquireAmaCloserLease({ rootDir, repo: ID.repo, prNumber: 999, headSha: TO, watcherPid: 2, now: NOW });
  assert.equal(findLiveAmaCloserLease(rootDir, ID), null, 'another PR\'s lease must not match');
});

test('findLiveAmaCloserLease returns null when the lease dir does not exist', () => {
  assert.equal(findLiveAmaCloserLease(root(), ID), null);
});

test('an interrupted rekey resumes instead of refusing forever', () => {
  // The rekey is write-destination-then-remove-source, so a crash between the steps
  // leaves BOTH files on disk. A guard that only refuses would refuse on every retry,
  // turning one transient interruption into a permanently orphaned lease -- the exact
  // strand this function exists to fix.
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 5, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_z', now: NOW });

  // Simulate the crash: step 1 completed, step 2 did not.
  const first = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(first.rekeyed, true);
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 5, now: NOW }); // source back on disk

  const resumed = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(resumed.rekeyed, true, 'must complete rather than refuse');
  assert.equal(resumed.resumed, true, 'and report that it resumed');
  assert.equal(existsSync(amaCloserLeaseFilePath(rootDir, { ...ID, headSha: FROM })), false,
    'the leftover source must be cleaned up');
  assert.equal(readAmaCloserLease(rootDir, { ...ID, headSha: TO }).lrqId, 'lrq_z',
    'the carried lease is preserved, not overwritten by the retry');
});

test('a DIFFERENT owner at the destination is still refused', () => {
  // The resume path must not become a way to clobber someone else's lease: it keys on
  // rekeyedFromHeadSha matching OUR source head.
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  acquireAmaCloserLease({ rootDir, ...ID, headSha: TO, watcherPid: 2, now: NOW });
  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, false);
  assert.equal(res.reason, 'lease-already-exists-at-to-head');
  assert.equal(readAmaCloserLease(rootDir, { ...ID, headSha: TO }).watcherPid, 2, 'untouched');
});
