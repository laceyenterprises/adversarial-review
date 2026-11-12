// AGYSTALELAUNCH-01: a reviewer run record stuck in `launching` must not hold
// an agy reviewer holder. The adopted-lease liveness check proves the process
// group leader's identity (start time against `spawnedAt`) for every state,
// and a `launching` record past the launch grace without a verified leader is
// settled `failed` and releases its holder, at readiness and at watcher start.
//
// Synthetic records and a synthetic process table only: the real
// `verifyPgidIdentity` runs against a fake `ps`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgyReviewerIdentityPool } from '../src/agy-reviewer-identities.mjs';
import { runAgyReviewerStartupChecks } from '../src/watcher-agy-startup-preflight.mjs';
import {
  readReviewerRunRecord, reapStaleLaunchingReviewerRunRecord, writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';
import { verifyPgidIdentity } from '../src/process-group-identity.mjs';

const owner = 'fixture-owner';
const holder = 'fixture-login-a';
const GRACE_MS = 60_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const declarations = {
  token_accounts: { 'agy-login-0': { family: 'gemini', holder_user: holder, concurrency: 1, allowed_models: ['gemini-test'] } },
  identity_token_pools: { 'gemini-reviewer': ['agy-login-0'] },
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agystalelaunch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function recordingLog() {
  const lines = [];
  const push = (line) => lines.push(String(line));
  return { lines, log: push, info: push, warn: push, error: push };
}

// `processes` maps a live PGID to its leader's start time (ms), or to null for
// a group whose leader is gone or whose start time `ps` cannot give.
function makePool(root, processes, options = {}) {
  return createAgyReviewerIdentityPool({
    env: { ADVERSARIAL_REVIEW_STATE_DIR: join(root, 'data') },
    log: options.log || recordingLog(),
    hqOwner: owner,
    runStateRootDir: root,
    leaseWaitMs: 0,
    launchGraceMs: GRACE_MS,
    resolveRuntime: () => 'antigravity',
    resolveModel: () => 'gemini-test',
    loadIdentities: () => [holder],
    loadTokenPools: () => declarations,
    referenceSettings: () => [],
    readBootstrapRecordImpl: () => null,
    checkHqOwnerAuthImpl: async () => ({ ok: true }),
    readQuotaCooldownImpl: () => null,
    listUserProcessesImpl: async () => ({ ok: true, processes: [] }),
    runPinnedImpl: async ({ args }) => ({ code: 0, stdout: args[0] === 'status'
      ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n'
      : args[0] === 'probe' ? 'probe.ok=yes\n' : '' }),
    deliverAlertImpl: async () => ({ id: 'fixture' }),
    isPgidAliveImpl: (pgid) => Object.hasOwn(processes, pgid),
    verifyPgidIdentityImpl: (pgid, spawnedAt) => verifyPgidIdentity(pgid, spawnedAt, {
      execFileImpl: async (_command, args) => {
        const startedMs = processes[Number(args.at(-1))];
        return { stdout: Number.isFinite(startedMs) ? `${new Date(startedMs).toString()}\n` : '' };
      },
    }),
    ...options,
  });
}

function writeHolderRecord(root, { sessionUuid = 'agy-fixture-review', state = 'launching', pgid = null, spawnedAtMs, runtime = 'argus-security' } = {}) {
  return writeReviewerRunRecord(root, {
    sessionUuid,
    state,
    runtime,
    pgid,
    spawnedAt: new Date(spawnedAtMs).toISOString(),
    subjectContext: { agyHolderLease: { user: holder, reviewId: sessionUuid }, agyIdentityLease: { user: holder, reviewId: sessionUuid } },
  });
}

async function leases(pool) {
  const lease = await pool.acquire({ reviewId: 'agy-next-review' });
  if (lease) await pool.release(lease);
  return Boolean(lease);
}

test('AGYSTALELAUNCH-01: the incident shape (15-day-old launching record, PGID reused by an unrelated process) does not hold the holder and is reaped once', async (t) => {
  const root = fixture(t);
  const nowMs = Date.now();
  // The PGID belongs to a process that started 14 hours ago, two weeks after
  // the record's launch.
  const processes = { 41001: nowMs - 14 * 60 * MINUTE };
  writeHolderRecord(root, { pgid: 41001, spawnedAtMs: nowMs - 15 * DAY });
  const log = recordingLog();
  const pool = makePool(root, processes, { log });

  assert.equal(await leases(pool), true, 'the stale launching record does not hold the holder');
  const settled = readReviewerRunRecord(root, 'agy-fixture-review');
  assert.equal(settled.state, 'failed');
  assert.equal(settled.pgid, null, 'a settled record no longer names the recycled PGID');
  const reaps = log.lines.filter((line) => /reaped stale launching reviewer run record agy-fixture-review/.test(line));
  assert.equal(reaps.length, 1);
  assert.match(reaps[0], /age 15d0h > launch grace 1m0s, recycled: process group 41001 leader started/);
  assert.doesNotMatch(log.lines.join('\n'), /still runs; not leased/, 'it is never reported as a running review');

  await pool.refreshReadiness();
  assert.equal(await leases(pool), true);
  assert.equal(log.lines.filter((line) => /reaped stale launching/.test(line)).length, 1, 'logged once');
});

test('AGYSTALELAUNCH-01: a young launching record whose live PGID leader started before spawnedAt does not hold, and is not reaped yet', async (t) => {
  const root = fixture(t);
  const nowMs = Date.now();
  writeHolderRecord(root, { pgid: 41002, spawnedAtMs: nowMs - 10_000 });
  const pool = makePool(root, { 41002: nowMs - 2 * DAY });

  assert.equal(await leases(pool), true, 'a proven recycled leader is not this review');
  assert.equal(readReviewerRunRecord(root, 'agy-fixture-review').state, 'launching', 'within the grace the record is left alone');
});

test('AGYSTALELAUNCH-01: a genuinely live launching review holds, and the hold line names its age and verified identity', async (t) => {
  const root = fixture(t);
  const nowMs = Date.now();
  const spawnedAtMs = nowMs - 10_000;
  writeHolderRecord(root, { pgid: 41003, spawnedAtMs });
  const log = recordingLog();
  const pool = makePool(root, { 41003: spawnedAtMs }, { log });

  assert.equal(await leases(pool), false, 'the live review keeps its holder');
  assert.equal(readReviewerRunRecord(root, 'agy-fixture-review').state, 'launching');
  const hold = log.lines.find((line) => /from a previous watcher still runs; not leased until it ends/.test(line));
  assert.match(hold, /state launching, age \d+s, verified: process group 41003 leader started with this review/);
});

test('AGYSTALELAUNCH-01: a launching review with a verified leader holds past the grace (an Argus child stays launching all run)', async (t) => {
  const root = fixture(t);
  const spawnedAtMs = Date.now() - 20 * MINUTE;
  writeHolderRecord(root, { pgid: 41004, spawnedAtMs });
  const pool = makePool(root, { 41004: spawnedAtMs + 1_000 });

  assert.equal(await leases(pool), false);
  assert.equal(readReviewerRunRecord(root, 'agy-fixture-review').state, 'launching', 'a verified launch is never reaped');
});

test('AGYSTALELAUNCH-01: a heartbeating review whose leader started during its launch (after a slow preflight) still holds', async (t) => {
  const root = fixture(t);
  const spawnedAtMs = Date.now() - 10 * MINUTE;
  writeHolderRecord(root, { state: 'heartbeating', runtime: 'cli-direct', pgid: 41005, spawnedAtMs });
  const pool = makePool(root, { 41005: spawnedAtMs + 25_000 });

  assert.equal(await leases(pool), false, 'a leader 25 s after spawnedAt is this review, not a recycled PGID');
});

for (const [name, pgid, processes] of [
  ['no PGID', null, {}],
  ['a dead PGID', 41006, {}],
  ['unreadable identity evidence', 41007, { 41007: null }],
]) {
  test(`AGYSTALELAUNCH-01: a launching record past the grace with ${name} is reaped and releases its holder`, async (t) => {
    const root = fixture(t);
    writeHolderRecord(root, { pgid, spawnedAtMs: Date.now() - 5 * MINUTE });
    const pool = makePool(root, processes);
    assert.equal(await leases(pool), true);
    assert.equal(readReviewerRunRecord(root, 'agy-fixture-review').state, 'failed');
  });
}

test('AGYSTALELAUNCH-01: within the grace, a launching record without a PGID or with unreadable evidence still holds', async (t) => {
  for (const [pgid, processes] of [[null, {}], [41008, { 41008: null }]]) {
    const root = fixture(t);
    writeHolderRecord(root, { pgid, spawnedAtMs: Date.now() - 5_000 });
    const pool = makePool(root, processes);
    assert.equal(await leases(pool), false, `pgid=${pgid}: the fork may be in progress`);
    assert.equal(readReviewerRunRecord(root, 'agy-fixture-review').state, 'launching');
  }
});

for (const state of ['completed', 'failed', 'cancelled']) {
  test(`AGYSTALELAUNCH-01: a ${state} record keeps its behaviour and is never rewritten`, async (t) => {
    const root = fixture(t);
    const spawnedAtMs = Date.now() - 15 * DAY;
    const cases = [
      // [processes, holds]
      [{ 41009: Date.now() - 14 * 60 * MINUTE }, false], // recycled PGID: released
      [{ 41009: null }, true], // unreadable evidence: holds, as before
      [{}, false], // gone: released
    ];
    for (const [processes, holds] of cases) {
      writeHolderRecord(root, { state, pgid: 41009, spawnedAtMs });
      const before = readFileSync(join(root, 'data', 'reviewer-runs', 'agy-fixture-review.json'), 'utf8');
      const pool = makePool(root, processes);
      assert.equal(await leases(pool), !holds, JSON.stringify(processes));
      assert.equal(readFileSync(join(root, 'data', 'reviewer-runs', 'agy-fixture-review.json'), 'utf8'), before);
    }
  });
}

test('AGYSTALELAUNCH-01: the watcher startup checks reap stale launching records before the first lease', async (t) => {
  const root = fixture(t);
  const nowMs = Date.now();
  writeHolderRecord(root, { sessionUuid: 'agy-stale-a', pgid: 41010, spawnedAtMs: nowMs - 9 * DAY });
  writeHolderRecord(root, { sessionUuid: 'agy-stale-b', pgid: null, spawnedAtMs: nowMs - 23 * DAY });
  const pool = makePool(root, { 41010: nowMs - MINUTE });
  const result = await runAgyReviewerStartupChecks({ env: {}, log: recordingLog(), identityPool: pool,
    warnIfUnavailableImpl: async () => ({ checked: false }) });
  assert.deepEqual(result.reaped.map(({ sessionUuid, liveness }) => [sessionUuid, liveness]).sort(),
    [['agy-stale-a', 'recycled'], ['agy-stale-b', 'unverified']]);
  for (const sessionUuid of ['agy-stale-a', 'agy-stale-b']) {
    assert.equal(readReviewerRunRecord(root, sessionUuid).state, 'failed');
  }
  assert.equal(await leases(pool), true);

  const throwing = await runAgyReviewerStartupChecks({ env: {}, log: recordingLog(),
    identityPool: { sweepAll: async () => [], reapStaleLaunchingRecords: async () => { throw new Error('EIO'); } },
    warnIfUnavailableImpl: async () => ({}) });
  assert.deepEqual(throwing.reaped, [], 'a failed reap never blocks startup');
});

for (const [runtime, multi] of [['agent-runtime', false], ['antigravity', true]]) {
  test(`AGYSTALELAUNCH-01: startup reaps persisted holds with an undeclared owner-only ${runtime} plan`, async (t) => {
    const root = fixture(t);
    const spawnedAtMs = Date.now() - 9 * DAY;
    writeHolderRecord(root, { sessionUuid: 'agy-stale', pgid: null, spawnedAtMs });
    writeHolderRecord(root, { sessionUuid: 'agy-live', pgid: 41012, spawnedAtMs });
    const pool = makePool(root, { 41012: spawnedAtMs }, {
      resolveRuntime: () => runtime,
      loadIdentities: () => [],
      loadTokenPools: () => ({}),
    });
    assert.equal(pool.plan().multi, multi, 'exercise the actual runtime plan');
    const livePath = join(root, 'data', 'reviewer-runs', 'agy-live.json');
    const liveBefore = readFileSync(livePath, 'utf8');

    const result = await runAgyReviewerStartupChecks({
      env: {}, log: recordingLog(), identityPool: pool,
      warnIfUnavailableImpl: async () => ({ checked: false }),
    });
    assert.deepEqual(result.reaped.map(({ sessionUuid }) => sessionUuid), ['agy-stale']);
    const settled = readReviewerRunRecord(root, 'agy-stale');
    assert.equal(settled.state, 'failed');
    assert.equal(settled.pgid, null);
    assert.equal(readFileSync(livePath, 'utf8'), liveBefore, 'verified live records remain unchanged');
    assert.deepEqual(await pool.reapStaleLaunchingRecords(), [], 'repeated startup reap is idempotent');
  });
}

test('AGYSTALELAUNCH-01: a reap that cannot be written still does not hold past the grace, and warns once', async (t) => {
  const root = fixture(t);
  writeHolderRecord(root, { pgid: null, spawnedAtMs: Date.now() - 5 * MINUTE });
  const log = recordingLog();
  const pool = makePool(root, {}, { log, reapStaleLaunchingRecordImpl: () => { throw new Error('EACCES'); } });
  assert.equal(await leases(pool), true);
  await pool.refreshReadiness();
  assert.equal(log.lines.filter((line) => /cannot settle stale launching reviewer run record/.test(line)).length, 1);
});

test('AGYSTALELAUNCH-01: the reap settles only the exact launching record it judged', (t) => {
  const root = fixture(t);
  const spawnedAtMs = Date.now() - 5 * MINUTE;
  const judged = writeHolderRecord(root, { pgid: null, spawnedAtMs });
  // The launch reached heartbeating after the scan read it.
  writeHolderRecord(root, { state: 'heartbeating', pgid: 41011, spawnedAtMs });
  const moved = reapStaleLaunchingReviewerRunRecord(root, judged);
  assert.equal(moved.reaped, false);
  assert.equal(readReviewerRunRecord(root, judged.sessionUuid).state, 'heartbeating');

  writeHolderRecord(root, { pgid: null, spawnedAtMs });
  const reaped = reapStaleLaunchingReviewerRunRecord(root, judged, { settledAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(reaped.reaped, true);
  assert.equal(reaped.record.state, 'failed');
  assert.equal(reaped.record.lastHeartbeatAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(reapStaleLaunchingReviewerRunRecord(root, { sessionUuid: 'agy-missing' }), { reaped: false, record: null });
});
