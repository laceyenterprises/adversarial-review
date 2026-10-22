import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { reapStaleCloserLeases } from '../src/recovery-reaper.mjs';
import { reconcileRecoveryLaunches } from '../src/ama/recovery-launch-reconciliation.mjs';
import { reconcilePreReceiptIntent, tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease, amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath, readAmaCloserDispatchRecord, updateAmaCloserDispatchRecord,
  findActiveAmaCloserLaunches, isActiveAmaCloserDispatchRecord, maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch, hammerRetryCapFilePath } from '../src/ama/hammer-retry-cap.mjs';
import { readLaunchRequestByIdempotencyKeyAsync } from '../src/session-ledger-read-adapter.mjs';

const identity = { repo: 'fixture/repo', prNumber: 8, headSha: 'a'.repeat(40) };
const started = '2026-10-22T10:18:18Z';
const now = '2026-10-22T14:00:00Z';
const key = 'ama-closer-fixture';
const dead = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
const receipt = { launch_request_id: 'lrq_fixture', idempotency_key: key,
  ticket_ref: 'AMA-PR-8', target_repo: 'repo', status: 'running', requested_at: started };
function fixture(t, patch = {}, lease = true) {
  const rootDir = mkdtempSync(join(tmpdir(), 'intent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDbPath = join(rootDir, 'ledger.sqlite');
  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE launch_requests (launch_request_id TEXT, idempotency_key TEXT, ticket_ref TEXT, target_repo TEXT, status TEXT, requested_at TEXT)');
  db.close();
  const record = { schemaVersion: 1, ...identity, reviewedSha: identity.headSha,
    targetRemediationSha: identity.headSha, state: 'dispatching', workerClass: 'hammer',
    dispatchPhase: 'submitting', dispatchIdempotencyKey: key, retryCount: 2,
    lastAttemptedAt: started, dispatchTimeoutMs: 600_000, lastError: null,
    custom: 'preserved', ...patch };
  updateAmaCloserDispatchRecord(rootDir, identity, () => record);
  if (lease) acquireAmaCloserLease({ rootDir, ...identity, now: started, watcherPid: 12345 });
  const options = { ledgerDbPath, env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' }, now,
    processKillImpl: dead, logger: { warn() {} } };
  return { rootDir, options, record,
    read: () => readAmaCloserDispatchRecord(rootDir, identity),
    reconcile: extra => reconcilePreReceiptIntent(rootDir, identity, { ...options, ...extra }),
    insert: row => { const db = new Database(ledgerDbPath); try {
      db.prepare('INSERT INTO launch_requests VALUES (@launch_request_id,@idempotency_key,@ticket_ref,@target_repo,@status,@requested_at)').run(row);
    } finally { db.close(); } },
  };
}

for (const phase of ['prepared', 'submitting', 'accepted']) {
  test(`SIGKILL after persisted ${phase} intent releases fence and reconciles without launching`, async t => {
    const f = fixture(t, {}, false);
    // A real process dies holding the native flock after persisting the intent.
    // accepted additionally commits HQ's synthetic receipt before dying, without
    // persisting the local receipt. No production service or launcher is used.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from 'better-sqlite3';
      import { tryAcquireCloserIntentLock } from ${JSON.stringify(new URL('../src/ama/pre-receipt-intent.mjs', import.meta.url).href)};
      import { acquireAmaCloserLease } from ${JSON.stringify(new URL('../src/ama/closer-lease.mjs', import.meta.url).href)};
      import { updateAmaCloserDispatchRecord } from ${JSON.stringify(new URL('../src/ama/dispatch-closer.mjs', import.meta.url).href)};
      const root = ${JSON.stringify(f.rootDir)}, identity = ${JSON.stringify(identity)};
      const intentLock = tryAcquireCloserIntentLock(root, identity);
      if (!intentLock) throw Error('lock unavailable');
      acquireAmaCloserLease({rootDir: root, ...identity, now: ${JSON.stringify(started)}, watcherPid: process.pid});
      updateAmaCloserDispatchRecord(root, identity, current => ({...current, dispatchPhase: ${JSON.stringify(phase === 'prepared' ? 'prepared' : 'submitting')}}), { intentLock });
      ${phase === 'accepted' ? `const db = new Database(${JSON.stringify(f.options.ledgerDbPath)});
      db.prepare('INSERT INTO launch_requests VALUES (?, ?, ?, ?, ?, ?)').run(...${JSON.stringify(Object.values(receipt))}); db.close();` : ''}
      process.kill(process.pid, 'SIGKILL');
    `], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    const outcome = await f.reconcile();
    assert.equal(outcome.status, phase === 'prepared' ? 'no-launch' : phase === 'accepted' ? 'receipt-recovered' : 'unknown');
    if (phase === 'prepared') {
      assert.equal(f.read().retryCount, 1);
      assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
      assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
    } else if (phase === 'accepted') {
      assert.equal(f.read().launchRequestId, receipt.launch_request_id);
      assert.equal(f.read().retryCount, 2);
      assert.equal(readAmaCloserLease(f.rootDir, identity).lrqId, receipt.launch_request_id);
      assert.equal(readHammerRetryCapLedger(f.rootDir, identity).lifetimeAttemptCount, 1);
    } else {
      assert.equal(f.read().state, 'dispatching');
      assert.equal(readAmaCloserLease(f.rootDir, identity).status, 'pending');
    }
    const before = f.read();
    await f.reconcile();
    assert.deepEqual(f.read(), before, 'reconciliation is idempotent');
    assert.equal(f.read().custom, 'preserved');
  });
}

test('legacy and submitted intents keep same-PR ownership past any age; diagnostics stop at inspection', async t => {
  for (const dispatchIdempotencyKey of [null, key]) {
    const f = fixture(t, { dispatchIdempotencyKey }, false);
    await f.reconcile();
    assert.equal(f.read().preReceiptReconciliation.status, 'inspection-required');
    const deadline = f.read().preReceiptReconciliation.deadlineAt;
    await f.reconcile({ now: '2030-01-01T00:00:00Z' });
    assert.equal(f.read().preReceiptReconciliation.deadlineAt, deadline);
    assert.equal(isActiveAmaCloserDispatchRecord(f.read(), { now: '2030-01-01' }), true);
    const active = await findActiveAmaCloserLaunches(f.rootDir, { ...f.options, now: '2030-01-01T00:00:00Z' });
    assert.equal(active.length, 1);
    assert.equal(active[0].holdsCapacity, false, 'unknown PR does not hold a fleet slot indefinitely');
    let launches = 0;
    const decision = await maybeDispatchAmaCloser({ cfg: { enabled: true },
      dispatchContext: { rootDir: f.rootDir, ...identity, dispatchedAt: now },
      execFileImpl: () => { launches++; throw Error('must not launch'); }, logger: { warn() {} } });
    assert.equal(decision.reason, 'existing-dispatch-unknown');
    assert.equal(decision.skipMergeAgent, true);
    assert.equal(launches, 0);
  }
});

for (const mode of ['live', 'foreign-host', 'dispatched-other', 'unreadable', 'missing', 'ambiguous', 'foreign-ticket', 'foreign-repo']) {
  test(`prepared intent preserves lease and budget with ${mode} evidence`, async t => {
    const f = fixture(t, { dispatchPhase: 'prepared' });
    const extra = {};
    if (mode === 'live') extra.processKillImpl = () => {};
    if (mode === 'foreign-host') {
      writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({
        ...readAmaCloserLease(f.rootDir, identity), holderHost: `${hostname()}-other`,
      }));
    }
    if (mode === 'dispatched-other') updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_other' });
    if (mode === 'unreadable') extra.readIntentReceiptImpl = () => { throw Error('unavailable'); };
    if (mode === 'missing') extra.readIntentReceiptImpl = () => ({ ok: false, reason: 'missing-ledger-target' });
    if (mode === 'ambiguous') extra.readIntentReceiptImpl = () => ({ ok: true, rows: [receipt, receipt] });
    if (mode === 'foreign-ticket') f.insert({ ...receipt, ticket_ref: 'LAC-OTHER' });
    if (mode === 'foreign-repo') f.insert({ ...receipt, target_repo: 'different' });
    const lease = readAmaCloserLease(f.rootDir, identity);
    assert.equal((await f.reconcile(extra)).status, 'unknown');
    assert.equal(f.read().retryCount, 2);
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
    assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
  });
}

for (const replacement of ['record', 'lease', 'deleted']) test(`yielding lookup preserves concurrent ${replacement}`, async t => {
  const f = fixture(t);
  const outcome = await f.reconcile({ readIntentReceiptImpl: async () => {
    if (replacement === 'record') writeFileSync(amaCloserDispatchFilePath(f.rootDir, identity), JSON.stringify({ ...f.read(), newAnnotation: true }));
    if (replacement === 'lease') writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({ ...readAmaCloserLease(f.rootDir, identity), watcherPid: 999 }));
    if (replacement === 'deleted') rmSync(amaCloserDispatchFilePath(f.rootDir, identity));
    return { ok: true, rows: [receipt] };
  } });
  assert.equal(outcome.status, 'held');
  assert.equal(f.read()?.preReceiptReconciliation, undefined);
  assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
});

test('intent lock release is idempotent and preserves a subsequent holder', t => {
  const f = fixture(t);
  const release = tryAcquireCloserIntentLock(f.rootDir, identity);
  assert.equal(typeof release, 'function');
  release();
  const nextRelease = tryAcquireCloserIntentLock(f.rootDir, identity);
  assert.equal(typeof nextRelease, 'function');
  try {
    assert.doesNotThrow(() => release());
    assert.equal(tryAcquireCloserIntentLock(f.rootDir, identity), null);
  } finally { nextRelease(); }
  assert.doesNotThrow(() => release());
});

test('one reconciliation owns the PR fence while ledger evidence yields', async t => {
  const f = fixture(t);
  let finish;
  const first = f.reconcile({ readIntentReceiptImpl: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal((await f.reconcile()).reason, 'intent-lock-held');
  assert.equal(tryAcquireCloserIntentLock(f.rootDir, { ...identity, headSha: 'other-head' }), null);
  finish({ ok: true, rows: [receipt] });
  assert.equal((await first).status, 'receipt-recovered');
});

for (const phase of ['promoted', 'charged', 'settled-no-launch']) test(`recovery resumes after ${phase} persistence interruption`, async t => {
  const f = fixture(t, { dispatchPhase: phase === 'settled-no-launch' ? 'prepared' : 'submitting' });
  if (phase !== 'settled-no-launch') f.insert(receipt);
  if (phase === 'promoted') updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'dispatched', lrqId: receipt.launch_request_id });
  if (phase === 'settled-no-launch') updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'terminal', terminalOutcome: 'deferred' });
  if (phase === 'charged') recordHammerRetryDispatch(f.rootDir, identity, { jobKey: identity.headSha, headSha: identity.headSha, dispatchKey: key });
  assert.equal((await f.reconcile()).status, phase === 'settled-no-launch' ? 'no-launch' : 'receipt-recovered');
  if (phase !== 'settled-no-launch') assert.equal(readHammerRetryCapLedger(f.rootDir, identity).lifetimeAttemptCount, 1);
});

test('dry-run changes no intent, lease or budget bytes', async t => {
  const f = fixture(t);
  f.insert(receipt);
  const bytes = readFileSync(amaCloserDispatchFilePath(f.rootDir, identity), 'utf8');
  const lease = readAmaCloserLease(f.rootDir, identity);
  assert.equal((await f.reconcile({ dryRun: true })).status, 'receipt-recovered');
  assert.equal(readFileSync(amaCloserDispatchFilePath(f.rootDir, identity), 'utf8'), bytes);
  assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
});

test('Postgres receipt lookup uses read-only parameterized bounded SQL', async () => {
  const r = await readLaunchRequestByIdempotencyKeyAsync({ idempotencyKey: "key'quote",
    ledgerTarget: { backend: 'postgres', databaseName: 'fixture' }, env: {},
    spawnSyncImpl(command, args, options) {
      assert.equal(command, 'psql');
      assert.ok(args.includes("intent_key=key'quote"));
      assert.match(options.input, /BEGIN READ ONLY/);
      assert.match(options.input, /idempotency_key = :'intent_key' LIMIT 2/);
      assert.doesNotMatch(options.input, /key'quote/);
      return { status: 0, stdout: JSON.stringify(receipt) + '\n' };
    } });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].launch_request_id, receipt.launch_request_id);
});

for (const kind of ['corrupt', 'invalid-keys', 'suppressed']) test(`receipt recovery preserves ${kind} retry evidence`, async t => {
  const f = fixture(t);
  f.insert(receipt);
  recordHammerRetryDispatch(f.rootDir, identity, { jobKey: identity.headSha,
    headSha: identity.headSha, dispatchKey: 'previous-key' });
  const path = hammerRetryCapFilePath(f.rootDir, identity);
  const ledger = readHammerRetryCapLedger(f.rootDir, identity);
  writeFileSync(path, kind === 'corrupt' ? '{invalid-json'
    : JSON.stringify({ ...ledger, ...(kind === 'invalid-keys' ? { chargedDispatchKeys: key }
      : { suppressed: true, lifetimeSuppressed: true, alertedAt: started }) }));
  const before = readFileSync(path, 'utf8');
  const result = await f.reconcile();
  if (kind === 'suppressed') {
    assert.equal(result.status, 'receipt-recovered');
    const charged = readHammerRetryCapLedger(f.rootDir, identity);
    assert.equal(charged.lifetimeAttemptCount, 2);
    assert.equal(charged.suppressed, true);
    assert.equal(charged.lifetimeSuppressed, true);
    assert.equal(charged.alertedAt, started);
  } else {
    assert.equal(result.status, 'unknown');
    assert.equal(f.read().preReceiptReconciliation.reason, 'receipt-budget-unreadable');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(readAmaCloserLease(f.rootDir, identity).status, 'pending');
  }
});

test('stale-lease reaper defers to the native PR fence before intent persistence', async t => {
  const f = fixture(t, { state: 'no-dispatch' });
  const before = readAmaCloserLease(f.rootDir, identity);
  const release = tryAcquireCloserIntentLock(f.rootDir, identity);
  try {
    const result = await reapStaleCloserLeases({ rootDir: f.rootDir, now,
      thresholdMs: 1, logger: { warn() {}, error() {} }, isProcessAlive: () => false });
    assert.equal(result.released, 0);
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), before);
  } finally { release(); }
});

test('ownerless recovery cannot annotate a new intent using its predecessor terminal result', async t => {
  const f = fixture(t, { state: 'dispatched', launchRequestId: 'lrq_previous' });
  const before = readAmaCloserLease(f.rootDir, identity);
  const result = await reconcileRecoveryLaunches({ rootDir: f.rootDir,
    listActiveImpl: () => [{ ...f.read(), dispatchPath: amaCloserDispatchFilePath(f.rootDir, identity) }],
    isPhantomImpl: () => false, logger: { log() {}, warn() {} },
    readStatusImpl: async () => {
      updateAmaCloserDispatchRecord(f.rootDir, identity, current => ({ ...current, state: 'dispatching' }));
      return { ok: true, row: { status: 'failed' } };
    },
  });
  assert.equal(result.reclaimed, 0);
  assert.equal(result.uncertain, 1);
  assert.deepEqual(readAmaCloserLease(f.rootDir, identity), before);
  assert.equal(f.read().lastObservedStatus, undefined);
});

for (const accepted of [false, true]) test(`lease mutation fence preserves concurrent owner before ${accepted ? 'receipt recovery' : 'no-launch settlement'}`, async t => {
  const f = fixture(t, { dispatchPhase: accepted ? 'submitting' : 'prepared' });
  if (accepted) f.insert(receipt);
  const lease = readAmaCloserLease(f.rootDir, identity);
  const fd = openSync(amaCloserLeaseFilePath(f.rootDir, identity) + '.reclaim.lock', 'a');
  fsExt.flockSync(fd, 'exnb');
  try {
    const held = await f.reconcile();
    assert.equal(held.reason, 'lease-mutation-raced');
    assert.equal(f.read().state, 'dispatching');
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  } finally { closeSync(fd); }
  assert.equal((await f.reconcile()).status, accepted ? 'receipt-recovered' : 'no-launch');
  if (accepted) assert.equal(readHammerRetryCapLedger(f.rootDir, identity).lifetimeAttemptCount, 1);
});

test('lease mutation compares the entire expected owner under its reclaim fence', t => {
  const f = fixture(t);
  const lease = readAmaCloserLease(f.rootDir, identity);
  assert.throws(() => updateAmaCloserLease({ rootDir: f.rootDir, ...identity,
    status: 'terminal', terminalOutcome: 'deferred', expectedLease: { ...lease, watcherPid: 999 },
  }), error => error.code === 'ESTALE');
  assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
});

test('reaper preserves a replacement pending owner with identical state and timestamps', async t => {
  const f = fixture(t, { state: 'no-dispatch' });
  let replaced = false;
  const result = await reapStaleCloserLeases({ rootDir: f.rootDir, now,
    thresholdMs: 6 * 60 * 60_000, deadHolderThresholdMs: 1,
    logger: { warn() {}, error() {} },
    isProcessAlive: () => {
      const lease = readAmaCloserLease(f.rootDir, identity);
      writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({ ...lease, watcherPid: 999 }));
      replaced = true;
      return false;
    },
  });
  assert.equal(replaced, true);
  assert.equal(result.released, 0);
  assert.equal(readAmaCloserLease(f.rootDir, identity).watcherPid, 999);
});
