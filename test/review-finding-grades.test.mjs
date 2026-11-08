import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { persistReviewFindings } from '../src/review-finding-records.mjs';
import { reviewerPromptProvenance, buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { persistHostedReviewerExecution } from '../src/reviewer-execution-pass.mjs';
import { GRADE_TAXONOMY, backlogGradeCode, backfillFindingGrades, recordFindingGrade, readFindingGrades } from '../src/review-finding-grades.mjs';
import { main } from '../bin/review-grades.mjs';

const at = '2026-01-01T00:00:00Z';
const body = `## Blocking Issues
- **Validate input**
  - **Category:** correctness
  - **File:** \`input.mjs\`
  - **Lines:** 2
  - **Problem:** Invalid input is accepted.
## Non-blocking Issues
- None.
`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-grades-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = { repo: 'sample/service', prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  const pass = beginReviewerPass(root, { ...key, reviewerClass: 'codex', headSha: 'a'.repeat(40) });
  updateReviewerPassBodyCapture(root, { ...key, bodyMd: body, verdict: 'request-changes' });
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  const finding = db.prepare('SELECT * FROM review_findings').get();
  return { root, key, pass, db, finding };
}
function grade(finding, extra = {}) {
  return { findingId: finding.finding_id, sourceKey: 'synthetic-grade', taxonomyCode: 'tp.valid',
    graderKind: 'grader', evidence: { file: 'input.mjs', lines: [2, 2] }, gradedAt: at, ...extra };
}

test('migration is repeatable, retains grades and enforces taxonomy at storage and API boundaries', t => {
  const { db, finding } = fixture(t);
  assert.equal(recordFindingGrade(db, grade(finding)), 1);
  assert.equal(recordFindingGrade(db, grade(finding)), 0);
  ensureReviewStateSchema(db);
  db.prepare("DELETE FROM schema_migrations WHERE id='20261108_review_finding_grades.sql'").run();
  ensureReviewStateSchema(db);
  assert.equal(readFindingGrades(db).length, 1);
  for (const [taxonomyCode, label] of Object.entries(GRADE_TAXONOMY)) {
    recordFindingGrade(db, grade(finding, { sourceKey: taxonomyCode, taxonomyCode, label: label ?? 'real' }));
  }
  for (const extra of [{ taxonomyCode: 'fp.invented' }, { label: 'unknown' }, { taxonomyCode: 'fp.duplicate', label: 'real' },
    { confidence: 1.1 }, { costUsd: -1 }, { attempt: 0 }, { evidence: {} }, { lifecycle: true }, { promptDigest: 'version-1' }, { interestedParty: 'false' }, { gradedHeadSha: 'main' }]) {
    assert.throws(() => recordFindingGrade(db, grade(finding, extra)), /invalid finding grade/);
  }
  assert.throws(() => db.prepare("UPDATE review_finding_grades SET taxonomy_code='unknown'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE review_finding_grades SET label='false' WHERE taxonomy_code='tp.valid'").run(), /CHECK/);
});

test('backlog mapping preserves lifecycle and ambiguous false-positive distinctions', t => {
  const { db, finding } = fixture(t);
  db.prepare(`INSERT INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area,outcome,reason,result_pr)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(finding.finding_id, 'sample/service', 7, finding.head_sha,
    finding.content_sha256, 'codex', 'src', 'applied', 'Added input validation', 8);
  const cases = [
    ['applied', 'Added input validation', 'tp.valid'],
    ['dropped', 'already-fixed-in-8: Merged validation fix', 'tp.already-fixed-elsewhere'],
    ['dropped', 'out-of-scope-with-ticket: TRACK-1', 'tp.out-of-scope'],
    ['dropped', 'false-positive: Source PR closed without merge; reviewed changes did not land', 'life.pr-closed'],
    ['dropped', 'stale-code-changed: Final posted review superseded this finding', 'life.superseded'],
    ['dropped', 'stale-code-changed: Module removed', 'ind.stale'],
    ['dropped', 'not-reproducible: Fixture passes', 'ind.cannot-reproduce'],
    ['dropped', 'false-positive: The existing branch handles this', 'fp.unclassified'],
    ['dropped', 'false-positive: Duplicate of finding 2', 'fp.duplicate'],
    ['dropped', 'false-positive: Misread code: A guard exists', 'fp.misread-code'],
    ['dropped', 'false-positive: Speculative claim without a reachable path', 'fp.speculative'],
    ...['misread-code', 'hallucinated-symbol', 'wrong-spec', 'speculative', 'duplicate'].map(code =>
      ['dropped', `false-positive: ${code}: Synthetic evidence`, `fp.${code}`]),
  ];
  for (const [outcome, reason, code] of cases) {
    assert.equal(backlogGradeCode(outcome, reason), code);
    db.prepare('UPDATE finding_backlog SET outcome=?,reason=? WHERE finding_id=?').run(outcome, reason, finding.finding_id);
    assert.equal(backfillFindingGrades(db).inserted, 1);
    assert.equal(backfillFindingGrades(db).inserted, 0);
    const row = readFindingGrades(db).at(-1);
    assert.equal(row.taxonomy_code, code);
    assert.equal(row.lifecycle, Number(code.startsWith('life.')));
    assert.equal(row.grader_kind, row.lifecycle ? 'lifecycle' : 'batch-remediator');
    assert.equal(row.graded_head_sha, null);
  }
  assert.equal(backlogGradeCode('dropped', 'False positive - misread-code: Incorrect reading'), 'fp.misread-code');
  assert.equal(backlogGradeCode('dropped', 'already fixed in #8: Merged fix'), 'tp.already-fixed-elsewhere');
  assert.equal(backlogGradeCode('dropped', 'pr-closed-without-merge'), 'life.pr-closed');
  assert.equal(backlogGradeCode('dropped', 'superseded-final-review'), 'life.superseded');
  assert.equal(backlogGradeCode('dropped', 'batch-retry-exhausted: No result'), null);
  assert.equal(readFindingGrades(db).length, cases.length);
});

test('backfill retains separate remediation and withdrawal sources including commentless remediator disputes', t => {
  const { db, finding } = fixture(t);
  const reply = 'b'.repeat(64);
  db.prepare(`INSERT INTO review_finding_replies(reply_id,job_id,round_number,start_head_sha,published_head_sha,payload_json)
    VALUES (?,'synthetic-job',1,?,?,'{}')`).run(reply, finding.head_sha, 'c'.repeat(40));
  db.prepare(`INSERT INTO review_finding_remediations(finding_id,reply_id,commit_sha,reason)
    VALUES (?,?,?,'overlapping-diff')`).run(finding.finding_id, reply, 'c'.repeat(40));
  db.prepare(`INSERT INTO review_finding_disputes VALUES (?,?,?,?,'withdrawn-by-hammer',?,1,0)`)
    .run(finding.finding_id, finding.hammer_identity, finding.head_sha, 'synthetic-comment', 'd'.repeat(64));
  db.prepare(`INSERT INTO ham_finding_disputes(repo,pr_number,identity,head_sha,finding_reviewed_head,resolution,reply_id,resolved_at)
    VALUES ('sample/service',7,?,?,?,'withdrawn-by-remediator',?,?)`)
    .run(finding.hammer_identity, finding.head_sha, finding.head_sha, reply, at);
  assert.equal(backfillFindingGrades(db).inserted, 3);
  assert.equal(backfillFindingGrades(db).inserted, 0);
  let rows = readFindingGrades(db);
  assert.deepEqual(rows.map(r => [r.grader_kind, r.label, r.interested_party]),
    [['remediator', 'real', 0], ['hammer', 'false', 1], ['remediator', 'false', 1]]);
  db.prepare("UPDATE review_finding_remediations SET reason='disputed-with-evidence',commit_sha=NULL").run();
  assert.equal(backfillFindingGrades(db).inserted, 1);
  rows = readFindingGrades(db);
  assert.equal(rows.at(-1).interested_party, 1);
  assert.equal(rows.at(-1).graded_head_sha, finding.head_sha);
  for (const row of rows) assert.equal(row.evidence_sha256,
    createHash('sha256').update(row.evidence_json).digest('hex'));
});

test('resolved stage prompt digest and harness survive pass metadata and finding projection updates', t => {
  const { db, root, key, pass } = fixture(t);
  const prompt = buildPromptForReviewerModel('codex', '+synthetic diff', 'context', { promptStage: 'last' });
  const provenance = reviewerPromptProvenance(prompt, { promptStage: 'last' });
  assert.equal(provenance.promptDigest, createHash('sha256').update(prompt).digest('hex'));
  assert.notEqual(provenance.promptDigest, reviewerPromptProvenance(`${prompt}\n`).promptDigest);
  assert.equal(reviewerPromptProvenance('custom rubric', { promptOverride: true }).promptSet, null);
  const execution = { harness: 'native', model: 'synthetic-model', effort: 'high', ...provenance };
  assert.equal(persistHostedReviewerExecution({ rootDir: root, ...key, reviewerClass: 'codex',
    reviewDbAttemptNumber: 1, execution }), true);
  persistReviewFindings(db, pass.pass_id);
  let row = db.prepare('SELECT * FROM review_findings').get();
  assert.equal(row.reviewer_harness, 'native');
  assert.equal(row.prompt_set, provenance.promptSet);
  assert.equal(row.prompt_digest, provenance.promptDigest);
  assert.equal(row.prompt_stage, 'last');
  const metadata = JSON.parse(db.prepare('SELECT metadata_json FROM reviewer_passes').get().metadata_json);
  metadata.reviewerExecution = { ...execution, promptDigest: null, promptDigests: [provenance.promptDigest] };
  db.prepare('UPDATE reviewer_passes SET metadata_json=?').run(JSON.stringify(metadata));
  row = db.prepare('SELECT * FROM review_findings').get();
  assert.equal(row.prompt_digest, null);
  assert.deepEqual(JSON.parse(row.prompt_digests_json), [provenance.promptDigest]);
});

test('show/export use explicit database and deterministic grade cursor without writes', t => {
  const { db, root, finding } = fixture(t);
  recordFindingGrade(db, grade(finding));
  recordFindingGrade(db, grade(finding, { sourceKey: 'second', taxonomyCode: 'fp.unclassified' }));
  const args = ['--db', join(root, 'data', 'reviews.db')];
  let output = '';
  const first = main(['show', ...args, '--finding-id', finding.finding_id, '--limit', '1'], s => { output += s; });
  assert.equal(JSON.parse(output).grades.length, 1);
  output = '';
  main(['export', ...args, '--after-grade-id', String(first.nextCursor)], s => { output += s; });
  assert.equal(JSON.parse(output).source_key, 'second');
  assert.equal(readFindingGrades(db, { repo: 'other/service' }).length, 0);
  assert.throws(() => main(['show']), /--db is required/);
  assert.throws(() => main(['show', ...args, '--limit', '5001']), /invalid/);
});
