import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PoolConfigConflictError,
  resetPoolConfigConflictWarnings,
  warnPoolConfigConflict,
} from '../src/pool-config-conflict.mjs';

afterEach(resetPoolConfigConflictWarnings);

test('conflict warnings deduplicate every key and explicit reset permits another warning', () => {
  resetPoolConfigConflictWarnings();
  const keys = ['roles.build_pack_default_worker_class', 'roles.codex_worker_account_order'];
  const error = new PoolConfigConflictError(keys, 'private-source-path');
  const messages = [];
  const log = { warn: message => messages.push(message) };
  const expected = keys.map(key => `[agy-identities] pool-config-conflict: ${key}; inspect migration report`);
  assert.equal(warnPoolConfigConflict(new Error('unrelated'), log), false);
  assert.equal(warnPoolConfigConflict(error, log), true);
  assert.equal(warnPoolConfigConflict(error, log), true);
  assert.deepEqual(messages, expected);
  resetPoolConfigConflictWarnings();
  assert.equal(warnPoolConfigConflict(error, log), true);
  assert.deepEqual(messages, [...expected, ...expected]);
});
