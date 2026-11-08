import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { readReviewFindings } from '../src/review-finding-records.mjs';
import { recordFindingGrade } from '../src/review-finding-grades.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'finding-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openReviewStateDb(root);
  t.after(() => db.close());
  for (let i = 1; i <= 3; i++) {
    const key = { repo: i === 3 ? 'sample/other' : 'sample/service', prNumber: i, attemptNumber: 1, passKind: 'first-pass' };
    beginReviewerPass(root, { ...key, reviewerClass: 'codex', headSha: String(i).repeat(40) });
    updateReviewerPassBodyCapture(root, { ...key, bodyMd: `## Blocking Issues
- **Validate input ${i}**
  - **Category:** correctness
  - **File:** \`${i === 3 ? 'modules_extra' : 'modules'}/input.mjs\`
  - **Lines:** 2
  - **Problem:** Invalid input is accepted.
## Non-blocking Issues
- None.
`, verdict: 'request-changes' });
  }
  db.prepare("UPDATE reviewer_passes SET started_at='2026-01-02T00:00:00Z'").run();
  db.prepare("UPDATE review_findings SET reviewer_model='model-a',reviewer_harness='native',prompt_digest=?").run('a'.repeat(64));
  const rows = readReviewFindings(db);
  const grade = (index, sourceKey, taxonomyCode) => recordFindingGrade(db, {
    findingId: rows[index].finding_id, sourceKey, taxonomyCode, graderKind: 'grader',
    evidence: { file: 'modules/input.mjs', lines: [2, 2] }, gradedAt: '2026-01-03T00:00:00Z',
  });
  grade(0, 'real', 'tp.valid'); grade(0, 'false', 'fp.misread-code');
  grade(1, 'lifecycle', 'life.superseded');
  return { db, rows };
}

test('filters intersect before pagination and preserve reviewed heads and grades', t => {
  const { db, rows } = fixture(t);
  const options = { repo: 'sample/service', prNumbers: [1, 2], reviewerModel: 'model-a',
    reviewerHarness: 'native', promptDigest: 'a'.repeat(64), area: 'modules', blocking: true,
    since: '2026-01-01', until: '2026-01-03', limit: 1 };
  for (const [key, value] of Object.entries(options)) {
    assert.ok(readReviewFindings(db, { [key]: value }).length, `filter ${key}`);
  }
  const first = readReviewFindings(db, options);
  assert.equal(first[0].finding_id, rows[0].finding_id);
  assert.equal(first[0].head_sha, '1'.repeat(40));
  assert.equal(first[0].grades.length, 2);
  const second = readReviewFindings(db, { ...options, afterPassId: first[0].pass_id, afterOrdinal: first[0].ordinal });
  assert.equal(second[0].finding_id, rows[1].finding_id);
  assert.equal(readReviewFindings(db, { area: 'modules' }).length, 2);
  assert.equal(readReviewFindings(db, { prNumber: 3 })[0].repo, 'sample/other');
  for (const mismatch of [{ reviewerModel: 'other' }, { reviewerHarness: 'other' }, { promptDigest: 'b'.repeat(64) },
    { blocking: false }, { since: '2026-01-02T01:00:00Z' }, { until: '2026-01-02T01:00:00+01:00' }, { area: 'mod%' }]) {
    assert.deepEqual(readReviewFindings(db, { ...options, ...mismatch }), []);
  }
  assert.equal(readReviewFindings(db, { since: '2026-01-02T01:00:00+01:00' }).length, 3);
});

test('non-ISO date filters compare parsed instants with inclusive since and exclusive until', t => {
  const { db, rows } = fixture(t);
  const ids = rows.map(row => row.finding_id);
  for (const filters of [
    { since: 'Fri, 02 Jan 2026 00:00:00 GMT' },
    { until: 'Sat, 03 Jan 2026 00:00:00 GMT' },
    { since: '01/01/2026', until: '01/03/2026' },
    { since: 'Fri, 02 Jan 2026 01:00:00 +0100', until: '01/03/2026' },
  ]) {
    assert.deepEqual(readReviewFindings(db, filters).map(row => row.finding_id), ids);
  }
  for (const filters of [
    { since: 'Sat, 03 Jan 2026 00:00:00 GMT' },
    { until: 'Fri, 02 Jan 2026 00:00:00 GMT' },
  ]) {
    assert.deepEqual(readReviewFindings(db, filters), []);
  }
  assert.throws(() => readReviewFindings(db, {
    since: 'Fri, 02 Jan 2026 01:00:00 +0100', until: '2026-01-02T00:00:00Z',
  }), /invalid finding filters/);
});

test('area filters trim padding inside Markdown code quotes and preserve path boundaries', t => {
  const { db, rows } = fixture(t);
  const update = db.prepare('UPDATE review_findings SET file=? WHERE finding_id=?');
  update.run('  ` modules/input.mjs `  ', rows[0].finding_id);
  update.run('` modules `', rows[1].finding_id);
  update.run('` modules_extra/input.mjs `', rows[2].finding_id);
  for (const area of ['modules', 'modules/']) {
    assert.deepEqual(readReviewFindings(db, { area }).map(row => row.finding_id),
      rows.slice(0, 2).map(row => row.finding_id));
  }
  assert.deepEqual(readReviewFindings(db, { area: 'modules/input.mjs' }).map(row => row.finding_id),
    [rows[0].finding_id]);
  assert.deepEqual(readReviewFindings(db, { area: 'mod%' }), []);
});

test('label states exclude lifecycle-only grades and expose conflicting labels as disputed', t => {
  const { db, rows } = fixture(t);
  assert.deepEqual(readReviewFindings(db, { labelState: 'graded' }).map(r => r.finding_id), [rows[0].finding_id]);
  assert.deepEqual(readReviewFindings(db, { labelState: 'disputed' }).map(r => r.finding_id), [rows[0].finding_id]);
  assert.equal(readReviewFindings(db, { labelState: 'ungraded' }).length, 2);
  assert.equal(readReviewFindings(db, { findingId: rows[1].finding_id })[0].grades[0].lifecycle, 1);
  for (const filters of [{ labelState: 'real' }, { blocking: 'false' }, { prNumbers: [] },
    { prNumbers: [0] }, { since: 'invalid' }, { since: '2026-02-01', until: '2026-01-01' }, { area: '../src' }]) {
    assert.throws(() => readReviewFindings(db, filters), /invalid finding filters/);
  }
});
