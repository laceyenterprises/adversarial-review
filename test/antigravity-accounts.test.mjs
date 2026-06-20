import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AntigravityAccountRegistry,
  createAntigravityAccountRegistry,
} from '../src/auth/antigravity-accounts.mjs';

function mockClock(startMs = Date.parse('2026-06-20T18:00:00.000Z')) {
  let currentMs = startMs;
  return {
    nowMs: () => currentMs,
    set: (nextMs) => {
      currentMs = nextMs;
    },
    advance: (deltaMs) => {
      currentMs += deltaMs;
    },
  };
}

test('Antigravity accounts select round-robin across N accounts', () => {
  const registry = createAntigravityAccountRegistry(['acct-0', 'acct-1', 'acct-2'], {
    clock: mockClock(),
  });

  assert.equal(registry.selectAccount().id, 'acct-0');
  assert.equal(registry.selectAccount().id, 'acct-1');
  assert.equal(registry.selectAccount().id, 'acct-2');
  assert.equal(registry.selectAccount().id, 'acct-0');
  assert.equal(registry.selectAccount().id, 'acct-1');
});

test('Antigravity account cooldown is skipped and becomes eligible after expiry', () => {
  const clock = mockClock();
  const registry = new AntigravityAccountRegistry(['acct-0', 'acct-1'], { clock });

  assert.equal(registry.selectAccount().id, 'acct-0');
  registry.markRateLimited('acct-1', '2026-06-20T18:05:00.000Z');

  assert.equal(registry.selectAccount().id, 'acct-0');
  assert.equal(registry.selectAccount().id, 'acct-0');

  clock.set(Date.parse('2026-06-20T18:05:00.000Z'));
  assert.equal(registry.selectAccount().id, 'acct-1');
  assert.equal(registry.selectAccount().id, 'acct-0');
});

test('Antigravity accounts rotate on cap so capped account is skipped next selection', () => {
  const registry = createAntigravityAccountRegistry(['acct-0', 'acct-1', 'acct-2'], {
    clock: mockClock(),
  });

  const selected = registry.selectAccount();
  assert.equal(selected.id, 'acct-0');
  registry.markRateLimited(selected.id, '2026-06-20T18:10:00.000Z');

  assert.equal(registry.selectAccount().id, 'acct-1');
  assert.equal(registry.selectAccount().id, 'acct-2');
  assert.equal(registry.selectAccount().id, 'acct-1');
});

test('Antigravity allCapped returns the earliest retryAfter', () => {
  const registry = createAntigravityAccountRegistry(['acct-0', 'acct-1', 'acct-2'], {
    clock: mockClock(),
  });

  registry.markRateLimited('acct-0', '2026-06-20T18:30:00.000Z');
  registry.markRateLimited('acct-1', '2026-06-20T18:10:00.000Z');
  assert.deepEqual(registry.allCapped(), {
    allCapped: false,
    retryAfter: null,
    retryAfterMs: null,
  });

  registry.markRateLimited('acct-2', '2026-06-20T18:20:00.000Z');
  assert.deepEqual(registry.allCapped(), {
    allCapped: true,
    retryAfter: '2026-06-20T18:10:00.000Z',
    retryAfterMs: Date.parse('2026-06-20T18:10:00.000Z'),
  });
  assert.equal(registry.selectAccount(), null);
});

test('Antigravity single-account registry selects it and allCapped reflects cooldown', () => {
  const clock = mockClock();
  const registry = createAntigravityAccountRegistry([{ id: 'acct-0', tokenFile: '/tmp/acct-0.json' }], {
    clock,
  });

  const selected = registry.selectAccount();
  assert.deepEqual(selected, {
    id: 'acct-0',
    accountId: 'acct-0',
    tokenFile: '/tmp/acct-0.json',
  });
  assert.deepEqual(registry.allCapped(), {
    allCapped: false,
    retryAfter: null,
    retryAfterMs: null,
  });

  registry.markRateLimited('acct-0', '2026-06-20T18:01:00.000Z');
  assert.deepEqual(registry.allCapped(), {
    allCapped: true,
    retryAfter: '2026-06-20T18:01:00.000Z',
    retryAfterMs: Date.parse('2026-06-20T18:01:00.000Z'),
  });
  assert.equal(registry.selectAccount(), null);

  clock.advance(60_000);
  assert.equal(registry.allCapped().allCapped, false);
  assert.equal(registry.selectAccount().id, 'acct-0');
});
