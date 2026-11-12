// Provider-side pin for the historical-projection capability flag. A companion
// repository reads HISTORICAL_PROJECTION_SUPPORTED and refuses its explicit
// backfill unless it is true, so the flag and the behaviour it claims are
// tested together here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import * as records from '../src/review-finding-records.mjs';

const { backfillReviewFindings, persistReviewFindings, HISTORICAL_PROJECTION_SUPPORTED } = records;
const repo = 'sample/service', head = 'c'.repeat(40);
const body = `## Blocking Issues
- None.
## Non-blocking Issues
- **Name the helper**
  - **File:** \`src/helper.mjs\`
  - **Lines:** 4
  - **Problem:** The helper name hides its purpose.
`;

function mergedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'osgboundaryflag-'));
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  // Merged before any projection runs: the finding_backlog_late_capture
  // trigger fires on every review_findings insert for this PR.
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref,merged_at)
    VALUES (?,11,'2026-06-10T00:00:00Z','codex','merged',?,'2026-06-10T00:00:00Z')`).run(repo, head);
  const pass = beginReviewerPass(root, { repo, prNumber: 11, attemptNumber: 1,
    passKind: 'first-pass', reviewerClass: 'codex', headSha: head });
  db.prepare(`UPDATE reviewer_passes SET body_md=?,body_captured_at='2026-06-10T00:00:00Z',gh_comment_id='1'
    WHERE pass_id=?`).run(body, pass.pass_id);
  return { db, pass };
}

const count = (db, sql) => db.prepare(sql).get().n;

test('the provider exports the historical-projection capability as exactly true', () => {
  assert.ok(Object.hasOwn(records, 'HISTORICAL_PROJECTION_SUPPORTED'));
  assert.equal(HISTORICAL_PROJECTION_SUPPORTED, true);
});

test('a backfilled finding on a merged PR is historical and never a backlog candidate', t => {
  const { db } = mergedFixture(t);
  assert.equal(backfillReviewFindings(db).inserted, 1);
  const row = db.prepare('SELECT finding_id, historical_projection FROM review_findings').get();
  assert.equal(row.historical_projection, 1);
  assert.equal(count(db, 'SELECT count(*) n FROM finding_backlog_candidates'), 0);
  // The late-capture trigger ran for the merged PR and enrolled nothing.
  assert.equal(count(db, 'SELECT count(*) n FROM finding_backlog'), 0);
});

test('a live-captured finding on a merged PR still enrolls through the same view', t => {
  const { db, pass } = mergedFixture(t);
  assert.equal(persistReviewFindings(db, pass.pass_id), 1);
  const row = db.prepare('SELECT finding_id, historical_projection FROM review_findings').get();
  assert.equal(row.historical_projection, 0);
  assert.deepEqual(db.prepare('SELECT finding_id FROM finding_backlog_candidates').all(),
    [{ finding_id: row.finding_id }]);
  assert.deepEqual(db.prepare('SELECT finding_id FROM finding_backlog').all(),
    [{ finding_id: row.finding_id }]);
});
