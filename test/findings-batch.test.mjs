import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'findings-batch-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
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
  return { rootDir, db, pass };
}

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
