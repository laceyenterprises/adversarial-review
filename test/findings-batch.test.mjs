import './helpers/dispatch-read-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { resetLoadAwareTimeoutCachesForTesting } from '../src/load-aware-timeout.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';

const fixtureNow = Date.parse('2026-01-02T00:00:00Z');

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
  db.transaction(() => ensureReviewStateSchema(db))();
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

function succeededPreparation(launchRequestId) {
  return { stdout: JSON.stringify({ launchRequestId, repo, status: 'succeeded', terminal: true, succeeded: true }) };
}

test('batch jobs own advisory-only and mixed feedback, and durably record applied or declined advice', async t => {
  const { claimFindingBatches, settleFindingBatch, runFindingBatches } = await import('../src/findings-batch.mjs');
  for (const mixed of [false, true]) for (const applied of [false, true]) {
    await t.test(`mixed=${mixed}, applied=${applied}`, async t => {
      const { rootDir, db, pass } = fixture(t);
      pass(1, mixed ? body + advisory : adviceOnly);
      assert.deepEqual(claimFindingBatches(db, '2026-01-02', { now: fixtureNow }), []);
      db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
      assert.deepEqual(claimFindingBatches(db, '2026-01-02', { now: fixtureNow }), []);
      db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
      let prompt;
      await runFindingBatches({ now: fixtureNow, db, rootDir, env: { HQ_ROOT: rootDir }, day: '2026-01-02',
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
        .map(f => ({ findingId: f.finding_id, outcome: 'dropped', reason: 'not-reproducible: Already fixed on main' }));
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
      await runFindingBatches({ now: fixtureNow, db, rootDir, env: { HQ_ROOT: rootDir }, resolutionOnly: true,
        execFileImpl: async () => succeededPreparation(batch.launch_id),
        fetchPr: async () => { reads++; return { ...pr, state: 'MERGED' }; } });
      assert.equal(reads, applied ? 1 : 0);
      const stored = db.prepare('SELECT completed_at,result_json FROM finding_batches').get();
      assert.ok(stored.completed_at);
      const grades = db.prepare('SELECT grader_kind,taxonomy_code FROM review_finding_grades').all();
      assert.deepEqual(grades, mixed ? [{ grader_kind: 'batch-remediator', taxonomy_code: 'ind.cannot-reproduce' }] : []);
      assert.deepEqual(JSON.parse(stored.result_json).simplicityNotes, result.simplicityNotes);
      assert.deepEqual(claimFindingBatches(db, '2026-01-03', { now: fixtureNow }), []);
      assert.equal(settleFindingBatch(db, batch, result), true);
      assert.equal(db.prepare('SELECT count(*) n FROM review_finding_grades').get().n, mixed ? 1 : 0);
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
  const [first] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_notes WHERE batch_id=?').get(first.batch_id).n, 0);
  const p = pass(4, adviceOnly);
  const { persistReviewFindings } = await import('../src/review-finding-records.mjs');
  // Re-projecting an old duplicate must not steal ownership from the final pass.
  const oldPass = db.prepare('SELECT min(pass_id) id FROM reviewer_passes').get().id;
  persistReviewFindings(db, oldPass);
  db.prepare('UPDATE reviewer_passes SET gh_comment_id=NULL WHERE pass_id=?').run(p.pass_id);
  assert.deepEqual(claimFindingBatches(db, '2026-01-03', { now: fixtureNow }), []);
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='4' WHERE pass_id=?").run(p.pass_id);
  const other = openReviewStateDb(rootDir);
  try {
    const [batch] = claimFindingBatches(other, '2026-01-03', { now: fixtureNow });
    assert.equal(batch.area, '_simplicity');
    assert.deepEqual(claimFindingBatches(db, '2026-01-03', { now: fixtureNow }), []);
    persistReviewFindings(db, p.pass_id);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_batch_notes WHERE batch_id=?').get(batch.batch_id).n, 1);
    pass(5, adviceOnly);
    assert.deepEqual(claimFindingBatches(db, '2026-01-04', { now: fixtureNow }), []);
  } finally { other.close(); }
});

test('mixed batches let advisories use cited paths outside the finding area', async t => {
  const { db, pass } = fixture(t);
  const { claimFindingBatches, findingBatchPrompt } = await import('../src/findings-batch.mjs');
  pass(1, body.replace('src/result.mjs', 'docs/result.md') + advisory);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [batch] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
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
  assert.deepEqual(claimFindingBatches(db, '2026-01-02', { now: fixtureNow }), []);
  // Unreadable timestamps cannot authorize a worker, and a refresh can repair them.
  for (const mergedAt of [null, 'not-a-timestamp']) {
    db.prepare('UPDATE reviewed_prs SET merged_at=?').run(mergedAt);
    assert.deepEqual(claimFindingBatches(db, '2026-01-02', { now: fixtureNow }), []);
    assert.equal(db.prepare('SELECT dropped_reason FROM finding_batch_notes').get().dropped_reason, 'merge-time-unverified');
  }
  db.prepare("UPDATE reviewed_prs SET merged_at='2026-01-02T00:00:00Z'").run();
  backfillReviewFindings(db);
  assert.equal(claimFindingBatches(db, '2026-01-02', { now: fixtureNow }).length, 1);
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
  assert.deepEqual(claimFindingBatches(db, '2026-01-02', { now: fixtureNow }), []);
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
  const [batch] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
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
  const [batch] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
  await runFindingBatches({ now: fixtureNow, db, rootDir, day: '2026-01-02', env: { HQ_ROOT: rootDir },
    readLaunches: async () => ({ ok: true, rows: [] }),
    execFileImpl: async () => { throw Error('launch failed'); }, logger: { warn() {} } });
  [area] = summarizeFindingBacklog(db, fixtureNow).areas;
  assert.equal(area.inBatch, 1);
  assert.equal(area.waitingForMerge, 0);
  assert.equal(area.error, 'batch-dispatch-retryable: launch failed');
  const { note_id: noteId } = db.prepare('SELECT note_id FROM finding_batch_notes').get();
  const result = { batchId: batch.batch_id, findings: [], prNumber: 8, headSha: head,
    simplicityNotes: [{ noteId, simplicityNoteApplied: true, reason: 'Reuse the helper' }] };
  assert.equal(settleFindingBatch(db, batch, result, { state: 'CLOSED', body: `Finding-Batch: ${batch.batch_id}` }), false);
  assert.equal(summarizeFindingBacklog(db, fixtureNow).areas[0].inBatch, 1);
  settleFindingBatch(db, batch, result, { state: 'MERGED', body: `Finding-Batch: ${batch.batch_id}` });
  assert.deepEqual(summarizeFindingBacklog(db, fixtureNow).areas, []);
});

test('a preparation dispatch timeout adopts its scoped launch and settles the batch', async t => {
  const { rootDir, db, pass } = fixture(t);
  const { runFindingBatches } = await import('../src/findings-batch.mjs');
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const options = { rootDir, db, now: fixtureNow, day: '2026-01-02', env: { HQ_ROOT: rootDir },
    logger: { warn() {} },
    execFileImpl: async () => { throw Object.assign(Error('dispatch timed out'), { killed: true, signal: 'SIGTERM' }); },
    readLaunches: async ({ idempotencyKey, repo: targetRepo, projectRef }) => {
      const { batch_id: batchId } = db.prepare('SELECT batch_id FROM finding_batches').get();
      assert.equal(idempotencyKey, `findings-batch-${batchId}`);
      assert.equal(targetRepo, repo);
      assert.equal(projectRef, 'adversarial-merge-authority');
      return { ok: true, rows: [{ idempotency_key: idempotencyKey, launch_request_id: 'fixture-lost-receipt',
        ticket_ref: `FINDINGS-${batchId}`, target_repo: repo, status: 'succeeded' }] };
    } };
  await runFindingBatches(options);
  const batch = db.prepare('SELECT * FROM finding_batches').get();
  assert.equal(batch.launch_id, 'fixture-lost-receipt');
  assert.equal(batch.error, null);
  assert.equal(batch.batch_attempts, 0);
  const { finding_id: findingId } = db.prepare('SELECT finding_id FROM finding_backlog').get();
  writeFileSync(join(rootDir, 'data', 'finding-batches', batch.batch_id, 'outcomes.json'), JSON.stringify({
    batchId: batch.batch_id, findings: [{ findingId, outcome: 'dropped', reason: 'not-reproducible: Already addressed' }],
  }));
  await runFindingBatches({ ...options, resolutionOnly: true, execFileImpl: async (_bin, args) => {
    assert.equal(args[1], 'status');
    return succeededPreparation(batch.launch_id);
  } });
  assert.ok(db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
});

test('unreadable preparation recovery defers only its batch', async t => {
  const { rootDir, db, pass } = fixture(t);
  const { claimFindingBatches, runFindingBatches } = await import('../src/findings-batch.mjs');
  pass(1, body.replace('## Verdict', `- **Document the option**
  - **File:** \`docs/options.md\`
  - **Lines:** 1
  - **Problem:** The option lacks a description.
- **Cover the edge case**
  - **File:** \`test/result.mjs\`
  - **Lines:** 1
  - **Problem:** The edge case lacks coverage.
## Verdict`));
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const day = '2026-01-02';
  assert.equal(claimFindingBatches(db, day, { now: fixtureNow }).length, 3);
  const [deferred, ready, finished] = db.prepare('SELECT batch_id FROM finding_batches ORDER BY rowid')
    .all().map(row => row.batch_id);
  const { finding_id: findingId } = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').get(finished);
  const dir = join(rootDir, 'data', 'finding-batches', finished);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({
    batchId: finished, findings: [{ findingId, outcome: 'dropped', reason: 'not-reproducible: Already addressed' }],
  }));

  const dispatches = [], probes = [], warnings = [];
  const result = await runFindingBatches({ rootDir, db, now: fixtureNow, day, env: { HQ_ROOT: rootDir },
    logger: { warn: message => warnings.push(message) },
    execFileImpl: async (_bin, args) => {
      const key = args[args.indexOf('--idempotency-key') + 1];
      dispatches.push(key);
      if (key === `findings-batch-${deferred}`) throw Error('dispatch timed out');
      return { stdout: '{"launchRequestId":"fixture-next-receipt"}' };
    },
    readLaunches: async ({ idempotencyKey, timeoutMs }) => {
      probes.push({ idempotencyKey, timeoutMs });
      return { ok: false };
    } });

  assert.deepEqual(result, { completed: true });
  assert.deepEqual(dispatches, [`findings-batch-${deferred}`, `findings-batch-${ready}`]);
  assert.deepEqual(probes, [{ idempotencyKey: `findings-batch-${deferred}`, timeoutMs: 30_000 }]);
  assert.ok(warnings.some(message => message.includes(`${deferred}: preparation dispatch receipt unavailable`)));
  const readBatch = db.prepare('SELECT launch_id,error,batch_attempts,completed_at,released_at FROM finding_batches WHERE batch_id=?');
  assert.deepEqual(readBatch.get(deferred),
    { launch_id: null, error: null, batch_attempts: 0, completed_at: null, released_at: null });
  assert.equal(readBatch.get(ready).launch_id, 'fixture-next-receipt');
  assert.ok(readBatch.get(finished).completed_at);
});

test('mixed settlement normalizes note whitespace and persists only validated fields', async t => {
  const { db, pass } = fixture(t);
  const { claimFindingBatches, settleFindingBatch } = await import('../src/findings-batch.mjs');
  pass(1, body + advisory);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [batch] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
  const { finding_id: findingId } = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').get(batch.batch_id);
  const { note_id: noteId } = db.prepare('SELECT note_id FROM finding_batch_notes WHERE batch_id=?').get(batch.batch_id);
  const result = { batchId: batch.batch_id, prNumber: { unvalidated: true }, headSha: 'irrelevant', extra: 'omit me',
    findings: [{ findingId, outcome: 'dropped', reason: ' not-reproducible: Already fixed ', extra: 'omit me' }],
    simplicityNotes: [{ noteId, simplicityNoteApplied: false, reason: ' Already\r\n fixed\t on main ', extra: 'omit me' }] };
  assert.equal(settleFindingBatch(db, batch, result), true);
  assert.equal(db.prepare('SELECT outcome FROM finding_backlog').get().outcome, 'dropped');
  const stored = JSON.parse(db.prepare('SELECT result_json FROM finding_batches').get().result_json);
  assert.deepEqual(stored, { batchId: batch.batch_id, prNumber: null, headSha: null,
    findings: [{ findingId, outcome: 'dropped', reason: 'not-reproducible: Already fixed' }],
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
      'stale-code-changed: Final posted review superseded this finding');
  } finally { reopened.close(); }
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='closed'").run();
  assert.equal(db.prepare("SELECT count(*) n FROM finding_backlog WHERE reason='false-positive: Source PR closed without merge; reviewed changes did not land'").get().n, 1);
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
  const [batch] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
  const other = openReviewStateDb(rootDir);
  try { assert.deepEqual(claimFindingBatches(other, '2026-01-02', { now: fixtureNow }), []); }
  finally { other.close(); }
  assert.deepEqual(claimFindingBatches(db, '2026-01-03', { now: fixtureNow }), []);
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
  await runFindingBatches({ now: fixtureNow, db, rootDir, env, day: '2026-01-02', execFileImpl, logger: { warn() {} } });
  assert.equal(db.prepare('SELECT launch_id FROM finding_batches').get().launch_id, null);
  await runFindingBatches({ now: fixtureNow, db, rootDir, env, day: '2026-01-02', execFileImpl });
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
  // New findings receive another capped batch on the same day.
  pass(2, body.replace('Explain the result', 'Explain another result'));
  db.prepare("UPDATE reviewed_prs SET pr_state='open'").run();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const [next] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
  assert.deepEqual(claimFindingBatches(db, '2026-01-03', { now: fixtureNow }), []);
  const findingId = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').get(next.batch_id).finding_id;
  // FINDINGSREQUEUE-01: a blank reason returns that finding for re-verification.
  assert.equal(settleFindingBatch(db, next, { batchId: next.batch_id,
    findings: [{ findingId, outcome: 'dropped', reason: '' }] }), true);
  assert.deepEqual(db.prepare('SELECT batch_id,batch_attempts,outcome FROM finding_backlog WHERE finding_id=?').get(findingId),
    { batch_id: null, batch_attempts: 1, outcome: null });
  const [retry] = claimFindingBatches(db, '2026-01-03', { now: fixtureNow });
  assert.notEqual(retry.batch_id, next.batch_id);
  settleFindingBatch(db, retry, { batchId: retry.batch_id,
    findings: [{ findingId, outcome: 'dropped', reason: 'not-reproducible: Already described on current main' }] });
  assert.equal(db.prepare('SELECT reason FROM finding_backlog WHERE batch_id=?').get(retry.batch_id).reason,
    'not-reproducible: Already described on current main');
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
  assert.equal(summarizeFindingBacklog(db, fixtureNow).available, false);
});

test('FINDINGSBATCH-01 default PR reader collects merged evidence through gh and preserves unresolved batches', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { claimFindingBatches, runFindingBatches } = await import('../src/findings-batch.mjs');
  const [batch] = claimFindingBatches(db, '2026-01-02', { now: fixtureNow });
  const rows = db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=?').all(batch.batch_id);
  const dir = join(rootDir, 'data', 'finding-batches', batch.batch_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ batchId: batch.batch_id, prNumber: 8, headSha: head,
    findings: rows.map(r => ({ findingId: r.finding_id, outcome: 'applied', reason: 'Documented return value' })) }));
  const env = { HQ_ROOT: rootDir, GH_TOKEN: 'fixture-only' };
  let response;
  let reads = 0;
  const options = { db, rootDir, env, day: '2026-01-02', now: Date.parse('2026-01-02T01:00:00Z'), logger: { warn() {} },
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
  await ticker.tick(now + 86400000);
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
  const ticker = createFindingBatchTicker({ rootDir, db, env: { HQ_ROOT: rootDir }, intervalMs: 86400000,
    execFileImpl: async (_bin, args) => {
      if (args[1] === 'status') return succeededPreparation(args[2]);
      launches++;
      return { stdout: '{"launchRequestId":"fixture-launch"}' };
    },
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
    findings: rows.map((r, i) => ({ findingId: r.finding_id, outcome: i ? 'dropped' : 'applied', reason: 'not-reproducible: Checked current main' })) }));
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
  await ticker.tick(now + 86400000);
  assert.equal(launches, 2);
});

async function publicationFixture(t, { advice = false, expectedTimeout = null, expectedReadTimeout = 30_000 } = {}) {
  const f = fixture(t);
  f.pass(1, advice ? adviceOnly : body);
  f.db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { runFindingBatches } = await import('../src/findings-batch.mjs');
  const env = { HQ_ROOT: f.rootDir };
  const dispatches = [];
  await runFindingBatches({ now: fixtureNow, ...f, env, day: '2026-01-02', execFileImpl: async (_bin, args, options) => {
    assert.ok(options.timeout >= 900_000);
    if (expectedTimeout !== null) assert.equal(options.timeout, expectedTimeout);
    dispatches.push(args);
    return { stdout: '{"launchRequestId":"fixture-initial"}' };
  } });
  const batch = f.db.prepare('SELECT * FROM finding_batches').get();
  const outputPath = join(f.rootDir, 'data', 'finding-batches', batch.batch_id, 'outcomes.json');
  const result = { batchId: batch.batch_id, prNumber: null, headSha: head,
    findings: f.db.prepare('SELECT finding_id FROM finding_backlog').all()
      .map(r => ({ findingId: r.finding_id, outcome: 'applied', reason: 'Documented return value' })),
    simplicityNotes: f.db.prepare('SELECT note_id FROM finding_batch_notes').all()
      .map(n => ({ noteId: n.note_id, simplicityNoteApplied: true, reason: 'Removed duplicate helper' })) };
  writeFileSync(outputPath, JSON.stringify(result));
  const status = { launchRequestId: batch.launch_id, repo, branch: 'fixture/findings',
    status: 'succeeded', terminal: true, succeeded: true,
    milestones: { branch_pushed: { status: 'done' } } };
  const key = `findings-batch-${batch.batch_id}`;
  const publisherKey = `findings-batch-publish-${batch.batch_id}`;
  const launch = { launch_request_id: batch.launch_id, idempotency_key: key,
    ticket_ref: `FINDINGS-${batch.batch_id}`, target_repo: repo, status: 'succeeded' };
  const launches = [launch];
  const publication = { prs: [], headSha: head };
  const handoffs = [];
  const options = { ...f, env, resolutionOnly: true, logger: { warn() {} },
    fetchPublication: async (_repo, branch) => {
      assert.equal(_repo, repo);
      assert.equal(branch, status.branch);
      return publication;
    },
    readLaunches: async args => {
      assert.ok([key, publisherKey].includes(args.idempotencyKey));
      // The release helper retains its separate 15-second read contract.
      assert.ok(args.timeoutMs === 15_000 || args.timeoutMs === expectedReadTimeout);
      return { ok: true, rows: launches.filter(row => row.idempotency_key === args.idempotencyKey) };
    },
    execFileImpl: async (bin, args, options) => {
      assert.equal(bin, 'hq');
      if (args[1] === 'status') {
        assert.deepEqual(args, ['dispatch', 'status', batch.launch_id, '--json', '--root', f.rootDir]);
        assert.equal(options.timeout, expectedReadTimeout);
        return { stdout: JSON.stringify(status) };
      }
      if (args[0] === 'decision') {
        handoffs.push(args);
        Object.assign(status, { status: 'canceled', succeeded: false });
        launch.status = 'canceled';
        return { stdout: JSON.stringify({ sourceLaunchId: batch.launch_id, batchId: batch.batch_id,
          repo, branch: status.branch, headSha: head, state: 'superseded', branchReleased: true }) };
      }
      // Model provisioning that takes 496 seconds without a real wall-clock
      // wait. Both submissions must survive the former fixed 60-second kill.
      assert.ok(options.timeout >= 900_000);
      if (expectedTimeout !== null) assert.equal(options.timeout, expectedTimeout);
      dispatches.push(args);
      assert.equal(args[args.indexOf('--idempotency-key') + 1], publisherKey);
      launches.push({ ...launch, idempotency_key: publisherKey, launch_request_id: 'fixture-publish', status: 'running' });
      return { stdout: '{"launchRequestId":"fixture-publish"}' };
    } };
  const pr = { number: 81, state: 'OPEN', headRefOid: head, headRefName: status.branch,
    isCrossRepository: false, body: `Finding-Batch: ${batch.batch_id}` };
  return { ...f, batch, outputPath, result, status, dispatches, handoffs, launches, publication, options, pr,
    run: overrides => runFindingBatches({ now: fixtureNow, ...options, ...overrides }) };
}

test('a terminal preparation with a partially written artifact settles after the complete read', async t => {
  const f = await publicationFixture(t);
  f.result.findings[0] = { ...f.result.findings[0], outcome: 'dropped', reason: 'not-reproducible: Checked current main' };
  f.result.headSha = null;
  writeFileSync(f.outputPath, '{"batchId":');
  const finish = setTimeout(() => writeFileSync(f.outputPath, JSON.stringify(f.result)), 25);
  t.after(() => clearTimeout(finish));
  await f.run({ fetchPr: () => assert.fail('no GitHub lookup for a drop') });
  const row = f.db.prepare('SELECT completed_at,error FROM finding_batches').get();
  assert.equal(row.error, null);
  assert.ok(row.completed_at);
});

test('a drop citation from another repository never becomes a batch PR lookup', async t => {
  const f = await publicationFixture(t);
  f.result.headSha = null;
  f.status.prNumber = 42; // The launch receipt is not a publication outcome.
  f.result.findings[0] = { ...f.result.findings[0], outcome: 'dropped',
    reason: 'already-fixed-in-23: Merged fix in example/companion#23' };
  writeFileSync(f.outputPath, JSON.stringify(f.result));
  const reads = [];
  await f.run({ fetchPr: async (target, number) => {
    reads.push([target, number]);
    throw Error(`GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`);
  } });
  const row = f.db.prepare('SELECT completed_at,error FROM finding_batches').get();
  assert.equal(row.error, null);
  assert.deepEqual(reads, []);
  assert.ok(row.completed_at);
});

test('invalid JSON is not reported while preparation is live and after exit has a typed error', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'running', terminal: false, succeeded: false });
  writeFileSync(f.outputPath, '{"batchId":');
  const get = () => f.db.prepare('SELECT completed_at,error FROM finding_batches').get();
  await f.run();
  assert.deepEqual(get(), { completed_at: null, error: null });
  Object.assign(f.status, { status: 'succeeded', terminal: true, succeeded: true });
  await f.run();
  assert.deepEqual(get(), { completed_at: null, error: 'batch-outcome-invalid-json' });
});

test('numbered publication uses the artifact and retries transient GraphQL failures', async t => {
  const f = await publicationFixture(t);
  writeFileSync(f.outputPath, JSON.stringify({ ...f.result, prNumber: f.pr.number }));
  f.status.prNumber = 42;
  let calls = 0;
  await f.run({ execFileImpl: async (bin, args, options) => {
    if (bin === 'hq') return f.options.execFileImpl(bin, args, options);
    assert.equal(bin, 'gh');
    assert.deepEqual(args.slice(0, 5), ['pr', 'view', String(f.pr.number), '--repo', repo]);
    if (++calls === 1) throw Error('GraphQL: Something went wrong while executing your query');
    return { stdout: JSON.stringify({ ...f.pr, state: 'MERGED' }) };
  } });
  assert.equal(calls, 2);
  const row = f.db.prepare('SELECT completed_at,error FROM finding_batches').get();
  assert.equal(row.error, null);
  assert.ok(row.completed_at);
});

test('GitHub failure after retries keeps aged work pending for the next pass', async t => {
  const f = await publicationFixture(t);
  writeFileSync(f.outputPath, JSON.stringify({ ...f.result, prNumber: f.pr.number }));
  const get = () => f.db.prepare('SELECT completed_at,released_at,error FROM finding_batches').get();
  const now = fixtureNow + 86400001;
  await f.run({ now, fetchPr: async () => { throw Error('HTTP 503'); } });
  assert.deepEqual(get(), { completed_at: null, released_at: null, error: null });
  await f.run({ now: now + 3600000, fetchPr: async () => ({ ...f.pr, state: 'MERGED' }) });
  assert.ok(get().completed_at);
});

test('published outcomes skip preparation probes across collection ticks', async t => {
  const f = await publicationFixture(t);
  writeFileSync(f.outputPath, JSON.stringify({ ...f.result, prNumber: f.pr.number }));
  const options = { execFileImpl: () => assert.fail('published outcomes need no preparation command'),
    fetchPr: async () => f.pr };
  await f.run(options);
  await f.run(options);
  assert.equal(f.db.prepare('SELECT completed_at,error FROM finding_batches').get().error, null);
  await f.run({ ...options, fetchPr: async () => ({ ...f.pr, state: 'MERGED' }) });
  assert.ok(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
});

test('marked branch PR recovery survives a lost artifact rewrite without a live publisher', async t => {
  for (const publisher of ['absent', 'failed']) await t.test(publisher, async t => {
    const f = await publicationFixture(t);
    if (publisher === 'failed') {
      writeFileSync(join(f.rootDir, 'data', 'finding-batches', f.batch.batch_id, 'publish-intent.json'), '{}');
      f.launches.push({ ...f.launches[0], idempotency_key: `findings-batch-publish-${f.batch.batch_id}`,
        launch_request_id: 'dead-publisher', status: 'failed' });
    }
    f.publication.prs = [{ ...f.pr, headRefOid: 'c'.repeat(40) }];
    await f.run({ fetchPr: async (target, number) => {
      assert.equal(target, repo);
      assert.equal(number, f.pr.number);
      return f.publication.prs[0];
    } });
    const recovered = JSON.parse(readFileSync(f.outputPath, 'utf8'));
    assert.deepEqual(recovered, { ...f.result, prNumber: f.pr.number, headSha: 'c'.repeat(40) });
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
    await f.run({ execFileImpl: () => assert.fail('restart uses recovered artifact'),
      fetchPublication: () => assert.fail('restart uses numbered PR'),
      fetchPr: async () => ({ ...f.pr, state: 'MERGED', headRefOid: 'c'.repeat(40) }) });
    assert.ok(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
    assert.equal(f.db.prepare('SELECT result_pr FROM finding_backlog').get().result_pr, f.pr.number);
  });
});

test('permanent GitHub read failures remain visible and release aged terminal batches', async t => {
  for (const boundary of ['numbered PR', 'branch PR']) {
    for (const detail of ['HTTP 401 Bad credentials', 'HTTP 403 Forbidden', 'repository not found', 'Unexpected token in JSON']) {
      await t.test(`${boundary}: ${detail}`, async t => {
        const f = await publicationFixture(t);
        if (boundary === 'numbered PR') writeFileSync(f.outputPath, JSON.stringify({ ...f.result, prNumber: f.pr.number }));
        const fail = async () => { throw Error(detail); };
        const options = boundary === 'numbered PR' ? { fetchPr: fail } : { fetchPublication: fail };
        await f.run(options);
        assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, detail);
        await f.run({ ...options, now: fixtureNow + 86400001 });
        assert.ok(f.db.prepare('SELECT released_at FROM finding_batches').get().released_at);
        assert.equal(f.db.prepare('SELECT batch_attempts FROM finding_backlog').get().batch_attempts, 1);
      });
    }
  }
});

test('an explicitly missing artifact PR records a typed error and does not fall back to branch discovery', async t => {
  const f = await publicationFixture(t);
  writeFileSync(f.outputPath, JSON.stringify({ ...f.result, prNumber: f.pr.number }));
  await f.run({
    fetchPr: async () => {
      throw Error(`GraphQL: Could not resolve to a PullRequest with the number of ${f.pr.number}. (repository.pullRequest)`);
    },
    fetchPublication: () => assert.fail('artifact PR is the only settlement candidate'),
  });
  const row = f.db.prepare('SELECT completed_at,error FROM finding_batches').get();
  assert.deepEqual(row, { completed_at: null, error: 'batch-pr-not-found' });
});

test('FINDINGSDECISIONHOLD-01 supersedes the blocked decision before dispatch and records one handoff', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'blocked_needs_decision', succeeded: false });
  f.launches[0].status = 'blocked_needs_decision';
  const order = [];
  let activeBatch;
  const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', sql => {
    const statement = prepare(sql);
    if (sql === 'SELECT * FROM finding_batches WHERE completed_at IS NULL AND released_at IS NULL ORDER BY rowid') {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args) => {
        const rows = all(...args);
        activeBatch = rows[0];
        return rows;
      });
    }
    return statement;
  });
  await f.run({ execFileImpl: async (bin, args, options) => {
    order.push(args.slice(0, 2).join(' '));
    if (args[0] === 'dispatch' && args[1] !== 'status') {
      const persisted = prepare('SELECT decision_publication_json FROM finding_batches').get();
      assert.equal(activeBatch.decision_publication_json, persisted.decision_publication_json);
      assert.equal(JSON.parse(activeBatch.decision_publication_json).branchReleased, true);
    }
    return f.options.execFileImpl(bin, args, options);
  } });
  assert.deepEqual(order, ['dispatch status', 'decision supersede-publication', 'dispatch --priority']);
  assert.equal(f.dispatches.length, 2);
  const receipt = JSON.parse(f.db.prepare('SELECT decision_publication_json FROM finding_batches').get().decision_publication_json);
  assert.equal(receipt.branchReleased, true);
  assert.equal(receipt.headSha, head);
  await f.run();
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.dispatches.length, 2);
});

test('FINDINGSDECISIONHOLD-01 a succeeded source never closes a decision', async t => {
  const f = await publicationFixture(t);
  await f.run();
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.handoffs.length, 0);
});

test('a publication dispatch timeout adopts the publisher without replacing the preparation launch', async t => {
  const f = await publicationFixture(t);
  await f.run({ execFileImpl: async (bin, args, options) => {
    const receipt = await f.options.execFileImpl(bin, args, options);
    if (args[1] === 'status') return receipt;
    throw Object.assign(Error('dispatch timed out'), { killed: true, signal: 'SIGTERM' });
  } });
  assert.deepEqual(f.db.prepare('SELECT launch_id,error FROM finding_batches').get(),
    { launch_id: f.batch.launch_id, error: null });
  await f.run({ now: fixtureNow + 3600000 });
  assert.equal(f.dispatches.length, 2, 'the adopted publisher fences subsequent dispatch');
  writeFileSync(f.outputPath, JSON.stringify({ ...f.result, prNumber: f.pr.number }));
  await f.run({ fetchPr: async () => ({ ...f.pr, state: 'MERGED' }) });
  assert.ok(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
});

test('FINDINGSDECISIONHOLD-01 untyped lifecycle failures retain aged canceled source custody', async t => {
  for (const stderr of [undefined, 'unexpected runtime crash']) await t.test(String(stderr), async t => {
    const f = await publicationFixture(t);
    Object.assign(f.status, { status: 'canceled', succeeded: false });
    f.launches[0].status = 'canceled';
    await f.run({ now: fixtureNow + 86400001, execFileImpl: async (bin, args, options) => {
      if (args[0] !== 'decision') return f.options.execFileImpl(bin, args, options);
      throw Object.assign(Error('process terminated'), { stderr });
    } });
    const row = f.db.prepare('SELECT error,released_at FROM finding_batches').get();
    assert.match(row.error, /batch-decision-publication-failed/);
    assert.equal(row.released_at, null);
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM finding_backlog WHERE batch_id=?')
      .get(f.batch.batch_id).n, f.result.findings.length);
  });
});

test('FINDINGSDECISIONHOLD-01 recovers a lifecycle handoff whose batch receipt was lost', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'canceled', succeeded: false });
  f.launches[0].status = 'canceled';
  await f.run();
  assert.equal(f.handoffs.length, 1, 'the supported API must validate its prior audit');
  assert.equal(f.dispatches.length, 2);
  assert.ok(f.db.prepare('SELECT decision_publication_json FROM finding_batches').get().decision_publication_json);
});

test('FINDINGSDECISIONHOLD-01 a mismatched lifecycle receipt cannot authorize publication', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'blocked_needs_decision', succeeded: false });
  await f.run({ execFileImpl: async (bin, args, options) => {
    const response = await f.options.execFileImpl(bin, args, options);
    return args[0] === 'decision'
      ? { stdout: JSON.stringify({ ...JSON.parse(response.stdout), headSha: 'c'.repeat(40) }) } : response;
  } });
  assert.equal(f.dispatches.length, 1);
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-decision-publication-receipt-mismatch');
});

test('FINDINGSDECISIONHOLD-01 malformed lifecycle responses retain the canceled source and work', async t => {
  for (const stdout of ['null', '{invalid']) await t.test(stdout, async t => {
    const f = await publicationFixture(t);
    Object.assign(f.status, { status: 'canceled', succeeded: false });
    f.launches[0].status = 'canceled';
    await f.run({ now: fixtureNow + 86400001, execFileImpl: async (bin, args, options) =>
      args[0] === 'decision' ? { stdout } : f.options.execFileImpl(bin, args, options) });
    const row = f.db.prepare('SELECT error,released_at FROM finding_batches').get();
    assert.match(row.error, /^batch-decision-publication-receipt-(invalid|mismatch)$/);
    assert.equal(row.released_at, null);
    assert.equal(f.dispatches.length, 1);
  });
});

test('FINDINGSDECISIONHOLD-01 a verified handoff renews a spent pre-handoff intent once', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'blocked_needs_decision', succeeded: false });
  f.launches[0].status = 'blocked_needs_decision';
  const intentPath = join(f.rootDir, 'data', 'finding-batches', f.batch.batch_id, 'publish-intent.json');
  const prior = { batchId: f.batch.batch_id, branch: f.status.branch,
    idempotencyKey: `findings-batch-${f.batch.batch_id}`, sourceLaunchId: f.batch.launch_id,
    submittedAt: new Date(fixtureNow - 3600000).toISOString(), dispatchTimeoutMs: 900000, resubmissionCount: 1 };
  writeFileSync(intentPath, JSON.stringify(prior));
  await f.run();
  assert.equal(f.dispatches.length, 2);
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  assert.equal(intent.decisionPublication.headSha, head);
  assert.equal(intent.handoffOf.resubmissionCount, 1);
  assert.equal(intent.resubmissionCount, 0);
  await f.run();
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.dispatches.length, 2);
});

test('FINDINGSDECISIONHOLD-01 handoff cannot bypass the old ambiguity deadline or a late publisher', async t => {
  for (const latePublisher of [null, 'running', 'succeeded', 'failed']) await t.test(String(latePublisher), async t => {
    const f = await publicationFixture(t);
    Object.assign(f.status, { status: 'blocked_needs_decision', succeeded: false });
    f.launches[0].status = 'blocked_needs_decision';
    const intentPath = join(f.rootDir, 'data', 'finding-batches', f.batch.batch_id, 'publish-intent.json');
    writeFileSync(intentPath, JSON.stringify({ batchId: f.batch.batch_id, branch: f.status.branch,
      idempotencyKey: `findings-batch-${f.batch.batch_id}`, sourceLaunchId: f.batch.launch_id,
      submittedAt: new Date(fixtureNow).toISOString(), dispatchTimeoutMs: 900000, resubmissionCount: 1 }));
    await f.run({ execFileImpl: async (bin, args, options) => {
      const response = await f.options.execFileImpl(bin, args, options);
      if (latePublisher && args[0] === 'decision') {
        f.launches.push({ ...f.launches[0], launch_request_id: 'fixture-late-publisher', status: latePublisher });
      }
      return response;
    } });
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.handoffs.length, 1);
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error,
      latePublisher ? null : 'batch-publish-receipt-pending');
    assert.equal(JSON.parse(readFileSync(intentPath, 'utf8')).resubmissionCount, 1);
    if (latePublisher) {
      f.publication.prs = [f.pr];
      await f.run({ fetchPr: async () => f.pr });
      assert.equal(f.dispatches.length, 1, 'fresh PR recovery never submits another publisher');
      assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, null);
    }
  });
});

test('FINDINGSDECISIONHOLD-01 the publication handoff cannot renew its own spent retry', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'blocked_needs_decision', succeeded: false });
  f.launches[0].status = 'blocked_needs_decision';
  let submissions = 0;
  const execFileImpl = async (bin, args, options) => {
    if (args[0] === 'dispatch' && args[1] !== 'status') {
      submissions++;
      throw Error('fixture dispatch receipt unavailable');
    }
    return f.options.execFileImpl(bin, args, options);
  };
  const intentPath = join(f.rootDir, 'data', 'finding-batches', f.batch.batch_id, 'publish-intent.json');
  await f.run({ execFileImpl });
  let intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  const afterDeadline = () => Date.parse(intent.submittedAt) + intent.dispatchTimeoutMs + 600001;
  await f.run({ execFileImpl, now: afterDeadline() });
  intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  assert.equal(intent.resubmissionCount, 1);
  await f.run({ execFileImpl, now: afterDeadline() });
  assert.equal(submissions, 2);
  assert.equal(f.handoffs.length, 1);
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-publish-receipt-pending');
});

test('FINDINGSDECISIONHOLD-01 refuses unpushed work and retains the cause and full diagnostic once', async t => {
  const f = await publicationFixture(t);
  Object.assign(f.status, { status: 'blocked_needs_decision', succeeded: false });
  f.launches[0].status = 'blocked_needs_decision';
  const logs = [];
  const cause = '[hq] error: decision-publication-unpushed-work: retained HEAD differs from tested head';
  const stderr = `${'diagnostic context '.repeat(40)}\n${cause}\nfull diagnostic tail`;
  await f.run({ logger: { warn: message => logs.push(message) }, execFileImpl: async (bin, args, options) => {
    if (args[0] !== 'decision') return f.options.execFileImpl(bin, args, options);
    throw Object.assign(Error(`Command failed: ${'hq dispatch '.repeat(40)}`), { stderr });
  } });
  const row = f.db.prepare('SELECT error,decision_publication_json,released_at FROM finding_batches').get();
  assert.equal(row.error, cause);
  assert.ok(row.error.length <= 300);
  assert.equal(row.decision_publication_json, null);
  assert.equal(row.released_at, null);
  assert.equal(f.dispatches.length, 1);
  assert.equal(logs.filter(message => message.includes('full diagnostic tail')).length, 1);
  await f.run({ now: fixtureNow + 86400001, execFileImpl: async (bin, args, options) => {
    if (args[0] !== 'decision') return f.options.execFileImpl(bin, args, options);
    throw Object.assign(Error('handoff refused'), { stderr: cause });
  } });
  assert.equal(f.db.prepare('SELECT released_at FROM finding_batches').get().released_at, null,
    'age does not discard unresolved decision custody');
});

test('FINDINGSSTATUSTIMEOUT-01 publication probes use read-scale bounds while dispatch retains provisioning time', async t => {
  t.mock.method(os, 'platform', () => 'linux');
  const cores = os.cpus().length;
  t.mock.method(os, 'loadavg', () => [cores * 3, cores * 3, cores * 3]);
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-A', '-o', '%cpu=']);
    return `${cores * 100}\n`;
  });
  syncBuiltinESMExports();
  resetLoadAwareTimeoutCachesForTesting();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetLoadAwareTimeoutCachesForTesting();
  });
  const f = await publicationFixture(t, { expectedTimeout: 5_400_000, expectedReadTimeout: 180_000 });
  assert.equal(f.dispatches.length, 1);
  // Model elapsed child/transport time without waiting on wall-clock sleeps.
  // Either old 15-second probe bound rejects before publication.
  const elapsedMs = 20_000;
  let statusReads = 0, keyedReads = 0;
  await f.run({
    execFileImpl: async (bin, args, options) => {
      if (args[1] === 'status') {
        statusReads++;
        assert.ok(elapsedMs < options.timeout);
      }
      return f.options.execFileImpl(bin, args, options);
    },
    readLaunches: async args => {
      keyedReads++;
      assert.ok(elapsedMs < args.timeoutMs);
      return f.options.readLaunches(args);
    },
  });
  assert.equal(statusReads, 1);
  assert.equal(keyedReads, 1);
  assert.equal(f.dispatches.length, 2, 'publisher provisioning retains its uncapped load scaling');
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, null);
});

test('FINDINGSSTATUSTIMEOUT-01 terminated publication probes record their cause and retry without release', async t => {
  for (const boundary of ['status', 'ledger']) {
    for (const failure of [
      { killed: true, signal: 'SIGTERM' },
      { killed: true },
      { timedOut: true },
      { code: 'ETIMEDOUT' },
      { signal: 'SIGKILL' },
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' },
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
    ]) await t.test(`${boundary}: ${JSON.stringify(failure)}`, async t => {
      const f = await publicationFixture(t);
      const logs = [];
      const fail = async () => {
        throw Object.assign(Error(`Command failed: ${'synthetic command '.repeat(30)}`), failure,
          { stderr: `[hq] error: ${'synthetic diagnostic '.repeat(30)}` });
      };
      await f.run({ logger: { warn: message => logs.push(message) },
        ...(boundary === 'status' ? { execFileImpl: fail } : { readLaunches: fail }) });
      const row = f.db.prepare('SELECT error,released_at,completed_at,batch_attempts FROM finding_batches').get();
      const operation = boundary === 'status' ? 'hq dispatch status' : 'keyed launch probe';
      const expected = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? `${operation} output exceeded limit${failure.signal ? ` (signal ${failure.signal})` : ''}`
        : failure.signal === 'SIGKILL' ? `${operation} terminated (signal SIGKILL)`
          : `${operation} timed out after 30000 ms${failure.signal ? ` (signal ${failure.signal})` : ''}`;
      assert.equal(row.error, failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? expected : null);
      assert.equal(row.released_at, null);
      assert.equal(row.completed_at, null);
      assert.equal(row.batch_attempts, 0);
      assert.ok(logs[0].slice(0, 300).includes(expected));
      assert.equal(f.dispatches.length, 1);
      await f.run();
      assert.equal(f.dispatches.length, 2, 'next pass retries publication with the same batch');
      assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, null);
    });
  }
});

test('FINDINGSSTATUSTIMEOUT-01 typed keyed read timeout remains visible and retryable', async t => {
  const f = await publicationFixture(t);
  const logs = [];
  await f.run({ logger: { warn: message => logs.push(message) },
    readLaunches: async () => ({ ok: false, reason: 'dispatch-read-unavailable', timedOut: true }) });
  const row = f.db.prepare('SELECT error,released_at FROM finding_batches').get();
  assert.equal(row.error, null);
  assert.equal(row.released_at, null);
  assert.match(logs[0], /keyed launch probe timed out after 30000 ms/);
  await f.run();
  assert.equal(f.dispatches.length, 2);
});

async function nativePublicationFixture(t) {
  const f = await publicationFixture(t);
  const native = JSON.parse(readFileSync(new URL('./fixtures/findings-custody/native-status.json', import.meta.url), 'utf8'));
  assert.equal('target_worktree' in native.launch, false, 'replay the actual public projection');
  Object.assign(f.status, native.status);
  f.batch.launch_id = native.status.launchRequestId;
  f.db.prepare('UPDATE finding_batches SET launch_id=?').run(f.batch.launch_id);
  Object.assign(f.launches[0], native.launch, {
    idempotency_key: `findings-batch-${f.batch.batch_id}`, ticket_ref: `FINDINGS-${f.batch.batch_id}`,
  });
  return f;
}

test('FINDINGSBATCHCUSTODY-01 native owner status publishes once and retains artifact custody', async t => {
  const f = await nativePublicationFixture(t);
  const original = readFileSync(f.outputPath, 'utf8');
  await f.run();
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.dispatches[1][f.dispatches[1].indexOf('--branch') + 1], f.status.branch);
  await f.run();
  assert.equal(f.dispatches.length, 2);
  assert.equal(readFileSync(f.outputPath, 'utf8'), original);
  assert.equal(f.db.prepare('SELECT completed_at,error FROM finding_batches').get().error, null);
  assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
});

test('FINDINGSBATCHCUSTODY-01 native publication requires independent exact repository and launch evidence', async t => {
  const cases = [
    ['foreign repository, same short name', f => { f.launches[0].target_repo = 'other/service'; }],
    ['foreign ticket', f => { f.launches[0].ticket_ref = 'FINDINGS-other'; }],
    ['foreign key', f => { f.launches[0].idempotency_key = 'findings-batch-other'; }],
    ['failed preparation', f => { f.status.status = 'failed'; f.status.succeeded = false; }],
    ['tested head absent from remote', f => { f.publication.headSha = undefined; }],
    ['wrong remote head', f => { f.publication.headSha = 'c'.repeat(40); }],
    ['unmarked result PR', f => { f.publication.prs = [{ ...f.pr, body: 'foreign' }]; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = await nativePublicationFixture(t);
    const original = readFileSync(f.outputPath, 'utf8');
    mutate(f);
    await f.run();
    assert.equal(f.dispatches.length, 1);
    const stored = f.db.prepare('SELECT completed_at,error FROM finding_batches').get();
    assert.equal(stored.completed_at, null);
    assert.ok(stored.error);
    assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
    assert.equal(readFileSync(f.outputPath, 'utf8'), original);
  });
});

test('FINDINGSBATCHCUSTODY-01 workspace display paths do not grant repository authority', async t => {
  for (const path of ['/foreign/workers/other/service', '/synthetic/relocated/service']) {
    await t.test(path, async t => {
      const f = await nativePublicationFixture(t);
      f.status.repo = path;
      delete f.status.workspacePath;
      await f.run();
      assert.equal(f.dispatches.length, 2, 'keyed producer identity and remote tested head authorize publication');
    });
  }
});

test('FINDINGSREQUEUE-01 invalid historical outcomes return the finding for re-verification and retain the artifact', async t => {
  for (const [outcome, reason, error] of [
    ['dropped', 'This looks stale', 'invalid-dropped-reason'],
    ['resolved', 'Fixed in the prepared branch', 'invalid-finding-outcome'],
    ['applied', '', 'invalid-finding-outcome'],
  ]) await t.test(error + ':' + outcome, async t => {
    const f = await nativePublicationFixture(t);
    Object.assign(f.result.findings[0], { outcome, reason });
    writeFileSync(f.outputPath, JSON.stringify(f.result));
    const original = readFileSync(f.outputPath, 'utf8');
    await f.run();
    assert.equal(f.dispatches.length, 1, 'an invalid applied claim is never published');
    const stored = f.db.prepare('SELECT completed_at,error,result_json FROM finding_batches').get();
    assert.ok(stored.completed_at);
    assert.equal(stored.error, null);
    assert.deepEqual(JSON.parse(stored.result_json).requeued, [{ findingId: f.result.findings[0].findingId, reason: error }]);
    assert.deepEqual(f.db.prepare('SELECT outcome,batch_id,batch_attempts FROM finding_backlog').get(),
      { outcome: null, batch_id: null, batch_attempts: 1 });
    assert.deepEqual(f.db.prepare('SELECT batch_id,reason,disposition FROM finding_batch_releases').all(),
      [{ batch_id: f.batch.batch_id, reason: error, disposition: 'requeued' }]);
    assert.equal(readFileSync(f.outputPath, 'utf8'), original);
  });
});

test('FINDINGSSHAPE-01 dispatches decision-only preparation and one pr-shaped publisher on the pushed branch', async t => {
  for (const advice of [false, true]) await t.test(`advice-only=${advice}`, async t => {
    const f = await publicationFixture(t, { advice });
    const initial = f.dispatches[0];
    assert.equal(initial[initial.indexOf('--completion-shape') + 1], 'decision-only');
    assert.equal(initial.includes('--branch'), false);
    const preparePrompt = readFileSync(initial[initial.indexOf('--prompt') + 1], 'utf8');
    assert.match(preparePrompt, /Do not run hq pr open in this launch/);
    assert.match(preparePrompt, /Write applied outcomes only after the push succeeds/);
    await f.run();
    assert.equal(f.dispatches.length, 2);
    const publish = f.dispatches[1];
    assert.equal(publish[publish.indexOf('--completion-shape') + 1], 'pr');
    assert.equal(publish[publish.indexOf('--branch') + 1], f.status.branch);
    assert.equal(initial[initial.indexOf('--idempotency-key') + 1], `findings-batch-${f.batch.batch_id}`);
    assert.equal(publish[publish.indexOf('--idempotency-key') + 1], `findings-batch-publish-${f.batch.batch_id}`);
    for (const flag of ['--ticket', '--repo']) {
      assert.equal(publish[publish.indexOf(flag) + 1], initial[initial.indexOf(flag) + 1]);
    }
    const prompt = readFileSync(publish[publish.indexOf('--prompt') + 1], 'utf8');
    assert.match(prompt, /hq pr open --spec-ref none/);
    assert.ok(prompt.includes(`Finding-Batch: ${f.batch.batch_id}`));
    assert.match(prompt, /never open a second PR/);
    assert.equal(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
    await f.run(); // A restart/next hourly pass sees the existing publisher.
    assert.equal(f.dispatches.length, 2);
    f.publication.prs = [f.pr];
    await f.run({ fetchPr: async () => f.pr });
    assert.equal(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
    const merged = { ...f.pr, state: 'MERGED', headRefOid: 'b'.repeat(40) };
    f.publication.prs[0] = merged;
    await f.run({ fetchPr: async () => merged });
    const stored = f.db.prepare('SELECT * FROM finding_batches').get();
    assert.ok(stored.completed_at);
    assert.equal(stored.launch_id, f.batch.launch_id);
    assert.equal(JSON.parse(stored.result_json).prNumber, 81);
    assert.equal(JSON.parse(stored.result_json).headSha, 'b'.repeat(40));
    assert.equal(f.dispatches.length, 2);
  });
});

test('FINDINGSSHAPE-01 decline-only outcomes finish without GitHub, push or publisher', async t => {
  const f = await publicationFixture(t);
  f.result.headSha = null;
  f.result.findings.forEach(outcome => { outcome.outcome = 'dropped'; outcome.reason = 'not-reproducible: Already fixed on main'; });
  writeFileSync(f.outputPath, JSON.stringify(f.result));
  const unexpected = async () => assert.fail('declines require no external command');
  await f.run({ fetchPr: unexpected, fetchPublication: unexpected, readLaunches: unexpected });
  const stored = f.db.prepare('SELECT * FROM finding_batches').get();
  assert.ok(stored.completed_at);
  assert.equal(JSON.parse(stored.result_json).prNumber, null);
  assert.equal(JSON.parse(stored.result_json).headSha, null);
  assert.equal(f.dispatches.length, 1);
});

test('FINDINGSREQUEUE-01 the push milestone is not push authority; the remote tested head is', async t => {
  // Dispatch status reports every unobserved milestone as not_started and does
  // not re-probe a decision-only launch at exit, so a real push can read as
  // anything but done. Only the remote branch head decides.
  for (const status of ['not_started', 'pending', 'failed']) await t.test(`push=${status}`, async t => {
    const f = await publicationFixture(t);
    f.status.milestones = { branch_pushed: { status } };
    await f.run();
    assert.equal(f.dispatches.length, 2, 'the pushed tested head publishes');
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, null);
  });
  await t.test('tested head never pushed', async t => {
    const f = await publicationFixture(t);
    f.status.milestones = { branch_pushed: { status: 'not_started' } };
    f.publication.headSha = 'c'.repeat(40);
    await f.run();
    assert.deepEqual(f.db.prepare('SELECT error,release_reason FROM finding_batches').get(),
      { error: 'batch-push-evidence-mismatch', release_reason: 'batch-push-evidence-mismatch' });
    assert.equal(f.dispatches.length, 1);
  });
});

test('FINDINGSSHAPE-01 valid unmerged publication clears stale errors without settling outcomes', async t => {
  for (const state of ['OPEN', 'CLOSED']) await t.test(state, async t => {
    const f = await publicationFixture(t);
    f.db.prepare('UPDATE finding_batches SET error=?').run('batch-publish-receipt-unavailable');
    f.publication.prs = [{ ...f.pr, state, body: 'unrelated' }];
    await f.run();
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-pr-evidence-mismatch');
    f.publication.prs = [{ ...f.pr, state }];
    await f.run({ fetchPr: async () => ({ ...f.pr, state }) });
    const stored = f.db.prepare('SELECT * FROM finding_batches').get();
    assert.equal(stored.error, null);
    assert.equal(stored.completed_at, null);
    assert.equal(stored.result_json, null);
    assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
    assert.equal(f.dispatches.length, 1);
  });
});

test('FINDINGSSHAPE-01 lost publisher receipts and terminal launches never dispatch a second publisher', async t => {
  for (const enqueued of [false, true]) await t.test(`enqueued=${enqueued}`, async t => {
    const f = await publicationFixture(t);
    await f.run({ execFileImpl: async (bin, args, options) => {
      if (args[1] === 'status') return f.options.execFileImpl(bin, args, options);
      if (enqueued) await f.options.execFileImpl(bin, args, options);
      throw Error('lost publish receipt');
    } });
    if (enqueued) f.launches[1].status = 'failed';
    await f.run();
    await f.run();
    assert.equal(f.dispatches.length, enqueued ? 2 : 1);
    assert.equal(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error,
      enqueued ? 'batch-publish-ended-without-pr: failed' : 'batch-publish-receipt-pending');
    if (enqueued) {
      // FINDINGSREQUEUE-01: both keyed launches ended with no PR. The batch is
      // released and its finding re-batched, never given a second publisher.
      assert.deepEqual(f.db.prepare('SELECT released_at IS NOT NULL AS released,release_reason FROM finding_batches').get(),
        { released: 1, release_reason: 'batch-publish-ended-without-pr: failed' });
      assert.deepEqual(f.db.prepare('SELECT batch_id,batch_attempts FROM finding_backlog').get(), { batch_id: null, batch_attempts: 1 });
      return;
    }
    const merged = { ...f.pr, state: 'MERGED' };
    f.publication.prs = [merged];
    await f.run({ fetchPr: async () => merged });
    assert.ok(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
  });
});

async function strandedPublicationFixture(t) {
  t.mock.method(Date, 'now', () => fixtureNow);
  const f = await publicationFixture(t);
  const intentPath = join(f.rootDir, 'data', 'finding-batches', f.batch.batch_id, 'publish-intent.json');
  const readIntent = () => JSON.parse(readFileSync(intentPath, 'utf8'));
  const absentDispatch = async (bin, args, options) => {
    if (args[1] === 'status') return f.options.execFileImpl(bin, args, options);
    f.dispatches.push(args);
    assert.equal(readIntent().dispatchTimeoutMs, options.timeout);
    throw Error('synthetic submission did not enqueue');
  };
  await f.run({ execFileImpl: absentDispatch });
  const intent = readIntent();
  assert.equal(intent.submittedAt, new Date(fixtureNow).toISOString());
  assert.equal(intent.resubmissionCount, 0);
  return { ...f, intentPath, intent, readIntent, absentDispatch,
    deadline: fixtureNow + intent.dispatchTimeoutMs + 600000 };
}

test('PUBLISHINTENTSTRAND-01 absent receipt resubmits once after the recorded deadline on the original branch/key/ticket', async t => {
  const f = await strandedPublicationFixture(t);
  await f.run({ now: f.deadline });
  assert.equal(f.dispatches.length, 2, 'deadline boundary remains pending');
  await f.run({ now: f.deadline + 1 });
  assert.equal(f.dispatches.length, 3);
  const updated = f.readIntent();
  assert.equal(updated.resubmissionCount, 1);
  assert.equal(updated.submittedAt, new Date(f.deadline + 1).toISOString());
  assert.deepEqual(updated.resubmitOf, {
    submittedAt: f.intent.submittedAt, dispatchTimeoutMs: f.intent.dispatchTimeoutMs,
  });
  for (const flag of ['--branch', '--idempotency-key', '--ticket']) {
    assert.equal(f.dispatches[2][f.dispatches[2].indexOf(flag) + 1],
      f.dispatches[1][f.dispatches[1].indexOf(flag) + 1]);
  }
  assert.equal(statSync(f.intentPath).mode & 0o777, 0o664 & ~process.umask());
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, null);
  await f.run({ now: f.deadline + 2 });
  assert.equal(f.dispatches.length, 3, 'a recovered live publisher fences further dispatch');
});

test('PUBLISHINTENTSTRAND-01 second absence spends no third submission and retains stale requeue accounting', async t => {
  const f = await strandedPublicationFixture(t);
  await f.run({ now: f.deadline + 1, execFileImpl: f.absentDispatch });
  assert.equal(f.readIntent().resubmissionCount, 1, 'retry is durable even when submission throws');
  const bytes = readFileSync(f.intentPath, 'utf8');
  const later = f.deadline + 2 + f.readIntent().dispatchTimeoutMs + 600000;
  await f.run({ now: later, execFileImpl: f.absentDispatch });
  assert.equal(f.dispatches.length, 3);
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-publish-receipt-pending');
  await f.run({ now: Math.max(later, fixtureNow + 86400001), execFileImpl: f.absentDispatch });
  assert.equal(f.dispatches.length, 3);
  assert.equal(readFileSync(f.intentPath, 'utf8'), bytes);
  assert.deepEqual(f.db.prepare('SELECT released_at IS NOT NULL AS released,release_reason FROM finding_batches').get(),
    { released: 1, release_reason: 'batch-publish-receipt-pending' });
  assert.deepEqual(f.db.prepare('SELECT batch_id,batch_attempts,outcome FROM finding_backlog').get(),
    { batch_id: null, batch_attempts: 1, outcome: null });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM finding_batch_releases').get().n, 1);
});

for (const status of ['running', 'succeeded', 'failed']) {
  test(`PUBLISHINTENTSTRAND-01 a late ${status} publisher recovers the receipt without resubmission`, async t => {
    const f = await strandedPublicationFixture(t);
    f.launches.push({ ...f.launches[0], launch_request_id: 'synthetic-publisher', status });
    await f.run({ now: f.deadline + 1 });
    assert.equal(f.dispatches.length, 2);
    assert.deepEqual(f.readIntent(), f.intent);
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error,
      status === 'running' ? null : `batch-publish-ended-without-pr: ${status}`);
  });
}

for (const probe of [{ ok: false }, { ok: true, rows: [] }]) {
  test(`PUBLISHINTENTSTRAND-01 unreadable or missing keyed custody holds intent (${JSON.stringify(probe)})`, async t => {
    const f = await strandedPublicationFixture(t);
    await f.run({ now: f.deadline + 1, readLaunches: async () => probe });
    assert.equal(f.dispatches.length, 2);
    assert.deepEqual(f.readIntent(), f.intent);
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-publish-receipt-unavailable');
  });
}

test('PUBLISHINTENTSTRAND-01 a thrown ledger probe remains receipt-unavailable', async t => {
  const f = await strandedPublicationFixture(t);
  await f.run({ now: f.deadline + 1, readLaunches: async () => { throw Error('synthetic unavailable'); } });
  assert.equal(f.dispatches.length, 2);
  assert.deepEqual(f.readIntent(), f.intent);
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-publish-receipt-unavailable');
});

test('PUBLISHINTENTSTRAND-01 concurrent collectors spend the absent-receipt retry once', async t => {
  const f = await strandedPublicationFixture(t);
  let unblock, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = f.run({ now: f.deadline + 1, fetchPublication: async () => {
    entered();
    await new Promise(resolve => { unblock = resolve; });
    return f.publication;
  } });
  await ready;
  try {
    await f.run({ now: f.deadline + 1 });
    assert.equal(f.dispatches.length, 2);
  } finally { unblock(); }
  await held;
  assert.equal(f.dispatches.length, 3);
  assert.equal(f.readIntent().resubmissionCount, 1);
});

for (const patch of [
  { submittedAt: 'invalid' }, { dispatchTimeoutMs: -1 }, { dispatchTimeoutMs: null },
  { resubmissionCount: null }, { resubmissionCount: 2 }, { branch: 'other/branch' },
]) {
  test(`PUBLISHINTENTSTRAND-01 uncertain intent evidence holds (${JSON.stringify(patch)})`, async t => {
    const f = await strandedPublicationFixture(t);
    writeFileSync(f.intentPath, JSON.stringify({ ...f.intent, ...patch }));
    await f.run({ now: f.deadline + 1 });
    assert.equal(f.dispatches.length, 2);
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-publish-receipt-pending');
  });
}

for (const status of ['running', 'unknown-status']) {
  test(`PUBLISHINTENTSTRAND-01 ${status} keyed decision custody prevents resubmission despite terminal CLI status`, async t => {
    const f = await strandedPublicationFixture(t);
    f.launches[0].status = status;
    await f.run({ now: f.deadline + 1 });
    assert.equal(f.dispatches.length, 2);
    assert.deepEqual(f.readIntent(), f.intent);
    assert.equal(f.db.prepare('SELECT released_at FROM finding_batches').get().released_at, null);
  });
}

test('PUBLISHINTENTSTRAND-01 configurable grace keeps an absent receipt pending until it expires', async t => {
  const f = await strandedPublicationFixture(t);
  const { findingBatchOptions } = await import('../src/findings-batch.mjs');
  assert.equal(findingBatchOptions({}).publishReceiptGraceMs, 600000);
  const env = { ...f.options.env, ADVERSARIAL_FINDINGS_BATCH_PUBLISH_RECEIPT_GRACE_MS: '1200000' };
  assert.equal(findingBatchOptions(env).publishReceiptGraceMs, 1200000);
  assert.throws(() => findingBatchOptions({ ADVERSARIAL_FINDINGS_BATCH_PUBLISH_RECEIPT_GRACE_MS: '0' }));
  await f.run({ env, now: f.deadline + 1 });
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-publish-receipt-pending');
  await f.run({ env, now: f.deadline + 600001 });
  assert.equal(f.dispatches.length, 3);
});

test('PUBLISHINTENTSTRAND-01 legacy intent uses mtime and current dispatch bound before one retry', async t => {
  const f = await strandedPublicationFixture(t);
  const legacy = { ...f.intent };
  delete legacy.submittedAt;
  delete legacy.dispatchTimeoutMs;
  delete legacy.resubmissionCount;
  writeFileSync(f.intentPath, JSON.stringify(legacy));
  utimesSync(f.intentPath, new Date(fixtureNow), new Date(fixtureNow));
  await f.run({ now: fixtureNow + 1 });
  assert.equal(f.dispatches.length, 2, 'legacy intent inside grace is retained');
  await f.run({ now: f.deadline + 1 });
  assert.equal(f.dispatches.length, 3);
  assert.equal(f.readIntent().resubmitOf.submittedAt, new Date(fixtureNow).toISOString());
});

test('PUBLISHINTENTSTRAND-01 the persisted timeout defines the old deadline independently of current load', async t => {
  const f = await strandedPublicationFixture(t);
  writeFileSync(f.intentPath, JSON.stringify({ ...f.intent, dispatchTimeoutMs: 1000 }));
  await f.run({ now: fixtureNow + 601001 });
  assert.equal(f.dispatches.length, 3);
  assert.equal(f.readIntent().resubmitOf.dispatchTimeoutMs, 1000);
});

test('PUBLISHINTENTSTRAND-01 submission time includes time spent awaiting publication evidence', async t => {
  const f = await publicationFixture(t);
  let clock = fixtureNow;
  t.mock.method(Date, 'now', () => clock);
  await f.run({ fetchPublication: async () => {
    clock += 300000;
    return f.publication;
  } });
  const intent = JSON.parse(readFileSync(join(f.rootDir, 'data', 'finding-batches',
    f.batch.batch_id, 'publish-intent.json'), 'utf8'));
  assert.equal(intent.submittedAt, new Date(fixtureNow + 300000).toISOString());
});

test('FINDINGSSHAPE-01 publication holds on invalid manifests, live preparation and uncertain evidence', async t => {
  const cases = [
    ['foreign manifest', f => { f.result.batchId = 'foreign'; }],
    ['missing finding', f => { f.result.findings = []; }],
    ['missing pushed head', f => { f.result.headSha = null; }],
    ['live preparation', f => { f.status.status = 'running'; f.status.terminal = false; }],
    ['explicit nonterminal', f => { f.status.terminal = false; }],
    ['foreign launch', f => { f.status.launchRequestId = 'foreign'; }],
    ['foreign repo', f => { f.status.repo = 'other/service'; }],
    ['missing branch', f => { f.status.branch = null; }],
    ['remote head mismatch', f => { f.publication.headSha = 'c'.repeat(40); }],
    ['missing ledger receipt', f => { f.launches.length = 0; }],
    ['foreign receipt', f => { f.launches[0].idempotency_key = 'foreign'; }],
    ['foreign ticket', f => { f.launches[0].ticket_ref = 'foreign'; }],
    ['foreign receipt repo', f => { f.launches[0].target_repo = 'other/service'; }],
    ['unmarked PR', f => { f.publication.prs = [{ ...f.pr, body: 'unrelated' }]; }],
    ['multiple PRs', f => { f.publication.prs = [f.pr, f.pr]; }],
    ['fork PR', f => { f.publication.prs = [{ ...f.pr, isCrossRepository: true }]; }],
    ['other branch PR', f => { f.publication.prs = [{ ...f.pr, headRefName: 'other' }]; }],
    ['missing PR number', f => { f.publication.prs = [{ ...f.pr, number: null }]; }],
    ['missing PR head', f => { f.publication.prs = [{ ...f.pr, headRefOid: null }]; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const f = await publicationFixture(t);
    mutate(f);
    writeFileSync(f.outputPath, JSON.stringify(f.result));
    await f.run();
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at, null);
    assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
  });
});

test('FINDINGSSHAPE-01 concurrent collectors fence publisher submission', async t => {
  const f = await publicationFixture(t);
  let unblock, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = f.run({ fetchPublication: async () => {
    entered();
    await new Promise(resolve => { unblock = resolve; });
    return f.publication;
  } });
  await ready;
  await f.run();
  assert.equal(f.dispatches.length, 1);
  unblock();
  await held;
  assert.equal(f.dispatches.length, 2);
});

test('FINDINGSSHAPE-01 branch discovery fences duplicate publication even after ref deletion', async t => {
  const f = await publicationFixture(t);
  const ghCalls = [];
  const execFileImpl = async (bin, args, opts) => {
    if (bin === 'hq') return f.options.execFileImpl(bin, args, opts);
    assert.equal(bin, 'gh');
    assert.equal(opts.timeout, 15_000);
    ghCalls.push(args);
    if (args[0] === 'pr') return { stdout: JSON.stringify(args[1] === 'view' ? f.publication.prs[0] : f.publication.prs) };
    assert.deepEqual(args, ['api', `repos/${repo}/git/ref/heads/fixture/findings`]);
    return { stdout: JSON.stringify({ object: { sha: head } }) };
  };
  // Omit the injected reader to exercise the production transport with stubs.
  const { runFindingBatches } = await import('../src/findings-batch.mjs');
  const options = { ...f.options };
  delete options.fetchPublication;
  await runFindingBatches({ now: fixtureNow, ...options, execFileImpl });
  assert.deepEqual(ghCalls, [
    ['pr', 'list', '--repo', repo, '--head', f.status.branch, '--state', 'all', '--limit', '100',
      '--json', 'number,headRefOid,body,headRefName,isCrossRepository'],
    ['api', `repos/${repo}/git/ref/heads/fixture/findings`],
  ]);
  for (const state of ['CLOSED', 'MERGED']) {
    f.publication.prs = [{ ...f.pr, state }];
    await runFindingBatches({ now: fixtureNow, ...options, execFileImpl });
    assert.equal(ghCalls.at(-1)[0], 'pr');
    assert.equal(f.dispatches.length, 2);
    assert.equal(Boolean(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at), state === 'MERGED');
  }
  assert.equal(ghCalls.filter(args => args[0] === 'api').length, 1);
});

test('FINDINGSSHAPE-01 hourly collection publishes a prepared batch without a new daily claim', async t => {
  const f = await publicationFixture(t);
  const { createFindingBatchTicker } = await import('../src/findings-batch.mjs');
  rmSync(f.outputPath);
  const ticker = createFindingBatchTicker(f.options);
  const now = Date.parse('2026-01-02T01:00:00Z');
  await ticker.tick(now);
  writeFileSync(f.outputPath, JSON.stringify(f.result));
  await ticker.tick(now + 3600000);
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.db.prepare('SELECT count(*) n FROM finding_batches').get().n, 1);
  await ticker.tick(now + 7200000);
  assert.equal(f.dispatches.length, 2);
});

test('FINDINGSSHAPE-01 ref reader encodes reserved characters within branch segments', async t => {
  const f = await publicationFixture(t);
  f.status.branch = 'fixture/topic#1+fix';
  const ghCalls = [];
  await f.run({ fetchPublication: undefined, execFileImpl: async (bin, args, opts) => {
    if (bin === 'hq') return f.options.execFileImpl(bin, args, opts);
    assert.equal(bin, 'gh');
    ghCalls.push(args);
    if (args[0] === 'pr') return { stdout: '[]' };
    return { stdout: JSON.stringify({ object: { sha: head } }) };
  } });
  assert.equal(ghCalls[0][ghCalls[0].indexOf('--head') + 1], 'fixture/topic#1+fix');
  assert.deepEqual(ghCalls[1], ['api', `repos/${repo}/git/ref/heads/fixture/topic%231%2Bfix`]);
  assert.equal(ghCalls.length, 2);
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, null);
});

test('FINDINGSSHAPE-01 unreadable command or ledger evidence preserves unresolved outcomes', async t => {
  for (const [boundary, reason] of [
    ['status', 'fixture evidence unavailable'],
    ['branch/PR', 'fixture evidence unavailable'],
    ['ledger', 'batch-publish-receipt-unavailable'],
  ]) await t.test(boundary, async t => {
    const f = await publicationFixture(t);
    const fail = async () => { throw Error('fixture evidence unavailable'); };
    const overrides = boundary === 'status' ? { execFileImpl: fail }
      : boundary === 'branch/PR' ? { fetchPublication: fail } : { readLaunches: fail };
    await f.run(overrides);
    assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, reason);
    assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
    assert.equal(f.dispatches.length, 1);
    await f.run();
    assert.equal(f.dispatches.length, 2, 'a read failure must not persist a submission intent');
  });
});

test('FINDINGSBATCH-02 covers 1000 findings in capped priority batches without daily or active-area ceilings', async t => {
  const { db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const source = db.prepare('SELECT * FROM review_findings LIMIT 1').get();
  db.prepare('DELETE FROM finding_backlog').run();
  const addFinding = db.prepare(`INSERT INTO review_findings
    (finding_id,pass_id,ordinal,content_sha256,blocking,finding_json,head_sha,reviewer_identity,hammer_identity)
    VALUES (?,?,?,?,0,?,?,'codex','synthetic-hammer')`);
  const addBacklog = db.prepare(`INSERT OR REPLACE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area,captured_at)
    VALUES (?,?,7,?,?,'codex',?,?)`);
  db.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      const id = `synthetic-${i}`, severity = i % 2 ? 'high' : 'low';
      addFinding.run(id, source.pass_id, i + 10, id, JSON.stringify({ severity }), head);
      addBacklog.run(id, repo, head, id, `area-${i % 3}`, `2026-01-${i % 2 ? '02' : '01'}T00:00:00Z`);
    }
  })();
  const { claimFindingBatches } = await import('../src/findings-batch.mjs');
  const batches = claimFindingBatches(db, '2026-01-02', { now: fixtureNow, batchSize: 37 });
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog WHERE batch_id IS NULL').get().n, 0);
  assert.ok(batches.length > 27);
  let previousSeverity = 'high';
  for (const b of batches) {
    const rows = db.prepare(`SELECT f.finding_json FROM finding_backlog b JOIN review_findings f USING(finding_id)
      WHERE batch_id=?`).all(b.batch_id);
    assert.ok(rows.length > 0 && rows.length <= 37);
    const severities = rows.map(r => JSON.parse(r.finding_json).severity);
    assert.ok(severities.every(s => s === severities[0]));
    if (previousSeverity === 'low') assert.equal(severities[0], 'low');
    previousSeverity = severities[0];
  }
  const first = db.prepare(`SELECT json_extract(f.finding_json,'$.severity') AS severity FROM finding_backlog b
    JOIN review_findings f USING(finding_id) WHERE batch_id=?`).all(batches[0].batch_id);
  assert.ok(first.every(r => r.severity === 'high'), 'severity outranks the older low-severity findings');
  assert.deepEqual(claimFindingBatches(db, '2026-01-02', { now: fixtureNow, batchSize: 37 }), []);
  assert.deepEqual(claimFindingBatches(db, '2026-01-03', { now: fixtureNow, batchSize: 37 }), []);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('FINDINGSBATCH-02 null status repo and absent milestone use ledger plus remote pushed head', async t => {
  for (const status of ['succeeded', 'blocked_needs_decision', 'failed']) await t.test(status, async t => {
    const f = await publicationFixture(t);
    Object.assign(f.status, { repo: null, status, terminal: true, succeeded: status === 'succeeded', milestones: {} });
    await f.run();
    assert.equal(f.dispatches.length, status === 'failed' ? 1 : 2);
    if (status === 'failed') assert.equal(f.db.prepare('SELECT error FROM finding_batches').get().error, 'batch-preparation-failed');
  });
  for (const failure of ['repo', 'launch', 'head']) await t.test(failure, async t => {
    const f = await publicationFixture(t);
    f.status.repo = null;
    f.status.milestones = {};
    if (failure === 'repo') f.launches[0].target_repo = 'synthetic/foreign';
    if (failure === 'launch') f.launches[0].launch_request_id = 'foreign';
    if (failure === 'head') f.publication.headSha = 'c'.repeat(40);
    await f.run();
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, null);
  });
});

test('FINDINGSBATCH-02 strict dropped vocabulary, ticket and zero-outcome failure', async t => {
  const f = await publicationFixture(t);
  const { settleFindingBatch } = await import('../src/findings-batch.mjs');
  const { normalizeDroppedReason } = await import('../src/findings-batch.mjs');
  const result = { ...f.result, findings: f.result.findings.map(r => ({ ...r, outcome: 'dropped' })) };
  // FINDINGSREQUEUE-01: these no longer error the batch; they re-verify (see its tests).
  for (const reason of ['No time', 'stale-code-changed', 'false-positive:', 'already-fixed-in-0: bad PR', 'unknown: text']) {
    assert.equal(normalizeDroppedReason(reason), null, reason);
  }
  result.findings[0].reason = 'out-of-scope-with-ticket: SYNTH-23 owns the broader refactor';
  assert.equal(settleFindingBatch(f.db, f.batch, result), true);
  f.db.prepare("INSERT INTO finding_batches(batch_id,repo,area,day) VALUES ('empty',?,'empty','2026-01-02')").run(repo);
  const empty = f.db.prepare("SELECT * FROM finding_batches WHERE batch_id='empty'").get();
  assert.throws(() => settleFindingBatch(f.db, empty, { batchId: 'empty', findings: [] }), /batch-zero-outcomes/);
});

test('FINDINGSBATCH-02 applied requires merge or an open current-head pipeline attachment', async t => {
  const f = await publicationFixture(t);
  const { settleFindingBatch } = await import('../src/findings-batch.mjs');
  const result = { ...f.result, prNumber: 81 };
  assert.equal(settleFindingBatch(f.db, f.batch, result, f.pr), false);
  f.db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref,review_status)
    VALUES (?,81,'2026-01-02','codex','open',?,'pending')`).run(repo, 'c'.repeat(40));
  assert.equal(settleFindingBatch(f.db, f.batch, result, f.pr), false);
  f.db.prepare('UPDATE reviewed_prs SET revision_ref=? WHERE pr_number=81').run(head);
  assert.equal(settleFindingBatch(f.db, f.batch, result, f.pr), true);
  assert.equal(f.db.prepare('SELECT result_pr FROM finding_backlog').get().result_pr, 81);
});

test('FINDINGSBATCH-02 health reports finding counts, outcome days, errors and overdue alert', async t => {
  const f = await publicationFixture(t);
  const { summarizeFindingBacklog, findingBacklogAlert } = await import('../src/findings-backlog.mjs');
  f.db.prepare("UPDATE finding_backlog SET captured_at='2026-01-01T00:00:00Z'").run();
  f.db.prepare("UPDATE finding_batches SET error='batch-preparation-failed'").run();
  const health = summarizeFindingBacklog(f.db, Date.parse('2026-01-04T00:00:00Z'));
  assert.equal(health.openCount, 1);
  assert.equal(health.unbatchedCount, 0);
  assert.equal(health.oldestOpenAgeMs, 72 * 3600000);
  assert.deepEqual(health.batchErrors, [{ error: 'batch-preparation-failed', count: 1 }]);
  assert.equal(findingBacklogAlert(health).code, 'review:findings_backlog_overdue');
  assert.equal(findingBacklogAlert(health, 96 * 3600000), null);
  f.db.prepare("UPDATE finding_backlog SET outcome='dropped',reason='false-positive: Current code already checks the input'").run();
  f.db.prepare("UPDATE finding_backlog SET resolved_at='2026-01-03T00:00:00Z'").run();
  const settled = summarizeFindingBacklog(f.db, fixtureNow);
  assert.equal(settled.openCount, 0);
  assert.equal(settled.oldestOpenAgeMs, 0);
  assert.deepEqual(settled.perDay, [{ day: '2026-01-03', applied: 0, dropped: 1 }]);
});

test('FINDINGSBATCH-02 configurable cadence claims newly captured findings within the same day', async t => {
  const { db, rootDir, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { createFindingBatchTicker } = await import('../src/findings-batch.mjs');
  let launches = 0;
  const ticker = createFindingBatchTicker({ db, rootDir, env: { HQ_ROOT: rootDir, ADVERSARIAL_FINDINGS_BATCH_INTERVAL_MS: '60000' },
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: `launch-${++launches}` }) }) });
  const now = Date.parse('2026-01-02T00:00:00Z');
  await ticker.tick(now);
  pass(2, body.replace('Explain the result', 'Explain another result'));
  await ticker.tick(now + 59999);
  assert.equal(launches, 1);
  await ticker.tick(now + 60000);
  assert.equal(launches, 2);
});

test('FINDINGSBATCH-02 operator backfill is explicit, capped and idempotent with synthetic dispatch', async t => {
  const { rootDir, db, pass } = fixture(t);
  const finding = body.slice(body.indexOf('- **Explain'), body.indexOf('## Verdict'));
  pass(1, body.replace(finding, Array.from({ length: 7 }, (_, i) => finding.replace('Explain the result', `Explain result ${i}`)).join('')));
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const { main } = await import('../bin/findings-batch-backfill.mjs');
  await assert.rejects(main([]), /required/);
  const args = ['--root', rootDir, '--db', join(rootDir, 'data', 'reviews.db'), '--concurrency', '2', '--batch-size', '1'];
  let calls = 0, active = 0, peak = 0;
  const dependencies = { now: fixtureNow, env: { HQ_ROOT: rootDir }, execFileImpl: async () => {
    const launch = ++calls;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { stdout: JSON.stringify({ launchRequestId: `synthetic-backfill-${launch}` }) };
  } };
  await main(args, dependencies);
  await main(args, dependencies);
  assert.equal(calls, 7);
  assert.equal(peak, 2);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batches').get().n, 7);
});

test('FINDINGSBATCH-02 migration preserves assigned parents with foreign keys enabled', async t => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE finding_batches(batch_id TEXT PRIMARY KEY,repo TEXT,area TEXT,day TEXT,
    launch_id TEXT,completed_at TEXT,error TEXT,result_json TEXT,UNIQUE(repo,area,day));
    CREATE UNIQUE INDEX finding_batches_active ON finding_batches(repo,area) WHERE completed_at IS NULL;
    CREATE TABLE finding_backlog(finding_id TEXT PRIMARY KEY,batch_id TEXT REFERENCES finding_batches(batch_id),outcome TEXT,reason TEXT);
    CREATE TABLE reviewed_prs(repo TEXT,pr_number INTEGER,pr_state TEXT);
    CREATE TABLE finding_batch_notes(note_id TEXT,batch_id TEXT REFERENCES finding_batches(batch_id));
    INSERT INTO finding_batches VALUES ('retained','synthetic/service','src','2026-01-01','launch',NULL,'old error',NULL);
    INSERT INTO finding_backlog VALUES ('retained-finding','retained',NULL,NULL);
    INSERT INTO finding_batch_notes VALUES ('retained-note','retained');`);
  const sql = readFileSync(new URL('../migrations/20261030_findings_batch_drain.sql', import.meta.url), 'utf8');
  db.exec(`INSERT INTO finding_batches VALUES ('empty','synthetic/service','empty','2026-01-01',NULL,'2026-01-02',NULL,'{"findings":[]}');`);
  db.transaction(() => db.exec(sql))();
  assert.deepEqual(db.prepare("SELECT completed_at,error FROM finding_batches WHERE batch_id='empty'").get(),
    { completed_at: null, error: 'batch-zero-outcomes' });
  assert.equal(db.prepare('SELECT launch_id FROM finding_batches').get().launch_id, 'launch');
  assert.equal(db.prepare('SELECT batch_id FROM finding_backlog').get().batch_id, 'retained');
  assert.equal(db.prepare('SELECT batch_id FROM finding_batch_notes').get().batch_id, 'retained');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.prepare("INSERT INTO finding_batches(batch_id,repo,area,day) VALUES ('new','synthetic/service','src','2026-01-01')").run();
});

test('FINDINGSBATCH-02 pipeline health routes the configured backlog age alert without external reads', async t => {
  const { db, rootDir, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  db.prepare("UPDATE finding_backlog SET captured_at='2026-01-01T00:00:00Z'").run();
  const { collectReviewPipelineHealth, evaluateReviewPipelineFindings, resolveReviewPipelineHealthConfig }
    = await import('../src/review-pipeline-health.mjs');
  const snapshot = collectReviewPipelineHealth({ rootDir, hqRoot: rootDir, env: { HQ_ROOT: rootDir },
    now: () => new Date('2026-01-04T00:00:00Z'), config: { hostChecksEnabled: false },
    execFileSyncImpl: () => { throw Error('external reads prohibited'); }, listOpenPrsSyncImpl: () => [] });
  assert.equal(snapshot.nonBlockingBacklog.openCount, 1);
  assert.equal(snapshot.nonBlockingBacklog.oldestOpenAgeMs, 72 * 3600000);
  assert.equal(snapshot.findings.filter(f => f.code === 'review:findings_backlog_overdue').length, 1);
  const config = resolveReviewPipelineHealthConfig({ ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS: String(96 * 3600000) });
  assert.equal(evaluateReviewPipelineFindings({ ...snapshot, config }, { observedAt: snapshot.observedAt })
    .some(f => f.code === 'review:findings_backlog_overdue'), false);
  const configured = collectReviewPipelineHealth({ rootDir, hqRoot: rootDir,
    env: { HQ_ROOT: rootDir, ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS: 'abc' },
    now: () => new Date('2026-01-04T12:00:00Z'),
    config: { hostChecksEnabled: false, findingsBacklogMaxAgeMs: 96 * 3600000 },
    execFileSyncImpl: () => { throw Error('external reads prohibited'); }, listOpenPrsSyncImpl: () => [] });
  assert.equal(configured.nonBlockingBacklog.available, true);
  assert.equal(configured.nonBlockingBacklog.batchableCount, 1);
  assert.equal(configured.nonBlockingBacklog.outOfWindow, 0);
  assert.equal(configured.findings.some(f => f.code === 'review:findings_backlog_overdue'), false);
});

test('FINDINGSBATCH-02 worker drop artifacts settle every justified vocabulary code', async t => {
  for (const reason of ['stale-code-changed: Current function was replaced',
    ' already-fixed-in-23: The merged fix removes the obsolete branch ',
    'not-reproducible: The cited input passes the focused reproduction',
    'out-of-scope-with-ticket: SYNTH-23 tracks the broader change',
    'false-positive: Current validation rejects the cited input']) {
    await t.test(reason.trim().split(':')[0], async t => {
      const f = await publicationFixture(t);
      writeFileSync(f.outputPath, JSON.stringify({ ...f.result,
        findings: f.result.findings.map(row => ({ ...row, outcome: 'dropped', reason })) }));
      const reads = [];
      await f.run({ fetchPr: async (target, number) => {
        reads.push([target, number]);
        return { state: 'MERGED' };
      } });
      assert.deepEqual(reads, []);
      assert.equal(f.db.prepare('SELECT outcome FROM finding_backlog').get().outcome, 'dropped');
      assert.equal(f.db.prepare('SELECT result_pr FROM finding_backlog').get().result_pr, null);
      assert.ok(f.db.prepare('SELECT completed_at FROM finding_batches').get().completed_at);
      assert.equal(f.dispatches.length, 1);
    });
  }
});


test('operator backfill waits for a contending SQLite writer', async t => {
  const { rootDir, db, pass } = fixture(t);
  pass();
  db.prepare("UPDATE reviewed_prs SET pr_state='merged'").run();
  const dbPath = join(rootDir, 'data', 'reviews.db');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db = new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 500);
  `, dbPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  writer.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    writer.once('error', reject);
    writer.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => { if (writer.exitCode === null) writer.kill(); await exited; });
  await new Promise((resolve, reject) => {
    writer.stdout.once('data', resolve);
    writer.once('error', reject);
    writer.once('exit', () => reject(new Error(`writer exited before locking: ${stderr}`)));
  });
  const { main } = await import('../bin/findings-batch-backfill.mjs');
  await main(['--root', rootDir, '--db', dbPath, '--concurrency', '1'], {
    now: fixtureNow,
    env: { HQ_ROOT: rootDir },
    execFileImpl: async () => ({ stdout: JSON.stringify({ launchRequestId: 'contended-backfill' }) }),
  });
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.equal(db.prepare('SELECT launch_id FROM finding_batches').get().launch_id, 'contended-backfill');
});
