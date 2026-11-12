import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { blockingFindingIdentity } from '../src/ama/hammer-adjudication.mjs';
import * as records from '../src/review-finding-records.mjs';
import { backfillFindingGrades } from '../src/review-finding-grades.mjs';
import { createBackfillWritePacer, parseWriteDutyCycle } from '../src/backfill-write-pacer.mjs';

const { backfillReviewFindings, persistReviewFindings } = records;
const repo = 'sample/service', head = 'a'.repeat(40);
// Synthetic review bodies; a larger body makes each projection a measurable write.
const reviewBody = (count, label = 'Check') => [
  '## Blocking Issues',
  ...Array.from({ length: count }, (_, i) => `- **${label} input ${i}**\n  - **File:** \`src/input-${i}.mjs\`\n  - **Lines:** ${i + 1}\n  - **Problem:** Input ${i} is accepted without validation.\n  - **Why it matters:** Invalid input ${i} reaches storage.\n  - **Recommended fix:** Validate input ${i}.`),
  '## Non-blocking Issues',
  '- **Document result**\n  - **File:** `src/result.mjs`\n  - **Problem:** The result lacks documentation.',
  '## Simplicity and cost (advisory)',
  'Reuse `src/result.mjs:formatResult` and delete the duplicate wrapper (~20 lines saved).',
  '',
].join('\n');

function corpus(t, { passes = 3, findings = 2, merged = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'backfill-pace-'));
  const path = join(root, 'reviews.db');
  const db = new Database(path, { timeout: 3000 });
  db.pragma('journal_mode = WAL');
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE contention_fixture (value INTEGER); INSERT INTO contention_fixture VALUES (0)');
  if (merged) db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref,merged_at)
    VALUES (?,1,'2026-06-10T00:00:00Z','sample','merged',?,'2026-06-10T00:00:00Z')`).run(repo, head);
  const insert = db.prepare(`INSERT INTO reviewer_passes
    (repo,pr_number,attempt_number,reviewer_class,pass_kind,started_at,status,body_md,head_sha,gh_comment_id,body_captured_at,metadata_json)
    VALUES (?,1,?,'sample','first-pass','2026-06-10T00:00:00Z','posted',?,?,?,'2026-06-10T00:00:00Z',?)`);
  const ids = Array.from({ length: passes }, (_, n) => Number(insert.run(repo, n + 1, reviewBody(findings), head,
    `comment-${n}`, JSON.stringify({ reviewerExecution: { harness: 'sample-harness', promptSet: 'sample' } })).lastInsertRowid));
  return { db, path, root, ids };
}

const dump = db => Object.fromEntries(['review_findings', 'finding_batch_notes', 'review_finding_disputes',
  'finding_backlog'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const totalChanges = db => db.prepare('SELECT total_changes() n').get().n;

// The second connection runs on another thread so it can contend while this
// thread runs the synchronous backfill. It records every write attempt.
function liveWriter(t, path, busyTimeoutMs) {
  const flags = new Int32Array(new SharedArrayBuffer(16));
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const Database = require(workerData.module);
    const db = new Database(workerData.path, { timeout: workerData.busyTimeoutMs });
    const f = new Int32Array(workerData.buffer);
    Atomics.store(f, 0, 1); Atomics.notify(f, 0);
    while (Atomics.load(f, 1) === 0) {
      try { db.exec('BEGIN IMMEDIATE; UPDATE contention_fixture SET value=value+1; COMMIT'); Atomics.add(f, 2, 1); }
      catch (err) {
        if (!/SQLITE_BUSY|SQLITE_LOCKED/.test(String(err.code))) throw err;
        if (db.inTransaction) db.exec('ROLLBACK');
        Atomics.add(f, 3, 1);
      }
      Atomics.wait(f, 1, 0, 2);
    }
    db.close();
    Atomics.store(f, 0, 2); Atomics.notify(f, 0);
  `, { eval: true, workerData: { path, busyTimeoutMs, buffer: flags.buffer,
    module: fileURLToPath(import.meta.resolve('better-sqlite3')) } });
  t.after(() => worker.terminate());
  const waitFor = value => {
    const deadline = Date.now() + 10000;
    while (Atomics.load(flags, 0) !== value) {
      assert.ok(Date.now() < deadline, 'live writer handshake timed out');
      Atomics.wait(flags, 0, Atomics.load(flags, 0), 20);
    }
  };
  waitFor(1);
  return {
    stop() {
      Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
      waitFor(2);
      return { ok: Atomics.load(flags, 2), busy: Atomics.load(flags, 3) };
    },
  };
}

test('capability flag tells the companion backfill command that pacing is available', () => {
  assert.equal(records.BACKFILL_WRITE_PACING_SUPPORTED, true);
  assert.equal(records.HISTORICAL_PROJECTION_SUPPORTED, true);
  assert.equal(typeof records.createBackfillWritePacer, 'function');
  assert.equal(records.DEFAULT_BACKFILL_WRITE_DUTY_CYCLE, 0.2);
});

test('a live writer with a short busy timeout keeps committing while the backfill projects new and captured passes', t => {
  const { db, path, ids } = corpus(t, { passes: 120, findings: 40 });
  const writer = liveWriter(t, path, 100);
  const fresh = backfillReviewFindings(db, { limit: 5000 });
  const replay = backfillReviewFindings(db, { limit: 5000 });
  const { ok, busy } = writer.stop();
  assert.equal(busy, 0, `live writer hit SQLITE_BUSY ${busy} times (${ok} commits)`);
  assert.ok(ok > 10, `live writer committed only ${ok} times`);
  assert.equal(fresh.scanned, ids.length);
  assert.equal(fresh.written, ids.length);
  assert.equal(fresh.inserted, ids.length * 41);
  assert.equal(fresh.pacing.writeTransactions, ids.length);
  assert.ok(fresh.pacing.writeDutyCycle <= 0.2 + 1e-9, `duty cycle ${fresh.pacing.writeDutyCycle}`);
  assert.deepEqual([replay.written, replay.skipped, replay.inserted, replay.pacing.writeTransactions],
    [0, ids.length, 0, 0]);
});

test('already-captured passes take no write transaction, even while another connection holds the write lock', t => {
  const { db, path, ids } = corpus(t, { passes: 4 });
  assert.equal(backfillReviewFindings(db).written, ids.length);
  const before = dump(db);
  const changes = totalChanges(db);
  db.pragma('busy_timeout = 0');
  const holder = new Database(path, { timeout: 0 });
  t.after(() => holder.close());
  holder.exec('BEGIN IMMEDIATE');
  try {
    // busy_timeout=0: any write transaction would fail at once with SQLITE_BUSY.
    const result = backfillReviewFindings(db);
    assert.deepEqual([result.scanned, result.written, result.skipped, result.inserted], [ids.length, 0, ids.length, 0]);
    assert.equal(result.pacing.writeTransactions, 0);
  } finally { holder.exec('ROLLBACK'); }
  assert.equal(totalChanges(db), changes);
  assert.deepEqual(dump(db), before);
});

test('every projection difference is repaired, and the repaired state is the fixed point live replay would produce', async t => {
  const identity = blockingFindingIdentity(parseReviewFindings(reviewBody(2)).blocking.findings[0]);
  const mutations = {
    'missing finding row': db => db.prepare('DELETE FROM review_findings WHERE ordinal=1').run(),
    'finding not current': db => db.prepare('UPDATE review_findings SET current_body=0 WHERE ordinal=2').run(),
    'stale row still current': db => db.prepare(`INSERT INTO review_findings
      (finding_id,pass_id,ordinal,content_sha256,blocking,finding_json,reviewer_identity,hammer_identity,historical_projection)
      SELECT pass_id || ':9:stale',pass_id,9,'stale',0,'{}','sample','stale',1 FROM reviewer_passes`).run(),
    'prompt attribution drift': db => db.prepare("UPDATE review_findings SET prompt_set='other' WHERE ordinal=1").run(),
    'reviewer attribution drift': db => db.prepare("UPDATE review_findings SET reviewer_identity='other' WHERE ordinal=1").run(),
    'missing advisory note': db => db.prepare('DELETE FROM finding_batch_notes').run(),
    'stray unassigned note': db => db.prepare(`INSERT INTO finding_batch_notes
      (note_id,pass_id,repo,pr_number,head_sha,note,historical_projection)
      SELECT 'stray',pass_id,repo,pr_number,head_sha,'old advice',1 FROM reviewer_passes`).run(),
    'unsynced posted dispute': db => db.prepare(`INSERT INTO ham_finding_disputes
      (repo,pr_number,identity,head_sha,finding_reviewed_head,resolution,comment_id,evidence_sha256)
      VALUES (?,1,?,?,?,'withdrawn-by-hammer','synthetic-comment',?)`).run(repo, identity, 'b'.repeat(40), head, 'c'.repeat(64))
      // The insert trigger links it at once; drop that link to model a dispute
      // posted before its finding was captured.
      && db.prepare('DELETE FROM review_finding_disputes').run(),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, t2 => {
      const { db, ids } = corpus(t2, { passes: 1 });
      backfillReviewFindings(db);
      mutate(db);
      const before = dump(db);
      const repaired = backfillReviewFindings(db);
      assert.equal(repaired.written, 1, 'the difference was detected');
      assert.notDeepEqual(dump(db), before, 'the write changed the projection');
      const fixed = dump(db);
      persistReviewFindings(db, ids[0], { historicalProjection: true });
      assert.deepEqual(dump(db), fixed, 'skip criterion matches a full historical replay');
      assert.equal(backfillReviewFindings(db).written, 0, 'a repaired pass is skipped next time');
    });
  }
});

test('the review body is parsed outside every transaction, and a pass changed mid-flight is re-read and re-parsed, never written from the stale parse', t => {
  const { db, ids } = corpus(t, { passes: 2 });
  backfillReviewFindings(db);
  const changed = reviewBody(3, 'Revised');
  let parses = 0;
  const parse = body => {
    parses += 1;
    assert.equal(db.inTransaction, false, 'parse ran inside a transaction');
    // A live capture lands between the backfill's read and its write.
    if (parses === 1) {
      db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(changed, ids[0]);
      persistReviewFindings(db, ids[0]);
    }
    return parseReviewFindings(body);
  };
  // Force the write path for both passes so the stale-plan branch is reached.
  db.prepare('UPDATE review_findings SET current_body=0').run();
  const result = backfillReviewFindings(db, { parse });
  assert.equal(result.replanned, 1);
  assert.deepEqual(db.prepare(`SELECT title, historical_projection FROM review_findings
    WHERE pass_id=? AND current_body=1 AND blocking=1 ORDER BY ordinal`).all(ids[0]).map(row => [row.title, row.historical_projection]),
  [0, 1, 2].map(i => [`Revised input ${i}`, 0]), 'the live capture is not overwritten with the stale parse');
  assert.equal(db.prepare('SELECT count(*) n FROM review_findings WHERE pass_id=? AND current_body=1').get(ids[1]).n, 3);
});

test('a pass that keeps changing is finally re-planned under the lock from its latest row', t => {
  const { db, ids } = corpus(t, { passes: 1 });
  let parses = 0;
  const insideLock = [];
  const parse = body => {
    parses += 1;
    insideLock.push(db.inTransaction);
    // Every outside-the-lock parse races a fresh live update of the body.
    if (!db.inTransaction) db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?')
      .run(reviewBody(1, `Edit ${parses}`), ids[0]);
    return parseReviewFindings(body);
  };
  const result = backfillReviewFindings(db, { parse });
  assert.deepEqual([result.written, result.replanned], [1, 1]);
  assert.deepEqual(insideLock, [false, false, false, true]);
  assert.deepEqual(db.prepare(`SELECT title FROM review_findings WHERE current_body=1 AND blocking=1`).all(),
    [{ title: 'Edit 3 input 0' }]);
  assert.equal(result.pacing.writeTransactions, 3, 'empty stale-plan transactions are paced too');
});

test('historical rows keep historical_projection=1 and enroll nothing, while a live capture of the same shape enrolls', t => {
  const root = mkdtempSync(join(tmpdir(), 'backfill-pace-enroll-'));
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare("UPDATE schema_migrations SET applied_at='2026-01-01T00:00:00Z' WHERE id='20261024_simplicity_batch.sql'").run();
  for (const pr of [7, 8]) {
    db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref,merged_at)
      VALUES (?,?,'2026-06-10T00:00:00Z','codex','merged',?,'2026-06-10T00:00:00Z')`).run(repo, pr, head);
    const pass = beginReviewerPass(root, { repo, prNumber: pr, attemptNumber: 1,
      passKind: 'first-pass', reviewerClass: 'codex', headSha: head });
    db.prepare("UPDATE reviewer_passes SET body_md=?,body_captured_at='2026-06-10T00:00:00Z',gh_comment_id=? WHERE pass_id=?")
      .run(reviewBody(2), `comment-${pr}`, pass.pass_id);
    if (pr === 8) persistReviewFindings(db, pass.pass_id);
  }
  const live = db.prepare(`SELECT count(*) n FROM finding_backlog WHERE pr_number=8`).get().n;
  assert.ok(live > 0, 'control: a live capture enrolls');
  const result = backfillReviewFindings(db);
  assert.equal(result.written, 1, 'only the uncaptured pass is written');
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE pr_number=7').get().n, 0);
  assert.deepEqual(db.prepare(`SELECT DISTINCT historical_projection h FROM review_findings f
    JOIN reviewer_passes p USING(pass_id) WHERE p.pr_number=7`).all(), [{ h: 1 }]);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE pr_number=8').get().n, live);
  assert.deepEqual(db.prepare(`SELECT DISTINCT historical_projection h FROM review_findings f
    JOIN reviewer_passes p USING(pass_id) WHERE p.pr_number=8`).all(), [{ h: 0 }], 'replay never demotes live rows');
});

test('the pacer yields after every write transaction, including empty and failed ones', () => {
  let clock = 0;
  const sleeps = [];
  const pacer = createBackfillWritePacer({ maxWriteDutyCycle: 0.2, now: () => clock,
    sleep: ms => { sleeps.push(ms); clock += ms; } });
  assert.equal(pacer.write(() => { clock += 3; return 0; }), 0);
  assert.throws(() => pacer.write(() => { clock += 2; throw new Error('synthetic'); }), /synthetic/);
  pacer.write(() => {}); // Sub-millisecond writes still yield.
  assert.deepEqual(sleeps, [12, 8, 1]);
  const summary = pacer.summary();
  assert.equal(summary.writeTransactions, 3);
  assert.equal(summary.writeMs, 5);
  assert.equal(summary.yieldMs, 21);
  assert.ok(summary.writeDutyCycle <= 0.2);
  const unpaced = createBackfillWritePacer({ maxWriteDutyCycle: 1, sleep: () => assert.fail('no yield at 1') });
  unpaced.write(() => {});
  for (const bad of ['0', '-0.1', '1.5', 'abc', '', '1e-1', 0, 2, null]) {
    assert.throws(() => parseWriteDutyCycle(bad), /write duty cycle/, String(bad));
  }
  assert.deepEqual(['.5', '0.05', '1', '1.0', 0.2].map(parseWriteDutyCycle), [0.5, 0.05, 1, 1, 0.2]);
});

test('passes that rewrite rows without inserting are paced too, and both phases share one caller pacer', t => {
  const { db, ids } = corpus(t, { passes: 3 });
  backfillReviewFindings(db);
  db.prepare('UPDATE review_findings SET current_body=0').run();
  const sleeps = [];
  const pacer = createBackfillWritePacer({ sleep: ms => sleeps.push(ms) });
  const result = backfillReviewFindings(db, { pacer });
  assert.deepEqual([result.inserted, result.written], [0, ids.length]);
  assert.equal(sleeps.length, ids.length);
  const grades = backfillFindingGrades(db, { pacer });
  assert.equal(grades.pacing.writeTransactions, ids.length * 2, 'grade passes are paced by the same pacer');
  assert.equal(sleeps.length, ids.length * 2);
});

test('CLIs accept a duty-cycle flag, report pacing, and reject an invalid pace before opening the database', t => {
  const { db, path, ids } = corpus(t, { passes: 2 });
  db.close();
  for (const [name, inserted] of [['findings', ids.length * 3], ['grades', 0]]) {
    const cli = fileURLToPath(new URL(`../bin/review-${name}.mjs`, import.meta.url));
    const missing = join(mkdtempSync(join(tmpdir(), 'backfill-pace-cli-')), 'absent.db');
    const refused = spawnSync(process.execPath, [cli, 'backfill', '--db', missing, '--max-write-duty-cycle', '0'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /write duty cycle/);
    assert.equal(existsSync(missing), false);
    const ran = spawnSync(process.execPath, [cli, 'backfill', '--db', path, '--max-write-duty-cycle', '0.1'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(ran.status, 0, ran.stderr);
    const output = JSON.parse(ran.stdout.trim().split('\n').at(-1));
    assert.equal(output.inserted, inserted);
    assert.equal(output.pacing.maxWriteDutyCycle, 0.1);
  }
});
