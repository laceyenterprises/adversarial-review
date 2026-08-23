import test from 'node:test';
import assert from 'node:assert/strict';

import { isActiveAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';

const HOUR = 3600_000;
const NOW = '2026-08-23T06:00:00.000Z';
const nowMs = Date.parse(NOW);
const ago = (h) => new Date(nowMs - h * HOUR).toISOString();

test('a stale dispatched record stops blocking its repoPrKey', () => {
  // Regression for 2026-08-23. A `dispatched` record whose worker died without
  // writing a terminal ledger status keeps a non-terminal lastObservedStatus
  // forever. With no age escape it stayed "active" indefinitely and wedged the
  // consume loop: the follow-up daemon logged deferredSamePR=2 with
  // activeAtStart=0 and capacityRemaining=8 while the merge backlog froze.
  //
  // Live values: agent-os#5703 (starting, 7.0h), agent-os#5715 (running, 5.7h),
  // adversarial-review#893 (unknown, 4.6h) -- and #3114/#3116 wedged the same
  // way for 1180 hours.
  for (const status of ['starting', 'running', 'unknown', 'blocked', 'stalled']) {
    const record = { state: 'dispatched', lastObservedStatus: status, lastObservedAt: ago(24) };
    assert.equal(
      isActiveAmaCloserDispatchRecord(record, { now: NOW }),
      false,
      `a 24h-old dispatched record with status='${status}' must not stay active`
    );
  }
});

test('a live dispatched record is never raced', () => {
  // The escape must only fire on staleness. A closer that is genuinely running
  // refreshes lastObservedAt, and must keep holding its key.
  //
  // `dispatchedAt`/`lastAttemptedAt` are stamped ONCE at launch and never
  // refreshed, so a long-running closer always carries stale launch stamps
  // alongside a fresh `lastObservedAt`. Staleness is therefore evaluated
  // against the most recent timestamp on the record, not the first truthy one:
  // an `a || b || c` chain would read the launch stamp, shadow the live
  // evidence, and reclaim a worker that is still running.
  for (const status of ['starting', 'running']) {
    for (const [label, record] of [
      ['lastObservedAt only', { lastObservedAt: NOW }],
      ['stale dispatchedAt + fresh lastObservedAt', { dispatchedAt: ago(24), lastObservedAt: NOW }],
      ['stale lastAttemptedAt + fresh lastObservedAt', { lastAttemptedAt: ago(24), lastObservedAt: NOW }],
      ['stale createdAt + launch stamps + fresh lastObservedAt', {
        createdAt: ago(72),
        dispatchedAt: ago(24),
        lastAttemptedAt: ago(24),
        lastObservedAt: NOW,
      }],
    ]) {
      assert.equal(
        isActiveAmaCloserDispatchRecord(
          { state: 'dispatched', lastObservedStatus: status, ...record },
          { now: NOW }
        ),
        true,
        `a freshly-observed dispatched record (${label}) with status='${status}' must stay active`
      );
    }
  }
});

test('a live dispatching record is never raced by a stale launch stamp', () => {
  // Same shadowing hazard on the `dispatching` branch, which shares the
  // most-recent-timestamp helper.
  assert.equal(
    isActiveAmaCloserDispatchRecord(
      { state: 'dispatching', lastAttemptedAt: ago(24), lastObservedAt: NOW },
      { now: NOW }
    ),
    true,
    'a dispatching record refreshed just now must stay active despite an old launch stamp'
  );
  assert.equal(
    isActiveAmaCloserDispatchRecord(
      { state: 'dispatching', lastAttemptedAt: ago(24), lastObservedAt: ago(24) },
      { now: NOW }
    ),
    false,
    'a dispatching record with no fresh timestamp anywhere must still age out'
  );
});

test('a dispatched record with no parseable timestamp stays held', () => {
  // Deliberate asymmetry with `dispatching`: ama-hammer-retry-cap asserts a
  // launch-only record (status 'unknown', no timestamps) must keep its key.
  assert.equal(
    isActiveAmaCloserDispatchRecord(
      { state: 'dispatched', lastObservedStatus: 'unknown' },
      { now: NOW }
    ),
    true
  );
  assert.equal(
    isActiveAmaCloserDispatchRecord(
      { state: 'dispatched', lastObservedStatus: 'running', lastObservedAt: 'not-a-date' },
      { now: NOW }
    ),
    true
  );
});

test('a terminal dispatched record is inactive regardless of age', () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    assert.equal(
      isActiveAmaCloserDispatchRecord(
        { state: 'dispatched', lastObservedStatus: status, lastObservedAt: NOW },
        { now: NOW }
      ),
      false
    );
  }
});
