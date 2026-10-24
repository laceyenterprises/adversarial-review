import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { observeHoldRelease, holdReleaseRoute, markHoldReleaseRouted, readLatestHoldRelease } from '../src/operator-hold-release.mjs';
import { evaluateHammerStopHold } from '../src/ama/hammer-stop-hold.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger, markHammerRetryCapExhausted, hammerRetryCapFilePath } from '../src/ama/hammer-retry-cap.mjs';
import { refundOperatorHeldHammerStop } from '../src/ama/operator-hold-refund.mjs';
import { recordReviewCycleVerdict } from '../src/review-cycle-cap.mjs';

const repo = 'fixture/repo', prNumber = 1, headSha = 'a'.repeat(40);
const heldAt = '2026-10-11T16:00:00Z', releasedAt = '2026-10-11T17:00:00Z';
const silent = { log() {}, warn() {}, error() {} };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hold-release-'));
  mkdirSync(join(rootDir, 'data'));
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, labels_json TEXT)');
  db.prepare('INSERT INTO reviewed_prs VALUES (?, ?, ?)').run(repo, prNumber, JSON.stringify(['no-merge-hold']));
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const observe = (liveLabels, now = releasedAt) => observeHoldRelease({ db, repo, prNumber, headSha, liveLabels, now });
  return { rootDir, db, observe };
}
const settled = { verdict: 'approved', reviewedHeadSha: headSha, blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingCount: 0 };
const candidate = { mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS' };
const posted = { review_status: 'posted', reviewer_head_sha: headSha };
for (const [name, facts, action] of [
  ['first review', { row: { review_status: 'pending' } }, 'review'],
  ['re-review', { row: posted, settled: { ...settled, reviewedHeadSha: 'b'.repeat(40) } }, 'review'],
  ['blocking findings', { row: posted, settled: { ...settled, blockingFindingCount: 1 }, roundsLeft: true }, 'remediation'],
  ['active remediation', { row: posted, settled: { verdict: '', remediationPending: true } }, 'remediation'],
  ['clean review', { row: posted, settled, candidate }, 'daemon-clean-merge'],
  ['conflict', { row: posted, settled, candidate: { ...candidate, mergeable: 'CONFLICTING' } }, 'hammer'],
  ['red checks', { row: posted, settled, candidate: { ...candidate, checksConclusion: 'FAILURE' } }, 'hammer'],
  ['stale base', { row: posted, settled, candidate: { ...candidate, mergeStateStatus: 'BEHIND' } }, 'hammer'],
  ['cycle cap', { row: posted, cycleCapped: true }, 'hammer'],
]) {
  test(`${name}: held then released on the same head arms the existing stage once`, t => {
    const { db, observe } = fixture(t);
    assert.equal(observe(['no-merge-hold'], heldAt), null);
    const release = observe([]);
    assert.ok(release);
    const route = holdReleaseRoute({ headSha, ...facts });
    assert.equal(route.action, action);
    const lines = [];
    assert.equal(markHoldReleaseRouted({ db, release, route, logger: { log: line => lines.push(line) } }), true);
    assert.equal(markHoldReleaseRouted({ db, release, route, logger: silent }), false);
    assert.equal(observe([]), null);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`stage=${route.stage} action=${action}`));
  });
}
test('partial removal is not release; re-applying either hold cancels undelivered intent', t => {
  const { db, observe } = fixture(t);
  observe(['do-not-merge', 'no-merge-hold'], heldAt);
  assert.equal(observe(['do-not-merge']), null);
  const release = observe([]);
  assert.deepEqual(JSON.parse(release.removed_json), ['do-not-merge']);
  observe(['merge-agent-skip']);
  assert.equal(markHoldReleaseRouted({ db, release, route: { stage: 'clean-review', action: 'daemon-clean-merge' }, logger: silent }), false);
  const next = observe([]);
  assert.ok(next.id > release.id);
});
test('durable intent survives restart; invalid stored/live labels do not manufacture a release', t => {
  const { db, rootDir, observe } = fixture(t);
  assert.equal(observe(undefined), null);
  db.prepare('UPDATE reviewed_prs SET labels_json = NULL').run();
  assert.equal(observe([]), null);
  observe(['no-merge-hold'], heldAt);
  const release = observe([]);
  const secondDb = new Database(join(rootDir, 'data', 'reviews.db'));
  try {
    const replay = observeHoldRelease({ db: secondDb, repo, prNumber, headSha, liveLabels: [] });
    assert.equal(replay.id, release.id);
    assert.equal(readLatestHoldRelease(rootDir, repo, prNumber, headSha).id, release.id);
    assert.equal(db.prepare('SELECT count(*) n FROM operator_hold_releases').get().n, 1);
  } finally { secondDb.close(); }
});
test('unknown settled stage logs a current-head re-review fallback', () => {
  assert.deepEqual(holdReleaseRoute({ row: posted, headSha }), { stage: 'rereview', action: 'review', unknown: true });
});
test('same-head hammer stop is released by label removal and refunds only a hold-only stop once', async t => {
  const { rootDir, observe } = fixture(t);
  recordHammerRetryDispatch(rootDir, { repo, prNumber }, { jobKey: headSha, headSha, now: heldAt });
  const args = { rootDir, hqRoot: rootDir, repo, prNumber, headSha, logger: silent,
    prMetadata: { headSha, baseSha: 'base', mergeableState: 'MERGEABLE', statusCheckRollup: [] },
    readAuditImpl: () => ({ attempts: [{ outcome: 'failed-without-merge', reason: 'label-no-merge-hold', noExecution: true, launchRequestId: 'held-launch', head: headSha, startedAt: '2026-10-11T16:01:00Z' }] }),
    now: '2026-10-11T16:02:00Z' };
  assert.equal((await evaluateHammerStopHold(args)).action, 'hold');
  observe([]);
  const released = await evaluateHammerStopHold({ ...args, now: releasedAt });
  assert.equal(released.action, 'release');
  assert.deepEqual(released.changed, ['hold-released']);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }).attemptCount, 0);
  await evaluateHammerStopHold({ ...args, now: '2026-10-11T17:01:00Z' });
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }).lifetimeAttemptCount, 0);
  // A later real hammer stop on the same head does not reuse the old release.
  const next = await evaluateHammerStopHold({ ...args, now: '2026-10-11T17:03:00Z',
    readAuditImpl: () => ({ attempts: [{ outcome: 'failed-without-merge', reason: 'ci-not-green', head: headSha, startedAt: '2026-10-11T17:02:00Z' }] }) });
  assert.equal(next.action, 'hold');
});
test('held verdicts retain the cycle-cap breaker across hold and release', t => {
  const { db, observe } = fixture(t);
  let tick = 0;
  const record = sha => recordReviewCycleVerdict(db, { repo, prNumber, headSha: sha,
    verdictAt: new Date(Date.parse(heldAt) + tick++ * 1000).toISOString() });
  assert.equal(record(headSha).count, 1);
  observe([]);
  assert.equal(record(headSha).count, 1);
  observe(['no-merge-hold']);
  assert.equal(record('b'.repeat(40)).count, 2);
  observe([]);
  assert.equal(record('c'.repeat(40)).count, 3);
});

test('refund write failure logs and still releases the hammer hold without changing charges', async t => {
  const { rootDir, observe } = fixture(t);
  recordHammerRetryDispatch(rootDir, { repo, prNumber }, { jobKey: headSha, headSha, now: heldAt });
  observe([]);
  const ledgerPath = hammerRetryCapFilePath(rootDir, { repo, prNumber });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === ledgerPath) throw new Error('fixture refund disk failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const warnings = [];
  const result = await evaluateHammerStopHold({ rootDir, hqRoot: rootDir, repo, prNumber, headSha,
    logger: { ...silent, warn: line => warnings.push(line) }, now: releasedAt,
    prMetadata: { headSha, baseSha: 'base', mergeableState: 'MERGEABLE', statusCheckRollup: [] },
    readAuditImpl: () => ({ attempts: [{ outcome: 'failed-without-merge', reason: 'label-no-merge-hold',
      noExecution: true, launchRequestId: 'held-launch', head: headSha, startedAt: '2026-10-11T16:01:00Z' }] }),
  });
  assert.equal(result.action, 'release');
  assert.deepEqual(result.changed, ['hold-released']);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }).attemptCount, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /operator-hold refund failed.*fixture refund disk failure/);
});

test('hold-only refunds preserve real attempts and their durable keys survive the next dispatch', t => {
  const { rootDir } = fixture(t);
  const identity = { repo, prNumber };
  for (const now of ['2026-10-11T14:00:00Z', '2026-10-11T15:00:00Z', heldAt]) {
    recordHammerRetryDispatch(rootDir, identity, { jobKey: headSha, headSha, now });
  }
  const stop = { headSha, recordedAt: '2026-10-11T16:01:00Z', refundStops: [
    { auditHead: headSha, stopKey: 'held-1', noExecution: true, launchRequestId: 'held-launch-1', predicate: 'label-no-merge-hold', recordedAt: '2026-10-11T14:01:00Z' },
    { auditHead: headSha, stopKey: 'real', predicate: 'label-no-merge-hold', recordedAt: '2026-10-11T15:01:00Z' },
    { auditHead: headSha, stopKey: 'held-2', noExecution: true, launchRequestId: 'held-launch-2', predicate: 'label-do-not-merge', recordedAt: '2026-10-11T16:01:00Z' },
  ] };
  assert.equal(refundOperatorHeldHammerStop(rootDir, identity, stop), true);
  let ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.attemptCount, 1);
  assert.equal(ledger.lifetimeAttemptCount, 1);
  const refundedAt = ledger.operatorHoldRefundedAt;
  markHammerRetryCapExhausted(rootDir, identity, { jobKey: headSha, headSha, attemptCount: 1 });
  ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.deepEqual(ledger.operatorHoldRefundStopKeys, ['held-1', 'held-2']);
  assert.equal(ledger.operatorHoldRefundedAt, refundedAt);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: headSha, headSha, now: '2026-10-11T18:00:00Z' });
  assert.equal(refundOperatorHeldHammerStop(rootDir, identity, { ...stop, recordedAt: '2026-10-11T18:01:00Z' }), false);
  ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.attemptCount, 2);
  assert.deepEqual(ledger.operatorHoldRefundStopKeys, ['held-1', 'held-2']);
  assert.equal(ledger.operatorHoldRefundedAt, refundedAt);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: 'fresh-review', headSha, now: '2026-10-11T19:00:00Z' });
  ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.deepEqual(ledger.operatorHoldRefundStopKeys, ['held-1', 'held-2']);
  assert.equal(ledger.operatorHoldRefundedAt, refundedAt);
});

test('RCV-08 hold-only refund retains permanent unexecuted launch identities', t => {
  const { rootDir } = fixture(t);
  const identity = { repo, prNumber };
  const ledger = recordHammerRetryDispatch(rootDir, identity, { jobKey: headSha, headSha, now: heldAt });
  const oldIds = Array.from({ length: 10 }, (_, i) => `old-launch-${i}`);
  writeFileSync(hammerRetryCapFilePath(rootDir, identity), JSON.stringify({ ...ledger, unexecutedLaunchRequestIds: oldIds }));
  const stop = { headSha, recordedAt: releasedAt, stopKey: 'new-stop', predicate: 'label-no-merge-hold',
    noExecution: true, launchRequestId: 'new-launch' };
  assert.equal(refundOperatorHeldHammerStop(rootDir, identity, stop), true);
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity).unexecutedLaunchRequestIds,
    [...oldIds, 'new-launch']);
  assert.equal(refundOperatorHeldHammerStop(rootDir, identity, stop), false);
});

 test('unchanged snapshots perform no DDL or writes after initialization', t => {
  const { db, observe } = fixture(t);
  observe(['no-merge-hold']);
  const before = db.prepare('SELECT total_changes() n').get().n;
  const exec = db.exec.bind(db);
  db.exec = () => { throw new Error('unexpected repeated DDL'); };
  try {
    observe(['no-merge-hold']);
    assert.equal(db.prepare('SELECT total_changes() n').get().n, before);
  } finally { db.exec = exec; }
});
 test('failed release transaction preserves the held snapshot for retry', t => {
  const { db, observe } = fixture(t);
  observe(['no-merge-hold']);
  db.exec("CREATE TRIGGER fail_release BEFORE INSERT ON operator_hold_releases BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  assert.throws(() => observe([]), /fixture failure/);
  assert.deepEqual(JSON.parse(db.prepare('SELECT labels_json FROM reviewed_prs').get().labels_json), ['no-merge-hold']);
  db.exec('DROP TRIGGER fail_release');
  assert.ok(observe([]));
});
