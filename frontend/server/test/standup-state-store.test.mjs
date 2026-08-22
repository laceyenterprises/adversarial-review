/**
 * The standup state store (ARF-06).
 *
 * Small files, but the allowlist is one of them, so the failure modes here are
 * the invisible kind: a lost concurrent write, a half-written document, or a
 * corrupt file quietly replaced by an empty one.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StandupStateError, assertOwnedByUs, openJsonState } from '../src/standup/state-store.mjs';
import { tmpStateRoot } from './helpers/standup-fixtures.mjs';

async function withFakeUid(uid, fn) {
  const original = process.getuid;
  process.getuid = () => uid;
  try {
    return await fn();
  } finally {
    process.getuid = original;
  }
}

function store(name = 'state.json', options = {}) {
  const path = join(tmpStateRoot(), 'nested', name);
  return openJsonState(path, { empty: () => ({ version: 1, items: [] }), ...options });
}

describe('standup state store', () => {
  it('reads an absent file as the empty document', async () => {
    const state = store();
    assert.deepEqual(await state.read(), { version: 1, items: [] });
    assert.equal(await state.exists(), false);
  });

  it('creates the directory, writes atomically, and keeps the file private', async () => {
    const state = store();
    await state.update((current) => ({
      document: { ...current, items: ['a'] },
      result: 'written',
    }));
    assert.deepEqual(JSON.parse(readFileSync(state.path, 'utf8')).items, ['a']);
    assert.equal(statSync(state.path).mode & 0o777, 0o600);
    // No temp file or lock left behind.
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(join(state.path, '..')), ['state.json']);
  });

  it('serializes concurrent read-modify-write instead of losing entries', async () => {
    // Two allowlist entries added at once must both survive — the lost one
    // would be a login whose reviews stop being counted with nothing to see.
    const state = store();
    await Promise.all(['a', 'b', 'c', 'd'].map((item) => state.update((current) => ({
      document: { ...current, items: [...current.items, item] },
      result: null,
    }))));
    const items = (await state.read()).items;
    assert.equal(items.length, 4);
    assert.deepEqual([...items].sort(), ['a', 'b', 'c', 'd']);
  });

  it('writes nothing when the callback declines', async () => {
    const state = store();
    await state.update(() => null);
    assert.equal(await state.exists(), false);
  });

  it('refuses a corrupt document rather than replacing it', async () => {
    const state = store();
    await state.update((current) => ({ document: current, result: null }));
    writeFileSync(state.path, '{ not json');
    await assert.rejects(state.read(), (err) => {
      assert.ok(err instanceof StandupStateError);
      assert.equal(err.code, 'standup_state_corrupt');
      assert.match(err.message, /Refusing to overwrite it/);
      return true;
    });
    // And the bytes are still there for an operator to salvage.
    assert.equal(readFileSync(state.path, 'utf8'), '{ not json');
  });

  it('applies the caller shape check on read', async () => {
    const state = store('state.json', {
      parse: (document) => {
        if (!Array.isArray(document.items)) throw new TypeError('items must be an array');
        return document;
      },
    });
    await state.update(() => ({ document: { version: 1, items: 'nope' }, result: null }));
    await assert.rejects(state.read(), /items must be an array/);
  });

  it('lets a file we own — or one that does not exist yet — through the owner check', async () => {
    // Provisioning a state file that is not there yet is this module's normal
    // path, but only under a state root owned by the current uid.
    const state = store();
    await assertOwnedByUs(state.path);
    await state.update((current) => ({ document: current, result: null }));
    await assertOwnedByUs(state.path);
  });

  it('refuses to create an absent state file under a directory owned by another uid', async (t) => {
    if (typeof process.getuid !== 'function') {
      t.skip('uid ownership checks are POSIX-only');
      return;
    }
    const state = store();
    const fakeUid = process.getuid() + 100000;

    await withFakeUid(fakeUid, async () => {
      await assert.rejects(
        state.update((current) => ({ document: current, result: null })),
        (err) => {
          assert.equal(err.code, 'standup_state_foreign_owner');
          assert.match(err.message, /Refusing to write standup state across accounts/);
          return true;
        },
      );
    });
    assert.equal(await state.exists(), false);
  });

  it('checks an existing lock file owner before waiting on it', async (t) => {
    if (typeof process.getuid !== 'function') {
      t.skip('uid ownership checks are POSIX-only');
      return;
    }
    const state = store();
    await state.update((current) => ({ document: current, result: null }));
    const lockPath = `${state.path}.lock`;
    writeFileSync(lockPath, `${process.pid}\n`);
    const fakeUid = process.getuid() + 100000;

    await withFakeUid(fakeUid, async () => {
      await assert.rejects(
        assertOwnedByUs(lockPath),
        (err) => {
          assert.equal(err.code, 'standup_state_foreign_owner');
          assert.equal(err.path, lockPath);
          return true;
        },
      );
    });
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
  });

  it('refuses a demonstrably stale lock without deleting it', async () => {
    const state = store('state.json', { lockWaitMs: 30, lockStaleMs: 1 });
    const lockPath = `${state.path}.lock`;
    await state.update((current) => ({ document: current, result: null }));
    writeFileSync(lockPath, '999999\n');
    const { utimesSync } = await import('node:fs');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    await assert.rejects(
      state.update((current) => ({ document: { ...current, items: ['after'] }, result: null })),
      (err) => {
        assert.equal(err.code, 'standup_state_stale_lock');
        assert.match(err.message, /Refusing automatic stale-lock takeover/);
        return true;
      },
    );
    assert.equal(readFileSync(lockPath, 'utf8'), '999999\n');
    assert.deepEqual((await state.read()).items, []);
  });

  it('does not let two stale-lock waiters delete each other\'s replacement lock', async () => {
    const state = store('state.json', { lockWaitMs: 30, lockStaleMs: 1 });
    const lockPath = `${state.path}.lock`;
    await state.update((current) => ({ document: current, result: null }));
    writeFileSync(lockPath, '999999\n');
    const { utimesSync } = await import('node:fs');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    const attempts = await Promise.allSettled([
      state.update((current) => ({ document: { ...current, items: [...current.items, 'a'] }, result: null })),
      state.update((current) => ({ document: { ...current, items: [...current.items, 'b'] }, result: null })),
    ]);

    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.equal(attempt.status, 'rejected');
      assert.equal(attempt.reason.code, 'standup_state_stale_lock');
    }
    assert.equal(readFileSync(lockPath, 'utf8'), '999999\n');
    assert.deepEqual((await state.read()).items, []);
  });

  it('does not take over a stale lock whose owner is still alive', async () => {
    const state = store('state.json', { lockWaitMs: 30, lockStaleMs: 1 });
    const lockPath = `${state.path}.lock`;
    await state.update((current) => ({ document: current, result: null }));
    writeFileSync(lockPath, `${process.pid}\n`);
    const { utimesSync } = await import('node:fs');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longAgo, longAgo);

    await assert.rejects(
      state.update((current) => ({ document: { ...current, items: ['stolen'] }, result: null })),
      (err) => {
        assert.equal(err.code, 'standup_state_locked');
        return true;
      },
    );
    assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
  });
});
