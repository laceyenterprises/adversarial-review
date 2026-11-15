import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { underMaxLoad } from './helpers/load-time-kit.mjs';
import {
  resolveReviewerCeilingConfig,
  resolveReviewerCeilingSeconds,
} from '../src/reviewer-timeout-model.mjs';
import { resolveReviewerTimeoutMs } from '../src/reviewer-timeout.mjs';
import {
  computeReviewerLeaseExpiryAt,
  isReviewerLeaseExpired,
} from '../src/reviewer-lease.mjs';

// Diagnostic reproductions of the documented policy, not acceptance tests for
// a repaired cap. A future policy repair should deliberately update these.
test('REVIEWERLEASECAP-01: default streamed ceiling produces a 14-hour claim', t => {
  underMaxLoad(t);
  // Full CPU corroboration: multiplier = 1 + (load/core - 1) * 2.5.
  const multiplier = 14 / 3;
  t.mock.method(os, 'loadavg', () => [
    (os.cpus().length || 1) * (1 + (multiplier - 1) / 2.5), 0, 0,
  ]);
  const { max } = resolveReviewerCeilingConfig();
  assert.equal(max, 10_800);
  // Same saturated-size input used by pollonce-phases when it claims a PR.
  const timeoutMs = resolveReviewerCeilingSeconds({
    changedLines: Number.MAX_SAFE_INTEGER,
  }) * 1000;
  assert.equal(timeoutMs, 14 * 60 * 60 * 1000);
  assert.ok(resolveReviewerTimeoutMs() <= 2 * 60 * 60 * 1000,
    'the legacy 20-minute resolver does not explain the streamed lease');
  const startedAt = '2026-01-01T00:00:00.000Z';
  const row = {
    reviewer_started_at: startedAt,
    reviewer_timeout_ms: timeoutMs,
    reviewer_lease_expires_at: computeReviewerLeaseExpiryAt(startedAt, timeoutMs),
  };
  assert.equal(row.reviewer_lease_expires_at, '2026-01-01T14:00:00.000Z');
  assert.equal(isReviewerLeaseExpired(row, new Date('2026-01-01T01:00:00Z')), false);
  assert.equal(isReviewerLeaseExpired(row, new Date('2026-01-01T14:00:00Z')), true);
});

test('REVIEWERLEASECAP-01: default streamed maximum scales to 18 hours', t => {
  underMaxLoad(t);
  assert.equal(resolveReviewerCeilingSeconds({
    changedLines: Number.MAX_SAFE_INTEGER,
  }), 18 * 60 * 60);
});
