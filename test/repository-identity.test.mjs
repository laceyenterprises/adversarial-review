import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { MARK_ATTEMPT_STARTED_SQL } from '../src/review-state-statements.mjs';
import {
  canonicalRepositoryName, observeRepositoryIdentity, observeRepositoryListing,
  recoverRepositoryObservations, recoverRepositoryRename,
} from '../src/repository-identity.mjs';
import { repositoryStateDigest } from '../src/repository-state-files.mjs';
import { withRepositoryStateCycle, withRepositoryStateRead } from '../src/repository-state-lock.mjs';
import { acquireAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { acquireMergeLease, inspectMergeLease } from '../src/ama/merge-lease.mjs';
import { listFollowUpJobsInDir } from '../src/follow-up-jobs.mjs';
import { handoffDigest } from '../src/finalization/queue-handoff.mjs';
import { repositoryNames, resolveRepositoryName } from '../src/repository-names.mjs';
import { repositoryObservationCache } from '../src/repository-state-cache.mjs';
import { pageCiOnce } from '../src/ci-recovery.mjs';
import { storedPrimaryChange } from '../src/ama/primary-change-store.mjs';
import { readCompletedRemediationRounds } from '../src/ama/hammer-head-validation.mjs';
import { ensureReviewCycleCapSchema, previewReviewCycleCount, recordReviewCycleVerdict } from '../src/review-cycle-cap.mjs';
import { ensureTtmTrackerSchema } from '../src/ttm-tracker.mjs';

const oldName = 'example-org/alpha', newName = 'example-org/beta';
const repository = full_name => ({ id: 123, node_id: 'R_fixture123', full_name });
const head = 'a'.repeat(40);
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repository-rename-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  ensureReviewStateSchema(db);
  const logs = [], warnings = [];
  const options = { db, rootDir, logger: { log: line => logs.push(line), warn: line => warnings.push(line) } };
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  function json(path, value) {
    const full = join(rootDir, 'data', path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(value));
    return full;
  }
  return { ...options, options, logs, warnings, json };
}
function seedReview(db) {
  db.prepare(`INSERT INTO reviewed_prs
    (repo,pr_number,reviewed_at,reviewer,pr_state,review_status,reviewer_head_sha,revision_ref,domain_id,subject_external_id)
    VALUES (?,7,'2026-10-30','codex','open','posted',?,?,'code-pr',?)`).run(oldName, head, head, `${oldName}#7`);
  return db.prepare(`INSERT INTO reviewer_passes
    (repo,pr_number,attempt_number,reviewer_class,pass_kind,started_at,status)
    VALUES (?,7,1,'codex','first-pass','2026-10-30','completed')`).run(oldName).lastInsertRowid;
}

test('listing backfills stable identities and rename preserves review, remediation, closer and merge ownership', t => {
  const { db, rootDir, options, logs, json } = fixture(t);
  const passId = seedReview(db);
  observeRepositoryListing({ ...options, repositories: [repository(oldName)] });
  assert.deepEqual(db.prepare('SELECT repository_id,node_id,full_name FROM repository_identities').get(),
    { repository_id: '123', node_id: 'R_fixture123', full_name: oldName });
  const jobId = 'example-org__alpha-pr-7-fixture';
  const jobPath = json(`follow-up-jobs/pending/${jobId}.json`,
    { jobId, repo: oldName, prNumber: 7, round: 2, status: 'pending', headSha: head });
  acquireAmaCloserLease({ rootDir, repo: oldName, prNumber: 7, headSha: head, watcherPid: process.pid });
  const closer = readAmaCloserLease(rootDir, { repo: oldName, prNumber: 7, headSha: head });
  const merge = acquireMergeLease({ rootDir, repo: oldName, base: 'main', holderPr: 7,
    holderHead: head, holderPid: process.pid, deadlineSeconds: 3600 });
  assert.equal(merge.acquired, true);
  const waitPath = join(rootDir, 'data', 'ama-closure-waits', repositoryStateDigest(`${oldName}#7`) + '.db');
  mkdirSync(dirname(waitPath), { recursive: true });
  const waitDb = new Database(waitPath);
  waitDb.exec("CREATE TABLE waits_by_class(head TEXT,class TEXT,started INTEGER); INSERT INTO waits_by_class VALUES ('head','review',42)");
  waitDb.close();

  const renamed = observeRepositoryIdentity({ ...options, repository: repository(newName) });
  assert.equal(renamed.renamed, true);
  assert.equal(canonicalRepositoryName(db, oldName), newName);
  assert.equal(db.prepare('SELECT repo FROM reviewer_passes WHERE pass_id=?').get(passId).repo, newName);
  assert.equal(db.prepare('SELECT count(*) AS n FROM reviewed_prs').get().n, 1);
  assert.equal(db.prepare('SELECT subject_external_id FROM reviewed_prs').get().subject_external_id, `${newName}#7`);
  // The production claim CAS cannot request another review of this posted head.
  assert.equal(db.prepare(MARK_ATTEMPT_STARTED_SQL).run('2026-10-30', 'new-session', head, head, 1000,
    '2026-10-31', head, newName, 7).changes, 0);
  const jobs = listFollowUpJobsInDir(rootDir, 'pending', { repo: newName, prNumber: 7 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobPath, jobPath);
  assert.equal(jobs[0].job.repo, newName);
  assert.equal(jobs[0].job.jobId, jobId);
  assert.equal(jobs[0].job.round, 2);
  assert.deepEqual(readAmaCloserLease(rootDir, { repo: newName, prNumber: 7, headSha: head }),
    { ...closer, repo: newName });
  assert.equal(inspectMergeLease({ rootDir, repo: newName, base: 'main' }).lease.leaseId, merge.lease.leaseId);
  // A worker that retained its dispatch arguments resolves the same ownership.
  assert.equal(readAmaCloserLease(rootDir, { repo: oldName, prNumber: 7, headSha: head }).repo, newName);
  const movedWait = new Database(join(dirname(waitPath), repositoryStateDigest(`${newName}#7`) + '.db'));
  assert.equal(movedWait.prepare('SELECT started FROM waits_by_class').get().started, 42);
  movedWait.close();
  assert.equal(existsSync(waitPath), false);
  assert.equal(observeRepositoryIdentity({ ...options, repository: repository(newName) }).renamed, false);
  assert.equal(logs.length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repository_rename_audit').get().n, 1);
});

test('URL counters, event keys, completed rounds and dependent unsigned receipt digests keep their identities', async t => {
  const { db, rootDir, options, json } = fixture(t);
  seedReview(db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  ensureReviewCycleCapSchema(db);
  recordReviewCycleVerdict(db, { repo: oldName, prNumber: 7, headSha: head, verdictAt: '2026-10-30T00:00:00Z' });
  ensureTtmTrackerSchema(db);
  db.prepare(`INSERT INTO ttm_flag_state(event_key,repo,pr_number,flag_kind,state,first_observed_at,last_observed_at)
    VALUES (?,?,7,'ownerless','active','2026-10-30','2026-10-30')`).run(`${oldName}#7:ownerless:${head}`, oldName);
  const rounds = [{ state: 'completed', startHeadSha: 'b'.repeat(40), resultingHeadSha: head }];
  const jobId = 'example-org__alpha-pr-7-completed';
  json(`follow-up-jobs/completed/${jobId}.json`,
    { jobId, repo: oldName, prNumber: 7, status: 'completed', remediationPlan: { rounds } });
  const handoff = { lane: { repository: oldName, base: 'main' } };
  const decisionBody = { receiptDigest: handoffDigest(handoff) };
  const decision = { ...decisionBody, id: `decision:${handoffDigest(decisionBody)}` };
  const body = { lane: handoff.lane, decision };
  const receipt = { ...body, digest: handoffDigest(body) };
  db.exec('CREATE TABLE fixture_receipts(repository TEXT,handoff_json TEXT,receipt_json TEXT,receipt_digest TEXT)');
  db.prepare('INSERT INTO fixture_receipts VALUES (?,?,?,?)')
    .run(oldName, JSON.stringify(handoff), JSON.stringify(receipt), receipt.digest);
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  assert.equal(previewReviewCycleCount(db, { repo: newName, prNumber: 7, headSha: head,
    now: '2026-10-30T01:00:00Z' }).previous.verdict_count, 1);
  assert.equal(db.prepare('SELECT event_key FROM ttm_flag_state').get().event_key, `${newName}#7:ownerless:${head}`);
  assert.deepEqual(await readCompletedRemediationRounds(rootDir, newName, 7), rounds);
  const row = db.prepare('SELECT * FROM fixture_receipts').get();
  const moved = JSON.parse(row.receipt_json);
  const { id, ...movedDecision } = moved.decision;
  assert.equal(movedDecision.receiptDigest, handoffDigest(JSON.parse(row.handoff_json)));
  assert.equal(id, `decision:${handoffDigest(movedDecision)}`);
  const { digest, ...movedBody } = moved;
  assert.equal(digest, handoffDigest(movedBody));
  assert.equal(row.receipt_digest, digest);
});

for (const failure of ['file', 'database']) {
  test(`interrupted ${failure} participant is fenced and replayed without another review or audit`, async t => {
    const { db, rootDir, options, json, logs } = fixture(t);
    seedReview(db);
    observeRepositoryIdentity({ ...options, repository: repository(oldName) });
    json('state-a.json', { repo: oldName, prNumber: 7 });
    json('state-b.json', { repo: oldName, prNumber: 7 });
    const otherPath = join(rootDir, 'data', 'ham-primary-change-refusals.db');
    const other = new Database(otherPath);
    other.exec('CREATE TABLE refusals(repo TEXT, pr INTEGER)');
    other.prepare('INSERT INTO refusals VALUES (?,7)').run(oldName);
    other.close();
    const crash = () => { throw new Error('synthetic interruption'); };
    assert.throws(() => observeRepositoryIdentity({ ...options, repository: repository(newName),
      ...(failure === 'file' ? { afterFile: crash } : { afterDatabase: crash }) }), /synthetic interruption/);
    assert.equal(db.prepare('SELECT repo FROM reviewed_prs').get().repo, oldName);
    await assert.rejects(withRepositoryStateCycle(rootDir, async () => {}), { code: 'REPOSITORY_STATE_BUSY' });
    recoverRepositoryRename(options);
    recoverRepositoryRename(options);
    assert.equal(db.prepare('SELECT repo FROM reviewed_prs').get().repo, newName);
    const reopened = new Database(otherPath);
    assert.equal(reopened.prepare('SELECT repo FROM refusals').get().repo, newName);
    assert.equal(reopened.prepare('SELECT count(*) AS n FROM repository_rename_audit').get().n, 1);
    reopened.close();
    assert.equal(JSON.parse(readFileSync(join(rootDir, 'data', 'state-b.json'))).repo, newName);
    assert.equal(logs.length, 1);
    await withRepositoryStateCycle(rootDir, async () => {});
  });
}

test('reused old name has a distinct identity and never inherits the prior review', t => {
  const { db, rootDir, options, warnings } = fixture(t);
  seedReview(db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  observeRepositoryListing({ ...options, repositories: [{ ...repository(oldName), id: 456 }, repository(newName)] });
  assert.equal(db.prepare('SELECT repo FROM reviewed_prs').get().repo, newName);
  assert.equal(db.prepare('SELECT count(*) AS n FROM reviewed_prs WHERE repo=?').get(oldName).n, 0);
  assert.equal(canonicalRepositoryName(db, oldName), oldName);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /distinct repository id 456/);
  assert.equal(resolveRepositoryName(rootDir, oldName), oldName);
  assert.equal(resolveRepositoryName(rootDir, newName), newName);
  assert.deepEqual(repositoryNames(rootDir, oldName), [oldName]);
  assert.equal(readAmaCloserLease(rootDir, { repo: oldName, prNumber: 7, headSha: head }), null);
});

test('payload identity observed inside a cycle defers intake and recovers at the next boundary', async t => {
  const { db, rootDir, options } = fixture(t);
  seedReview(db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  await assert.rejects(withRepositoryStateCycle(rootDir, async () => {
    observeRepositoryIdentity({ ...options, repository: repository(newName) });
  }), { code: 'REPOSITORY_STATE_BUSY' });
  assert.equal(db.prepare('SELECT repo FROM reviewed_prs').get().repo, oldName);
  recoverRepositoryObservations(options);
  assert.equal(db.prepare('SELECT repo FROM reviewed_prs').get().repo, newName);
});

test('migration cannot cross an active owner, including a detached settlement', async t => {
  const { rootDir, options } = fixture(t);
  seedReview(options.db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  let finish;
  const owner = withRepositoryStateCycle(rootDir, () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => observeRepositoryIdentity({ ...options, repository: repository(newName) }), { code: 'REPOSITORY_STATE_BUSY' });
  finish();
  await owner;
  withRepositoryStateRead(rootDir, () => assert.throws(() =>
    observeRepositoryIdentity({ ...options, repository: repository(newName) }), { code: 'REPOSITORY_STATE_BUSY' }));
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
});

test('local finalization lookups and handoff checksums move together; signed evidence remains intact', t => {
  const { db, options } = fixture(t);
  seedReview(db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  const signed = { repo: oldName, signature: 'fixture-signature' };
  const payload = { lane: { repository: oldName, base: 'main' }, attestations: signed };
  const digest = handoffDigest(payload);
  db.exec('CREATE TABLE fixture_handoffs(repository TEXT,payload_json TEXT,payload_digest TEXT,ack_json TEXT)');
  db.prepare('INSERT INTO fixture_handoffs VALUES (?,?,?,?)')
    .run(oldName, JSON.stringify(payload), digest, JSON.stringify({ payloadDigest: digest }));
  db.prepare(`INSERT INTO finalization_ledger(domain_id,subject_external_id,event_type,at,payload_json)
    VALUES ('code-pr',?,'attestation_recorded','2026-10-30',?)`).run(`${oldName}#7`, JSON.stringify({ attestation: signed }));
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  const row = db.prepare('SELECT * FROM fixture_handoffs WHERE repository=?').get(newName);
  assert.equal(JSON.parse(row.payload_json).lane.repository, newName);
  assert.deepEqual(JSON.parse(row.payload_json).attestations, signed);
  assert.equal(row.payload_digest, handoffDigest(JSON.parse(row.payload_json)));
  assert.equal(JSON.parse(row.ack_json).payloadDigest, row.payload_digest);
  assert.deepEqual(JSON.parse(db.prepare('SELECT payload_json FROM finalization_ledger WHERE subject_external_id=?')
    .get(`${newName}#7`).payload_json).attestation, signed);
});

test('unowned destination state or colliding constraints roll back before files move', t => {
  const { db, options, json } = fixture(t);
  seedReview(db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  const path = json('fixture.json', { repo: oldName });
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer) VALUES (?,7,'2026-10-30','codex')`).run(newName);
  assert.throws(() => observeRepositoryIdentity({ ...options, repository: repository(newName) }), /unowned state/);
  assert.equal(JSON.parse(readFileSync(path)).repo, oldName);
  assert.equal(db.prepare('SELECT full_name FROM repository_identities').get().full_name, oldName);
});

test('observation recovery survives a crash after the rename committed but before observation removal', async t => {
  const { db, options, json, rootDir, logs } = fixture(t);
  seedReview(db);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  json('repository-renames/observation.json', repository(newName));
  recoverRepositoryObservations(options);
  assert.equal(logs.length, 1);
  await withRepositoryStateCycle(rootDir, async () => {});
});

test('renames invalidate disposable observations and rekey primary-change tuple digests', async t => {
  const { options, rootDir } = fixture(t);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  const cache = repositoryObservationCache(new Map());
  await withRepositoryStateCycle(rootDir, async () => cache.set(`${oldName}#7`, 'fixture'));
  const args = { rootDir, repo: oldName, prNumber: 7, baseSha: 'b'.repeat(40), headSha: head, mergeBase: 'c'.repeat(40) };
  const history = { headSha: head, hasHammerCommits: false };
  await storedPrimaryChange(args, async () => history);
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  await withRepositoryStateCycle(rootDir, async () => assert.equal(cache.size, 0));
  assert.deepEqual(await storedPrimaryChange({ ...args, repo: newName }, () => {
    throw new Error('must reuse migrated primary-change result');
  }), history);
});

test('legacy CI recovery digests retain their consumed once-per-head budget after rename', async t => {
  const { options, rootDir, json } = fixture(t);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  const identity = `page:${oldName}:7:${head}:fixture-ci`;
  const oldPath = json(`ci-recovery/${repositoryStateDigest(identity)}.json`,
    { reason: 'fixture-ci', state: 'posted', reservedAt: '2026-10-30T00:00:00Z' });
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  assert.equal(await pageCiOnce({ rootDir, repo: newName, prNumber: 7, headSha: head, reason: 'fixture-ci',
    deliverAlertImpl: () => { throw new Error('a consumed budget must not page again'); } }), false);
  assert.equal(existsSync(oldPath), false);
});

test('digest-only CI evidence under a reused name cannot be borrowed by its historical owner', async t => {
  const { options, rootDir, json } = fixture(t);
  observeRepositoryIdentity({ ...options, repository: repository(oldName) });
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  observeRepositoryIdentity({ ...options, repository: { ...repository(oldName), id: 456 } });
  const identity = `page:${oldName}:7:${head}:fixture-ci`;
  const oldPath = json(`ci-recovery/${repositoryStateDigest(identity)}.json`,
    { reason: 'fixture-ci', state: 'posted' });
  await assert.rejects(pageCiOnce({ rootDir, repo: newName, prNumber: 7, headSha: head, reason: 'fixture-ci',
    deliverAlertImpl: () => { throw new Error('ambiguity must not page'); } }), /Ambiguous legacy CI reservation/);
  assert.equal(existsSync(oldPath), true);
  assert.equal(existsSync(join(dirname(oldPath),
    `${repositoryStateDigest(identity.replace(oldName, newName))}.json`)), false);
});

test('mixed-case repository identities rewrite keys without rewriting signed evidence or prose', t => {
  const { options, json } = fixture(t);
  observeRepositoryIdentity({ ...options, repository: repository('Example-Org/Alpha') });
  const path = json('fixture.json', { repo: oldName, key: `${oldName}#7`, identity: `page:${oldName}:7:${head}:fixture`,
    body: `Review for ${oldName}`, attestation: { repo: oldName, signature: 'fixture' } });
  observeRepositoryIdentity({ ...options, repository: repository(newName) });
  const record = JSON.parse(readFileSync(path));
  assert.equal(record.repo, newName);
  assert.equal(record.key, `${newName}#7`);
  assert.equal(record.identity, `page:${newName}:7:${head}:fixture`);
  assert.equal(record.body, `Review for ${oldName}`);
  assert.equal(record.attestation.repo, oldName);
});
