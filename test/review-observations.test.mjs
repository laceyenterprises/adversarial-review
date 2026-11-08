import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readReviewObservations } from '../src/review-observations.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';

test('CLI validates stdin and emits bounded public errors with failing exit status', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, selector: { kind: 'reviews' }, repositories: ['example/repo'] };
  const run = input => spawnSync(process.execPath,
    [fileURLToPath(new URL('../src/review-observations-cli.mjs', import.meta.url))],
    { input, encoding: 'utf8', timeout: 10_000 });
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data/reviews.db'));
  try {
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs(repo, pr_number, review_status, pr_state, reviewed_at, reviewer)
      VALUES (?, ?, 'posted', 'open', '2026-10-01T00:00:00Z', 'fixture')`).run('Example/Repo', 1);
    beginReviewerPass(rootDir, { repo: 'example/repo', prNumber: 1, attemptNumber: 1,
      passKind: 'first-pass', reviewerClass: 'codex', startedAt: '2026-10-01T00:00:00Z' });
    completeReviewerPass(rootDir, { repo: 'example/repo', prNumber: 1, attemptNumber: 1,
      passKind: 'first-pass', status: 'completed', endedAt: '2026-10-02T00:00:00Z' });
    db.prepare('UPDATE reviewer_passes SET body_md=?, verdict=? WHERE repo=? AND attempt_number=?')
      .run('completed body', 'approved', 'example/repo', 1);
    db.prepare('INSERT INTO pr_merge_closeouts(repo, pr_number, closeout_body_md, closeout_posted_at) VALUES (?, ?, ?, ?)')
      .run('example/repo', 1, 'merged body', '2026-10-04T00:00:00Z');
  } finally {
    db.close();
  }
  const valid = run(JSON.stringify(request));
  assert.equal(valid.error, undefined);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stderr, '');
  const { observed_at: observedAt, ...projection } = JSON.parse(valid.stdout);
  assert.equal(new Date(observedAt).toISOString(), observedAt);
  const { observed_at: _expectedObservedAt, ...expected } = readReviewObservations(request);
  assert.deepEqual(projection, expected);
  assert.equal(projection.items.length, 1);
  assert.equal(projection.items[0].review_body, 'completed body');
  assert.equal(projection.items[0].verdict, 'approved');
  assert.equal(projection.items[0].attempt_number, 1);
  assert.equal(projection.items[0].closeout_body, 'merged body');
  assert.equal(projection.items[0].closeout_posted_at, '2026-10-04T00:00:00Z');
  assert.equal(projection.items[0].pr_state, 'open');
  for (const [input, reason] of [
    ['{private-invalid-json', 'invalid review request JSON'],
    [' '.repeat(32769), 'request too large'],
    [JSON.stringify({ ...request, selector: { kind: 'unknown' } }), 'invalid review selector'],
    [JSON.stringify({ ...request, repositories: ['*'] }), 'review repository grant required'],
    ['null', 'review evidence unavailable'],
  ]) {
    const result = run(input);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${reason}\n`);
    assert.doesNotMatch(result.stderr, /private-invalid-json|review-cli-/);
  }
  const encoded = JSON.stringify(request);
  assert.equal(run(encoded.padEnd(32768, ' ')).status, 0, 'exact size limit remains accepted');
  // The transport limit counts UTF-16 code units, rather than UTF-8 bytes.
  for (const character of ['é', '😀']) {
    const unicode = JSON.stringify({ ...request, padding: character }).padEnd(32768, ' ');
    assert.equal(unicode.length, 32768);
    assert.ok(Buffer.byteLength(unicode, 'utf8') > 32768);
    const atLimit = run(unicode);
    assert.equal(atLimit.status, 0, atLimit.stderr);
    const overLimit = run(`${unicode} `);
    assert.equal(overLimit.status, 1);
    assert.equal(overLimit.stdout, '');
    assert.equal(overLimit.stderr, 'request too large\n');
  }
});

test('real producer schema: scoped pages, latest completed pass, nullable closeout and end cutoff', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-projection-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data/reviews.db'));
  try {
    ensureReviewStateSchema(db);
    const cols = db.prepare('PRAGMA table_info(reviewed_prs)').all();
    assert.ok(cols.some(col => col.name === 'pr_state'));
    db.prepare(`INSERT INTO reviewed_prs(repo, pr_number, review_status, pr_state, reviewed_at, reviewer) VALUES (?, ?, 'posted', 'open', '2026-10-01T00:00:00Z', 'fixture')`).run('Example/Repo', 1);
    // These rows exercise the real schema; transport/provider boundaries are absent.
    function insert(repo, attemptNumber, status, startedAt, endedAt, body, verdict) {
      beginReviewerPass(rootDir, { repo, prNumber: 1, attemptNumber, passKind: 'first-pass', reviewerClass: 'codex', startedAt });
      completeReviewerPass(rootDir, { repo, prNumber: 1, attemptNumber, passKind: 'first-pass', status, endedAt });
      db.prepare('UPDATE reviewer_passes SET body_md=?, verdict=? WHERE repo=? AND attempt_number=?').run(body, verdict, repo, attemptNumber);
    }
    insert('example/repo', 1, 'completed', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'completed body', 'approved');
    insert('example/repo', 2, 'failed', '2026-09-30T00:00:00Z', '2026-10-03T00:00:00Z', 'failed body', null);
    insert('foreign/repo', 1, 'failed', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', 'foreign body', null);
    db.prepare('INSERT INTO pr_merge_closeouts(repo, pr_number, closeout_body_md, closeout_posted_at) VALUES (?, ?, ?, ?)')
      .run('example/repo', 1, 'merged body', '2026-10-04T00:00:00Z');
    const read = selector => readReviewObservations({ rootDir, selector, repositories: ['example/repo'] });
    const first = read({ kind: 'passes', ended_since: '2026-10-02T00:00:00+00:00', limit: 1 });
    assert.equal(first.items[0].status, 'failed');
    assert.equal(first.complete, false);
    assert.equal(first.next_offset, 1);
    const tail = read({ kind: 'passes', ended_since: '2026-10-02T00:00:00Z', limit: 1, offset: 1 });
    assert.equal(tail.complete, true);
    assert.equal(tail.items[0].status, 'completed');
    const [row] = read({ kind: 'reviews' }).items;
    assert.equal(row.review_body, 'completed body');
    assert.equal(row.verdict, 'approved');
    assert.equal(row.attempt_number, 1);
    assert.equal(row.closeout_body, 'merged body');
    assert.equal(row.closeout_posted_at, '2026-10-04T00:00:00Z');
    assert.equal(row.pr_state, 'open');
    assert.equal(read({ kind: 'passes', since: '2030-01-01T00:00:00Z' }).items.length, 0);
    assert.throws(() => read({ kind: 'passes', sql: 'select 1' }), /selector/); // negative fixture
    for (const selector of [undefined, null, { kind: 'passes', ended_since: 123 },
      { kind: 'passes', ended_since: 'bad date' }, { kind: 'reviews', since: '2026-10-01T00:00:00Z' },
      { kind: 'reviews', ended_since: '2026-10-01T00:00:00Z' }]) {
      assert.throws(() => read(selector), { message: 'invalid review selector' });
    }
    assert.throws(() => readReviewObservations({ rootDir, selector: { kind: 'passes' }, repositories: ['*'] }), /grant/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('old partial schema is explicit, empty is observable and missing DB is unavailable', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-partial-'));
  try {
    const read = selector => readReviewObservations({ rootDir, selector, repositories: ['example/repo'] });
    assert.deepEqual(read({ kind: 'reviews' }).missing_fields, ['review_store']);
    mkdirSync(join(rootDir, 'data'));
    const db = new Database(join(rootDir, 'data/reviews.db'));
    db.exec('CREATE TABLE reviewed_prs(repo TEXT, pr_number INTEGER)');
    assert.deepEqual(read({ kind: 'reviews' }).items, []);
    db.exec("INSERT INTO reviewed_prs VALUES ('example/repo',1)");
    const partial = read({ kind: 'reviews' });
    assert.ok(partial.missing_fields.includes('review_status'));
    assert.ok(partial.missing_fields.includes('reviewer_passes.repo'));
    assert.ok(partial.missing_fields.includes('reviewer_passes.pr_number'));
    assert.equal(partial.items[0].review_body, null);
    assert.equal(partial.scope_complete, false);
    assert.equal(partial.mutation_authority, false);
    db.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('table-less stores are unavailable; a real table retains exact column drift', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-store-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data/reviews.db'));
  const read = kind => readReviewObservations({ rootDir, selector: { kind }, repositories: ['example/repo'] });
  try {
    for (const kind of ['passes', 'reviews']) {
      assert.deepEqual(read(kind).missing_fields, ['review_store']);
      assert.equal(read(kind).scope_complete, false);
    }
    db.exec(`CREATE TABLE reviewer_passes(pass_id INTEGER, repo TEXT, pr_number INTEGER,
      attempt_number INTEGER, reviewer_class TEXT, reviewer_model TEXT, pass_kind TEXT,
      started_at TEXT, ended_at TEXT, status TEXT, metadata_json TEXT)`);
    db.exec('ALTER TABLE reviewer_passes DROP COLUMN metadata_json');
    assert.deepEqual(read('passes').missing_fields, ['metadata_json']);
    db.exec(`CREATE TABLE reviewed_prs(repo TEXT, pr_number INTEGER, pr_state TEXT,
      review_status TEXT, failure_message TEXT, reviewer_head_sha TEXT,
      revision_ref TEXT, reviewed_at TEXT, posted_at TEXT);
      ALTER TABLE reviewed_prs DROP COLUMN posted_at;
      ALTER TABLE reviewer_passes ADD COLUMN body_md TEXT;
      ALTER TABLE reviewer_passes ADD COLUMN verdict TEXT;
      CREATE TABLE pr_merge_closeouts(repo TEXT, pr_number INTEGER,
        closeout_body_md TEXT, closeout_posted_at TEXT)`);
    assert.deepEqual(read('reviews').missing_fields, ['posted_at']);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
