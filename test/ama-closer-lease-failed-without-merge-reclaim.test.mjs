import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS,
  AMA_CLOSER_RECLAIMABLE_TERMINAL_OUTCOME,
  isReclaimableDispatchedAmaCloserLease,
} from '../src/ama/dispatch-closer.mjs';

// 2026-09-05: the hammer self-deadlocked on its own lease.
//
// It acquired the closer lease at the pre-remediation head, pushed its terminal
// remediation commit, the lease was rekeyed onto that new head and terminalized
// `failed-without-merge` -- and the merge attempt then parked:
//
//   AMG-04 parked: merge lease acquisition parked PR 6288
//   No further action was taken after the lease parked, per the HAM instructions.
//
// The hammer exited 0 having verified its own trailers at the live head and run
// the tests. It simply could not merge past a lock it was still holding, because
// ANY terminalOutcome made a dispatched lease unreclaimable forever.
//
// SPEC 4.4 rule #5 makes only `succeeded` sticky. `failed-without-merge` records
// that one attempt did not merge, not that closure authority is spent.

const base = { status: 'dispatched', updatedAt: '2026-09-05T20:00:00Z' };
const AGED = '2026-09-05T21:00:00Z';   // > 30m past updatedAt
const FRESH = '2026-09-05T20:05:00Z';  // < 30m past updatedAt

const reclaim = (terminalOutcome, now, extra = {}) =>
  isReclaimableDispatchedAmaCloserLease({ ...base, ...extra, terminalOutcome }, { now });

test('a failed-without-merge lease is reclaimable once aged', () => {
  assert.equal(reclaim(AMA_CLOSER_RECLAIMABLE_TERMINAL_OUTCOME, AGED), true);
  assert.equal(reclaim('failed-without-merge', AGED), true);
});

test('deferred and superseded leases are reclaimable once aged', () => {
  assert.equal(reclaim('deferred', AGED), true);
  assert.equal(reclaim('superseded', AGED), true);
});

test('succeeded stays sticky and is never reclaimed', () => {
  // SPEC 4.4 rule #5 -- the terminal-succeeded surface is the contract.
  assert.equal(reclaim('succeeded', AGED), false);
});

test('the age bound still applies to retryable terminal outcomes', () => {
  // Reclaim must not race a close that is still in flight.
  assert.equal(reclaim('failed-without-merge', FRESH), false);
  assert.equal(reclaim('deferred', FRESH), false);
  assert.equal(reclaim('superseded', FRESH), false);
});

test('a lease with no terminal outcome is unchanged', () => {
  assert.equal(reclaim(null, AGED), true);
  assert.equal(reclaim(undefined, AGED), true);
  assert.equal(reclaim(null, FRESH), false);
});

test('non-dispatched leases are still out of scope', () => {
  assert.equal(
    isReclaimableDispatchedAmaCloserLease(
      { status: 'pending', terminalOutcome: 'failed-without-merge', updatedAt: base.updatedAt },
      { now: AGED },
    ),
    false,
  );
});

test('the reclaim age bound is the shared dispatched-lease constant', () => {
  assert.equal(AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, 30 * 60 * 1000);
});
