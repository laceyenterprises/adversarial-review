import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { runFindingBatches, findingBatchDispatchScope } from '../src/findings-batch.mjs';
import { summarizeFindingBacklog, findingBacklogAlert } from '../src/findings-backlog.mjs';
import { readLaunchRequestByIdempotencyKeyAsync } from '../src/session-ledger-read-adapter.mjs';
import { main as releaseMain } from '../bin/findings-batch-release.mjs';

// FINDINGSBATCHSTRAND-01. Synthetic owners, repositories, findings and launches
// only. The producer double reproduces the dispatch-read grant model: reads are
// granted per exact (project, owner/repo) pair; an unscoped read silently drops
// rows outside every grant; a scoped read without its pair is refused.
const fixtureNow = Date.parse('2026-01-02T00:00:00Z');
const DAY = 24 * 3600000;
const PRIMARY = 'first-owner/service';
const SECOND = 'second-owner/tool';
const PROJECT = 'adversarial-merge-authority';
const head = 'a'.repeat(40);

function grantFilteredProducer(grants) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const covered = (row, pool) => pool.some(g => g.project_ref === row.project_ref && same(g.repo, row.repo_full_name));
  const producer = { grants, launches: [], selectors: [], async dispatchLookup(selector) {
    producer.selectors.push(selector);
    const scoped = 'project_ref' in selector || 'repo' in selector;
    let pool = producer.grants;
    if (scoped) {
      pool = pool.filter(g => g.project_ref === selector.project_ref && same(g.repo, selector.repo));
      if (!pool.length) {
        throw Object.assign(Error('app-contract dispatch_scope_denied: exact recovery read grant required'),
          { status: 403, code: 'dispatch_scope_denied' });
      }
    }
    const matched = producer.launches.filter(row => row.idempotency_key === selector.idempotency_key);
    const items = matched.filter(row => covered(row, pool))
      .map(({ project_ref: _project, repo_full_name: _repo, ...row }) => row);
    return { schema_version: 1, status: items.length ? 'found' : 'not_found', complete: true,
      roots: items.map(row => row.launch_request_id), items, retry_edges: [],
      ...(scoped && !matched.length ? { scope_complete: true, absence_proof: { version: 1,
        kind: 'canonical-exact-selector-absence', selector, grant_id: 'synthetic-grant',
        observed_at: new Date(fixtureNow).toISOString() } } : {}) };
  } };
  return producer;
}

const reviewBody = titles => `## Blocking Issues
- None.
## Non-blocking Issues
${titles.map(title => `- **${title}**
  - **File:** \`src/result.mjs\`
  - **Lines:** 2
  - **Problem:** ${title} lacks a description.
`).join('')}## Verdict
Comment only
`;

function fixture(t, { repo = SECOND, grants = [{ project_ref: PROJECT, repo: PRIMARY }] } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'findings-strand-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref) VALUES (?,7,?,'codex','open',?)")
    .run(repo, '2026-01-01T00:00:00Z', head);
  const key = { repo, prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  const pass = beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(rootDir, { ...key, bodyMd: reviewBody(['First result', 'Second result']), verdict: 'comment-only' });
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='1', body_captured_at='2026-01-01T00:00:01Z' WHERE pass_id=?").run(pass.pass_id);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged',merged_at='2026-01-02T00:00:00Z'").run();
  const env = { HQ_ROOT: rootDir };
  const producer = grantFilteredProducer(grants);
  const dispatches = [];
  const status = { branch: 'synthetic/findings', status: 'succeeded', terminal: true, succeeded: true };
  const execFileImpl = async (_bin, args) => {
    if (args[1] === 'status') {
      const row = producer.launches.find(launch => launch.launch_request_id === args[2]);
      return { stdout: JSON.stringify({ ...status, ...(row ? { status: row.status } : {}),
        terminal: !['running', 'queued'].includes(row?.status), launchRequestId: args[2] }) };
    }
    dispatches.push(args);
    const id = `synthetic-launch-${dispatches.length}`;
    // The dispatcher records the owner-qualified repository from registration.
    producer.launches.push({ launch_request_id: id, idempotency_key: args[args.indexOf('--idempotency-key') + 1],
      ticket_ref: args[args.indexOf('--ticket') + 1], target_repo: repo, status: 'running',
      project_ref: args[args.indexOf('--project') + 1], repo_full_name: repo });
    return { stdout: JSON.stringify({ launchRequestId: id }) };
  };
  const publication = { prs: [], headSha: head };
  const readLaunches = args => readLaunchRequestByIdempotencyKeyAsync({ ...args, dispatchSession: producer });
  const options = { now: fixtureNow, db, rootDir, env, execFileImpl, readLaunches, logger: { warn() {}, info() {} },
    readLaunchSnapshot: async () => ({ ok: false, reason: 'dispatch-read-unavailable', detail: 'dispatch absence scope unproven' }),
    fetchPublication: async () => publication, fetchPr: async () => ({ state: 'MERGED' }) };
  const run = overrides => runFindingBatches({ ...options, ...overrides });
  const batch = () => db.prepare('SELECT * FROM finding_batches ORDER BY rowid').get();
  const backlog = () => db.prepare('SELECT finding_id,batch_id,batch_attempts,outcome,reason FROM finding_backlog ORDER BY finding_id').all();
  const endLaunches = value => { for (const row of producer.launches) row.status = value; };
  const writeOutcomes = (target, extra = {}) => writeFileSync(join(rootDir, 'data', 'finding-batches', target.batch_id, 'outcomes.json'),
    JSON.stringify({ batchId: target.batch_id, prNumber: null, headSha: head, ...extra,
      findings: db.prepare('SELECT finding_id FROM finding_backlog WHERE batch_id=? ORDER BY finding_id').all(target.batch_id)
        .map(({ finding_id: findingId }) => ({ findingId, outcome: 'applied', reason: 'Documented the return value' })) }));
  return { rootDir, db, env, producer, dispatches, status, publication, options, run, batch, backlog, endLaunches,
    writeOutcomes, readLaunches };
}

const grantSecond = f => f.producer.grants.push({ project_ref: PROJECT, repo: SECOND });

test('root cause: an unscoped keyed read of a second-owner launch reads as unproven absence', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  const key = `findings-batch-${f.batch().batch_id}`;
  const unscoped = await f.readLaunches({ env: f.env, rootDir: f.rootDir, idempotencyKey: key });
  assert.equal(unscoped.ok, false);
  assert.equal(unscoped.detail, 'dispatch absence scope unproven');
  assert.notEqual(unscoped.selectorRefused, true, 'an unscoped read cannot name the missing grant');
  // The batch's exact pair names the refusal instead.
  const scope = findingBatchDispatchScope(f.batch(), f.env);
  assert.deepEqual(scope, { projectRef: PROJECT, repo: SECOND });
  const scoped = await f.readLaunches({ env: f.env, rootDir: f.rootDir, ...scope, idempotencyKey: key });
  assert.equal(scoped.ok, false);
  assert.equal(scoped.selectorRefused, true);
  grantSecond(f);
  const granted = await f.readLaunches({ env: f.env, rootDir: f.rootDir, ...scope, idempotencyKey: key });
  assert.equal(granted.ok, true);
  assert.deepEqual(granted.rows.map(row => row.target_repo), [SECOND]);
});

test('a second-owner batch receipt resolves through its scoped read and publishes', async t => {
  const f = fixture(t, { grants: [{ project_ref: PROJECT, repo: PRIMARY }, { project_ref: PROJECT, repo: SECOND }] });
  await f.run({ day: '2026-01-02' });
  f.writeOutcomes(f.batch());
  f.endLaunches('succeeded');
  await f.run({ resolutionOnly: true });
  assert.equal(f.batch().error, null);
  assert.equal(f.dispatches.length, 2, 'publisher submitted after the keyed receipt resolved');
  assert.ok(f.producer.selectors.every(selector => selector.project_ref === PROJECT && selector.repo === SECOND));
});

test('preparation-failed on an ended second-owner launch releases once its pair is readable', async t => {
  const f = fixture(t, { grants: [{ project_ref: PROJECT, repo: SECOND }] });
  await f.run({ day: '2026-01-02' });
  f.endLaunches('failed');
  f.status.status = 'failed';
  f.status.succeeded = false;
  f.writeOutcomes(f.batch());
  await f.run({ resolutionOnly: true });
  assert.equal(f.batch().release_reason, 'batch-preparation-failed');
  assert.deepEqual(f.backlog().map(row => [row.batch_id, row.batch_attempts]), [[null, 1], [null, 1]]);
});

test('a refused read grant holds needs-operator at once, is surfaced with batch id and reason, and clears when granted', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  const held = f.batch();
  f.endLaunches('failed');
  Object.assign(f.status, { status: 'failed', succeeded: false });
  f.writeOutcomes(held);
  const logs = [];
  await f.run({ resolutionOnly: true, logger: { warn: line => logs.push(line), info: line => logs.push(line) } });
  const reason = `batch-dispatch-read-scope-denied: ${PROJECT} ${SECOND}`;
  assert.equal(f.batch().released_at, null);
  assert.ok(logs.some(line => line.includes(`needs-operator ${held.batch_id}: ${reason}`)));
  const backlog = summarizeFindingBacklog(f.db, fixtureNow, { maxAgeMs: 30 * DAY });
  assert.deepEqual(backlog.heldBatches.map(row => [row.batchId, row.reason, row.openFindings, row.error]),
    [[held.batch_id, reason, 2, 'batch-preparation-failed']]);
  assert.equal(backlog.heldFindingCount, 2);
  const alert = findingBacklogAlert(backlog);
  assert.ok(alert.evidence.includes(`held=${held.batch_id}:${reason}`));
  assert.match(alert.message, /1 batches \(2 findings\) held for an operator/);
  // The hold keeps its first observation time across passes.
  const heldAt = JSON.parse(f.batch().hold_json).heldAt;
  await f.run({ resolutionOnly: true, now: fixtureNow + 3600000 });
  assert.equal(JSON.parse(f.batch().hold_json).heldAt, heldAt);
  grantSecond(f);
  await f.run({ resolutionOnly: true, now: fixtureNow + 7200000 });
  assert.ok(f.batch().released_at);
  assert.deepEqual(summarizeFindingBacklog(f.db, fixtureNow, { maxAgeMs: 30 * DAY }).heldBatches, []);
});

test('a succeeded second-owner launch whose receipt is refused records a typed error and publishes once granted', async t => {
  const f = fixture(t);
  await f.run({ day: '2026-01-02' });
  f.writeOutcomes(f.batch());
  f.endLaunches('succeeded');
  await f.run({ resolutionOnly: true });
  assert.equal(f.batch().error, `batch-dispatch-read-scope-denied: ${PROJECT} ${SECOND}`);
  assert.equal(f.dispatches.length, 1);
  assert.equal(summarizeFindingBacklog(f.db, fixtureNow, { maxAgeMs: 30 * DAY }).heldBatches.length, 1);
  grantSecond(f);
  await f.run({ resolutionOnly: true, now: fixtureNow + 3600000 });
  assert.equal(f.batch().error, null);
  assert.equal(f.batch().released_at, null, 'unexpired prepared work publishes instead of releasing');
  assert.equal(f.dispatches.length, 2);
  assert.deepEqual(summarizeFindingBacklog(f.db, fixtureNow, { maxAgeMs: 30 * DAY }).heldBatches, []);
});

test('an unreadable keyed probe past the timeout is surfaced as held', async t => {
  const f = fixture(t, { repo: PRIMARY });
  await f.run({ day: '2026-01-02' });
  await f.run({ resolutionOnly: true, now: fixtureNow + DAY + 1,
    readLaunches: async () => ({ ok: false, reason: 'dispatch-read-unavailable', detail: 'transient dispatch lookup failure' }) });
  const backlog = summarizeFindingBacklog(f.db, fixtureNow + DAY + 1, { maxAgeMs: 30 * DAY });
  assert.deepEqual(backlog.heldBatches.map(row => [row.batchId, row.reason]),
    [[f.batch().batch_id, 'batch-keyed-launch-probe-unreadable']]);
  // A later settlement write that changes the error retires the stale hold.
  f.db.prepare("UPDATE finding_batches SET error='batch-push-evidence-missing'").run();
  assert.deepEqual(summarizeFindingBacklog(f.db, fixtureNow + DAY + 1, { maxAgeMs: 30 * DAY }).heldBatches, []);
});

test('findings-batch-release retries, drops and refuses live or unreadable custody', async t => {
  const setup = async (t, options) => {
    const f = fixture(t, options);
    await f.run({ day: '2026-01-02' });
    return f;
  };
  const release = (f, extra = []) => releaseMain(['--root', f.rootDir, '--db', join(f.rootDir, 'data', 'reviews.db'),
    '--batch', f.batch().batch_id, ...extra], { env: f.env, execFileImpl: f.options.execFileImpl, readLaunches: f.readLaunches });
  const snapshot = f => JSON.stringify([f.batch(), f.backlog()]);

  await t.test('refuses a live launch and writes nothing', async t => {
    const f = await setup(t, { grants: [{ project_ref: PROJECT, repo: SECOND }] });
    const before = snapshot(f);
    const result = await release(f, ['--mode', 'retry', '--reason', 'operator retry', '--apply']);
    assert.equal(result.refused, 'launch-live');
    assert.equal(result.applied, false);
    assert.equal(snapshot(f), before);
  });

  await t.test('refuses a live keyed publisher while the recorded launch is terminal', async t => {
    const f = await setup(t, { grants: [{ project_ref: PROJECT, repo: SECOND }] });
    f.endLaunches('failed');
    f.producer.launches.push({ ...f.producer.launches[0], launch_request_id: 'synthetic-publisher', status: 'running' });
    const result = await release(f, ['--mode', 'drop', '--reason', 'operator drop', '--apply']);
    assert.equal(result.refused, 'keyed-launch-live');
    assert.equal(f.batch().released_at, null);
  });

  await t.test('previews read-only, then retries through the release helper', async t => {
    const f = await setup(t, { grants: [{ project_ref: PROJECT, repo: SECOND }] });
    f.endLaunches('failed');
    const before = snapshot(f);
    const preview = await release(f, ['--mode', 'retry', '--reason', 'stranded behind a hold']);
    assert.equal(preview.applied, false);
    assert.equal(preview.refused, undefined);
    assert.equal(preview.openFindings, 2);
    assert.equal(preview.wouldExhaust, 0);
    assert.equal(snapshot(f), before);
    assert.equal(existsSync(join(f.rootDir, 'data', 'finding-batches', f.batch().batch_id, 'publish.lock')), false);
    const applied = await release(f, ['--mode', 'retry', '--reason', 'stranded behind a hold', '--apply']);
    assert.equal(applied.applied, true);
    assert.equal(applied.result.requeued, 2);
    assert.equal(f.batch().release_reason, 'operator-retry: stranded behind a hold');
    assert.deepEqual(f.backlog().map(row => [row.batch_id, row.batch_attempts, row.outcome]), [[null, 1, null], [null, 1, null]]);
    assert.deepEqual(f.db.prepare('SELECT DISTINCT disposition,reason FROM finding_batch_releases').all(),
      [{ disposition: 'requeued', reason: 'operator-retry: stranded behind a hold' }]);
    // The released findings re-batch under a fresh identity on the next claim.
    await f.run({ day: '2026-01-03' });
    assert.equal(f.dispatches.length, 2);
    const again = await release(f, ['--mode', 'retry', '--reason', 'stranded behind a hold', '--apply']);
    assert.equal(again.refused, 'batch-already-settled');
  });

  await t.test('drops open findings with the operator reason', async t => {
    const f = await setup(t, { grants: [{ project_ref: PROJECT, repo: SECOND }] });
    f.endLaunches('failed');
    const result = await release(f, ['--mode', 'drop', '--reason', 'superseded by a rewrite', '--apply']);
    assert.equal(result.applied, true);
    assert.equal(result.result.dropped, 2);
    assert.deepEqual(f.backlog().map(row => [row.outcome, row.reason]),
      [['dropped', 'operator-dropped: superseded by a rewrite'], ['dropped', 'operator-dropped: superseded by a rewrite']]);
    assert.ok(f.batch().released_at);
    assert.equal(summarizeFindingBacklog(f.db, fixtureNow, { maxAgeMs: 30 * DAY }).openCount, 0);
  });

  await t.test('a refused keyed read needs the explicit acknowledgement, and never with a submitted publisher', async t => {
    const f = await setup(t);
    f.endLaunches('failed');
    const refused = await release(f, ['--mode', 'retry', '--reason', 'grant pending', '--apply']);
    assert.equal(refused.refused, 'keyed-launch-scope-denied');
    assert.equal(refused.custody.acknowledgeWith, '--accept-unreadable-custody');
    assert.equal(f.batch().released_at, null);
    writeFileSync(join(f.rootDir, 'data', 'finding-batches', f.batch().batch_id, 'publish-intent.json'), '{}');
    const intent = await release(f, ['--mode', 'retry', '--reason', 'grant pending', '--apply', '--accept-unreadable-custody']);
    assert.equal(intent.refused, 'keyed-launch-scope-denied');
    rmSync(join(f.rootDir, 'data', 'finding-batches', f.batch().batch_id, 'publish-intent.json'));
    const acknowledged = await release(f, ['--mode', 'retry', '--reason', 'grant pending', '--apply', '--accept-unreadable-custody']);
    assert.equal(acknowledged.applied, true);
    assert.equal(acknowledged.custody.keyedCustody, 'scope-denied');
  });

  await t.test('rejects malformed invocations before reading anything', async t => {
    const f = await setup(t);
    await assert.rejects(release(f, ['--mode', 'later', '--reason', 'x']), /--mode must be retry or drop/);
    await assert.rejects(release(f, ['--mode', 'drop']), /--reason is required/);
    await assert.rejects(releaseMain(['--root', f.rootDir, '--db', '/elsewhere/reviews.db', '--batch', 'a'.repeat(64),
      '--mode', 'drop', '--reason', 'x'], { readLaunches: f.readLaunches }), /--db must match/);
  });
});
