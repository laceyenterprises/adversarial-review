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
import { captureReadyFindings, summarizeFindingBacklog, findingBacklogAlert, retireExpiredFindings } from '../src/findings-backlog.mjs';
import { main as reviewFindingsCli } from '../bin/review-findings.mjs';

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
    const health = summarizeFindingBacklog(db, now, { maxAgeMs });
    assert.equal(health.available, true, health.error);
    assert.deepEqual(health.areas, []);
    assert.equal(health.notesHistorical, 1);
    assert.equal(health.notesOutOfWindow, 0);
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
    // Unknown merge clocks already receive a lifecycle drop on note capture.
    assert.equal(health.notesOutOfWindow, mergedAt === '2026-06-08T11:59:59.999Z' ? 1 : 0);
    assert.equal(health.notesHistorical, 0);
    assert.equal(health.areas.reduce((sum, area) => sum + area.size, 0), 1);
  }
});

test('the window includes its exact boundary and honors configured duration', t => {
  const { db, pass } = fixture(t, '2026-06-08T12:00:00Z');
  persistReviewFindings(db, pass.pass_id);
  assert.deepEqual(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs: maxAgeMs - 1 }), []);
  assert.equal(summarizeFindingBacklog(db, now, { maxAgeMs }).outOfWindow, 0);
  assert.ok(claimFindingBatches(db, '2026-06-10', { now, maxAgeMs }).length);
  const owned = summarizeFindingBacklog(db, now + maxAgeMs, { maxAgeMs });
  assert.equal(owned.areas.reduce((sum, area) => sum + area.size, 0), 2);
  assert.equal(owned.notesOutOfWindow, 0);
});

test('a stalled runner alerts after ordinary merge-time enrollments age out', t => {
  const { db, pass } = fixture(t, '2026-06-10T00:00:00Z');
  persistReviewFindings(db, pass.pass_id);
  db.prepare("UPDATE finding_backlog SET captured_at='2026-06-10T00:00:00Z'").run();
  assert.equal(findingBacklogAlert(summarizeFindingBacklog(db, now, { maxAgeMs }), maxAgeMs), null);
  const later = now + maxAgeMs;
  const health = summarizeFindingBacklog(db, later, { maxAgeMs });
  assert.equal(health.batchableCount, 0);
  assert.equal(health.outOfWindow, 1);
  const alert = findingBacklogAlert(health, maxAgeMs);
  assert.equal(alert.code, 'review:findings_backlog_overdue');
  assert.ok(alert.evidence.includes('outOfWindow=1'));
  assert.match(alert.recommendedAction, /explicit consensus-validated manifest/);
  assert.deepEqual(claimFindingBatches(db, '2026-06-12', { now: later, maxAgeMs }), []);
  const retired = retireExpiredFindings(db, { repo, reason: 'Operator accepted expiry without a correctness judgment',
    now: later, maxAgeMs, apply: true });
  assert.equal(retired.retired, 1);
  const row = db.prepare('SELECT * FROM finding_backlog').get();
  assert.equal(row.outcome, 'dropped');
  assert.equal(row.reason, 'out-of-window: Operator accepted expiry without a correctness judgment');
  assert.ok(row.resolved_at);
  assert.equal(row.batch_attempts, 0);
  assert.equal(row.result_pr, null);
  assert.equal(findingBacklogAlert(summarizeFindingBacklog(db, later, { maxAgeMs }), maxAgeMs), null);
  assert.equal(retireExpiredFindings(db, { repo, reason: 'Repeated disposition', now: later, maxAgeMs, apply: true }).retired, 0);
});

test('invalid default windows degrade only backlog health and explicit windows take precedence', t => {
  const { db, pass } = fixture(t, '2026-06-10T00:00:00Z');
  persistReviewFindings(db, pass.pass_id);
  const previous = process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS;
  try {
    for (const invalid of ['abc', '0', '']) {
      process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS = invalid;
      assert.equal(summarizeFindingBacklog(null, now).error, 'review-store-unavailable');
      const health = summarizeFindingBacklog(db, now);
      assert.equal(health.available, false);
      assert.match(health.error, /invalid ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS/);
      assert.equal(summarizeFindingBacklog(db, now, { maxAgeMs }).available, true);
    }
  } finally {
    if (previous === undefined) delete process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS;
    else process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS = previous;
  }
});

test('backlog summaries retain pre-requeue schema compatibility', t => {
  const { db, pass } = fixture(t, '2026-06-10T00:00:00Z');
  persistReviewFindings(db, pass.pass_id);
  db.exec('ALTER TABLE finding_batches DROP COLUMN released_at');
  db.exec('ALTER TABLE finding_backlog DROP COLUMN batch_attempts');
  const health = summarizeFindingBacklog(db, now, { maxAgeMs });
  assert.equal(health.available, true, health.error);
  assert.equal(health.batchableCount, 1);
  assert.equal(health.outOfWindow, 0);
  assert.equal(health.progress, null);
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

test('manifest claims ignore automatic clock/window configuration', t => {
  const { db } = fixture(t);
  backfillReviewFindings(db);
  const { finding_id } = db.prepare('SELECT finding_id FROM review_findings').get();
  const findings = [{ finding_id, head_sha: head, pr_number: 7, repo }];
  const manifest = { version: 1, findings, heads: [{ head_sha: head, pr_number: 7, repo }],
    sha256: createHash('sha256').update(JSON.stringify({ findings, version: 1 })).digest('hex') };
  const previous = process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS;
  try {
    process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS = 'invalid';
    assert.equal(claimFindingBatches(db, '2026-06-10', { manifest, now: NaN,
      readConsensus: () => ({ label: 'real' }) }).length, 1);
  } finally {
    if (previous === undefined) delete process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS;
    else process.env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS = previous;
  }
});

test('direct automatic claims resolve their window from the caller env', t => {
  const { db, pass } = fixture(t, '2026-06-08T12:00:00Z');
  persistReviewFindings(db, pass.pass_id);
  const env = { ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS: String(maxAgeMs - 1) };
  assert.deepEqual(claimFindingBatches(db, '2026-06-10', { now, env }), []);
  assert.ok(claimFindingBatches(db, '2026-06-10', { now,
    env: { ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS: String(maxAgeMs) } }).length);
});

test('live replays of existing legacy observations do not create backlog enrollment', t => {
  const { db, pass } = fixture(t);
  persistReviewFindings(db, pass.pass_id);
  // Simulate a live-default observation predating backlog deployment.
  db.prepare('DELETE FROM finding_backlog').run();
  assert.equal(persistReviewFindings(db, pass.pass_id), 0);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
  assert.equal(summarizeFindingBacklog(db, now, { maxAgeMs }).outOfWindow, 0);
});

test('bounded expiry disposition previews read-only and preserves ownership, retries and selections', t => {
  const { db, pass, root } = fixture(t);
  const findings = Array.from({ length: 9 }, (_, i) => `- **Finding ${i}**
  - **File:** src/result.mjs
  - **Lines:** 2
  - **Problem:** Missing documentation ${i}.`).join('\n');
  db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?')
    .run(`## Blocking Issues\n- None.\n## Non-blocking Issues\n${findings}`, pass.pass_id);
  persistReviewFindings(db, pass.pass_id);
  const rows = db.prepare('SELECT * FROM finding_backlog ORDER BY finding_id').all();
  assert.equal(rows.length, 9);
  db.prepare("INSERT INTO finding_batches(batch_id,repo,area,day) VALUES ('owned',?,'src','2026-06-10')").run(repo);
  db.prepare("UPDATE finding_backlog SET batch_id='owned' WHERE finding_id=?").run(rows[2].finding_id);
  db.prepare('UPDATE finding_backlog SET batch_attempts=1 WHERE finding_id=?').run(rows[3].finding_id);
  db.prepare('UPDATE finding_backlog SET manifest_sha256=? WHERE finding_id=?').run('b'.repeat(64), rows[4].finding_id);
  db.prepare("UPDATE finding_backlog SET outcome='dropped',reason='not-reproducible: Verified' WHERE finding_id=?")
    .run(rows[5].finding_id);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,merged_at)
    VALUES (?,8,'2026-06-10','codex','merged','9999-01-01T00:00:00Z'),(?,9,'2026-06-10','codex','open',NULL)`).run(repo, repo);
  db.prepare('UPDATE finding_backlog SET pr_number=8 WHERE finding_id=?').run(rows[6].finding_id);
  db.prepare('UPDATE finding_backlog SET pr_number=9 WHERE finding_id=?').run(rows[7].finding_id);
  db.prepare("UPDATE finding_backlog SET repo='other/service' WHERE finding_id=?").run(rows[8].finding_id);
  const before = db.prepare('SELECT * FROM finding_backlog ORDER BY finding_id').all();
  const args = ['retire-expired', '--db', join(root, 'data', 'reviews.db'), '--repo', repo,
    '--limit', '1', '--reason', 'Operator accepts age expiry'];
  const preview = reviewFindingsCli(args);
  assert.equal(preview.applied, false);
  assert.equal(preview.retired, 0);
  assert.deepEqual(preview.findings, [rows[0].finding_id]);
  assert.deepEqual(db.prepare('SELECT * FROM finding_backlog ORDER BY finding_id').all(), before);
  assert.equal(reviewFindingsCli([...args, '--apply']).retired, 1);
  assert.equal(reviewFindingsCli([...args, '--apply']).retired, 1);
  assert.equal(reviewFindingsCli([...args, '--apply']).retired, 0);
  assert.deepEqual(db.prepare('SELECT * FROM finding_backlog WHERE finding_id NOT IN (?,?) ORDER BY finding_id')
    .all(rows[0].finding_id, rows[1].finding_id), before.slice(2));
  for (const bad of [{ repo: null }, { reason: '' }, { reason: 'multiple\nlines' }, { limit: 0 }, { limit: 501 }]) {
    assert.throws(() => retireExpiredFindings(db, { repo, reason: 'Expiry', now, maxAgeMs, ...bad }));
  }
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
