// Regression: the review-state schema bootstrap must survive a busy database.
//
// `src/review-state-db.mjs` runs `ensureReviewStateSchema` at module-import
// time, before any caller can wrap it in a try/catch. When another connection
// held data/reviews.db for longer than the connection's busy_timeout, that
// unretried DDL threw a bare `SqliteError: database is locked` and killed the
// importing process outright — no fatal config banner, no recovery. On
// 2026-08-22 that took down three Node 22 CI suites at once
// (test/adapters/subject-github-pr.test.mjs, watcher-review-adoption-scheduler,
// watcher-vocabulary-fatigue), each dying at review-state-db.mjs:25 while
// sibling test processes held the same file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { withSqliteBusyRetrySync } from '../src/sqlite-busy-retry.mjs';

const silentLog = { warn() {} };

function withTempRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-state-bootstrap-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('schema bootstrap retries past a write lock held by another connection', () => {
  withTempRoot((root) => {
    const holder = openReviewStateDb(root);
    const booting = openReviewStateDb(root);
    let lockReleased = false;
    try {
      // A real exclusive write lock, not a simulated error: this is the exact
      // contention the parallel test runner produces.
      holder.exec('BEGIN EXCLUSIVE');

      const sleeps = [];
      withSqliteBusyRetrySync(() => ensureReviewStateSchema(booting), {
        label: 'review-state-schema-bootstrap',
        log: silentLog,
        // Deterministic stand-in for the wall-clock backoff: release the lock
        // partway through the retry budget instead of racing a timer.
        sleepImpl: (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2 && !lockReleased) {
            holder.exec('ROLLBACK');
            lockReleased = true;
          }
        },
      });

      assert.ok(sleeps.length >= 1, 'expected the bootstrap to have retried at least once');
      assert.ok(lockReleased, 'expected the exclusive lock to have been released during retries');
      assert.equal(
        booting.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reviewed_prs'").get()?.name,
        'reviewed_prs',
        'the schema must exist once the lock clears',
      );
    } finally {
      if (!lockReleased) {
        try {
          holder.exec('ROLLBACK');
        } catch {
          // Already rolled back or never begun.
        }
      }
      holder.close();
      booting.close();
    }
  });
});

test('schema bootstrap still surfaces a lock it can never acquire', () => {
  withTempRoot((root) => {
    const holder = openReviewStateDb(root);
    const booting = openReviewStateDb(root);
    try {
      holder.exec('BEGIN EXCLUSIVE');
      assert.throws(
        () => withSqliteBusyRetrySync(() => ensureReviewStateSchema(booting), {
          label: 'review-state-schema-bootstrap',
          log: silentLog,
          delaysMs: [0, 0],
          sleepImpl: () => {},
        }),
        /database is locked/,
        'the retry budget must not swallow a permanently locked database',
      );
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
      booting.close();
    }
  });
});
