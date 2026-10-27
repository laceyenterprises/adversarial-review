import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exerciseValidatedCloserQueue } from './helpers/validated-closer-queue.mjs';

test('LAC-2097: two queued validated PRs drain across unrelated base advances without CI restarts', t => {
  const root = mkdtempSync(join(tmpdir(), 'validated-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(exerciseValidatedCloserQueue(root), { merged: [1, 2], sourceMutations: 0, ciRestarts: 0, leaseAndWaitersClean: true });
});

test('LAC-2097: two queued strict PRs drain after bounded rebases with new exact-head checks', t => {
  const root = mkdtempSync(join(tmpdir(), 'strict-validated-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(exerciseValidatedCloserQueue(root, { strict: true }),
    { merged: [1, 2], sourceMutations: 2, ciRestarts: 2, leaseAndWaitersClean: true });
});

for (const strict of [false, true]) {
  test(`LAC-2097: two remediated PRs with shared paths and separated hunks drain (strict=${strict})`, t => {
    const root = mkdtempSync(join(tmpdir(), 'shared-path-queue-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(exerciseValidatedCloserQueue(root, { strict, samePath: true }),
      { merged: [1, 2], sourceMutations: 2, ciRestarts: 2, leaseAndWaitersClean: true });
  });
}
