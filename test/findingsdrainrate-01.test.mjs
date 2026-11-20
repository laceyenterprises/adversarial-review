import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { createFindingBatchTicker, findingBatchOptions, runFindingBatches } from '../src/findings-batch.mjs';
import { summarizeFindingBacklog } from '../src/findings-backlog.mjs';

// Synthetic repository, areas, findings and launches only.
const repo = 'sample/service', head = 'a'.repeat(40);
const fixtureNow = Date.parse('2026-01-02T00:00:00Z');
const KEY = 'ADVERSARIAL_FINDINGS_BATCH_CONCURRENCY';

// One merged PR whose findings fall in `areas` distinct areas: one batch each.
function fixture(t, areas = 6) {
  const rootDir = mkdtempSync(join(tmpdir(), 'findings-drain-rate-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const findings = Array.from({ length: areas }, (_, i) => `- **Describe result ${i}**
  - **File:** \`area${i}/result.mjs\`
  - **Lines:** 2
  - **Problem:** Result ${i} lacks a description.
`).join('');
  db.prepare("INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref) VALUES (?,7,?,'codex','open',?)")
    .run(repo, '2026-01-01T00:00:00Z', head);
  const key = { repo, prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  const pass = beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(rootDir, { ...key, verdict: 'comment-only',
    bodyMd: `## Blocking Issues\n- None.\n## Non-blocking Issues\n${findings}## Verdict\nComment only\n` });
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='1', body_captured_at='2026-01-01T00:00:01Z' WHERE pass_id=?")
    .run(pass.pass_id);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged',merged_at='2026-01-02T00:00:00Z'").run();
  // HQ-like dispatcher: provisioning takes a while; the idempotency key maps
  // to one launch however many times it is submitted.
  const launches = new Map();
  const submissions = [];
  let inFlight = 0, maxInFlight = 0;
  const execFileImpl = async (_bin, args) => {
    const idempotencyKey = args[args.indexOf('--idempotency-key') + 1];
    submissions.push(idempotencyKey);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    inFlight--;
    if (!launches.has(idempotencyKey)) launches.set(idempotencyKey, { launch_request_id: `synthetic-launch-${launches.size + 1}`,
      idempotency_key: idempotencyKey, status: 'running' });
    return { stdout: JSON.stringify({ launchRequestId: launches.get(idempotencyKey).launch_request_id }) };
  };
  const options = { db, rootDir, execFileImpl, logger: { warn() {}, info() {} },
    readLaunches: async ({ idempotencyKey }) => ({ ok: true, rows: launches.has(idempotencyKey) ? [launches.get(idempotencyKey)] : [] }) };
  return { rootDir, db, options, launches, submissions, maxInFlight: () => maxInFlight };
}

test('the concurrency knob is a validated positive integer with a default of 2', () => {
  assert.equal(findingBatchOptions({}).concurrency, 2);
  assert.equal(findingBatchOptions({ [KEY]: '5' }).concurrency, 5);
  assert.equal(findingBatchOptions({ [KEY]: '1' }).concurrency, 1);
  for (const value of ['0', '-1', '1.5', 'many', '']) {
    assert.throws(() => findingBatchOptions({ [KEY]: value }), new RegExp(`invalid ${KEY}`), value);
  }
});

test('the live collector submits every claimed batch with the configured concurrency', async t => {
  for (const [value, expected] of [[undefined, 2], ['1', 1], ['4', 4]]) await t.test(`${KEY}=${value}`, async t => {
    const f = fixture(t, 6);
    const env = { HQ_ROOT: f.rootDir, ...(value === undefined ? {} : { [KEY]: value }) };
    await createFindingBatchTicker({ ...f.options, env }).tick(fixtureNow);
    assert.equal(f.maxInFlight(), expected);
    const batches = f.db.prepare('SELECT launch_id FROM finding_batches').all();
    assert.equal(batches.length, 6);
    assert.ok(batches.every(batch => batch.launch_id), 'one pass submits every claimed batch');
    assert.equal(f.submissions.length, 6);
  });
});

test('an invalid concurrency refuses the collector pass before any claim or submission', async t => {
  const f = fixture(t, 2);
  const ticker = createFindingBatchTicker({ ...f.options, env: { HQ_ROOT: f.rootDir, [KEY]: '0' } });
  await assert.rejects(ticker.tick(fixtureNow), new RegExp(`invalid ${KEY}`));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM finding_batches').get().n, 0);
  assert.equal(f.submissions.length, 0);
});

test('concurrent collectors still bind each batch to one launch', async t => {
  const f = fixture(t, 8);
  const env = { HQ_ROOT: f.rootDir, [KEY]: '4' };
  const other = openReviewStateDb(f.rootDir);
  t.after(() => other.close());
  // Two collectors racing one store, plus an overlapping tick on one ticker.
  const ticker = createFindingBatchTicker({ ...f.options, env });
  await Promise.all([
    ticker.tick(fixtureNow),
    ticker.tick(fixtureNow),
    runFindingBatches({ ...f.options, db: other, env, now: fixtureNow, day: '2026-01-02', concurrency: 4 }),
  ]);
  const batches = f.db.prepare('SELECT batch_id,launch_id FROM finding_batches').all();
  assert.equal(batches.length, 8, 'the claim CAS gives every finding one batch');
  assert.equal(f.launches.size, 8);
  for (const batch of batches) {
    assert.equal(batch.launch_id, f.launches.get(`findings-batch-${batch.batch_id}`).launch_request_id);
  }
  // Within one collector a batch is submitted at most once per pass; across
  // collectors only the shared idempotency key can repeat, never a new launch.
  const perKey = new Map();
  for (const key of f.submissions) perKey.set(key, (perKey.get(key) || 0) + 1);
  assert.ok([...perKey.values()].every(count => count <= 2), JSON.stringify([...perKey]));
  const ids = f.db.prepare('SELECT count(DISTINCT batch_id) AS n, count(*) AS total FROM finding_backlog').get();
  assert.deepEqual([ids.n, ids.total], [8, 8]);
});

test('the backlog summary reports last-hour capture, resolution and completion rates', async t => {
  const f = fixture(t, 4);
  const now = Date.parse('2026-01-03T12:00:00Z');
  const ids = f.db.prepare('SELECT finding_id FROM finding_backlog ORDER BY finding_id').all().map(row => row.finding_id);
  const at = minutesAgo => new Date(now - minutesAgo * 60000).toISOString();
  // Three captures in the last hour, one earlier; one resolved recently.
  for (const [id, minutes] of ids.map((id, i) => [id, [10, 20, 50, 90][i]])) {
    f.db.prepare('UPDATE finding_backlog SET captured_at=? WHERE finding_id=?').run(at(minutes), id);
  }
  f.db.prepare("UPDATE finding_backlog SET outcome='dropped',reason='not-reproducible: synthetic' WHERE finding_id IN (?,?)")
    .run(ids[2], ids[3]);
  f.db.prepare('UPDATE finding_backlog SET resolved_at=? WHERE finding_id=?').run(at(5), ids[3]);
  f.db.prepare('UPDATE finding_backlog SET resolved_at=? WHERE finding_id=?').run(at(120), ids[2]);
  f.db.prepare("INSERT INTO finding_batches(batch_id,repo,area,day,completed_at) VALUES ('recent',?,'x','2026-01-03',?),('old',?,'y','2026-01-03',?)")
    .run(repo, at(30), repo, at(61));
  const summary = summarizeFindingBacklog(f.db, now);
  assert.equal(summary.available, true);
  assert.deepEqual(summary.rates, { capturedLastHour: 3, resolvedLastHour: 1, batchesCompletedLastHour: 1, netLastHour: 2 });
});
