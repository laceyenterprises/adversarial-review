import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { persistReviewFindings, persistReviewFindingsSafe, backfillReviewFindings } from '../src/review-finding-records.mjs';
import { backfillFindingGrades } from '../src/review-finding-grades.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';

const body = '## Blocking Issues\n- **Validate input**\n  - **File:** `input.mjs`\n  - **Problem:** Invalid input accepted.\n';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'projection-wal-'));
  mkdirSync(join(dir, 'data'));
  const path = join(dir, 'data/reviews.db');
  const db = new Database(path, { timeout: 3000 });
  db.pragma('journal_mode = WAL');
  ensureReviewStateSchema(db);
  db.exec('CREATE TABLE contention_fixture (value INTEGER); INSERT INTO contention_fixture VALUES (0)');
  const insert = db.prepare(`INSERT INTO reviewer_passes
    (repo,pr_number,attempt_number,reviewer_class,pass_kind,started_at,status,body_md)
    VALUES ('sample/service',?,1,'sample','first-pass','2026-01-01T00:00:00Z','posted',?)`);
  const ids = [1, 2].map(n => Number(insert.run(n, body).lastInsertRowid));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path, ids, root: dir };
}
function wait(flags, index, value) {
  const deadline = Date.now() + 5000;
  while (Atomics.load(flags, index) !== value) {
    assert.ok(Date.now() < deadline, 'worker handshake timed out');
    Atomics.wait(flags, index, Atomics.load(flags, index), 20);
  }
}
// The second connection runs on another thread so it can commit while SQLite
// synchronously waits on this thread. All databases and rows are synthetic.
function writer(t, path, mode) {
  const flags = new Int32Array(new SharedArrayBuffer(12));
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const Database = require(workerData.module);
    const db = new Database(workerData.path, { timeout: 0 });
    const f = new Int32Array(workerData.buffer);
    const signal = (i, n) => { Atomics.store(f, i, n); Atomics.notify(f, i); };
    if (workerData.mode === 'hold' || workerData.mode === 'retry') {
      db.exec('BEGIN IMMEDIATE; UPDATE contention_fixture SET value=value+1');
      signal(0, 1);
      Atomics.wait(f, 1, 0, 5000);
      if (workerData.mode === 'hold') Atomics.wait(f, 2, 0, 250);
      db.exec('COMMIT');
    } else {
      signal(0, 1);
      Atomics.wait(f, 1, 0, 5000);
      try { db.exec('UPDATE contention_fixture SET value=value+1'); signal(2, 1); }
      catch (err) { if (err.code === 'SQLITE_BUSY') signal(2, 2); else throw err; }
    }
    db.close(); signal(0, 2);
  `, { eval: true, workerData: { path, mode, buffer: flags.buffer,
    module: import.meta.resolve('better-sqlite3').replace('file://', '') } });
  t.after(() => worker.terminate());
  wait(flags, 0, 1);
  return flags;
}

test('deferred WAL snapshot upgrade fails after a concurrent commit', t => {
  const { db, path } = fixture(t);
  const flags = writer(t, path, 'commit');
  assert.throws(() => db.transaction(() => {
    db.prepare('SELECT * FROM contention_fixture').get();
    Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    wait(flags, 0, 2);
    db.exec('UPDATE contention_fixture SET value=value+1');
  })(), { code: 'SQLITE_BUSY_SNAPSHOT' });
});

for (const [name, project] of [
  ['finding', (db, id) => persistReviewFindings(db, id)],
  ['grade', db => backfillFindingGrades(db)],
]) {
  test(`${name} projection waits for an existing WAL writer and succeeds`, t => {
    const { db, path, ids } = fixture(t);
    if (name === 'grade') {
      persistReviewFindings(db, ids[0]);
      const f = db.prepare('SELECT * FROM review_findings LIMIT 1').get();
      db.prepare(`INSERT INTO finding_backlog (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area,outcome,reason,result_pr)
        VALUES (?,'sample/service',1,'head',?,'sample','src','applied','fixed',2)`).run(f.finding_id, f.content_sha256);
    }
    const flags = writer(t, path, 'hold');
    Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    const result = project(db, ids[0]);
    assert.equal(db.prepare('SELECT value FROM contention_fixture').get().value, 1,
      'projection succeeded after the writer committed');
    assert.equal(name === 'grade' ? result.inserted : result, 1);
    wait(flags, 0, 2);
  });
}

test('projector holds the write lock when a competing writer attempts to commit after its read', t => {
  const { db, path, ids } = fixture(t);
  const flags = writer(t, path, 'commit');
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (sql === 'SELECT * FROM reviewer_passes WHERE pass_id = ?') {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
        wait(flags, 0, 2);
        assert.equal(Atomics.load(flags, 2), 2, 'concurrent writer cannot invalidate this snapshot');
        return row;
      };
    }
    return statement;
  };
  assert.equal(persistReviewFindings(db, ids[0]), 1);
});

test('live body capture reserves the writer before its read and nested finding projection', t => {
  const { db, path, ids, root } = fixture(t);
  const flags = writer(t, path, 'commit');
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql.includes('SELECT pass_id, body_md, metadata_json')) {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const row = get(...args);
        Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
        wait(flags, 0, 2);
        assert.equal(Atomics.load(flags, 2), 2, 'outer capture transaction excludes a competing commit');
        return row;
      };
    }
    return statement;
  };
  try {
    const result = updateReviewerPassBodyCapture(root, { repo: 'sample/service', prNumber: 1,
      attemptNumber: 1, passKind: 'first-pass', bodyMd: body, verdict: 'request-changes',
      allowExistingBodyUpdate: true });
    assert.equal(result.changes, 1);
  } finally { Database.prototype.prepare = prepare; }
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings WHERE pass_id=?').get(ids[0]).n, 1);
});

test('safe live projection retries busy once and preserves failure isolation', t => {
  const { db, path, ids } = fixture(t);
  db.pragma('busy_timeout = 0');
  const flags = writer(t, path, 'retry');
  const warnings = [];
  const log = { warn(message) {
    warnings.push(message);
    Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    wait(flags, 0, 2);
  } };
  assert.equal(persistReviewFindingsSafe(db, ids[0], log), 1);
  assert.equal(warnings.length, 1);
  const other = new Database(path, { timeout: 0 });
  try {
    other.exec('BEGIN IMMEDIATE');
    const failed = [];
    assert.equal(persistReviewFindingsSafe(db, ids[1], { warn: m => failed.push(m) }), 0);
    assert.equal(failed.length, 2);
    assert.match(failed[1], /backfill required/);
  } finally { other.close(); }
});

test('finding backfill resumes after a pass and reports committed work idempotently', t => {
  const { db, ids } = fixture(t);
  const commits = [];
  const result = backfillReviewFindings(db, { afterPassId: ids[0], onPass: p => commits.push(p) });
  assert.deepEqual(result, { scanned: 1, inserted: 1, nextPassId: ids[1] });
  assert.deepEqual(commits, [{ passId: ids[1], inserted: 1 }]);
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings WHERE pass_id=?').get(ids[0]).n, 0);
  assert.equal(backfillReviewFindings(db, { afterPassId: ids[0] }).inserted, 0);
});

test('grade backfill commits and reports one pass at a time and safely replays completed passes', t => {
  const { db, ids } = fixture(t);
  for (const id of ids) {
    persistReviewFindings(db, id);
    const f = db.prepare('SELECT * FROM review_findings WHERE pass_id=?').get(id);
    db.prepare(`INSERT INTO finding_backlog
      (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area,outcome,reason)
      VALUES (?,'sample/service',?,'head',?,'sample','src','dropped','false-positive: speculative')`)
      .run(f.finding_id, id, f.content_sha256);
  }
  const committed = [];
  assert.throws(() => backfillFindingGrades(db, { onPass(pass) {
    assert.equal(db.inTransaction, false, 'callback observes a completed per-pass commit');
    committed.push(pass);
    throw new Error('synthetic interruption');
  } }), /synthetic interruption/);
  assert.deepEqual(committed, [{ passId: ids[0], inserted: 1 }]);
  assert.equal(db.prepare('SELECT count(*) n FROM review_finding_grades').get().n, 1);
  assert.deepEqual(backfillFindingGrades(db), { inserted: 1 });
  assert.deepEqual(backfillFindingGrades(db), { inserted: 0 });
});

test('safe live projection does not retry non-busy errors', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const warnings = [];
  assert.equal(persistReviewFindingsSafe(db, 1, { warn: m => warnings.push(m) }), 0);
  assert.deepEqual(warnings, ['[review-findings] projection failed for pass 1; backfill required']);
});
