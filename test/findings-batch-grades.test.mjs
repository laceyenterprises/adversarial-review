import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { claimFindingBatches, settleFindingBatch, releaseFindingBatch, runFindingBatches } from '../src/findings-batch.mjs';
import { recordFindingGrade } from '../src/review-finding-grades.mjs';
import { readRemediationConsensus, validateFindingManifest } from '../src/finding-remediation-selection.mjs';
import { main } from '../bin/findings-batch-backfill.mjs';

const repo = 'sample/service', head = 'a'.repeat(40), day = '2026-01-02';
function fixture(t, advisory = false) {
  const rootDir = mkdtempSync(join(tmpdir(), 'batch-grades-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare("UPDATE schema_migrations SET applied_at='2026-01-01 00:00:00' WHERE id='20261024_simplicity_batch.sql'").run();
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref)
    VALUES (?,7,'2026-01-01','codex','open',?)`).run(repo, head);
  const key = { repo, prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: head });
  const finding = i => `- **Validate input ${i}**
  - **File:** \`src/input.mjs\`
  - **Lines:** ${i + 1}
  - **Problem:** Invalid input ${i} is accepted.
`;
  updateReviewerPassBodyCapture(rootDir, { ...key, verdict: 'request-changes', bodyMd:
    `## Blocking Issues\n${finding(0)}## Non-blocking Issues\n${Array.from({ length: 8 }, (_, i) => finding(i + 1)).join('')}
${advisory ? '## Simplicity and cost (advisory)\nReuse `src/input.mjs:validate` and delete the duplicate wrapper (~20 lines saved).' : ''}` });
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='1',body_captured_at='2026-01-01T00:00:00Z'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged',merged_at='2026-01-02T00:00:00Z'").run();
  const rows = db.prepare('SELECT * FROM review_findings ORDER BY ordinal').all();
  assert.equal(rows.length, 9);
  const grade = (row, taxonomyCode = 'tp.valid', extra = {}) => recordFindingGrade(db, {
    findingId: row.finding_id, sourceKey: `test:${row.finding_id}:${taxonomyCode}`,
    taxonomyCode, graderKind: 'grader', gradedHeadSha: head,
    gradedAt: '2026-01-01T01:00:00Z', evidence: { file: 'src/input.mjs', lines: [2, 2] }, ...extra,
  });
  return { db, rootDir, rows, grade };
}

// Independently mirrors the RGY-02 producer's sorted, compact JSON hash.
function manifest(rows) {
  const findings = rows.map(row => ({ finding_id: row.finding_id, head_sha: row.head_sha, pr_number: 7, repo }))
    .sort((a, b) => a.finding_id.localeCompare(b.finding_id));
  const sha256 = createHash('sha256').update(JSON.stringify({ findings, version: 1 })).digest('hex');
  return { version: 1, findings, sha256, heads: rows.length ? [{ repo, pr_number: 7, head_sha: head }] : [] };
}

test('manifest hashing matches the RGY-02 Python canonical JSON recipe for Unicode identities', () => {
  const row = { finding_id: 'synthetic-é-🧪', repo: 'sample/café', pr_number: 7, head_sha: head };
  const db = { prepare: () => ({ get: () => row }) };
  // Golden digest generated with Python json.dumps(sort_keys=True,
  // separators=(',', ':')) and hashlib.sha256, including ensure_ascii=True.
  assert.equal(validateFindingManifest(db, { version: 1, findings: [row],
    heads: [{ repo: row.repo, pr_number: 7, head_sha: head }],
    sha256: '501c202d49dac9a99a1499bdb8d98abbd593ba7aac6c4bc23300b9a595a06148' }).size, 1);
});

test('manifest claims only real pinned findings, enrolls selected blocking findings, and leaves the default drain intact', t => {
  const { db, rows, grade } = fixture(t, true);
  grade(rows[0]); // Explicitly selected blocking finding.
  grade(rows[1]);
  grade(rows[2], 'fp.misread-code');
  grade(rows[3], 'tp.valid', { graderKind: 'batch-remediator', interestedParty: true });
  grade(rows[4], 'ind.stale');
  grade(rows[5], 'life.superseded');
  grade(rows[6], 'tp.already-fixed-elsewhere', { graderKind: 'batch-remediator', gradedHeadSha: null });
  grade(rows[7]); // Real but outside the selection.
  const selected = manifest(rows.slice(0, 7));
  const batches = claimFindingBatches(db, day, { manifest: selected, batchSize: 2 });
  assert.equal(batches.length, 2);
  assert.ok(batches.every(b => b.manifest_sha256 === selected.sha256));
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_notes WHERE batch_id IS NOT NULL').get().n, 0);
  const owned = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id IS NOT NULL').all();
  assert.deepEqual(owned.map(r => r.finding_id).sort(), [rows[0], rows[1], rows[6]].map(r => r.finding_id).sort());
  assert.deepEqual(claimFindingBatches(db, day, { manifest: selected }), []);
  const defaults = claimFindingBatches(db, day);
  assert.ok(defaults.length);
  assert.ok(defaults.every(b => b.manifest_sha256 === null));
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_notes WHERE batch_id IS NOT NULL').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE batch_id IS NULL').get().n, 0);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  ensureReviewStateSchema(db);
  db.prepare("DELETE FROM schema_migrations WHERE id='20261108_findings_batch_manifest.sql'").run();
  ensureReviewStateSchema(db); // Additive migration is repeat-safe.
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batches WHERE manifest_sha256=?').get(selected.sha256).n, 2);
});

test('manifest validation refuses tampering, missing identities, duplicate IDs and changed pins before claims', t => {
  const { db, rows, grade } = fixture(t);
  grade(rows[1]);
  const value = manifest([rows[1]]);
  for (const modify of [
    m => { m.sha256 = 'b'.repeat(64); },
    m => { m.findings[0].head_sha = 'b'.repeat(40); },
    m => { m.findings[0].repo = 'sample/other'; },
    m => { m.findings[0].pr_number = 8; },
    m => { m.findings[0].finding_id = 'missing'; },
    m => { m.findings.push(m.findings[0]); },
    m => { m.heads = []; },
  ]) {
    const invalid = structuredClone(value);
    modify(invalid);
    assert.throws(() => claimFindingBatches(db, day, { manifest: invalid }), /manifest/);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_batches').get().n, 0);
  }
  assert.equal(validateFindingManifest(db, value).size, 1);
  assert.deepEqual(claimFindingBatches(db, day, { manifest: manifest([]) }), []);
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  assert.deepEqual(claimFindingBatches(db, day, { manifest: value }), []);
});

test('fallback consensus prefers independent reviewed-head evidence and excludes lifecycle, stale and interested observations', t => {
  const { db, rows, grade } = fixture(t);
  const row = rows[1], read = () => readRemediationConsensus(db, { findingId: row.finding_id, reviewedHeadSha: head }).label;
  grade(row, 'tp.valid', { gradedHeadSha: 'b'.repeat(40) });
  assert.equal(read(), 'indeterminate');
  grade(row, 'tp.already-fixed-elsewhere', { graderKind: 'batch-remediator', gradedHeadSha: null });
  assert.equal(read(), 'real');
  grade(row, 'life.pr-closed');
  grade(row, 'ind.stale');
  grade(row, 'fp.unclassified', { interestedParty: true });
  assert.equal(read(), 'real');
  grade(row, 'fp.misread-code', { gradedAt: '2026-01-02T00:00:00Z' });
  assert.equal(read(), 'false');
  grade(row, 'tp.out-of-scope', { graderKind: 'batch-remediator', gradedAt: '2026-01-03T00:00:00Z' });
  assert.equal(read(), 'false');
});

test('manifest CLI dispatches and collects only its own batches and retains main applicability instructions', async t => {
  const { db, rows, grade, rootDir } = fixture(t);
  // Leave an unrelated prepared batch pending.
  const [unrelated] = claimFindingBatches(db, day, { manifest: manifest([rows[2]]),
    readConsensus: () => ({ label: 'real' }) });
  grade(rows[1]);
  const value = manifest([rows[1]]);
  const path = join(rootDir, 'selection.json');
  writeFileSync(path, JSON.stringify(value));
  const prompts = [];
  const deps = { env: { HQ_ROOT: rootDir }, execFileImpl: async (_bin, args) => {
    prompts.push(readFileSync(args[args.indexOf('--prompt') + 1], 'utf8'));
    return { stdout: '{"launchRequestId":"synthetic-launch"}' };
  } };
  const args = ['--root', rootDir, '--db', join(rootDir, 'data', 'reviews.db'), '--concurrency', '1', '--manifest', path];
  await main(args, deps);
  await main(args, deps);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Only apply findings that are still applicable on current origin\/main/);
  assert.ok(prompts[0].includes(rows[1].finding_id));
  assert.ok(!prompts[0].includes(rows[2].finding_id));
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE batch_id IS NULL').get().n, 6);
  assert.equal(db.prepare('SELECT launch_id FROM finding_batches WHERE batch_id=?').get(unrelated.batch_id).launch_id, null);
  let calls = 0;
  // An empty selection must not launch the default backlog.
  await runFindingBatches({ db, rootDir, manifest: manifest([]), env: { HQ_ROOT: rootDir },
    execFileImpl: async () => { calls++; throw Error('unexpected dispatch'); } });
  assert.equal(calls, 0);
});

test('settlement records taxonomy grades atomically after PR verification, with no grade for requeued or released findings', t => {
  const { db, rows } = fixture(t);
  const [batch] = claimFindingBatches(db, day);
  const members = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=? ORDER BY finding_id').all(batch.batch_id);
  const reasons = ['stale-code-changed: Function replaced', 'already-fixed-in-23: Merged validation',
    'not-reproducible: Input rejected', 'out-of-scope-with-ticket: TASK-23 tracks repair',
    'false-positive: misread-code: Validation rejects input',
    'false-positive: Source PR closed without merge; reviewed changes did not land'];
  const result = { batchId: batch.batch_id, prNumber: 24, headSha: head,
    findings: members.map((row, i) => ({ findingId: row.finding_id,
      outcome: i === 6 ? 'applied' : 'dropped', reason: reasons[i] ?? (i === 6 ? 'Added validation' : 'unknown reason') })) };
  assert.throws(() => settleFindingBatch(db, batch, result), /batch-drop-pr-unverified/);
  const fixPrs = { 23: { state: 'MERGED' } };
  const pr = { state: 'OPEN', headRefOid: head, body: `Finding-Batch: ${batch.batch_id}` };
  assert.equal(settleFindingBatch(db, batch, result, pr, fixPrs), false);
  assert.equal(db.prepare('SELECT count(*) n FROM review_finding_grades').get().n, 0);
  pr.state = 'MERGED';
  db.exec(`CREATE TRIGGER fail_grade BEFORE INSERT ON review_finding_grades BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`);
  assert.throws(() => settleFindingBatch(db, batch, result, pr, fixPrs), /synthetic write failure/);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE outcome IS NOT NULL').get().n, 0);
  db.exec('DROP TRIGGER fail_grade');
  assert.equal(settleFindingBatch(db, batch, result, pr, fixPrs), true);
  const grades = db.prepare('SELECT * FROM review_finding_grades ORDER BY grade_id').all();
  assert.deepEqual(grades.map(g => g.taxonomy_code), ['ind.stale', 'tp.already-fixed-elsewhere',
    'ind.cannot-reproduce', 'tp.out-of-scope', 'fp.misread-code', 'life.pr-closed', 'tp.valid']);
  assert.ok(grades.every(g => g.grader_kind === 'batch-remediator' && g.graded_head_sha === null && g.attempt === 1));
  assert.equal(grades[0].label, 'indeterminate');
  assert.equal(grades[5].lifecycle, 1);
  assert.equal(grades[5].label, 'indeterminate');
  assert.equal(JSON.parse(grades[6].evidence_json).resultPr, 24);
  assert.equal(settleFindingBatch(db, batch, result, pr, fixPrs), true);
  assert.equal(db.prepare('SELECT count(*) n FROM review_finding_grades').get().n, 7);
  const [retry] = claimFindingBatches(db, day);
  releaseFindingBatch(db, retry, 'synthetic failure');
  assert.equal(db.prepare('SELECT count(*) n FROM review_finding_grades').get().n, 7);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE finding_id=?').get(rows[0].finding_id).n, 0);
});

test('consensus reader seam supports authoritative real-only admission', t => {
  const { db, rows } = fixture(t);
  const [batch] = claimFindingBatches(db, day, { manifest: manifest(rows),
    readConsensus: (_db, { findingId }) => ({ label: findingId === rows[1].finding_id ? 'real' : 'false' }) });
  assert.deepEqual(db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').all(batch.batch_id),
    [{ finding_id: rows[1].finding_id }]);
});

test('selected retries keep manifest provenance, advance attempt identity and never steal another owner', t => {
  const { db, rows, grade } = fixture(t);
  grade(rows[1]);
  const value = manifest([rows[1]]);
  const [first] = claimFindingBatches(db, day, { manifest: value });
  assert.deepEqual(claimFindingBatches(db, day, { manifest: manifest([rows[1], rows[2]]) }), []);
  releaseFindingBatch(db, first, 'synthetic preparation failure');
  const [retry] = claimFindingBatches(db, day, { manifest: value });
  assert.notEqual(retry.batch_id, first.batch_id);
  assert.equal(retry.manifest_sha256, value.sha256);
  const result = { batchId: retry.batch_id, findings: [
    { findingId: rows[1].finding_id, outcome: 'dropped', reason: 'stale-code-changed: Function replaced' },
  ] };
  settleFindingBatch(db, retry, result);
  const gradeRow = db.prepare("SELECT * FROM review_finding_grades WHERE grader_kind='batch-remediator'").get();
  assert.equal(gradeRow.attempt, 2);
  assert.equal(JSON.parse(gradeRow.evidence_json).manifestSha256, value.sha256);
  assert.deepEqual(claimFindingBatches(db, day, { manifest: value }), []);
});
