import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../bin/reconcile-posted-orphans.mjs';

test('reconcile-posted-orphans parseArgs accepts help and limit', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.deepEqual(
    { ...parseArgs(['--root', '/tmp/adversarial-review', '--limit', '7', '--apply']), root: '<root>' },
    { root: '<root>', apply: true, limit: 7 }
  );
});

test('reconcile-posted-orphans parseArgs rejects missing flag values', () => {
  assert.throws(() => parseArgs(['--root']), /--root requires a value/);
  assert.throws(() => parseArgs(['--root', '--apply']), /--root requires a value/);
  assert.throws(() => parseArgs(['--limit']), /--limit requires a value/);
  assert.throws(() => parseArgs(['--limit', '0']), /--limit must be a positive integer/);
});
