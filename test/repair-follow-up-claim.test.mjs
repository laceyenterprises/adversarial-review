import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { main } from '../bin/repair-in-place.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { claimNextFollowUpJob, createFollowUpJob, getFollowUpJobDir } from '../src/follow-up-jobs.mjs';
import { persistRemediationDispatchPath } from '../src/remediation-dispatch-mode.mjs';
import { bindRepairHead, pendingRepairEpoch, reserveRepairEpoch } from '../src/repair-epochs.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { readRepairFollowUpClaim } from '../src/repair-follow-up-claim.mjs';
import { mockRepairDispatchScope, pairedDispatchAbsence } from './helpers/repair-dispatch-scope.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';

const repo = 'fixture/widgets', prNumber = 11159, headSha = '0ff19e32' + 'a'.repeat(32);
const identity = { repo, prNumber, headSha };

function fixture(t, { exhausted = true } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repair-follow-up-claim-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
    review_status,reviewer_head_sha,rereview_reason) VALUES (?,?,'2026-11-19T21:25:01Z',
    'synthetic','open','posted',?,?)`).run(repo, prNumber, headSha, exhausted ? 'closure-retry-exhausted' : null);
  db.close();
  createFollowUpJob({ rootDir, ...identity, revisionRef: headSha, branch: 'fixture',
    reviewPostedAt: '2026-11-19T21:25:01.300Z', reviewerModel: 'codex',
    reviewBody: '## Verdict\nREQUEST_CHANGES\n\n## Blocking findings\n1. Fix the fixture.' });
  const claim = claimNextFollowUpJob({ rootDir });
  const job = persistRemediationDispatchPath({ ...claim, dispatchPath: 'hq' });
  const argv = [rootDir, repo, String(prNumber), headSha, 'fixture-submit', 'false',
    job.jobId, String(process.pid), 'fixture-project'];
  return { rootDir, jobPath: claim.jobPath, job, argv };
}

test('the real pre-spawn claim permits one repair writer and retains the job', async t => {
  const { rootDir, jobPath, argv } = fixture(t);
  const bytes = readFileSync(jobPath);
  const options = mockRepairDispatchScope(t);
  const [reserved, competitor] = await Promise.all([
    main(argv, options),
    main(argv.with(4, 'competing-submit')),
  ]);
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  assert.equal(reserved.epoch.baseHead, headSha);
  assert.equal(competitor.reason, 'closer-submission-owned');
  assert.equal(pendingRepairEpoch(rootDir, identity).id, reserved.epoch.id);
  assert.deepEqual(readFileSync(jobPath), bytes);
});

test('denied repair scope leaves the pre-spawn claim and spent budgets intact', async t => {
  const { rootDir, jobPath, argv } = fixture(t);
  recordHammerRetryDispatch(rootDir, identity,
    { jobKey: headSha, headSha, launchRequestId: 'fixture-spent-closer' });
  const budgets = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(budgets.attemptCount, 1);
  const bytes = readFileSync(jobPath);
  const options = mockRepairDispatchScope(t, () => {
    throw new Error('app-contract dispatch_scope_denied: synthetic denial');
  });
  const result = await main(argv, options);
  assert.equal(result.reason, 'repair-dispatch-read-scope-denied');
  assert.deepEqual(readFileSync(jobPath), bytes);
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), budgets);
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('a changed pre-spawn claim during scope verification cannot reserve', async t => {
  const { rootDir, jobPath, job, argv } = fixture(t);
  let read = false;
  const options = mockRepairDispatchScope(t, selector => {
    read = true;
    job.remediationWorker = { state: 'spawned' };
    writeFileSync(jobPath, JSON.stringify(job));
    return pairedDispatchAbsence(selector);
  });
  assert.equal((await main(argv, options)).reason, 'remediation-owned');
  assert.equal(read, true);
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('legacy, missing, mismatched and stale claim evidence all refuse', async t => {
  const { rootDir, argv, jobPath, job } = fixture(t);
  for (const request of [argv.slice(0, 6), argv.with(6, `${argv[6]}-unknown`),
    argv.with(3, 'b'.repeat(40))]) {
    assert.equal((await main(request)).reason, 'remediation-owned');
  }
  for (const request of [argv.slice(0, 7), argv.with(7, '1'), argv.with(7, String(process.pid + 1))]) {
    assert.equal((await main(request)).reason, 'remediation-claim-launcher-mismatch');
  }
  const deadPid = 2 ** 31 - 1;
  job.claimedBy.launcherPid = deadPid;
  job.remediationPlan.rounds[0].claimedBy.launcherPid = deadPid;
  writeFileSync(jobPath, JSON.stringify(job));
  assert.equal((await main(argv.with(7, String(deadPid)))).reason, 'remediation-owned');
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('a changed claim during ownership observation cannot reserve', async t => {
  const { rootDir, jobPath, job, argv } = fixture(t);
  const request = main(argv);
  // The helper yields for ownership observation while the daemon can update
  // its own job. The pre-write reread must use the current record.
  job.remediationWorker = { state: 'spawned' };
  writeFileSync(jobPath, JSON.stringify(job));
  assert.equal((await request).reason, 'remediation-owned');
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('only a complete HQ claim at the current pre-spawn round attests ownership', async t => {
  const { rootDir, jobPath, job, argv } = fixture(t);
  const cases = [
    ['pending record', record => { record.status = 'pending'; }],
    ['attached worker', record => { record.remediationWorker = { state: 'spawned' }; }],
    ['bare dispatch', record => { record.remediationPlan.dispatchPath = 'bare'; }],
    ['over-budget round', record => { record.remediationPlan.maxRounds = 0; }],
    ['missing round state', record => { delete record.remediationPlan.rounds[0].state; }],
    ['mismatched start head', record => { record.remediationPlan.rounds[0].startHeadSha = 'b'.repeat(40); }],
  ];
  for (const [description, change] of cases) {
    const record = structuredClone(job);
    change(record);
    writeFileSync(jobPath, JSON.stringify(record));
    assert.equal((await main(argv)).reason, 'remediation-owned', description);
    assert.equal(pendingRepairEpoch(rootDir, identity), null);
  }
});

for (const bucket of ['pending', 'inProgress']) {
  test(`a competing ${bucket} record for the PR blocks an otherwise valid claim`, async t => {
    const { rootDir, argv, job } = fixture(t);
    // A payload for this PR still counts when its filename is anomalous.
    const path = join(getFollowUpJobDir(rootDir, bucket), 'misfiled.json');
    writeFileSync(path, JSON.stringify({ ...job, jobId: 'competing-job' }));
    assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-owned', jobId: 'competing-job' });
    writeFileSync(path, '{"jobId":"unknown-owner"}');
    assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-ownership-unknown', file: path });
    writeFileSync(path, '{');
    assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-ownership-unknown', file: path });
    assert.equal(pendingRepairEpoch(rootDir, identity), null);
  });
}

for (const bucket of ['pending', 'inProgress']) {
  test(`an unrelated ${bucket} job removed between enumeration and read does not block a claim`, t => {
    const { rootDir, job } = fixture(t);
    const path = join(getFollowUpJobDir(rootDir, bucket), 'unrelated.json');
    writeFileSync(path, JSON.stringify({ ...job, repo: 'other/repository', prNumber: 42 }));
    const read = fs.readFileSync;
    let removed = false;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === path) {
        rmSync(path);
        removed = true;
      }
      return read(file, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.deepEqual(readRepairFollowUpClaim(rootDir, {
      ...identity, ticket: job.jobId, launcherPid: process.pid,
    }), { ok: true, claimedAt: job.claimedAt });
    assert.equal(removed, true, 'the record disappeared after enumeration');
  });
}

test('losing the own claim between enumeration and read still fails closed', t => {
  const { rootDir, job, jobPath } = fixture(t);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === jobPath) rmSync(jobPath);
    return read(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(readRepairFollowUpClaim(rootDir, {
    ...identity, ticket: job.jobId, launcherPid: process.pid,
  }), {
    ok: false, reason: 'remediation-ownership-unknown', file: jobPath,
  });
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('unattributable records retain custody and identify the offending file', async t => {
  const { rootDir, argv } = fixture(t);
  const path = join(getFollowUpJobDir(rootDir, 'pending'), 'other__repository-pr-42-bad.json');
  for (const record of [{}, { repo: 'invalid' }, { repo: 'fixture/widgets' }]) {
    writeFileSync(path, JSON.stringify(record));
    assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-ownership-unknown', file: path });
  }
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('non-file JSON entries and non-ENOENT read errors still fail closed', async t => {
  const { rootDir, argv } = fixture(t);
  const path = join(getFollowUpJobDir(rootDir, 'pending'), 'unrelated.json');
  mkdirSync(path);
  assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-ownership-unknown', file: path });
  rmSync(path, { recursive: true });
  writeFileSync(path, '{}');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === path) throw Object.assign(new Error('unreadable fixture'), { code: 'EACCES' });
    return read(file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-ownership-unknown', file: path });
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('EPERM proves a matching launcher is alive without waiving PID equality', t => {
  const { rootDir, job } = fixture(t);
  const request = { ...identity, ticket: job.jobId, launcherPid: process.pid };
  const kill = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, process.pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error('cross-user fixture'), { code: 'EPERM' });
  });
  assert.deepEqual(readRepairFollowUpClaim(rootDir, request), { ok: true, claimedAt: job.claimedAt });
  assert.equal(readRepairFollowUpClaim(rootDir, { ...request, launcherPid: process.pid + 1 }).reason,
    'remediation-claim-launcher-mismatch');
  assert.equal(kill.mock.callCount(), 1);
});

for (const bucket of ['completed', 'failed', 'stopped']) {
  test(`a ticket in ${bucket} without an active claim reports absence`, async t => {
    const { rootDir, argv, job, jobPath } = fixture(t);
    rmSync(jobPath);
    const dir = getFollowUpJobDir(rootDir, bucket);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${job.jobId}.json`), JSON.stringify({ ...job, status: bucket }));
    assert.deepEqual(await main(argv), { ok: false, reason: 'remediation-claim-absent', jobId: job.jobId });
    assert.equal(pendingRepairEpoch(rootDir, identity), null);
  });
}

test('an intent lock and a closer lease on another head both retain custody', async t => {
  const { rootDir, argv } = fixture(t);
  const release = tryAcquireCloserIntentLock(rootDir, identity);
  try { assert.equal((await main(argv)).reason, 'closer-submission-owned'); }
  finally { release(); }
  const closer = { ...identity, headSha: 'b'.repeat(40), status: 'pending' };
  const path = amaCloserLeaseFilePath(rootDir, closer);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(closer));
  assert.equal((await main(argv)).reason, 'closer-owned-or-unknown');
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('an eligible own claim cannot create a repair epoch before budget exhaustion', async t => {
  const { rootDir, argv } = fixture(t, { exhausted: false });
  assert.deepEqual(await main(argv), { ok: true, epoch: null, reason: 'budget-available' });
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('unproven absence of an earlier repair still blocks the claimed job', async t => {
  const { rootDir, argv } = fixture(t);
  const previous = reserveRepairEpoch({ rootDir, ...identity, ownerKey: 'prior-submit',
    cause: 'closure-retry-exhausted', now: '2026-01-01T00:00:00Z' }).epoch;
  const sdk = dispatchReadTransport.sdk();
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk,
    connect: async config => ({ sessionToken: 'fixture', endpoint_url: config.endpoint_url }),
    readSessionDispatchLookup: async () => ({
      schema_version: 1, status: 'not_found', complete: true, roots: [], items: [], retry_edges: [],
    }),
  }));
  const result = await main(argv, { env: { APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/own-claim' } });
  assert.equal(result.reason, 'repair-owned');
  assert.deepEqual(pendingRepairEpoch(rootDir, identity), previous);
});

test('the repair epoch cap still refuses an otherwise eligible claim', async t => {
  const { rootDir, argv } = fixture(t);
  for (const [key, reviewedHead] of [['one', 'b'.repeat(40)], ['two', 'c'.repeat(40)]]) {
    const { epoch } = reserveRepairEpoch({ rootDir, ...identity, ownerKey: key, cause: 'closure-retry-exhausted' });
    bindRepairHead({ rootDir, ...identity, headSha: reviewedHead, epochId: epoch.id });
  }
  // Record the existing cap page through the normal API with a fixture sink.
  await observeClosureWait({ rootDir, repo, prNumber, headSha: 'repair-epoch-cap',
    waitClass: 'repair-epoch-cap', immediate: true, pageImpl: async () => {} });
  const result = await main(argv);
  assert.equal(result.reason, 'repair-epoch-cap');
  assert.equal(result.epochs.length, 2);
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});

test('a matching claim cannot reuse the same dispatch key from another repair head', async t => {
  const { rootDir, argv } = fixture(t);
  const { epoch } = reserveRepairEpoch({ rootDir, ...identity, headSha: 'b'.repeat(40),
    ownerKey: argv[4], cause: 'closure-retry-exhausted' });
  bindRepairHead({ rootDir, ...identity, epochId: epoch.id });
  assert.deepEqual(await main(argv), { ok: false, reason: 'repair-head-mismatch',
    refundedSpend: { closer: 0, review: 0 } });
  assert.equal(pendingRepairEpoch(rootDir, identity), null);
});
