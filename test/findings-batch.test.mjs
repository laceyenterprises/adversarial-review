import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';

const repo = 'sample/service', head = 'a'.repeat(40);
const body = `## Blocking Issues
- None.
## Non-blocking Issues
- **Explain the result**
  - **File:** \`src/result.mjs\`
  - **Lines:** 2
  - **Problem:** The returned value lacks a description.
## Verdict
Comment only
`;
const note = 'Reuse `src/result.mjs:formatResult` and delete the duplicate wrapper (~20 lines saved).';
const advisory = `\n## Simplicity and cost (advisory)\n${note}\n`;
const adviceOnly = body.replace(/- \*\*Explain the result\*\*[\s\S]*?(?=## Verdict)/, '- None.\n') + advisory;
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'findings-batch-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare("UPDATE schema_migrations SET applied_at='2026-01-01 00:00:00' WHERE id='20261024_simplicity_batch.sql'").run();
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const pass = (attempt = 1, text = body, sha = head) => {
    const key = { repo, prNumber: 7, attemptNumber: attempt, passKind: 'first-pass' };
    const p = beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: sha });
    updateReviewerPassBodyCapture(rootDir, { ...key, bodyMd: text, verdict: 'comment-only' });
    db.prepare("UPDATE reviewer_passes SET gh_comment_id=?, body_captured_at=? WHERE pass_id=?")
      .run(String(attempt), `2026-01-01T00:00:0${attempt}Z`, p.pass_id);
    return p;
  };
  db.prepare("INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref) VALUES (?,7,?,'codex','open',?)")
    .run(repo, '2026-01-01T00:00:00Z', head);
  db.prepare("UPDATE reviewed_prs SET merged_at='2026-01-02T00:00:00Z'").run();
  return { rootDir, db, pass };
}

test('batch jobs own advisory-only and mixed feedback, and durably record applied or declined advice', async t => {
  const { claimFindingBatches, settleFindingBatch, runFindingBatches } = await import('../src/findings-batch.mjs');
  for (const mixed of [false, true]) for (const applied of [false, true]) {
    await t.test(`mixed=${mixed}, applied=${applied}`, async t => {
      const { rootDir, db, pass } = fixture(t);
      pass(1, mixed ? body + advisory : adviceOnly);
      assert.deepEqual(claimFindingBatches(db, '2026-01-02'), []);
      db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
      assert.deepEqual(claimFindingBatches(db, '2026-01-02'), []);
      db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
      let prompt;
      await runFindingBatches({ db, rootDir, env: { HQ_ROOT: rootDir }, day: '2026-01-02',
        execFileImpl: async (_bin, args) => {
          prompt = readFileSync(args[args.indexOf('--prompt') + 1], 'utf8');
          return { stdout: '{"launchRequestId":"fixture-launch"}' };
        } });
      const batch = db.prepare('SELECT * FROM finding_batches').get();
      assert.equal(batch.area, mixed ? 'src' : '_simplicity');
      assert.ok(prompt.includes(note));
      assert.match(prompt, /simplicityNoteApplied as true or false and a one-line reason/);
      assert.match(prompt, /reduces net lines or runtime cost\nwithout changing behavior/);
      assert.equal(db.prepare('SELECT count(*) n FROM review_findings').get().n, mixed ? 1 : 0);
      const notes = db.prepare('SELECT * FROM finding_batch_notes WHERE batch_id=?').all(batch.batch_id);
      assert.equal(notes.length, 1);
      const findings = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').all(batch.batch_id)
        .map(f => ({ findingId: f.finding_id, outcome: 'dropped', reason: 'Already fixed on main' }));
      const result = { batchId: batch.batch_id, prNumber: applied ? 8 : null, headSha: applied ? head : null,
        findings, simplicityNotes: [{ noteId: notes[0].note_id, simplicityNoteApplied: applied,
          reason: applied ? 'Reused formatter and removed 20 lines' : 'Current helper changes behavior' }] };
      assert.throws(() => settleFindingBatch(db, batch, { ...result, simplicityNotes: [] }), /invalid-advisory-manifest/);
      for (const invalid of [undefined, 'false', null]) {
        assert.throws(() => settleFindingBatch(db, batch, { ...result,
          simplicityNotes: [{ ...result.simplicityNotes[0], simplicityNoteApplied: invalid }] }), /invalid-advisory-outcome/);
      }
      assert.throws(() => settleFindingBatch(db, batch, { ...result,
        simplicityNotes: [{ ...result.simplicityNotes[0], noteId: 'foreign' }] }), /invalid-advisory-outcome/);
      assert.throws(() => settleFindingBatch(db, batch, { ...result,
        simplicityNotes: [{ ...result.simplicityNotes[0], reason: '' }] }), /invalid-advisory-outcome/);
      const pr = { state: 'OPEN', body: `Finding-Batch: ${batch.batch_id}` };
      if (applied) {
        assert.throws(() => settleFindingBatch(db, batch, result), /batch-pr-evidence-mismatch/);
        assert.equal(settleFindingBatch(db, batch, result, pr), false);
        assert.equal(db.prepare('SELECT result_json FROM finding_batches').get().result_json, null);
      }
      const dir = join(rootDir, 'data', 'finding-batches', batch.batch_id);
      writeFileSync(join(dir, 'outcomes.json'), JSON.stringify(result));
      let reads = 0;
      await runFindingBatches({ db, rootDir, env: { HQ_ROOT: rootDir }, resolutionOnly: true,
        fetchPr: async () => { reads++; return { ...pr, state: 'MERGED' }; } });
      assert.equal(reads, applied ? 1 : 0);
      const stored = db.prepare('SELECT completed_at,result_json FROM finding_batches').get();
      assert.ok(stored.completed_at);
      assert.deepEqual(JSON.parse(stored.result_json).simplicityNotes, result.simplicityNotes);
      assert.deepEqual(claimFindingBatches(db, '2026-01-03'), []);
      assert.equal(settleFindingBatch(db, batch, result), true);
    });
  }
});

test('advisory enrollment uses the final posted review, deduplicates, and survives a late receipt', async t => {
  const { rootDir, db, pass } = fixture(t);
  const { claimFindingBatches } = await import('../src/findings-batch.mjs');
  pass(1, adviceOnly);
  pass(2, adviceOnly.replace(note, 'Reuse `src/result.mjs:formatResult` (~10 lines saved).'));
  pass(3, body); // A later review with no advice supersedes both notes.
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [first] = claimFindingBatches(db, '2026-01-02');
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_notes WHERE batch_id=?').get(first.batch_id).n, 0);
  const p = pass(4, adviceOnly);
  const { persistReviewFindings } = await import('../src/review-finding-records.mjs');
  // Re-projecting an old duplicate must not steal ownership from the final pass.
  const oldPass = db.prepare('SELECT min(pass_id) id FROM reviewer_passes').get().id;
  persistReviewFindings(db, oldPass);
  db.prepare('UPDATE reviewer_passes SET gh_comment_id=NULL WHERE pass_id=?').run(p.pass_id);
  assert.deepEqual(claimFindingBatches(db, '2026-01-03'), []);
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='4' WHERE pass_id=?").run(p.pass_id);
  const other = openReviewStateDb(rootDir);
  try {
    const [batch] = claimFindingBatches(other, '2026-01-03');
    assert.equal(batch.area, '_simplicity');
    assert.deepEqual(claimFindingBatches(db, '2026-01-03'), []);
    persistReviewFindings(db, p.pass_id);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_notes WHERE batch_id=?').get(batch.batch_id).n, 1);
    pass(5, adviceOnly);
    assert.deepEqual(claimFindingBatches(db, '2026-01-04'), []);
  } finally { other.close(); }
});

test('mixed batches let advisories use cited paths outside the finding area', async t => {
  const { db, pass } = fixture(t);
  const { claimFindingBatches, findingBatchPrompt } = await import('../src/findings-batch.mjs');
  pass(1, body.replace('src/result.mjs', 'docs/result.md') + advisory);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [batch] = claimFindingBatches(db, '2026-01-02');
  assert.equal(batch.area, 'docs');
  const prompt = findingBatchPrompt(batch, [], 'outcomes.json', [{ simplicityNote: note }]);
  assert.match(prompt, /Work only in area "docs"/);
  assert.match(prompt, /Advisories may touch their cited files outside the finding area/);
  assert.match(prompt, /src\/result.mjs:formatResult/);
});

test('historical backfill cannot dispatch advice; recent merges and late metadata remain recoverable', async t => {
  const { db, pass } = fixture(t);
  const { claimFindingBatches } = await import('../src/findings-batch.mjs');
  const { backfillReviewFindings } = await import('../src/review-finding-records.mjs');
  pass(1, adviceOnly);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged',merged_at='2025-12-31T23:59:59Z'").run();
  backfillReviewFindings(db);
  assert.equal(db.prepare('SELECT dropped_reason FROM finding_batch_notes').get().dropped_reason, 'historical-merge');
  assert.deepEqual(claimFindingBatches(db, '2026-01-02'), []);
  // Unreadable timestamps cannot authorize a worker, and a refresh can repair them.
  for (const mergedAt of [null, 'not-a-timestamp']) {
    db.prepare('UPDATE reviewed_prs SET merged_at=?').run(mergedAt);
    assert.deepEqual(claimFindingBatches(db, '2026-01-02'), []);
    assert.equal(db.prepare('SELECT dropped_reason FROM finding_batch_notes').get().dropped_reason, 'merge-time-unverified');
  }
  db.prepare("UPDATE reviewed_prs SET merged_at='2026-01-02T00:00:00Z'").run();
  backfillReviewFindings(db);
  assert.equal(claimFindingBatches(db, '2026-01-02').length, 1);
});

test('lifecycle migration retires legacy pending advice once and preserves owned notes', async t => {
  const { db, pass } = fixture(t);
  // Reconstruct the schema immediately before this additive migration so the
  // upgrade is exercised against existing rows, not only an empty database.
  db.exec(`DROP TRIGGER finding_batch_notes_lifecycle; DROP TRIGGER finding_batch_notes_capture;
    DROP TRIGGER finding_batch_notes_assignment; DROP TRIGGER finding_batch_notes_receipt;
    DROP VIEW finding_batch_note_candidates; DROP VIEW finding_batch_note_dispositions;
    DROP INDEX finding_batch_notes_pending; ALTER TABLE finding_batch_notes DROP COLUMN dropped_reason;
    CREATE INDEX finding_batch_notes_pending ON finding_batch_notes(repo,pr_number) WHERE batch_id IS NULL;
    DELETE FROM schema_migrations WHERE id='20261024_simplicity_batch_lifecycle.sql';`);
  const original = readFileSync(new URL('../migrations/20261024_simplicity_batch.sql', import.meta.url), 'utf8');
  db.exec(original.slice(original.indexOf('CREATE VIEW finding_batch_note_candidates')));
  const owned = pass(1, adviceOnly);
  db.prepare("INSERT INTO finding_batches(batch_id,repo,area,day) VALUES ('legacy',?,'_simplicity','2025-12-31')").run(repo);
  db.prepare("UPDATE finding_batch_notes SET batch_id='legacy' WHERE pass_id=?").run(owned.pass_id);
  const pending = pass(2, adviceOnly.replace(note, 'Reuse `src/other.mjs` (10 lines saved).'));
  db.prepare("UPDATE reviewed_prs SET pr_state='merged',merged_at='2025-12-31T00:00:00Z'").run();
  ensureReviewStateSchema(db);
  const rows = db.prepare('SELECT pass_id,batch_id,dropped_reason FROM finding_batch_notes ORDER BY pass_id').all();
  assert.deepEqual(rows, [
    { pass_id: owned.pass_id, batch_id: 'legacy', dropped_reason: null },
    { pass_id: pending.pass_id, batch_id: null, dropped_reason: 'historical-merge' },
  ]);
  ensureReviewStateSchema(db);
  assert.deepEqual(db.prepare('SELECT pass_id,batch_id,dropped_reason FROM finding_batch_notes ORDER BY pass_id').all(), rows);
  const { claimFindingBatches } = await import('../src/findings-batch.mjs');
  assert.deepEqual(claimFindingBatches(db, '2026-01-02'), []);
});

test('note dispositions retire closed and superseded reviews, preserving assigned snapshots', async t => {
  const { db, pass } = fixture(t);
  const { claimFindingBatches } = await import('../src/findings-batch.mjs');
  const { persistReviewFindings } = await import('../src/review-finding-records.mjs');
  const old = pass(1, adviceOnly);
  db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
  assert.equal(db.prepare('SELECT dropped_reason FROM finding_batch_notes').get().dropped_reason, 'pr-closed-without-merge');
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  const current = pass(2, adviceOnly.replace(note, 'Reuse `src/result.mjs` (10 lines saved).'));
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  assert.equal(db.prepare('SELECT dropped_reason FROM finding_batch_notes WHERE pass_id=?').get(old.pass_id).dropped_reason,
    'superseded-final-review');
  const [batch] = claimFindingBatches(db, '2026-01-02');
  const assigned = db.prepare('SELECT * FROM finding_batch_notes WHERE pass_id=?').get(current.pass_id);
  assert.equal(assigned.batch_id, batch.batch_id);
  db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
  persistReviewFindings(db, current.pass_id);
  assert.deepEqual(db.prepare('SELECT * FROM finding_batch_notes WHERE pass_id=?').get(current.pass_id), assigned);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const duplicate = pass(3, adviceOnly.replace(note, 'Reuse `src/result.mjs` (10 lines saved).'));
  assert.equal(db.prepare('SELECT dropped_reason FROM finding_batch_notes WHERE pass_id=?').get(duplicate.pass_id).dropped_reason,
    'superseded-final-review');
});

test('advisory-only health includes waiting and fenced notes, launch errors and settlement', async t => {
  const { db, rootDir, pass } = fixture(t);
  const { claimFindingBatches, settleFindingBatch, runFindingBatches } = await import('../src/findings-batch.mjs');
  const { summarizeFindingBacklog } = await import('../src/findings-backlog.mjs');
  pass(1, adviceOnly);
  let [area] = summarizeFindingBacklog(db, Date.parse('2026-01-03T00:00:00Z')).areas;
  assert.equal(area.area, '_simplicity');
  assert.equal(area.size, 1);
  assert.equal(area.waitingForMerge, 1);
  assert.equal(area.oldestAt, '2026-01-01T00:00:01Z');
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [batch] = claimFindingBatches(db, '2026-01-02');
  await runFindingBatches({ db, rootDir, day: '2026-01-02', env: { HQ_ROOT: rootDir },
    execFileImpl: async () => { throw Error('launch failed'); }, logger: { warn() {} } });
  [area] = summarizeFindingBacklog(db).areas;
  assert.equal(area.inBatch, 1);
  assert.equal(area.waitingForMerge, 0);
  assert.equal(area.error, 'launch failed');
  const { note_id: noteId } = db.prepare('SELECT note_id FROM finding_batch_notes').get();
  const result = { batchId: batch.batch_id, findings: [], prNumber: 8, headSha: head,
    simplicityNotes: [{ noteId, simplicityNoteApplied: true, reason: 'Reuse the helper' }] };
  assert.equal(settleFindingBatch(db, batch, result, { state: 'CLOSED', body: `Finding-Batch: ${batch.batch_id}` }), false);
  assert.equal(summarizeFindingBacklog(db).areas[0].inBatch, 1);
  settleFindingBatch(db, batch, result, { state: 'MERGED', body: `Finding-Batch: ${batch.batch_id}` });
  assert.deepEqual(summarizeFindingBacklog(db).areas, []);
});

test('mixed settlement normalizes note whitespace and persists only validated fields', async t => {
  const { db, pass } = fixture(t);
  const { claimFindingBatches, settleFindingBatch } = await import('../src/findings-batch.mjs');
  pass(1, body + advisory);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [batch] = claimFindingBatches(db, '2026-01-02');
  const { finding_id: findingId } = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').get(batch.batch_id);
  const { note_id: noteId } = db.prepare('SELECT note_id FROM finding_batch_notes WHERE batch_id=?').get(batch.batch_id);
  const result = { batchId: batch.batch_id, prNumber: { unvalidated: true }, headSha: 'irrelevant', extra: 'omit me',
    findings: [{ findingId, outcome: 'dropped', reason: ' Already fixed ', extra: 'omit me' }],
    simplicityNotes: [{ noteId, simplicityNoteApplied: false, reason: ' Already\r\n fixed\t on main ', extra: 'omit me' }] };
  assert.equal(settleFindingBatch(db, batch, result), true);
  assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, 'dropped');
  const stored = JSON.parse(db.prepare('SELECT result_json FROM finding_batches').get().result_json);
  assert.deepEqual(stored, { batchId: batch.batch_id, prNumber: null, headSha: null,
    findings: [{ findingId, outcome: 'dropped', reason: 'Already fixed' }],
    simplicityNotes: [{ noteId, simplicityNoteApplied: false, reason: 'Already fixed on main' }] });
});

test('FINDINGSBATCH-01 capture enrolls only the final review, deduplicates and survives reopen', async t => {
  const { db, rootDir, pass } = fixture(t);
  const { captureReadyFindings } = await import('../src/findings-backlog.mjs');
  const oldBody = body.replace('result.mjs', 'old.mjs');
  pass(1, oldBody);
  captureReadyFindings({ rootDir, repo, prNumber: 7, headSha: head,
    version: createHash('sha256').update(oldBody).digest('hex'), count: 1 });
  pass(2, body + body.slice(body.indexOf('- **Explain'), body.indexOf('## Verdict')));
  const duplicated = body.replace('## Verdict', body.slice(body.indexOf('- **Explain'), body.indexOf('## Verdict')) + '## Verdict');
  const version = createHash('sha256').update(duplicated).digest('hex');
  const final = pass(3, duplicated);
  db.prepare("UPDATE reviewer_passes SET metadata_json='invalid' WHERE pass_id=?").run(final.pass_id);
  assert.throws(() => captureReadyFindings({ rootDir, repo, prNumber: 7, headSha: 'b'.repeat(40), version, count: 2 }));
  assert.throws(() => captureReadyFindings({ rootDir, repo, prNumber: 7, headSha: head, version: 'edited', count: 2 }));
  captureReadyFindings({ rootDir, repo, prNumber: 7, headSha: head, version, count: 2 });
  captureReadyFindings({ rootDir, repo, prNumber: 7, headSha: head, version, count: 2 });
  db.prepare("UPDATE reviewed_prs SET pr_state='merged' WHERE repo=?").run(repo);
  const reopened = openReviewStateDb(rootDir);
  try {
    const rows = reopened.prepare('SELECT b.*, f.file, f.lines FROM finding_backlog b JOIN review_findings f USING(finding_id) WHERE b.outcome IS NULL').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].area, 'src');
    assert.equal(rows[0].head_sha, head);
    assert.equal(rows[0].reviewer_family, 'codex');
    assert.equal(rows[0].file, '`src/result.mjs`');
    assert.equal(rows[0].lines, '2');
    assert.equal(reopened.prepare("SELECT reason FROM finding_backlog WHERE outcome='dropped'").get().reason,
      'superseded-final-review');
  } finally { reopened.close(); }
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
  assert.equal(db.prepare("SELECT count(*) n FROM finding_backlog WHERE reason='pr-closed-without-merge'").get().n, 1);
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE outcome IS NULL').get().n, 1);
  // The ordinary merged write also captures without any ready-to-merge call.
  db.prepare('DELETE FROM finding_backlog').run();
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 1);
});

test('FINDINGSBATCH-01 daily claims fence concurrent dispatch and outcomes require the merged batch PR', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { claimFindingBatches, settleFindingBatch, findingBatchPrompt, runFindingBatches, createFindingBatchTicker } = await import('../src/findings-batch.mjs');
  const [batch] = claimFindingBatches(db, '2026-01-02');
  const other = openReviewStateDb(rootDir);
  try { assert.deepEqual(claimFindingBatches(other, '2026-01-02'), []); }
  finally { other.close(); }
  assert.deepEqual(claimFindingBatches(db, '2026-01-03'), []);
  let launches = 0;
  const env = { HQ_ROOT: rootDir, HQ_PARENT_SESSION: 'fixture-session', HQ_PROJECT: 'fixture-project' };
  const execFileImpl = async (bin, args) => {
    assert.equal(bin, 'hq');
    assert.equal(args[args.indexOf('--priority') + 1], 'normal');
    assert.equal(args[args.indexOf('--idempotency-key') + 1], `findings-batch-${batch.batch_id}`);
    launches++;
    if (launches === 1) throw Error('lost receipt');
    return { stdout: '{"launchRequestId":"fixture-launch"}' };
  };
  await runFindingBatches({ db, rootDir, env, day: '2026-01-02', execFileImpl, logger: { warn() {} } });
  assert.equal(db.prepare('SELECT launch_id FROM finding_batches').get().launch_id, null);
  await runFindingBatches({ db, rootDir, env, day: '2026-01-02', execFileImpl });
  const ticker = createFindingBatchTicker({ db, rootDir, env, execFileImpl });
  await ticker.tick(Date.parse('2026-01-02T01:00:00Z'));
  await ticker.tick(Date.parse('2026-01-02T02:00:00Z'));
  assert.equal(launches, 2);
  const rows = db.prepare('SELECT * FROM finding_backlog WHERE batch_id=?').all(batch.batch_id);
  assert.throws(() => db.prepare("UPDATE finding_backlog SET outcome='dropped'").run());
  const prompt = findingBatchPrompt(batch, rows, 'outcomes.json');
  assert.match(prompt, /current origin\/main/);
  assert.match(prompt, /no cited line or behaviour/);
  assert.match(prompt, /one PR/);
  const result = { batchId: batch.batch_id, prNumber: 8, headSha: head,
    findings: rows.map(r => ({ findingId: r.finding_id, outcome: 'applied', reason: 'Documented return value' })) };
  const pr = { state: 'MERGED', headRefOid: head, body: `Finding-Batch: ${batch.batch_id}` };
  assert.throws(() => settleFindingBatch(db, batch, { ...result, findings: [] }, pr));
  assert.throws(() => settleFindingBatch(db, batch, { ...result, batchId: 'foreign' }, pr));
  assert.throws(() => settleFindingBatch(db, batch, result, { ...pr, body: 'unrelated batch' }));
  assert.equal(settleFindingBatch(db, batch, result, { ...pr, state: 'OPEN' }), false);
  assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
  assert.equal(settleFindingBatch(db, batch, result, { ...pr, headRefOid: 'b'.repeat(40) }), true);
  assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, 'applied');
  const { readReviewFindings } = await import('../src/review-finding-records.mjs');
  assert.equal(readReviewFindings(db)[0].backlog_outcome, 'applied');
  assert.equal(readReviewFindings(db)[0].backlog_result_pr, 8);
  // New findings cannot launch another worker for the area on the same day.
  pass(2, body.replace('Explain the result', 'Explain another result'));
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  assert.deepEqual(claimFindingBatches(db, '2026-01-02'), []);
  const [next] = claimFindingBatches(db, '2026-01-03');
  const findingId = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').get(next.batch_id).finding_id;
  assert.throws(() => settleFindingBatch(db, next, { batchId: next.batch_id,
    findings: [{ findingId, outcome: 'dropped', reason: '' }] }));
  settleFindingBatch(db, next, { batchId: next.batch_id,
    findings: [{ findingId, outcome: 'dropped', reason: 'Already described on current main' }] });
  assert.equal(db.prepare('SELECT reason FROM finding_backlog WHERE batch_id=?').get(next.batch_id).reason,
    'Already described on current main');
});

test('FINDINGSBATCH-01 report exposes size and oldest age per area and reports unavailable schema', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { main } = await import('../bin/review-findings.mjs');
  db.prepare("UPDATE finding_backlog SET captured_at='2026-01-01T00:00:00Z'").run();
  const report = main(['backlog', '--db', join(rootDir, 'data', 'reviews.db')]);
  assert.equal(report.available, true);
  assert.equal(report.areas[0].area, 'src');
  assert.equal(report.areas[0].size, 1);
  assert.equal(report.areas[0].oldestAt, '2026-01-01T00:00:00Z');
  const { summarizeFindingBacklog } = await import('../src/findings-backlog.mjs');
  assert.equal(summarizeFindingBacklog(db, Date.parse('2026-01-03T00:00:00Z')).areas[0].oldestAgeMs, 172800000);
  db.prepare("UPDATE finding_backlog SET outcome='dropped',reason='No longer applies'").run();
  assert.deepEqual(main(['backlog', '--db', join(rootDir, 'data', 'reviews.db')]).areas, []);
  db.exec('DROP TRIGGER finding_backlog_on_merge; DROP TRIGGER finding_backlog_late_capture; DROP TRIGGER finding_backlog_late_receipt; DROP TRIGGER finding_backlog_on_close; DROP TABLE finding_backlog');
  assert.equal(summarizeFindingBacklog(db).available, false);
});

test('FINDINGSBATCH-01 default PR reader collects merged evidence through gh and preserves unresolved batches', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { claimFindingBatches, runFindingBatches } = await import('../src/findings-batch.mjs');
  const [batch] = claimFindingBatches(db, '2026-01-02');
  const rows = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').all(batch.batch_id);
  const dir = join(rootDir, 'data', 'finding-batches', batch.batch_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ batchId: batch.batch_id, prNumber: 8, headSha: head,
    findings: rows.map(r => ({ findingId: r.finding_id, outcome: 'applied', reason: 'Documented return value' })) }));
  const env = { HQ_ROOT: rootDir, GH_TOKEN: 'fixture-only' };
  let response;
  let reads = 0;
  const options = { db, rootDir, env, day: '2026-01-02', logger: { warn() {} },
    execFileImpl: async (bin, args, opts) => {
      reads++;
      assert.equal(bin, 'gh');
      assert.deepEqual(args, ['pr', 'view', '8', '--repo', repo, '--json', 'state,mergedAt,body,headRefOid']);
      assert.equal(opts.env.GH_TOKEN, env.GH_TOKEN);
      assert.equal(opts.timeout, 15_000);
      if (response instanceof Error) throw response;
      return { stdout: JSON.stringify(response) };
    } };
  for (const invalidBody of ['', `Finding-Batch: ${batch.batch_id}extra`, `Finding-Batch: foreign`]) {
    response = { state: 'MERGED', body: invalidBody };
    await runFindingBatches(options);
    assert.equal(db.prepare('SELECT error FROM finding_batches').get().error, 'batch-pr-evidence-mismatch');
    assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
  }
  response = Error('permission denied');
  await runFindingBatches(options);
  assert.equal(db.prepare('SELECT error FROM finding_batches').get().error, 'permission denied');
  assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
  for (const marker of [`  Finding-Batch: ${batch.batch_id}  `,
    `**Finding-Batch: ${batch.batch_id}**`, ` <!-- Finding-Batch: ${batch.batch_id} --> `]) {
    response = { state: 'OPEN', headRefOid: head, body: `Batch repairs\r\n${marker}\r\n` };
    await runFindingBatches(options);
    assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
    // Valid evidence clears a prior read/validation error without settling outcomes.
    assert.equal(db.prepare('SELECT error FROM finding_batches').get().error, null);
    assert.equal(db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
    db.prepare("UPDATE finding_batches SET error='prior validation error'").run();
  }
  response = { ...response, state: 'MERGED', mergedAt: '2026-01-02T04:00:00Z', headRefOid: 'b'.repeat(40) };
  await runFindingBatches(options);
  assert.equal(reads, 8);
  assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, 'applied');
  assert.equal(db.prepare('SELECT result_pr FROM finding_backlog').get().result_pr, 8);
  assert.equal(db.prepare('SELECT error FROM finding_batches').get().error, null);
  assert.ok(db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
});

test('FINDINGSBATCH-01 ticker resumes claimed batches next poll after a fleet stop clears', async t => {
  for (const haltFile of ['active.json', 'merge-kill.json']) await t.test(haltFile, async t => {
    const { rootDir, db, pass } = fixture(t);
    pass(1, body.replace('## Verdict', body.slice(body.indexOf('- **Explain'), body.indexOf('## Verdict'))
      .replace('src/result.mjs', 'docs/result.md') + '## Verdict'));
    db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
    const haltDir = join(rootDir, 'control', 'halt');
    mkdirSync(haltDir, { recursive: true });
    const haltPath = join(haltDir, haltFile);
    const { createFindingBatchTicker } = await import('../src/findings-batch.mjs');
    let sweeps = 0;
    const keys = [];
    const ticker = createFindingBatchTicker({ rootDir, env: { HQ_ROOT: rootDir },
      db: { transaction(fn) { sweeps++; return db.transaction(fn); }, prepare: (...args) => db.prepare(...args) },
      execFileImpl: async (bin, args) => {
        keys.push(args[args.indexOf('--idempotency-key') + 1]);
        // Engage the stop after one dispatch, leaving the other claimed batch pending.
        if (keys.length === 1) writeFileSync(haltPath, '{}');
        return { stdout: JSON.stringify({ launchRequestId: `fixture-launch-${keys.length}` }) };
      } });
    const now = Date.parse('2026-01-02T01:00:00Z');
    await ticker.tick(now);
    const batches = db.prepare('SELECT batch_id,launch_id FROM finding_batches').all();
    assert.equal(batches.length, 2);
    assert.equal(batches.filter(b => b.launch_id === null).length, 1);
    await ticker.tick(now + 30_000);
    assert.equal(keys.length, 1);
    rmSync(haltPath);
    await ticker.tick(now + 60_000);
    assert.equal(keys.length, 2);
    assert.deepEqual(new Set(keys), new Set(batches.map(b => `findings-batch-${b.batch_id}`)));
    assert.equal(db.prepare('SELECT count(*) n FROM finding_batches WHERE launch_id IS NULL').get().n, 0);
    assert.equal(sweeps, 3);
    await ticker.tick(now + 90_000);
    assert.equal(sweeps, 3);
  });
});

test('FINDINGSBATCH-01 ticker retries failed startup and fences overlapping polls until success', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { createFindingBatchTicker } = await import('../src/findings-batch.mjs');
  let transactions = 0, launches = 0, finish;
  const ticker = createFindingBatchTicker({ rootDir,
    db: { transaction(fn) {
      transactions++;
      if (transactions === 1) throw Error('SQLITE_BUSY');
      return db.transaction(fn);
    }, prepare: (...args) => db.prepare(...args) },
    env: { HQ_ROOT: rootDir }, execFileImpl: async () => {
      launches++;
      await new Promise(resolve => { finish = resolve; });
      return { stdout: '{"launchRequestId":"fixture-launch"}' };
    } });
  const now = Date.parse('2026-01-02T01:00:00Z');
  await assert.rejects(ticker.tick(now), /SQLITE_BUSY/);
  const retry = ticker.tick(now + 30_000);
  await ticker.tick(now + 60_000);
  assert.equal(transactions, 2);
  assert.equal(launches, 1);
  finish();
  await retry;
  await ticker.tick(now + 90_000);
  assert.equal(transactions, 2);
  await ticker.tick(Date.parse('2026-01-03T00:00:00Z'));
  assert.equal(transactions, 3);
  assert.equal(launches, 1);
});

test('FINDINGSBATCH-01 hourly settlement clears mixed outcomes without claiming or dispatching', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass(1, body.replace('## Verdict', body.slice(body.indexOf('- **Explain'), body.indexOf('## Verdict'))
    .replace('Explain the result', 'Explain dropped result') + '## Verdict'));
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { createFindingBatchTicker } = await import('../src/findings-batch.mjs');
  let launches = 0, reads = 0, merged = false;
  const ticker = createFindingBatchTicker({ rootDir, db, env: { HQ_ROOT: rootDir },
    execFileImpl: async () => { launches++; return { stdout: '{"launchRequestId":"fixture-launch"}' }; },
    fetchPr: async () => {
      reads++;
      return { state: merged ? 'MERGED' : 'OPEN', body: `Finding-Batch: ${batch.batch_id}` };
    } });
  const now = Date.parse('2026-01-02T01:00:00Z');
  await ticker.tick(now);
  const batch = db.prepare('SELECT * FROM finding_batches').get();
  const rows = db.prepare('SELECT finding_id FROM finding_backlog ORDER BY finding_id').all();
  const dir = join(rootDir, 'data', 'finding-batches', batch.batch_id);
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ batchId: batch.batch_id, prNumber: 8, headSha: head,
    findings: rows.map((r, i) => ({ findingId: r.finding_id, outcome: i ? 'dropped' : 'applied', reason: 'Checked current main' })) }));
  await ticker.tick(now + 3600000);
  assert.equal(reads, 1);
  assert.equal(db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
  merged = true;
  // A new area must wait for the daily claim, even when hourly settlement runs.
  pass(2, body.replace('src/result.mjs', 'docs/result.md'));
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  await ticker.tick(now + 3600001);
  assert.equal(reads, 1);
  await ticker.tick(now + 7200000);
  assert.equal(reads, 2);
  assert.equal(launches, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batches').get().n, 1);
  assert.ok(db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
  const outcomes = db.prepare('SELECT outcome,result_pr FROM finding_backlog WHERE batch_id=? ORDER BY finding_id').all(batch.batch_id);
  assert.deepEqual(outcomes, [{ outcome: 'applied', result_pr: 8 }, { outcome: 'dropped', result_pr: null }]);
  await ticker.tick(Date.parse('2026-01-03T00:00:00Z'));
  assert.equal(launches, 2);
});
