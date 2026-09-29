// The closer's dispatch-directory scans share one listing, re-read only when the
// directory changed. Review finding on adversarial-review#1181: "Full
// dispatch-directory readdir on every closer tick".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _resetSettledJsonNamesForTests,
  listSettledJsonNames,
} from '../src/ama/dispatch-dir-names.mjs';
import { listActiveAmaCloserDispatches } from '../src/ama/dispatch-closer.mjs';

function countingFs() {
  const calls = { readdir: 0 };
  return {
    calls,
    fsImpl: {
      statSync,
      readdirSync(dir) {
        calls.readdir += 1;
        return readdirSync(dir);
      },
    },
  };
}

function settle(dir) {
  const past = new Date(Date.now() - 60_000);
  utimesSync(dir, past, past);
}

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ama-dispatch-dir-names-'));
  _resetSettledJsonNamesForTests();
  try {
    return fn(root);
  } finally {
    _resetSettledJsonNamesForTests();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a settled, unchanged directory is listed once across calls', () => withTempDir((dir) => {
  writeFileSync(join(dir, 'a.json'), '{}');
  writeFileSync(join(dir, 'notes.txt'), '');
  settle(dir);
  const { calls, fsImpl } = countingFs();

  assert.deepEqual(listSettledJsonNames(dir, { fsImpl }), ['a.json']);
  assert.deepEqual(listSettledJsonNames(dir, { fsImpl }), ['a.json']);
  assert.deepEqual(listSettledJsonNames(dir, { fsImpl }), ['a.json']);
  assert.equal(calls.readdir, 1);
}));

test('a new entry changes the directory mtime and forces a re-list', () => withTempDir((dir) => {
  writeFileSync(join(dir, 'a.json'), '{}');
  settle(dir);
  const { calls, fsImpl } = countingFs();
  assert.deepEqual(listSettledJsonNames(dir, { fsImpl }), ['a.json']);

  writeFileSync(join(dir, 'b.json'), '{}');
  assert.deepEqual(listSettledJsonNames(dir, { fsImpl }).sort(), ['a.json', 'b.json']);
  assert.equal(calls.readdir, 2);
}));

test('a listing taken within the settle window of the mtime is never reused', () => {
  _resetSettledJsonNamesForTests();
  const mtimeMs = 1_700_000_000_000;
  let readdirCalls = 0;
  const fsImpl = {
    statSync: () => ({ ino: 7n, mtimeNs: BigInt(mtimeMs) * 1_000_000n }),
    readdirSync: () => {
      readdirCalls += 1;
      return ['a.json'];
    },
  };
  // A same-granule change on a coarse-mtime filesystem would keep this mtime,
  // so a listing this close to it cannot be trusted.
  listSettledJsonNames('/virtual/racy', { fsImpl, nowMs: mtimeMs + 500 });
  listSettledJsonNames('/virtual/racy', { fsImpl, nowMs: mtimeMs + 600 });
  assert.equal(readdirCalls, 2);

  listSettledJsonNames('/virtual/racy', { fsImpl, nowMs: mtimeMs + 5_000 });
  listSettledJsonNames('/virtual/racy', { fsImpl, nowMs: mtimeMs + 6_000 });
  assert.equal(readdirCalls, 3);
  _resetSettledJsonNamesForTests();
});

test('a missing directory lists as empty', () => withTempDir((root) => {
  assert.deepEqual(listSettledJsonNames(join(root, 'absent')), []);
}));

test('listActiveAmaCloserDispatches sees a record written after a cached listing', () => withTempDir((rootDir) => {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  mkdirSync(dir, { recursive: true });
  const now = '2026-09-29T12:00:00Z';
  const record = (prNumber, headSha) => ({
    schemaVersion: 1,
    repo: 'laceyenterprises/adversarial-review',
    prNumber,
    headSha,
    state: 'dispatched',
    lastObservedStatus: 'running',
    dispatchedAt: now,
    lastObservedAt: now,
  });
  writeFileSync(join(dir, 'laceyenterprises__adversarial-review-pr-1-aaa.json'), JSON.stringify(record(1, 'aaa')));
  settle(dir);
  assert.equal(listActiveAmaCloserDispatches(rootDir, { now }).length, 1);

  writeFileSync(join(dir, 'laceyenterprises__adversarial-review-pr-2-bbb.json'), JSON.stringify(record(2, 'bbb')));
  const active = listActiveAmaCloserDispatches(rootDir, { now });
  assert.deepEqual(active.map((entry) => entry.prNumber).sort(), [1, 2]);
}));
