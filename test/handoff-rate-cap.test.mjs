import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandoffRateLimiter } from '../src/handoff-rate-cap.mjs';

const SUBJECT = {
  repo: 'laceyenterprises/adversarial-review',
  pr_number: 57,
  head_sha: 'head-a',
};

test('handoff rate limiter treats malformed wake payloads as unkeyed', () => {
  const limiter = createHandoffRateLimiter({
    maxPerPrHead: 1,
    logger: { warn() {} },
  });

  assert.deepEqual(limiter.inspect(null), { accepted: true, reason: 'unkeyed-wake' });
  assert.deepEqual(limiter.inspect('not-json-object'), { accepted: true, reason: 'unkeyed-wake' });
  assert.equal(limiter.snapshot().size, 0);
});

test('handoff rate limiter prunes stale PR-head counters', () => {
  let nowMs = Date.parse('2026-07-09T12:00:00.000Z');
  const limiter = createHandoffRateLimiter({
    maxPerPrHead: 1,
    retentionMs: 100,
    logger: { warn() {} },
    now: () => new Date(nowMs).toISOString(),
  });

  assert.equal(limiter.inspect(SUBJECT).accepted, true);
  assert.equal(limiter.inspect(SUBJECT).accepted, false);
  assert.equal(limiter.snapshot().size, 1);

  nowMs += 101;

  const reset = limiter.inspect(SUBJECT);
  assert.equal(reset.accepted, true);
  assert.equal(reset.count, 1);
  assert.deepEqual([...limiter.snapshot().values()], [1]);
});

test('handoff rate limiter drops stale keys during later inspections', () => {
  let nowMs = Date.parse('2026-07-09T12:00:00.000Z');
  const limiter = createHandoffRateLimiter({
    maxPerPrHead: 10,
    retentionMs: 100,
    logger: { warn() {} },
    now: () => new Date(nowMs).toISOString(),
  });

  for (let index = 0; index < 5; index += 1) {
    limiter.inspect({ ...SUBJECT, head_sha: `head-${index}` });
  }
  assert.equal(limiter.snapshot().size, 5);

  nowMs += 101;
  limiter.inspect({ ...SUBJECT, head_sha: 'fresh-head' });

  const snapshot = limiter.snapshot();
  assert.equal(snapshot.size, 1);
  assert.deepEqual([...snapshot.values()], [1]);
});
