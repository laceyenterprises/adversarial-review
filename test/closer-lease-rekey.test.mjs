import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(moved.supersededHeads, [FROM], 'the full superseded-head chain starts with the source');

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

test('rekey retry completes cleanup after destination write succeeded', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 4242, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_x', now: NOW });

  const source = readAmaCloserLease(rootDir, { ...ID, headSha: FROM });
  const carried = {
    ...source,
    headSha: TO,
    rekeyedFromHeadSha: FROM,
    supersededHeads: [FROM],
    updatedAt: '2026-08-12T05:01:00.000Z',
  };
  const toPath = amaCloserLeaseFilePath(rootDir, { ...ID, headSha: TO });
  writeFileSync(toPath, `${JSON.stringify(carried, null, 2)}\n`);

  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, true);
  assert.deepEqual(res.lease, carried);
  assert.equal(existsSync(amaCloserLeaseFilePath(rootDir, { ...ID, headSha: FROM })), false,
    'retry must remove the old source lease instead of refusing forever');
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

test('a destination with matching source head but progressed owner still cleans up source', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_x', now: NOW });

  const source = readAmaCloserLease(rootDir, { ...ID, headSha: FROM });
  const differentOwner = {
    ...source,
    headSha: TO,
    watcherPid: 2,
    rekeyedFromHeadSha: FROM,
    supersededHeads: [FROM],
    updatedAt: '2026-08-12T05:01:00.000Z',
  };
  writeFileSync(
    amaCloserLeaseFilePath(rootDir, { ...ID, headSha: TO }),
    `${JSON.stringify(differentOwner, null, 2)}\n`,
  );

  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, true);
  assert.equal(res.resumed, true);
  assert.deepEqual(res.lease, differentOwner);
  assert.equal(existsSync(amaCloserLeaseFilePath(rootDir, { ...ID, headSha: FROM })), false,
    'matching rekey provenance proves the source lease is obsolete');
});

test('a terminal destination with matching source head still cleans up source', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_x', now: NOW });

  const source = readAmaCloserLease(rootDir, { ...ID, headSha: FROM });
  const terminalDestination = {
    ...source,
    headSha: TO,
    status: 'terminal',
    terminalOutcome: 'succeeded',
    rekeyedFromHeadSha: FROM,
    supersededHeads: [FROM],
    updatedAt: '2026-08-12T05:01:00.000Z',
  };
  writeFileSync(
    amaCloserLeaseFilePath(rootDir, { ...ID, headSha: TO }),
    `${JSON.stringify(terminalDestination, null, 2)}\n`,
  );

  const res = rekeyAmaCloserLease({ rootDir, ...ID, fromHeadSha: FROM, toHeadSha: TO, now: NOW });
  assert.equal(res.rekeyed, false);
  assert.equal(res.reason, 'destination-already-terminal');
  assert.equal(res.resumed, true);
  assert.deepEqual(res.lease, terminalDestination);
  assert.equal(existsSync(amaCloserLeaseFilePath(rootDir, { ...ID, headSha: FROM })), false,
    'terminal progress at the destination must not strand the old source lease');
});

test('findLiveAmaCloserLease ignores leases superseded by a rekey', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_old', now: NOW });

  const source = readAmaCloserLease(rootDir, { ...ID, headSha: FROM });
  const carried = {
    ...source,
    headSha: TO,
    rekeyedFromHeadSha: FROM,
    supersededHeads: [FROM],
    updatedAt: '2026-08-12T05:01:00.000Z',
  };
  writeFileSync(
    amaCloserLeaseFilePath(rootDir, { ...ID, headSha: TO }),
    `${JSON.stringify(carried, null, 2)}\n`,
  );

  const found = findLiveAmaCloserLease(rootDir, ID);
  assert.ok(found, 'must find the non-superseded live lease');
  assert.equal(found.headSha, TO);
  assert.equal(found.lease.lrqId, 'lrq_old');
});

test('findLiveAmaCloserLease ignores stranded ancestors after chained rekeys', () => {
  const rootDir = root();
  const middle = TO;
  const latest = 'c000000000000000000000000000000000000ccc';

  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_old', now: NOW });

  const source = readAmaCloserLease(rootDir, { ...ID, headSha: FROM });
  const carriedLatest = {
    ...source,
    headSha: latest,
    rekeyedFromHeadSha: middle,
    supersededHeads: [FROM, middle],
    updatedAt: '2026-08-12T05:02:00.000Z',
  };
  writeFileSync(
    amaCloserLeaseFilePath(rootDir, { ...ID, headSha: latest }),
    `${JSON.stringify(carriedLatest, null, 2)}\n`,
  );

  const found = findLiveAmaCloserLease(rootDir, ID);
  assert.ok(found, 'must find the true latest live lease');
  assert.equal(found.headSha, latest);
  assert.equal(found.lease.lrqId, 'lrq_old');
});

test('findLiveAmaCloserLease chooses the newest active lease deterministically', () => {
  const rootDir = root();
  const older = FROM;
  const newer = TO;

  acquireAmaCloserLease({
    rootDir, ...ID, headSha: older, watcherPid: 1, now: '2026-08-12T05:00:00.000Z',
  });
  acquireAmaCloserLease({
    rootDir, ...ID, headSha: newer, watcherPid: 2, now: '2026-08-12T05:01:00.000Z',
  });

  const found = findLiveAmaCloserLease(rootDir, ID);
  assert.ok(found, 'must find a live lease');
  assert.equal(found.headSha, newer);
  assert.equal(found.lease.watcherPid, 2);
});

test('findLiveAmaCloserLease returns null when only a superseding terminal lease remains', () => {
  const rootDir = root();
  acquireAmaCloserLease({ rootDir, ...ID, headSha: FROM, watcherPid: 1, now: NOW });
  updateAmaCloserLease({ rootDir, ...ID, headSha: FROM, status: 'dispatched', lrqId: 'lrq_old', now: NOW });

  const source = readAmaCloserLease(rootDir, { ...ID, headSha: FROM });
  const terminalDestination = {
    ...source,
    headSha: TO,
    status: 'terminal',
    terminalOutcome: 'succeeded',
    rekeyedFromHeadSha: FROM,
    supersededHeads: [FROM],
    updatedAt: '2026-08-12T05:01:00.000Z',
  };
  writeFileSync(
    amaCloserLeaseFilePath(rootDir, { ...ID, headSha: TO }),
    `${JSON.stringify(terminalDestination, null, 2)}\n`,
  );

  assert.equal(findLiveAmaCloserLease(rootDir, ID), null,
    'the old source is superseded and the destination is already terminal');
});

test('findLiveAmaCloserLease rejects missing PR identity', () => {
  const rootDir = root();
  assert.throws(() => findLiveAmaCloserLease(rootDir), /identity\.repo is required/);
  assert.throws(() => findLiveAmaCloserLease(rootDir, { repo: ID.repo }), /identity\.prNumber must be numeric/);
});
