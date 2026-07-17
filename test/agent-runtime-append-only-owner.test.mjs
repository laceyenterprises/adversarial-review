import test from 'node:test';
import assert from 'node:assert/strict';

import { assertCanonicalAppendOwner } from '../src/adapters/agent-runtime/append-only-owner.mjs';

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
