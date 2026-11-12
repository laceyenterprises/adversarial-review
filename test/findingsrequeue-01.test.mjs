import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { claimFindingBatches, releaseFindingBatch, runFindingBatches, settleFindingBatch,
  normalizeDroppedReason, FINDING_BATCH_MAX_ATTEMPTS } from '../src/findings-batch.mjs';
import { summarizeFindingBacklog } from '../src/findings-backlog.mjs';

// Synthetic repository, findings and launches only.
test.mock.method(Date, 'now', () => Date.parse('2026-01-02T00:00:00Z'));

const repo = 'sample/service', head = 'a'.repeat(40), DAY = 24 * 3600000;
const finding = title => `- **${title}**
  - **File:** \`src/result.mjs\`
  - **Lines:** 2
  - **Problem:** ${title} lacks a description.
`;
const reviewBody = titles => `## Blocking Issues
- None.
## Non-blocking Issues
${titles.map(finding).join('')}## Verdict
Comment only
`;

function fixture(t, titles = ['First result', 'Second result', 'Third result']) {
  const rootDir = mkdtempSync(join(tmpdir(), 'findings-requeue-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref) VALUES (?,7,?,'codex','open',?)")
    .run(repo, '2026-01-01T00:00:00Z', head);
  const key = { repo, prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  const pass = beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(rootDir, { ...key, bodyMd: reviewBody(titles), verdict: 'comment-only' });
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='1', body_captured_at='2026-01-01T00:00:01Z' WHERE pass_id=?")
    .run(pass.pass_id);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged',merged_at='2026-01-02T00:00:00Z'").run();
  const env = { HQ_ROOT: rootDir };
  const dispatches = [];
  const launches = new Map(); // idempotency key -> ledger rows
  const status = { repo, branch: 'synthetic/findings', status: 'blocked_needs_decision', terminal: true,
    succeeded: false, milestones: { branch_pushed: { status: 'failed' } } };
  const publication = { prs: [], headSha: null };
  const reads = { publication: 0 };
  const execFileImpl = async (_bin, args) => {
    if (args[1] === 'status') return { stdout: JSON.stringify({ ...status, launchRequestId: args[2] }) };
    dispatches.push(args);
    const idempotencyKey = args[args.indexOf('--idempotency-key') + 1];
    const id = `synthetic-launch-${dispatches.length}`;
    launches.set(idempotencyKey, [...(launches.get(idempotencyKey) || []), { launch_request_id: id,
      idempotency_key: idempotencyKey, ticket_ref: args[args.indexOf('--ticket') + 1], target_repo: 'service',
      status: 'running' }]);
    return { stdout: JSON.stringify({ launchRequestId: id }) };
  };
  const options = { db, rootDir, env, execFileImpl, logger: { warn() {} },
    readLaunches: async ({ idempotencyKey }) => ({ ok: true, rows: launches.get(idempotencyKey) || [] }),
    readLaunchSnapshot: async ({ launchRequestIds }) => {
      const rows = [...launches.values()].flat().filter(row => launchRequestIds.includes(row.launch_request_id));
      return rows.length ? { ok: true, rows }
        : { ok: false, reason: 'dispatch-read-unavailable', detail: 'dispatch absence scope unproven' };
    },
    fetchPublication: async () => { reads.publication++; return publication; },
    fetchPr: async () => ({ state: 'MERGED' }) };
  const run = overrides => runFindingBatches({ ...options, ...overrides });
  const batches = () => db.prepare('SELECT * FROM finding_batches ORDER BY rowid').all();
  const backlog = () => db.prepare('SELECT finding_id,batch_id,batch_attempts,outcome,reason FROM finding_backlog ORDER BY finding_id').all();
  const endLaunches = (value = 'blocked_needs_decision') => {
    for (const rows of launches.values()) for (const row of rows) row.status = value;
  };
  const writeOutcomes = (batch, findings, extra = {}) => writeFileSync(
    join(rootDir, 'data', 'finding-batches', batch.batch_id, 'outcomes.json'),
    JSON.stringify({ batchId: batch.batch_id, prNumber: null, headSha: null, findings, ...extra }));
  const ids = batch => db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=? ORDER BY finding_id')
    .all(batch.batch_id).map(r => r.finding_id);
  return { rootDir, db, env, dispatches, launches, status, publication, reads, options, run, batches, backlog,
    endLaunches, writeOutcomes, ids };
}

const applied = id => ({ findingId: id, outcome: 'applied', reason: 'Documented the return value' });

test('an ended launch whose push never landed releases its findings and the next batching pass claims them', async t => {
  for (const [name, extra] of [
    ['applied claim with no pushed head', {}],
    ['tested head missing from the remote branch', { headSha: head }],
  ]) await t.test(name, async t => {
    const f = fixture(t);
    await f.run({ day: '2026-01-02' });
    const [first] = f.batches();
    f.writeOutcomes(first, f.ids(first).map(applied), extra);
    f.endLaunches();
    await f.run({ resolutionOnly: true });
    const released = f.batches()[0];
    assert.equal(released.error, extra.headSha ? 'batch-push-evidence-mismatch' : 'batch-push-evidence-missing');
    assert.equal(released.release_reason, released.error);
    assert.ok(released.released_at);
    assert.equal(released.completed_at, null);
    assert.deepEqual(f.backlog().map(r => [r.batch_id, r.batch_attempts, r.outcome]),
      [[null, 1, null], [null, 1, null], [null, 1, null]]);
    const audit = f.db.prepare('SELECT batch_id,attempt,reason,disposition FROM finding_batch_releases').all();
    assert.equal(audit.length, 3);
    assert.ok(audit.every(r => r.batch_id === first.batch_id && r.attempt === 1
      && r.reason === released.error && r.disposition === 'requeued'));
    // A later collection pass leaves the released batch alone.
    await f.run({ resolutionOnly: true });
    assert.equal(f.dispatches.length, 1);
    // The next batching pass claims the findings into a fresh batch and worker.
    await f.run({ day: '2026-01-03' });
    const [, retry] = f.batches();
    assert.notEqual(retry.batch_id, first.batch_id);
    assert.equal(f.ids(retry).length, 3);
    assert.equal(f.dispatches.length, 2);
    const keyOf = args => args[args.indexOf('--idempotency-key') + 1];
    assert.equal(keyOf(f.dispatches[1]), `findings-batch-${retry.batch_id}`);
    assert.notEqual(keyOf(f.dispatches[1]), keyOf(f.dispatches[0]));
  });
});

test('a batch with any live keyed launch, or unreadable launch evidence, is untouched', async t => {
  await t.test('live preparation past the timeout with no outcomes', async t => {
    const f = fixture(t);
    await f.run({ day: '2026-01-02' });
    await f.run({ resolutionOnly: true, now: Date.now() + 3 * DAY });
    assert.equal(f.batches()[0].released_at, null);
    assert.ok(f.backlog().every(r => r.batch_id === f.batches()[0].batch_id && r.batch_attempts === 0));
  });
  await t.test('non-retryable error while a keyed publisher is still live', async t => {
    const f = fixture(t);
    await f.run({ day: '2026-01-02' });
    const [batch] = f.batches();
    f.writeOutcomes(batch, f.ids(batch).map(applied));
    f.endLaunches();
    f.launches.get(`findings-batch-${batch.batch_id}`).push({ launch_request_id: 'synthetic-publisher',
      idempotency_key: `findings-batch-${batch.batch_id}`, ticket_ref: `FINDINGS-${batch.batch_id}`,
      target_repo: 'service', status: 'running' });
    await f.run({ resolutionOnly: true });
    assert.equal(f.batches()[0].error, 'batch-push-evidence-missing');
    assert.equal(f.batches()[0].released_at, null);
    assert.equal(f.db.prepare('SELECT count(*) n FROM finding_batch_releases').get().n, 0);
  });
  await t.test('unreadable ledger', async t => {
    const f = fixture(t);
    await f.run({ day: '2026-01-02' });
    const [batch] = f.batches();
    f.writeOutcomes(batch, f.ids(batch).map(applied));
    await f.run({ resolutionOnly: true, now: Date.now() + 3 * DAY,
      readLaunches: async () => ({ ok: false, reason: 'synthetic-unavailable' }) });
    assert.equal(f.batches()[0].released_at, null);
  });
});

test('a missing direct snapshot holds custody while a terminal keyed launch can time out', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  f.launches.clear();
  const launchedAt = Date.parse(f.batches()[0].launched_at);
  await f.run({ resolutionOnly: true, now: launchedAt + DAY - 1 });
  assert.equal(f.batches()[0].released_at, null);
  const logs = [];
  await f.run({ resolutionOnly: true, now: launchedAt + DAY + 1,
    logger: { warn: message => logs.push(message) } });
  assert.equal(f.batches()[0].released_at, null);
  assert.ok(f.backlog().every(r => r.batch_id !== null && r.batch_attempts === 0));
  assert.ok(logs.some(message => message.includes('needs-operator:') || message.includes('batch-launch-probe-unreadable')));
  // A legacy row with no launched_at ages from its claim day.
  const g = fixture(t);
  await g.run({ day: '2026-01-02' });
  g.db.prepare('UPDATE finding_batches SET launched_at=NULL').run();
  g.endLaunches('failed');
  await g.run({ resolutionOnly: true, now: Date.parse('2026-01-03T00:00:01Z') });
  assert.ok(g.batches()[0].released_at);
  const timeout = fixture(t);
  await timeout.run({ day: '2026-01-02' });
  timeout.endLaunches('failed');
  await timeout.run({ resolutionOnly: true, now: Date.now() + 2 * 3600000,
    env: { ...timeout.env, ADVERSARIAL_FINDINGS_BATCH_TIMEOUT_MS: '3600000' } });
  assert.ok(timeout.batches()[0].released_at, 'the timeout is configurable');
});

test('the attempt cap drops a finding with the exhausted reason instead of leaving it open', async t => {
  const f = fixture(t, ['Only result']);
  assert.equal(FINDING_BATCH_MAX_ATTEMPTS, 3);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [batch] = claimFindingBatches(f.db, `2026-01-0${attempt}`);
    assert.ok(batch, `attempt ${attempt} is batched`);
    const released = releaseFindingBatch(f.db, batch, `batch-preparation-failed\n  detail ${attempt}`);
    assert.deepEqual([released.requeued, released.exhausted], attempt < 3 ? [1, 0] : [0, 1]);
    assert.equal(releaseFindingBatch(f.db, batch, 'again'), null, 'release is idempotent');
  }
  const [row] = f.backlog();
  assert.equal(row.outcome, 'dropped');
  assert.equal(row.reason, 'batch-retry-exhausted: batch-preparation-failed detail 3');
  assert.equal(row.batch_attempts, 3);
  assert.deepEqual(claimFindingBatches(f.db, '2026-01-09'), []);
  assert.deepEqual(f.db.prepare('SELECT attempt,disposition FROM finding_batch_releases ORDER BY release_id').all(),
    [{ attempt: 1, disposition: 'requeued' }, { attempt: 2, disposition: 'requeued' }, { attempt: 3, disposition: 'exhausted' }]);
  assert.ok(f.db.prepare('SELECT resolved_at FROM finding_backlog').get().resolved_at);
  assert.equal(f.db.prepare('SELECT count(*) n FROM review_finding_grades').get().n, 0,
    'retry exhaustion is a worker outcome, not a reviewer correctness grade');
});

test('a mixed batch with legacy reasons maps the unambiguous one, re-verifies the other and settles the rest', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  const [batch] = f.batches();
  const [a, b, c] = f.ids(batch);
  f.writeOutcomes(batch, [
    { findingId: a, outcome: 'dropped', reason: 'False positive - the input is validated upstream' },
    { findingId: b, outcome: 'dropped', reason: 'This looks stale' },
    { findingId: c, outcome: 'dropped', reason: 'not-reproducible: The focused reproduction passes' },
  ]);
  await f.run({ resolutionOnly: true });
  const stored = f.batches()[0];
  assert.ok(stored.completed_at);
  assert.equal(stored.error, null);
  assert.deepEqual(JSON.parse(stored.result_json).requeued, [{ findingId: b, reason: 'invalid-dropped-reason' }]);
  const rows = Object.fromEntries(f.backlog().map(r => [r.finding_id, r]));
  assert.equal(rows[a].reason, 'false-positive: the input is validated upstream');
  assert.equal(rows[c].reason, 'not-reproducible: The focused reproduction passes');
  assert.deepEqual([rows[b].outcome, rows[b].batch_id, rows[b].batch_attempts], [null, null, 1]);
  assert.equal(f.dispatches.length, 1);
  assert.deepEqual(f.db.prepare('SELECT finding_id,taxonomy_code FROM review_finding_grades ORDER BY finding_id').all(),
    [{ finding_id: a, taxonomy_code: 'fp.unclassified' }, { finding_id: c, taxonomy_code: 'ind.cannot-reproduce' }]);
  await f.run({ day: '2026-01-03' });
  assert.deepEqual(f.ids(f.batches()[1]), [b]);
});

test('legacy drop reasons map only when the code is unambiguous', () => {
  for (const [input, expected] of [
    ['stale-code-changed: Function was replaced', 'stale-code-changed: Function was replaced'],
    ['Stale: function was replaced', 'stale-code-changed: function was replaced'],
    ['already fixed in #23: removed the branch', 'already-fixed-in-23: removed the branch'],
    ['Not reproducible — passes locally', 'not-reproducible: passes locally'],
    ['out of scope: SYNTH-4 tracks it', 'out-of-scope-with-ticket: SYNTH-4 tracks it'],
    ['superseded-final-review', 'stale-code-changed: Final posted review superseded this finding'],
    ['pr-closed-without-merge', 'false-positive: Source PR closed without merge; reviewed changes did not land'],
    ['already fixed: removed the branch', null],
    ['This looks stale', null],
    ['stale-code-changed', null],
    ['Fixed upstream: see main', null],
    ['', null],
    [undefined, null],
  ]) assert.equal(normalizeDroppedReason(input), expected, String(input));
});

test('a batch that legitimately produces no change settles cleanly without push or publication evidence', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  const [batch] = f.batches();
  f.writeOutcomes(batch, f.ids(batch).map(findingId => ({ findingId, outcome: 'dropped',
    reason: 'stale-code-changed: The cited function no longer exists on main' })));
  f.status.milestones = { branch_pushed: { status: 'not_started' } };
  f.endLaunches('succeeded');
  await f.run({ resolutionOnly: true, now: Date.now() + 3 * DAY });
  const stored = f.batches()[0];
  assert.ok(stored.completed_at);
  assert.equal(stored.error, null);
  assert.equal(stored.released_at, null);
  assert.equal(f.reads.publication, 0);
  assert.ok(f.backlog().every(r => r.outcome === 'dropped' && r.batch_attempts === 0));
});

test('backlog progress reports open, unbatched, batched, stranded, retrying and exhausted counts', async t => {
  const f = fixture(t, ['A result', 'B result', 'C result', 'D result', 'E result']);
  const ids = f.backlog().map(r => r.finding_id);
  const summary = () => summarizeFindingBacklog(f.db).progress;
  assert.deepEqual(summary(), { open: 5, unbatched: 5, batched: 0, stranded: 0, retrying: 0, exhausted: 0, releasedBatches: 0 });
  const insertBatch = (id, error = null) => f.db.prepare(`INSERT INTO finding_batches(batch_id,repo,area,day,launch_id,error)
    VALUES (?,?,'src','2026-01-02','synthetic',?)`).run(id, repo, error);
  insertBatch('synthetic-running');
  insertBatch('synthetic-errored', 'batch-push-evidence-missing');
  insertBatch('synthetic-released');
  f.db.prepare("UPDATE finding_backlog SET batch_id='synthetic-running' WHERE finding_id=?").run(ids[0]);
  f.db.prepare("UPDATE finding_backlog SET batch_id='synthetic-errored' WHERE finding_id IN (?,?)").run(ids[1], ids[2]);
  f.db.prepare("UPDATE finding_backlog SET batch_id='synthetic-released' WHERE finding_id IN (?,?)").run(ids[3], ids[4]);
  f.db.prepare("UPDATE finding_backlog SET batch_attempts=2 WHERE finding_id=?").run(ids[4]);
  releaseFindingBatch(f.db, { batch_id: 'synthetic-released' }, 'batch-preparation-failed');
  const health = summarizeFindingBacklog(f.db);
  assert.deepEqual(health.progress, { open: 4, unbatched: 1, batched: 1, stranded: 2, retrying: 1, exhausted: 1, releasedBatches: 1 });
  assert.equal(health.openCount, health.progress.open);
  assert.deepEqual(health.batchErrors, [{ error: 'batch-push-evidence-missing', count: 1 }]);
  // The release pass drains the stranded pair once their launch has ended.
  releaseFindingBatch(f.db, { batch_id: 'synthetic-errored' }, 'batch-push-evidence-missing');
  assert.deepEqual(summary(), { open: 4, unbatched: 3, batched: 1, stranded: 0, retrying: 3, exhausted: 1, releasedBatches: 2 });
  assert.deepEqual(summarizeFindingBacklog(f.db).batchErrors, []);
});

test('released advisories are retired with the reason and leave the unresolved view', async t => {
  const f = fixture(t, ['Only result']);
  f.db.prepare("UPDATE schema_migrations SET applied_at='2026-01-01 00:00:00' WHERE id='20261024_simplicity_batch.sql'").run();
  const passId = f.db.prepare('SELECT pass_id FROM reviewer_passes').get().pass_id;
  f.db.prepare(`INSERT INTO finding_batch_notes(note_id,pass_id,repo,pr_number,head_sha,note)
    VALUES ('synthetic-note',?,?,7,?,'Reuse the formatter (~5 lines saved).')`).run(passId, repo, head);
  const [batch] = claimFindingBatches(f.db, '2026-01-02');
  assert.equal(f.db.prepare('SELECT batch_id FROM finding_batch_notes').get().batch_id, batch.batch_id);
  assert.equal(releaseFindingBatch(f.db, batch, 'batch-preparation-failed').notes, 1);
  assert.equal(f.db.prepare('SELECT dropped_reason FROM finding_batch_notes').get().dropped_reason,
    'batch-released: batch-preparation-failed');
  assert.deepEqual(summarizeFindingBacklog(f.db).areas.map(a => a.size), [1]);
});

test('the requeue migration is idempotent on re-application', async t => {
  const f = fixture(t, ['Only result']);
  const [batch] = claimFindingBatches(f.db, '2026-01-02');
  releaseFindingBatch(f.db, batch, 'batch-preparation-failed');
  f.db.prepare("DELETE FROM schema_migrations WHERE id='20261107_findings_batch_requeue.sql'").run();
  ensureReviewStateSchema(f.db);
  assert.equal(f.db.prepare('SELECT batch_attempts FROM finding_backlog').get().batch_attempts, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM finding_batch_releases').get().n, 1);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('settlement still refuses an already-fixed drop whose fix PR is unverified', async t => {
  const f = fixture(t, ['Only result']);
  const [batch] = claimFindingBatches(f.db, '2026-01-02');
  const [id] = f.ids(batch);
  const result = { batchId: batch.batch_id, findings: [{ findingId: id, outcome: 'dropped', reason: 'already fixed in #23: removed it' }] };
  assert.throws(() => settleFindingBatch(f.db, batch, result), /batch-drop-pr-unverified/);
  assert.equal(settleFindingBatch(f.db, batch, result, null, { 23: { state: 'MERGED' } }), true);
  assert.equal(f.backlog()[0].reason, 'already-fixed-in-23: removed it');
});

test('settlement refuses a batch a concurrent collector already released', async t => {
  const f = fixture(t, ['Only result']);
  const [batch] = claimFindingBatches(f.db, '2026-01-02');
  const [id] = f.ids(batch);
  releaseFindingBatch(f.db, batch, 'batch-preparation-failed');
  assert.throws(() => settleFindingBatch(f.db, batch, { batchId: batch.batch_id,
    findings: [{ findingId: id, outcome: 'dropped', reason: 'false-positive: synthetic' }] }), /batch-released/);
  assert.deepEqual([f.backlog()[0].outcome, f.backlog()[0].batch_id], [null, null]);
});

test('a store not yet migrated keeps its backlog summary and reports progress as null', async t => {
  const f = fixture(t, ['Only result']);
  claimFindingBatches(f.db, '2026-01-02');
  f.db.prepare("UPDATE finding_batches SET error='batch-preparation-failed'").run();
  for (const column of ['released_at', 'release_reason', 'launched_at']) f.db.exec(`ALTER TABLE finding_batches DROP COLUMN ${column}`);
  const health = summarizeFindingBacklog(f.db);
  assert.equal(health.available, true, health.error);
  assert.equal(health.openCount, 1);
  assert.equal(health.progress, null);
  assert.deepEqual(health.batchErrors, [{ error: 'batch-preparation-failed', count: 1 }]);
});

test('never-launched errored batches release after timeout, without another dispatch or lost accounting', async t => {
  for (const error of ['batch-push-evidence-missing', 'synthetic launch failure']) await t.test(error, async t => {
    const f = fixture(t);
    const [batch] = claimFindingBatches(f.db, '2026-01-02');
    f.db.prepare('UPDATE finding_batches SET error=?').run(error);
    const run = now => f.run({ resolutionOnly: true, now, execFileImpl: async () => assert.fail('must not dispatch') });
    await run(Date.parse('2026-01-02T23:59:59Z'));
    assert.equal(f.batches()[0].released_at, null);
    await f.run({ now: Date.parse('2026-01-03T00:00:01Z'),
      execFileImpl: async () => assert.fail('overdue failure releases before redispatch') });
    assert.equal(f.batches()[0].release_reason, error);
    assert.ok(f.backlog().every(row => row.batch_id === null && row.batch_attempts === 1 && row.outcome === null));
    const audit = f.db.prepare('SELECT batch_id,attempt,reason FROM finding_batch_releases').all();
    assert.equal(audit.length, 3);
    assert.ok(audit.every(row => row.batch_id === batch.batch_id && row.attempt === 1 && row.reason === error));
    await run(Date.parse('2026-01-04T00:00:01Z'));
    assert.equal(f.db.prepare('SELECT count(*) n FROM finding_batch_releases').get().n, 3);
  });
});

test('an applied artifact without a launch receipt names the missing launch rather than the push', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  const [batch] = f.batches();
  f.writeOutcomes(batch, f.ids(batch).map(applied), { headSha: head });
  f.db.prepare('UPDATE finding_batches SET launch_id=NULL,launched_at=NULL').run();
  await f.run({ resolutionOnly: true, now: Date.parse('2026-01-02T01:00:00Z') });
  assert.equal(f.batches()[0].error, 'batch-launch-receipt-missing');
  assert.equal(f.batches()[0].released_at, null);
});

test('an absent keyed receipt checks the actual launch and retry liveness after timeout', async t => {
  for (const state of ['failed', 'succeeded', 'absent', 'running', 'unknown', 'live-retry', 'unreadable', 'throws']) {
    await t.test(state, async t => {
      const f = fixture(t);
      const now = Date.parse('2026-01-02T00:00:00Z');
      await f.run({ day: '2026-01-02', now });
      const [batch] = f.batches();
      f.writeOutcomes(batch, f.ids(batch).map(applied), { headSha: head });
      let exactReads = 0;
      const logs = [];
      const overrides = {
        resolutionOnly: true, now: now + DAY + 1,
        logger: { warn: message => logs.push(message), info: message => logs.push(message) },
        readLaunches: async () => ({ ok: true, rows: [] }),
        readLaunchSnapshot: async ({ launchRequestIds }) => {
          exactReads++;
          assert.deepEqual(launchRequestIds, [batch.launch_id]);
          if (state === 'throws') throw Error('synthetic transport error');
          if (state === 'unreadable') return { ok: false };
          if (state === 'absent') return { ok: false, reason: 'dispatch-read-unavailable', detail: 'dispatch absence scope unproven' };
          return { ok: true, rows: [
            { launch_request_id: batch.launch_id, status: state === 'live-retry' ? 'failed' : state },
            ...(state === 'live-retry' ? [{ launch_request_id: 'synthetic-retry', status: 'running' }] : []),
          ] };
        },
      };
      await f.run({ ...overrides, now: now + DAY - 1 });
      assert.equal(exactReads, 0, 'absence cannot release before timeout');
      assert.equal(f.batches()[0].released_at, null);
      await f.run(overrides);
      assert.equal(exactReads, 1);
      const released = ['failed', 'succeeded'].includes(state);
      assert.equal(Boolean(f.batches()[0].released_at), released);
      assert.equal(f.batches()[0].error, 'batch-publish-receipt-unavailable');
      assert.ok(f.backlog().every(row => row.batch_attempts === (released ? 1 : 0)));
      if (['absent', 'unknown', 'unreadable', 'throws'].includes(state)) {
        assert.ok(logs.some(line => line.includes('needs-operator')));
        assert.ok(logs.some(line => line.includes('"openFindings":3') && line.includes('"oldestAgeMs":86400001')));
      }
    });
  }
});

test('an unreadable keyed probe stays held and reports needs-operator after timeout', async t => {
  for (const probe of [
    { ok: false, reason: 'dispatch-read-unavailable', detail: 'dispatch absence scope unproven' },
    { ok: true, rows: null },
  ]) await t.test(JSON.stringify(probe), async t => {
    const f = fixture(t);
    const now = Date.parse('2026-01-02T00:00:00Z');
    await f.run({ day: '2026-01-02', now });
    const logs = [];
    await f.run({ resolutionOnly: true, now: now + DAY + 1,
      logger: { warn: message => logs.push(message), info: message => logs.push(message) },
      readLaunches: async () => probe,
      readLaunchSnapshot: async () => assert.fail('unreadable keyed lookup cannot be bypassed') });
    assert.equal(f.batches()[0].released_at, null);
    assert.ok(f.backlog().every(row => row.batch_attempts === 0));
    assert.equal(logs.filter(line => line.includes('summary')).length, 1);
    assert.ok(logs.some(line => line.includes('needs-operator:batch-keyed-launch-probe-unreadable')));
  });
});

test('temporary dispatch failures retain the batch and never exhaust findings, even past timeout', async t => {
  const f = fixture(t, ['Only result']);
  const now = Date.parse('2026-01-02T00:00:00Z');
  const logs = [];
  let calls = 0;
  const overrides = { day: '2026-01-02', now,
    logger: { warn: message => logs.push(message), info: message => logs.push(message) },
    execFileImpl: async () => {
      calls++;
      throw Object.assign(Error('Command failed: hq dispatch sensitive command'), {
        stderr: `synthetic admission refused: Bearer synthetic-token password=synthetic-secret ${'x'.repeat(1000)}`,
      });
    } };
  const [batch] = claimFindingBatches(f.db, '2026-01-02');
  // Include an old capped row from before dispatch failures were classified.
  f.db.prepare('UPDATE finding_batches SET batch_attempts=3,error=?')
    .run('Command failed: hq dispatch --priority normal\nsynthetic stderr');
  f.db.prepare('UPDATE finding_backlog SET batch_attempts=2').run();
  const failures = [
    Object.assign(Error('dispatch timeout'), { killed: true, code: 'ETIMEDOUT' }),
    Object.assign(Error('TLS connection reset'), { code: 'ECONNRESET' }),
    Object.assign(Error('I/O unavailable'), { code: 'EIO' }),
  ];
  for (let pass = 0; pass < 12; pass++) {
    await f.run({ ...overrides, now: now + pass * DAY,
      ...(pass % 4 ? { execFileImpl: async () => { calls++; throw failures[pass % failures.length]; } } : {}) });
    assert.equal(f.batches().length, 1, 'retry retains the original batch/key');
    assert.equal(f.batches()[0].batch_attempts, 0);
    assert.equal(f.batches()[0].released_at, null);
    assert.equal(f.backlog()[0].batch_attempts, 2, 'no worker attempt was consumed');
    assert.equal(f.backlog()[0].outcome, null);
  }
  assert.equal(calls, 12);
  assert.ok(logs.some(line => line.includes('needs-operator:batch-dispatch-retry-overdue')));
  assert.equal(f.db.prepare('SELECT count(*) n FROM finding_batch_releases').get().n, 0);
  assert.ok(f.batches()[0].error.length < 335);
  assert.ok(!logs.join('\n').includes('synthetic-token'));
  assert.ok(!logs.join('\n').includes('synthetic-secret'));
  assert.ok(!logs.join('\n').includes('sensitive command'));
  await f.run({ ...overrides, resolutionOnly: true, now: now + 13 * DAY });
  assert.equal(calls, 12);
  // Recovery uses the original key and records a normal launch receipt.
  await f.run({ day: '2026-01-15', now: now + 13 * DAY });
  assert.equal(f.batches()[0].launch_id, 'synthetic-launch-1');
  assert.equal(f.batches()[0].error, null);
  assert.equal(f.dispatches[0][f.dispatches[0].indexOf('--idempotency-key') + 1], `findings-batch-${batch.batch_id}`);
});

test('returned invalid receipts still spend the durable dispatch cap', async t => {
  const f = fixture(t, ['Only result']);
  let calls = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.run({ day: '2026-01-02', now: Date.parse('2026-01-02T01:00:00Z'),
      execFileImpl: async () => { calls++; return { stdout: '{}' }; } });
    assert.equal(f.batches()[0].batch_attempts, attempt);
    assert.equal(Boolean(f.batches()[0].released_at), attempt === 3);
    assert.equal(f.backlog()[0].batch_attempts, attempt === 3 ? 1 : 0);
  }
  assert.equal(calls, 3);
  assert.match(f.batches()[0].release_reason, /^batch-dispatch-attempts-exhausted: batch-dispatch-receipt-invalid:/);
});

test('interleaved transient failures preserve the invalid-receipt cap', async t => {
  const f = fixture(t, ['Only result']);
  const now = Date.parse('2026-01-02T01:00:00Z');
  for (const [transient, attempts] of [[false, 1], [true, 1], [false, 2], [true, 2], [false, 3]]) {
    await f.run({ day: '2026-01-02', now, execFileImpl: async () => {
      if (transient) throw Object.assign(Error('dispatch timeout'), { code: 'ETIMEDOUT' });
      return { stdout: '{}' };
    } });
    assert.equal(f.batches()[0].batch_attempts, attempts);
    assert.equal(Boolean(f.batches()[0].released_at), attempts === 3);
  }
});

test('dispatch cap holds any live launch without making a fourth submission', async t => {
  const f = fixture(t);
  const [batch] = claimFindingBatches(f.db, '2026-01-02');
  f.db.prepare("UPDATE finding_batches SET batch_attempts=3,error='batch-dispatch-receipt-invalid: lost receipt'").run();
  f.launches.set(`findings-batch-${batch.batch_id}`, [{
    launch_request_id: 'synthetic-live', idempotency_key: `findings-batch-${batch.batch_id}`, status: 'running',
  }]);
  for (let pass = 0; pass < 2; pass++) await f.run({ day: '2026-01-02', now: Date.parse('2026-01-02T01:00:00Z'),
    execFileImpl: async () => assert.fail('exhausted dispatch must not retry') });
  assert.equal(f.batches()[0].released_at, null);
  assert.ok(f.backlog().every(row => row.batch_attempts === 0));
});

test('normal publisher receipt pending and transient status read failures remain waits before timeout', async t => {
  for (const pending of [true, false]) await t.test(String(pending), async t => {
    const f = fixture(t);
    const now = Date.parse('2026-01-02T00:00:00Z');
    await f.run({ day: '2026-01-02', now });
    const [batch] = f.batches();
    f.endLaunches('succeeded');
    f.writeOutcomes(batch, f.ids(batch).map(applied), { headSha: head });
    f.publication.headSha = head;
    const dir = join(f.rootDir, 'data', 'finding-batches', batch.batch_id);
    if (pending) writeFileSync(join(dir, 'publish-intent.json'), '{}');
    await f.run({ resolutionOnly: true, now: now + DAY - 1,
      ...(pending ? {} : { execFileImpl: async () => { throw Error('synthetic status read failed'); } }) });
    assert.equal(f.batches()[0].error, pending ? 'batch-publish-receipt-pending' : 'synthetic status read failed');
    assert.equal(f.batches()[0].released_at, null);
    assert.equal(f.batches()[0].batch_attempts, 0);
    assert.ok(f.backlog().every(row => row.batch_attempts === 0 && row.outcome === null));
  });
});

test('dispatch-attempt migration reapplication preserves durable counts', t => {
  const f = fixture(t);
  claimFindingBatches(f.db, '2026-01-02');
  f.db.prepare('UPDATE finding_batches SET batch_attempts=2').run();
  f.db.prepare("DELETE FROM schema_migrations WHERE id='20261109_findings_batch_dispatch_attempts.sql'").run();
  ensureReviewStateSchema(f.db);
  assert.equal(f.batches()[0].batch_attempts, 2);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});
