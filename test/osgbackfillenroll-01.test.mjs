import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { backfillReviewFindings, persistReviewFindings } from '../src/review-finding-records.mjs';
import { claimFindingBatches } from '../src/findings-batch.mjs';
import { captureReadyFindings, summarizeFindingBacklog } from '../src/findings-backlog.mjs';

const repo = 'sample/service', head = 'a'.repeat(40);
const now = Date.parse('2026-06-10T12:00:00Z'), maxAgeMs = 48 * 3600000;
const body = `## Blocking Issues
- None.
## Non-blocking Issues
- **Explain result**
  - **File:** \`src/result.mjs\`
  - **Lines:** 2
  - **Problem:** The result lacks documentation.
## Simplicity and cost (advisory)
Reuse \`src/result.mjs:formatResult\` and delete the duplicate wrapper (~20 lines saved).
`;
function fixture(t, mergedAt = '2026-02-01T00:00:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'historical-projection-'));
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  db.prepare("UPDATE schema_migrations SET applied_at='2026-01-01T00:00:00Z' WHERE id='20261024_simplicity_batch.sql'").run();
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref,merged_at)
    VALUES (?,7,?,'codex','merged',?,?)`).run(repo, '2026-06-10T00:00:00Z', head, mergedAt);
  const pass = beginReviewerPass(root, { repo, prNumber: 7, attemptNumber: 1,
    passKind: 'first-pass', reviewerClass: 'codex', headSha: head });
  db.prepare(`UPDATE reviewer_passes SET body_md=?,body_captured_at=?,gh_comment_id='1' WHERE pass_id=?`)
    .run(body, '2026-06-10T00:00:00Z', pass.pass_id);
  return { db, pass, root };
}

for (const mergedAt of ['2026-02-01T00:00:00Z', '2026-06-10T00:00:00Z']) {
  test(`explicit historical projection never enrolls (${mergedAt})`, t => {
    const { db, pass } = fixture(t, mergedAt);
    assert.equal(backfillReviewFindings(db).inserted, 1);
    assert.equal(backfillReviewFindings(db).inserted, 0);
    persistReviewFindings(db, pass.pass_id, { historicalProjection: true }); // Historical replay keeps its provenance.
    db.prepare("UPDATE reviewer_passes SET gh_comment_id='2' WHERE pass_id=?").run(pass.pass_id);
    db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
    db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
    assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_note_candidates').get().n, 0);
    assert.deepEqual(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }), []);
    assert.equal(db.prepare('SELECT historical_projection FROM review_findings').get().historical_projection, 1);
  });
}

test('live late capture and late posting receipt for a recent merge both enroll', t => {
  for (const lateReceipt of [false, true]) {
    const { db, pass } = fixture(t, '2026-06-10T00:00:00Z');
    if (lateReceipt) db.prepare('UPDATE reviewer_passes SET gh_comment_id=NULL WHERE pass_id=?').run(pass.pass_id);
    persistReviewFindings(db, pass.pass_id);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, lateReceipt ? 0 : 1);
    if (lateReceipt) db.prepare("UPDATE reviewer_passes SET gh_comment_id='2' WHERE pass_id=?").run(pass.pass_id);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 1);
    // Replaying already-live evidence cannot revoke its enrollment source.
    backfillReviewFindings(db);
    assert.equal(db.prepare('SELECT historical_projection FROM review_findings').get().historical_projection, 0);
    assert.equal(db.prepare('SELECT historical_projection FROM finding_batch_notes').get().historical_projection, 0);
    assert.ok(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }).length);
  }
});

test('automatic claims skip old or unknown merge times without changing rows, including advice', t => {
  for (const mergedAt of ['2026-06-08T11:59:59.999Z', null, 'invalid']) {
    const { db, pass } = fixture(t, mergedAt);
    persistReviewFindings(db, pass.pass_id);
    // A valid capture clock is independent of the unknown/old merge clock.
    db.prepare("UPDATE reviewer_passes SET body_captured_at='2026-06-10T00:00:00Z'").run();
    const before = db.prepare('SELECT * FROM finding_backlog').all();
    assert.equal(before.length, 1);
    assert.deepEqual(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }), []);
    assert.deepEqual(db.prepare('SELECT * FROM finding_backlog').all(), before);
    const health = summarizeFindingBacklog(db, now, { maxAgeMs });
    assert.equal(health.available, true, health.error);
    assert.equal(health.outOfWindow, 1);
    assert.equal(health.batchableCount, 0);
    assert.equal(health.openCount, 1);
  }
});

test('the window includes its exact boundary and honors configured duration', t => {
  const { db, pass } = fixture(t, '2026-06-08T12:00:00Z');
  persistReviewFindings(db, pass.pass_id);
  assert.deepEqual(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs: maxAgeMs - 1 }), []);
  assert.equal(summarizeFindingBacklog(db, now, { maxAgeMs }).outOfWindow, 0);
  assert.ok(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }).length);
});

test('a manifest explicitly enrolls a historical finding outside the automatic window', t => {
  const { db } = fixture(t);
  backfillReviewFindings(db);
  const { finding_id } = db.prepare('SELECT finding_id FROM review_findings').get();
  const findings = [{ finding_id, head_sha: head, pr_number: 7, repo }];
  const manifest = { version: 1, findings, heads: [{ head_sha: head, pr_number: 7, repo }],
    sha256: createHash('sha256').update(JSON.stringify({ findings, version: 1 })).digest('hex') };
  const batches = claimFindingBatches(db, '2026-06-10', { now, maxAgeMs, manifest,
    readConsensus: () => ({ label: 'real' }) });
  assert.equal(batches.length, 1);
  assert.equal(db.prepare('SELECT manifest_sha256 FROM finding_backlog').get().manifest_sha256, manifest.sha256);
  assert.equal(summarizeFindingBacklog(db, now, { maxAgeMs }).outOfWindow, 0);
});


test('a live capture after historical projection activates a recent late receipt', t => {
  const { db, root } = fixture(t, '2026-06-10T00:00:00Z');
  db.prepare('UPDATE reviewer_passes SET gh_comment_id=NULL').run();
  backfillReviewFindings(db);
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='2'").run();
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
  updateReviewerPassBodyCapture(root, { repo, prNumber: 7, attemptNumber: 1,
    passKind: 'first-pass', bodyMd: body, ghCommentId: '2', capturedAt: '2026-06-10T01:00:00Z',
    verdict: 'comment-only', allowExistingBodyUpdate: true });
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 1);
  assert.equal(db.prepare('SELECT historical_projection FROM finding_batch_notes').get().historical_projection, 0);
  assert.ok(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }).length);
});

test('verified live merge capture activates a previously backfilled open PR', t => {
  const { db, root } = fixture(t, '2026-06-10T00:00:00Z');
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  backfillReviewFindings(db);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
  captureReadyFindings({ rootDir: root, repo, prNumber: 7, headSha: head,
    version: createHash('sha256').update(body).digest('hex'), count: 1 });
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 1);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  assert.ok(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }).length);
});
