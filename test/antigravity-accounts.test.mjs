import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AntigravityAccountRegistryError,
  createAntigravityAccountRegistry,
} from '../src/auth/antigravity-accounts.mjs';

function mockClock(startIso) {
  let nowMs = Date.parse(startIso);
  return {
    now: () => nowMs,
    set: (iso) => {
      nowMs = Date.parse(iso);
    },
  };
}

test('selectAccount round-robins across ordered Antigravity accounts', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-a', 'acct-b', 'acct-c'],
    clock: clock.now,
  });

  assert.equal(registry.selectAccount(), 'acct-a');
  assert.equal(registry.selectAccount(), 'acct-b');
  assert.equal(registry.selectAccount(), 'acct-c');
  assert.equal(registry.selectAccount(), 'acct-a');
});

test('selectAccount skips cooled-down accounts, then reuses them after expiry', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-a', 'acct-b', 'acct-c'],
    clock: clock.now,
  });

  assert.equal(registry.selectAccount(), 'acct-a');
  registry.markRateLimited('acct-b', '2026-06-20T10:15:00.000Z');

  assert.equal(registry.selectAccount(), 'acct-c');
  assert.equal(registry.selectAccount(), 'acct-a');

  clock.set('2026-06-20T10:15:00.000Z');
  assert.equal(registry.selectAccount(), 'acct-b');
});

test('markRateLimited rotates a capped selected account out of the next selection', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-a', 'acct-b'],
    clock: clock.now,
  });

  const capped = registry.selectAccount();
  assert.equal(capped, 'acct-a');

  registry.markRateLimited(capped, '2026-06-20T10:30:00.000Z');

  assert.equal(registry.selectAccount(), 'acct-b');
  assert.equal(registry.selectAccount(), 'acct-b');
});

test('allCapped returns the earliest retryAfter when every account is cooled down', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-a', 'acct-b', 'acct-c'],
    clock: clock.now,
  });

  registry.markRateLimited('acct-a', '2026-06-20T10:45:00.000Z');
  registry.markRateLimited('acct-b', '2026-06-20T10:15:00.000Z');
  assert.deepEqual(registry.allCapped(), { allCapped: false, retryAfter: null });

  registry.markRateLimited('acct-c', '2026-06-20T10:30:00.000Z');
  assert.deepEqual(registry.allCapped(), {
    allCapped: true,
    retryAfter: '2026-06-20T10:15:00.000Z',
  });
  assert.equal(registry.selectAccount(), null);
});

test('single-account registry selects the account and reflects its cooldown state', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-solo'],
    clock: clock.now,
  });

  assert.equal(registry.selectAccount(), 'acct-solo');
  assert.deepEqual(registry.allCapped(), { allCapped: false, retryAfter: null });

  registry.markRateLimited('acct-solo', '2026-06-20T10:05:00.000Z');
  assert.equal(registry.selectAccount(), null);
  assert.deepEqual(registry.allCapped(), {
    allCapped: true,
    retryAfter: '2026-06-20T10:05:00.000Z',
  });

  clock.set('2026-06-20T10:05:00.000Z');
  assert.equal(registry.selectAccount(), 'acct-solo');
  assert.deepEqual(registry.allCapped(), { allCapped: false, retryAfter: null });
});

test('markRateLimited keeps the later cooldown when retried with an earlier retryAfter', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-a'],
    clock: clock.now,
  });

  assert.deepEqual(registry.markRateLimited('acct-a', '2026-06-20T11:00:00.000Z'), {
    accountId: 'acct-a',
    retryAfter: '2026-06-20T11:00:00.000Z',
  });
  assert.deepEqual(registry.markRateLimited('acct-a', '2026-06-20T10:10:00.000Z'), {
    accountId: 'acct-a',
    retryAfter: '2026-06-20T11:00:00.000Z',
  });

  clock.set('2026-06-20T10:10:00.000Z');
  assert.equal(registry.selectAccount(), null);

  clock.set('2026-06-20T11:00:00.000Z');
  assert.equal(registry.selectAccount(), 'acct-a');
});

test('markRateLimited treats numeric retryAfter values as delta seconds', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  const registry = createAntigravityAccountRegistry({
    accountIds: ['acct-a', 'acct-b'],
    clock: clock.now,
  });

  assert.deepEqual(registry.markRateLimited('acct-a', 120), {
    accountId: 'acct-a',
    retryAfter: '2026-06-20T10:02:00.000Z',
  });
  assert.equal(registry.selectAccount(), 'acct-b');

  assert.deepEqual(registry.markRateLimited('acct-b', '30'), {
    accountId: 'acct-b',
    retryAfter: '2026-06-20T10:00:30.000Z',
  });
  assert.deepEqual(registry.allCapped(), {
    allCapped: true,
    retryAfter: '2026-06-20T10:00:30.000Z',
  });
});

test('accounts prunes cooldowns for removed dynamic accounts', () => {
  const clock = mockClock('2026-06-20T10:00:00.000Z');
  let accountIds = ['acct-a', 'acct-b'];
  const registry = createAntigravityAccountRegistry({
    listAccounts: () => accountIds,
    clock: clock.now,
  });

  registry.markRateLimited('acct-a', '2026-06-20T11:00:00.000Z');
  registry.markRateLimited('acct-b', '2026-06-20T11:00:00.000Z');
  assert.equal(registry.cooldowns.size, 2);

  accountIds = ['acct-b'];
  assert.deepEqual(registry.status(), [{
    accountId: 'acct-b',
    eligible: false,
    retryAfter: '2026-06-20T11:00:00.000Z',
  }]);
  assert.equal(registry.cooldowns.size, 1);
  assert.equal(registry.cooldowns.has('acct-a'), false);
});

test('registry errors preserve canonical name and code over details', () => {
  const error = new AntigravityAccountRegistryError('ACCOUNT_UNKNOWN', 'bad account', {
    code: 'OVERRIDE',
    name: 'OtherError',
  });

  assert.equal(error.name, 'AntigravityAccountRegistryError');
  assert.equal(error.code, 'ACCOUNT_UNKNOWN');
});
