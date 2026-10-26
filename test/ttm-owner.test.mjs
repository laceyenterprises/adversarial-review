import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveTtmOwner, observeTtmReviewLane, readTtmOwnerEvidence } from '../src/ttm-owner.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { runTtmTrackerWatcherTick } from '../src/ttm-tracker.mjs';

const START = '2026-01-01T00:00:00.000Z';
const at = minutes => new Date(Date.parse(START) + minutes * 60_000).toISOString();
const suppressed = { status: 'pending', suppressed: true, reason: 'hammer-validated-head' };
const hold = { reason: 'companion-wait', releaseCondition: 'hammer-inputs-change', deadline: at(10) };

test('owner resolution selects exactly one owner and names all declined lanes', () => {
  assert.deepEqual(resolveTtmOwner({ review: suppressed }, at(0)), {
    owner: null, reason: 'review suppressed: hammer-validated-head; no live closer; no hold; no operator hold',
  });
  for (const status of ['pending', 'pending-upstream', 'ci-blocked', 'reviewing']) {
    assert.equal(resolveTtmOwner({ review: { status } }, START).owner, 'review-lane');
  }
  assert.equal(resolveTtmOwner({ review: { status: 'posted' } }, START).owner, null, 'completed review alone cannot own the next action');
  assert.equal(resolveTtmOwner({ review: suppressed, closers: [{ live: true }] }, START).owner, 'live-closer');
  assert.equal(resolveTtmOwner({ review: suppressed, holds: [hold] }, START).owner, 'hold');
  assert.match(resolveTtmOwner({ review: suppressed, holds: [hold] }, at(10)).reason, /deadline expired/);
  assert.equal(resolveTtmOwner({ review: suppressed, holds: [{ ...hold, deadline: null }] }, START).owner, null);
  assert.equal(resolveTtmOwner({ review: suppressed, holds: [{ ...hold, releaseCondition: 'somebody acts' }] }, START).owner, null);
  for (const label of ['no-merge-hold', 'do-not-merge', 'merge-agent-skip']) {
    assert.equal(resolveTtmOwner({ review: suppressed, labels: [{ name: label }], closers: [{ live: true }], holds: [hold] }, START).owner, 'operator-hold');
  }
});

function fixture() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, review_status, revision_ref)
    VALUES ('example/project', 1, ?, 'fixture', 'pending', 'head-a')`).run(START);
  observeTtmReviewLane(db, { repo: 'example/project', prNumber: 1, headSha: 'head-a', ...suppressed, observedAt: START });
  return db;
}

function tick(db, minutes, options = {}) {
  return runTtmTrackerWatcherTick({ db, now: () => new Date(at(minutes)), env: {},
    config: { baseBudgetMinutes: 1000, perRoundBudgetMinutes: 1000 }, logger: { log() {}, error() {} }, ...options });
}

test('suppressed review is ownerless after cadence plus margin and pages once per head, across restarts and resolution', async () => {
  const db = fixture();
  const pages = [];
  const deliverAlertFn = async (text, metadata) => pages.push({ text, metadata });
  try {
    assert.equal((await tick(db, 0, { deliverAlertFn })).flags.length, 0);
    assert.equal((await tick(db, 7, { deliverAlertFn })).flags.length, 0);
    const result = await tick(db, 8, { deliverAlertFn });
    assert.equal(result.flags[0].flagKind, 'ownerless');
    assert.match(pages[0].text, /example\/project#1.*ownerless.*review suppressed: hammer-validated-head/);
    await tick(db, 9, { deliverAlertFn });
    assert.equal(pages.length, 1);
    db.prepare("UPDATE reviewed_prs SET labels_json = '[\"no-merge-hold\"]'").run();
    assert.equal((await tick(db, 10, { deliverAlertFn })).flags.length, 0);
    db.prepare('UPDATE reviewed_prs SET labels_json = NULL').run();
    await tick(db, 11, { deliverAlertFn });
    await tick(db, 19, { deliverAlertFn });
    assert.equal(pages.length, 1, 'same head does not repage after a transient owner');
    observeTtmReviewLane(db, { repo: 'example/project', prNumber: 1, headSha: 'head-b', ...suppressed, observedAt: at(20) });
    assert.equal((await tick(db, 20, { deliverAlertFn })).flags.length, 0, 'new head gets a fresh grace');
    await tick(db, 28, { deliverAlertFn });
    assert.equal(pages.length, 2);
    assert.equal(pages[1].metadata.payload.headSha, 'head-b');
  } finally { db.close(); }
});

test('expired hold becomes ownerless; live closer and valid hold clear the timer', async () => {
  const db = fixture();
  let evidence = { review: suppressed, holds: [hold] };
  const options = { readOwnerEvidence: () => evidence };
  try {
    assert.equal((await tick(db, 0, options)).timelines[0].ownership.owner, 'hold');
    assert.equal((await tick(db, 9, options)).flags.length, 0);
    await tick(db, 10, options);
    const expired = await tick(db, 18, options);
    assert.equal(expired.flags[0].flagKind, 'ownerless');
    assert.match(expired.flags[0].details.stallReason, /deadline expired/);
    evidence = { review: suppressed, closers: [{ live: true }] };
    assert.equal((await tick(db, 19, options)).flags.length, 0);
    evidence = { review: suppressed };
    assert.equal((await tick(db, 20, options)).flags.length, 0);
  } finally { db.close(); }
});

test('all existing STUCK kinds page through the same path, and failed delivery retries', async () => {
  const db = fixture();
  const pages = [];
  try {
    db.prepare(`UPDATE reviewed_prs SET review_status = 'reviewing', reviewer_lease_expires_at = ?,
      rereview_requested_at = ?`).run(at(-60), at(-60));
    let attempts = 0;
    await tick(db, 0, { deliverAlertFn: async () => { attempts++; throw new Error('fixture transport failure'); } });
    await tick(db, 1, { deliverAlertFn: async text => { attempts++; pages.push(text); } });
    assert.match(pages[0], /rereview_unanswered/);
    assert.match(pages[0], /reviewer_lease_expired/);
    assert.equal(attempts, 2, 'one attempt per head per poll; a failed delivery retries on the next poll');
    await tick(db, 2, { deliverAlertFn: async text => pages.push(text) });
    assert.equal(pages.length, 1);
    // Terminal-but-unmerged uses the same generic STUCK selection too.
    const { pageTtmStuckFlags } = await import('../src/ttm-owner.mjs');
    await pageTtmStuckFlags(db, [{ repo: 'example/project', prNumber: 2, flagKind: 'terminal_but_unmerged',
      progressClass: 'stuck', details: { headSha: 'head-c', stallReason: 'settled' } }],
    { observedAt: START, deliverAlertFn: async text => pages.push(text) });
    assert.match(pages[1], /terminal_but_unmerged/);
  } finally { db.close(); }
});

test('observations retain suppression across deferred polls, clear it on admission, and never leak across heads', () => {
  const db = fixture();
  try {
    const observe = decision => observeTtmReviewLane(db, { repo: 'example/project', prNumber: 1, headSha: 'head-a', ...decision });
    observe({});
    assert.equal(db.prepare('SELECT review_suppressed FROM ttm_owner_state').get().review_suppressed, 1);
    observe({ suppressed: false });
    assert.equal(db.prepare('SELECT review_suppressed FROM ttm_owner_state').get().review_suppressed, 0);
    observe(suppressed);
    observe({ headSha: 'head-b' });
    assert.equal(db.prepare('SELECT review_suppressed FROM ttm_owner_state').get().review_suppressed, 0);
    assert.equal(readTtmOwnerEvidence(null, { reviewStatus: 'pending', reviewerLeaseExpiredMinutes: null }, null).review.suppressed, false);
  } finally { db.close(); }
});

test('unreadable evidence remains visible and terminal PRs clear ownership observations', async () => {
  const db = fixture();
  const options = { readOwnerEvidence: () => { throw Object.assign(new Error('synthetic corrupt record'), { code: 'FIXTURE_CORRUPT' }); } };
  try {
    await tick(db, 0, options);
    const result = await tick(db, 8, options);
    assert.match(result.flags[0].details.stallReason, /ownership evidence unreadable: FIXTURE_CORRUPT/);
    db.prepare("UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ?").run(at(9));
    assert.equal((await tick(db, 10, options)).flags.length, 0);
    assert.equal(db.prepare('SELECT ownerless_since FROM ttm_owner_state').get().ownerless_since, null);
  } finally { db.close(); }
});

test('local readers distinguish a live closer, terminal launch, pushed head, and live remediator without a ledger', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { amaCloserLeaseFilePath } = await import('../src/ama/closer-lease.mjs');
  const { amaCloserDispatchFilePath } = await import('../src/ama/dispatch-record-read.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'ttm-owner-fixture-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/project', prNumber: 1, headSha: 'head-a' };
  const write = (file, doc) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(doc)); };
  const row = { ...identity, labels: [], reviewStatus: 'posted', reviewerLeaseExpiredMinutes: null };
  const read = (fixtureRow = row) => resolveTtmOwner(readTtmOwnerEvidence(rootDir, fixtureRow, null), START);
  write(amaCloserLeaseFilePath(rootDir, identity), { ...identity, status: 'dispatched', lrqId: 'fixture-launch' });
  const record = { ...identity, state: 'dispatched', launchRequestId: 'fixture-launch', lastObservedStatus: 'running' };
  write(amaCloserDispatchFilePath(rootDir, identity), record);
  assert.equal(read().owner, 'live-closer');
  assert.equal(read({ ...row, headSha: 'head-b' }).owner, 'live-closer', 'live launch owns the PR after its own push');
  write(amaCloserDispatchFilePath(rootDir, identity), { ...record, terminalLaunchStatus: 'failed' });
  assert.equal(read().owner, null, 'terminal launch overrides the leftover dispatched lease');
  write(amaCloserLeaseFilePath(rootDir, identity), { ...identity, status: 'pending', lrqId: null });
  assert.equal(read().owner, 'live-closer', 'new pending lease owns a retry before a receipt replaces the old record');
  rmSync(amaCloserLeaseFilePath(rootDir, identity));
  const jobFile = join(rootDir, 'data', 'follow-up-jobs', 'in-progress', 'example__project-pr-1-fixture.json');
  write(jobFile, { repo: identity.repo, prNumber: 1, remediationWorker: { state: 'spawned', launchRequestId: 'fixture-remediator' } });
  assert.equal(read().owner, 'live-closer');
  write(jobFile, { repo: identity.repo, prNumber: 1, remediationWorker: { state: 'failed' } });
  assert.equal(read().owner, null);
});

test('hammer holds use existing exports and require both a computable release and a future deadline', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { amaAuditFilePath } = await import('../src/ama/audit.mjs');
  const { readHammerStopForHead } = await import('../src/ama/hammer-stop-hold.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'ttm-hold-fixture-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/project', prNumber: 1, headSha: 'a'.repeat(40) };
  const auditPath = amaAuditFilePath(rootDir, identity.repo, identity.prNumber, identity.headSha);
  mkdirSync(dirname(auditPath), { recursive: true });
  writeFileSync(auditPath, JSON.stringify({ attempts: [{ outcome: 'no-merge', reason: 'companion-wait',
    startedAt: START, attemptNumber: 1, headSha: identity.headSha }] }));
  const stop = readHammerStopForHead({ ...identity, hqRoot: rootDir });
  assert.ok(stop);
  const holdPath = join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', 'example-project-pr-1.json');
  mkdirSync(dirname(holdPath), { recursive: true });
  const save = entry => writeFileSync(holdPath, JSON.stringify({ heads: { [identity.headSha]: { stopKey: stop.stopKey, ...entry } } }));
  const row = { ...identity, reviewStatus: 'posted', reviewerLeaseExpiredMinutes: null };
  const read = nowIso => resolveTtmOwner(readTtmOwnerEvidence(rootDir, row, null, { hqRoot: rootDir }), nowIso);
  save({ inputs: { headSha: identity.headSha }, retryAfter: at(10) });
  assert.equal(read(START).owner, 'hold');
  assert.match(read(at(10)).reason, /deadline expired/);
  save({ inputs: { headSha: identity.headSha } });
  assert.match(read(START).reason, /no deadline/);
  save({ retryAfter: at(10) });
  assert.match(read(START).reason, /no machine-checkable release condition/);
  save({ inputs: { headSha: identity.headSha }, retryAfter: at(10), releasedAt: START });
  assert.equal(read(START).owner, null);
});
