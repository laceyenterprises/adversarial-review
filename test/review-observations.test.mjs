import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReviewObservations } from '../src/review-observations.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';

test('CLI projects valid stdin and rejects malformed, oversized and unauthorized requests', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'review-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data/reviews.db'));
  ensureReviewStateSchema(db);
  db.close();
  const request = { rootDir, selector: { kind: 'reviews' }, repositories: ['example/repo'] };
  const run = input => spawnSync(process.execPath, [
    fileURLToPath(new URL('../src/review-observations-cli.mjs', import.meta.url)),
  ], { input, encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } });
  const valid = JSON.stringify(request);
  // Pin both sides of the 32768-character transport limit.
  for (const input of [valid, valid.padEnd(32768, ' ')]) {
    const result = run(input);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const { observed_at: observedAt, ...reply } = JSON.parse(result.stdout);
    const { observed_at: _expectedTime, ...expected } = readReviewObservations(request);
    assert.ok(Number.isFinite(Date.parse(observedAt)));
    assert.deepEqual(reply, expected);
  }
  for (const input of ['', '{private-invalid-json', 'null', valid.padEnd(32769, ' '),
    JSON.stringify({ ...request, repositories: ['*'] }),
    JSON.stringify({ ...request, selector: { kind: 'reviews', sql: 'select private' } })]) {
    const result = run(input);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'review evidence unavailable\n');
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
