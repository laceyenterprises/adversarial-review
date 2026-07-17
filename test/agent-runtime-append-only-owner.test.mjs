import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCanonicalAppendOwner,
  assertCanonicalOwner,
} from '../src/adapters/agent-runtime/append-only-owner.mjs';

test('append-only owner guard rejects a caller that differs from the canonical owner', () => {
  const owners = new Map([
    ['/tool/data', 501],
  ]);
  assert.throws(
    () => assertCanonicalAppendOwner('/tool', '/tool/data/runtime-runs', '/tool/data/runtime-runs/2026-07.jsonl', {
      currentUid: () => 502,
      exists: (path) => owners.has(path),
      stat: (path) => ({ uid: owners.get(path) }),
    }),
    /refusing cross-user append-only store write: caller uid 502, canonical owner uid 501/,
  );
});

test('append-only owner guard rejects an existing file owned by a different user', () => {
  const owners = new Map([
    ['/tool/data/runtime-router-audit', 501],
    ['/tool/data/runtime-router-audit/2026-07.jsonl', 502],
  ]);
  assert.throws(
    () => assertCanonicalAppendOwner('/tool', '/tool/data/runtime-router-audit', '/tool/data/runtime-router-audit/2026-07.jsonl', {
      currentUid: () => 501,
      exists: (path) => owners.has(path),
      stat: (path) => ({ uid: owners.get(path) }),
    }),
    /refusing append to non-canonical-owned store file/,
  );
});

test('append-only owner guard permits the canonical owner', () => {
  const owners = new Map([['/tool', 501]]);
  assert.doesNotThrow(() => assertCanonicalAppendOwner('/tool', '/tool/data/runtime-runs', '/tool/data/runtime-runs/2026-07.jsonl', {
    currentUid: () => 501,
    exists: (path) => owners.has(path),
    stat: (path) => ({ uid: owners.get(path) }),
  }));
});

test('generic owner guard rejects cross-user durable state writes', () => {
  const owners = new Map([['/tool/data', 501]]);
  assert.throws(
    () => assertCanonicalOwner('/tool', '/tool/data/runtime-status-snapshot.json', {
      currentUid: () => 502,
      exists: (path) => owners.has(path),
      stat: (path) => ({ uid: owners.get(path) }),
    }),
    /refusing cross-user durable state write: caller uid 502, canonical owner uid 501/,
  );
});

test('generic owner guard rejects existing durable state files owned by a different user', () => {
  const owners = new Map([
    ['/tool/data', 501],
    ['/tool/data/runtime-canary-status.json', 502],
  ]);
  assert.throws(
    () => assertCanonicalOwner('/tool', '/tool/data/runtime-canary-status.json', {
      currentUid: () => 501,
      exists: (path) => owners.has(path),
      stat: (path) => ({ uid: owners.get(path) }),
    }),
    /refusing write to non-canonical-owned durable state file/,
  );
});
