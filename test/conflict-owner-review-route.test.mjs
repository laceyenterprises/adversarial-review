import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { conflictOwnerReviewRoute } from '../src/conflict-owner-review-route.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';

const headSha = 'a'.repeat(40), oldHead = 'b'.repeat(40), repo = 'fixture/repo', prNumber = 42;
function fixture(t, { status = null, head = headSha, settled = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'conflict-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const path = join(rootDir, 'data/reviews.db');
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  if (status) db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, review_status, reviewer_head_sha, reviewed_at, reviewer)
    VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z', 'synthetic')`).run(repo, prNumber, status, head);
  if (settled) db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, head_sha, pass_kind,
    gh_comment_id, body_captured_at, attempt_number, reviewer_class, started_at, status)
    VALUES (?, ?, ?, 'rereview', 'fixture-comment', '2026-01-01T00:00:00Z', 1, 'synthetic',
    '2026-01-01T00:00:00Z', 'completed')`).run(repo, prNumber, oldHead);
  return { db, rootDir, path, route: () => conflictOwnerReviewRoute({ rootDir, repo, prNumber, headSha }) };
}

for (const settled of [false, true]) test(`current-head review in flight wins over settled=${settled}`, t => {
  const f = fixture(t, { status: 'reviewing', settled });
  const before = readFileSync(f.path);
  assert.deepEqual(f.route(), { route: 'review-in-flight', headSha });
  assert.deepEqual(readFileSync(f.path), before, 'classification never mutates review state');
});

test('reviewing with an unknown reviewer head defers conservatively', t => {
  assert.equal(fixture(t, { status: 'reviewing', head: null }).route().route, 'review-in-flight');
});

for (const status of ['posted', 'pending', 'ci-blocked', 'failed', 'reviewing']) {
  test(`delivered review routes ${status} to AMA, including a prior reviewed head`, t => {
    const f = fixture(t, { status, head: oldHead, settled: true });
    assert.equal(f.route().route, 'hammer');
  });
}
for (const status of [null, 'pending', 'ci-blocked', 'failed']) test(`no delivered review with ${status} keeps PR-update`, t => {
  assert.equal(fixture(t, { status }).route().route, 'pr-update');
});
test('failed attempt with no posted artifact is not a settled review', t => {
  const f = fixture(t, { status: 'failed' });
  f.db.prepare(`INSERT INTO reviewer_passes (repo, pr_number, head_sha, pass_kind, ended_at,
    attempt_number, reviewer_class, started_at, status)
    VALUES (?, ?, ?, 'rereview', '2026-01-01T00:00:00Z', 1, 'synthetic', '2026-01-01T00:00:00Z', 'failed')`)
    .run(repo, prNumber, headSha);
  assert.equal(f.route().route, 'pr-update');
});
test('legacy posted review routes to hammer without captured passes', t => {
  assert.equal(fixture(t, { status: 'posted' }).route().route, 'hammer');
});
test('CLI binds the requested head and reports unavailable state without creating a DB', t => {
  const f = fixture(t, { status: 'reviewing' });
  const args = ['bin/conflict-owner-review-route.mjs', '--root-dir', f.rootDir,
    '--repo', repo, '--pr', String(prNumber), '--head-sha', headSha];
  const ok = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { route: 'review-in-flight', headSha });
  args[2] = join(f.rootDir, 'missing');
  const unavailable = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stdout, '');
  assert.throws(() => readFileSync(join(f.rootDir, 'missing/data/reviews.db')), /ENOENT/);
});
