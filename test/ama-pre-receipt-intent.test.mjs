import './helpers/dispatch-read-fixture.mjs';
import { seedCloserIntent, intentExpired } from './helpers/closer-intent-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { reapStaleCloserLeases } from '../src/recovery-reaper.mjs';
import { reconcileRecoveryLaunches } from '../src/ama/recovery-launch-reconciliation.mjs';
import { closerLaunchMatches, reconcilePreReceiptIntent, tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease, amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath, readAmaCloserDispatchRecord, updateAmaCloserDispatchRecord,
  findActiveAmaCloserLaunches, reconcileAmaCloserDispatches, isActiveAmaCloserDispatchRecord, maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { readHammerRetryCapLedger, recordHammerRetryDispatch, hammerRetryCapFilePath } from '../src/ama/hammer-retry-cap.mjs';
import { main as settleLegacyIntent } from '../bin/settle-legacy-closer-intent.mjs';
import { readLaunchRequestByIdempotencyKeyAsync, readLaunchRequestsForTicketSinceAsync } from '../src/session-ledger-read-adapter.mjs';

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
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
    processKillImpl: dead, deliverAlertImpl: async () => {}, logger: { warn() {} } };
  // Older fixtures do not claim process-scan evidence. Pin unknown explicitly.
  options.processExecFileSyncImpl = () => { throw Error('synthetic process scan unavailable'); };
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
    assert.equal(outcome.status, phase === 'accepted' ? 'receipt-recovered' : 'no-launch');
    if (phase !== 'accepted') {
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
    f.options.readLegacyIntentLaunchesImpl = () => ({ ok: false, reason: 'fixture-unreadable' });
    f.options.readIntentReceiptImpl = () => ({ ok: false, reason: 'fixture-unreadable' });
    await f.reconcile();
    assert.equal(f.read().preReceiptReconciliation.status, 'inspection-required');
    const deadline = f.read().preReceiptReconciliation.deadlineAt;
    await f.reconcile({ now: '2030-01-01T00:00:00Z' });
    assert.equal(f.read().preReceiptReconciliation.deadlineAt, deadline);
    assert.equal(isActiveAmaCloserDispatchRecord(f.read(), { now: '2030-01-01' }), Boolean(dispatchIdempotencyKey));
    const active = await findActiveAmaCloserLaunches(f.rootDir, { ...f.options, now: '2030-01-01T00:00:00Z' });
    assert.deepEqual(active, [], 'an unresolved intent never appears in the fleet launch census');
    let launches = 0;
    const decision = await maybeDispatchAmaCloser({ cfg: { enabled: true },
      prMetadata: { isOpen: true },
      dispatchContext: { rootDir: f.rootDir, ...identity, dispatchedAt: now },
      readLegacyIntentLaunchesImpl: f.options.readLegacyIntentLaunchesImpl,
      readIntentReceiptImpl: f.options.readIntentReceiptImpl,
      deliverAlertImpl: async () => {},
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
    if (mode === 'live') { extra.processKillImpl = () => {}; extra.now = started; }
    if (mode === 'foreign-host') {
      writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({
        ...readAmaCloserLease(f.rootDir, identity), holderHost: `${hostname()}-other`,
      }));
      extra.readIntentReceiptImpl = () => assert.fail('foreign lease must skip receipt lookup');
    }
    if (mode === 'dispatched-other') updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_other' });
    if (mode === 'unreadable') extra.readIntentReceiptImpl = () => { throw Error('unavailable'); };
    if (mode === 'missing') extra.readIntentReceiptImpl = () => ({ ok: false, reason: 'missing-ledger-target' });
    if (mode === 'ambiguous') extra.readIntentReceiptImpl = () => ({ ok: true, rows: [receipt, receipt] });
    if (mode === 'foreign-ticket') f.insert({ ...receipt, ticket_ref: 'LAC-OTHER' });
    if (mode === 'foreign-repo') f.insert({ ...receipt, target_repo: 'different' });
    const lease = readAmaCloserLease(f.rootDir, identity);
    assert.equal((await f.reconcile(extra)).status, 'unknown');
    if (mode === 'foreign-host') {
      assert.equal(f.read().preReceiptReconciliation.query.reason, 'lookup-skipped-foreign-lease');
      assert.deepEqual(f.read().preReceiptReconciliation.query.attempts, []);
    }
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

test('receipt recovery passes the exact idempotency key through the SDK', async () => {
  const r = await readLaunchRequestByIdempotencyKeyAsync({ idempotencyKey: "key'quote",
    dispatchSession: { dispatchLookup: async selector => {
      assert.deepEqual(selector, {idempotency_key: "key'quote"});
      return {schema_version:1,status:'found',complete:true,roots:[receipt.launch_request_id],items:[receipt],retry_edges:[]};
    } } });
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


for (const lease of [true, false]) test(`legacy empty ticket/time query settles without a receipt (lease=${lease})`, async t => {
  const f = fixture(t, { dispatchIdempotencyKey: undefined, launchRequestId: 'lrq_predecessor' }, lease);
  f.insert({ ...receipt, requested_at: '2026-10-22T10:00:00Z' });
  const outcome = await f.reconcile();
  assert.equal(outcome.status, 'no-launch');
  assert.equal(f.read().state, 'no-dispatch');
  assert.equal(f.read().reason, 'legacy-no-launch-proven');
  assert.equal(f.read().launchRequestId, null);
  assert.equal(f.read().retryCount, 1);
  assert.deepEqual(f.read().preReceiptReconciliation.query, {
    kind: 'launch-requests-for-ticket-since', ticketRef: 'AMA-PR-8',
    requestedAtOrAfter: started, limit: 1, ok: true, rowCount: 0,
    backend: 'app-contract', source: 'app-sdk', reason: null, detail: null,
    timeoutMs: f.read().preReceiptReconciliation.query.timeoutMs,
    attempts: [{ ok: true, reason: null, detail: null }], launchRequestIds: [],
  });
  if (lease) assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
  assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
  const before = f.read();
  assert.equal((await f.reconcile()).status, 'unchanged');
  assert.deepEqual(f.read(), before);
});

for (const mode of ['failed', 'thrown', 'malformed', 'missing-ledger', 'missing-table', 'row', 'other-repo',
  'absent-key-row', 'equal-time-offset', 'null-time', 'invalid-time', 'invalid-attempt', 'replacement-owner', 'dispatched-owner']) {
  test(`legacy intent retains ownership with ${mode} evidence`, async t => {
    const f = fixture(t, { dispatchIdempotencyKey: mode === 'absent-key-row' ? undefined : null,
      ...(mode === 'invalid-attempt' ? { lastAttemptedAt: null } : {}) });
    const extra = {};
    if (mode === 'failed') extra.readLegacyIntentLaunchesImpl = () => ({ ok: false, rows: [] });
    if (mode === 'thrown') extra.readLegacyIntentLaunchesImpl = () => { throw Error('fixture failure'); };
    if (mode === 'malformed') extra.readLegacyIntentLaunchesImpl = () => ({ ok: true, rows: null });
    if (mode === 'missing-ledger') rmSync(f.options.ledgerDbPath);
    if (mode === 'missing-table') {
      const db = new Database(f.options.ledgerDbPath);
      db.exec('DROP TABLE launch_requests'); db.close();
    }
    if (['row', 'other-repo', 'absent-key-row', 'equal-time-offset', 'null-time', 'invalid-time'].includes(mode)) {
      f.insert({ ...receipt, target_repo: mode === 'other-repo' ? 'different' : receipt.target_repo,
        requested_at: mode === 'equal-time-offset' ? '2026-10-22T03:18:18-07:00'
          : mode === 'null-time' ? null : mode === 'invalid-time' ? 'unreadable' : started });
    }
    if (mode === 'replacement-owner') writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({
      ...readAmaCloserLease(f.rootDir, identity), acquiredAt: now,
    }));
    if (mode === 'dispatched-owner') updateAmaCloserLease({ rootDir: f.rootDir, ...identity,
      status: 'dispatched', lrqId: 'lrq_different_owner' });
    const lease = readAmaCloserLease(f.rootDir, identity);
    assert.equal((await f.reconcile(extra)).status, 'unknown');
    assert.equal(f.read().state, 'dispatching');
    assert.equal(f.read().retryCount, 2);
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  });
}

test('legacy settlement resumes after deferred lease persistence', async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'terminal', terminalOutcome: 'deferred' });
  assert.equal((await f.reconcile()).status, 'no-launch');
  assert.equal(f.read().reason, 'legacy-no-launch-proven');
});

test('legacy query yielding preserves a replacement owner', async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  const result = await f.reconcile({ readLegacyIntentLaunchesImpl: async () => {
    writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({
      ...readAmaCloserLease(f.rootDir, identity), watcherPid: 999,
    }));
    return { ok: true, rows: [] };
  } });
  assert.equal(result.reason, 'intent-or-lease-changed');
  assert.equal(f.read().state, 'dispatching');
});

function operatorArgs(f, extra = []) {
  return ['--root-dir', f.rootDir, '--hq-root', join(f.rootDir, 'hq'),
    '--repo', identity.repo,
    '--pr', String(identity.prNumber), '--head', identity.headSha, ...extra];
}

test('operator legacy dry-run preserves intent, lease, budget and audit; apply audits settlement', async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  const path = amaCloserDispatchFilePath(f.rootDir, identity);
  const before = readFileSync(path, 'utf8');
  const lease = readAmaCloserLease(f.rootDir, identity);
  const options = { ...f.options, print() {} };
  assert.equal((await settleLegacyIntent(operatorArgs(f), options)).conclusive, true);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
  assert.deepEqual(readdirSync(join(f.rootDir, 'data')).sort(), ['ama-closer-leases', 'follow-up-jobs']);
  const applied = await settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'fixture recovery']), options);
  assert.equal(applied.conclusive, true);
  assert.equal(f.read().state, 'no-dispatch');
  assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
  const rows = readFileSync(applied.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.outcome), ['settlement-authorized', 'settled-no-dispatch']);
  assert.equal(rows[0].actor.length > 0, true);
  assert.equal(rows[0].revisionRef, identity.headSha);
  assert.deepEqual(rows[0].evidence, f.read().preReceiptReconciliation.query);
});

for (const head of ['A'.repeat(40), 'Aa'.repeat(20)]) test(`operator normalizes ${head.slice(0, 2)} head input for dry-run and apply`, async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  const args = operatorArgs(f);
  args[args.indexOf('--head') + 1] = head;
  const options = { ...f.options, print() {} };
  const preview = await settleLegacyIntent(args, options);
  assert.equal(preview.conclusive, true);
  assert.equal(preview.headSha, identity.headSha);
  assert.equal(f.read().state, 'dispatching');
  const applied = await settleLegacyIntent([...args, '--apply', '--reason', 'fixture recovery'], options);
  assert.equal(applied.conclusive, true);
  assert.equal(applied.headSha, identity.headSha);
  assert.equal(f.read().state, 'no-dispatch');
  assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
  const rows = readFileSync(applied.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.revisionRef), [identity.headSha, identity.headSha]);
});

for (const mode of ['unavailable', 'foreign-owner']) test(`operator apply refuses ${mode} UID verification without mutations`, async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  const before = readFileSync(amaCloserDispatchFilePath(f.rootDir, identity), 'utf8');
  const lease = readAmaCloserLease(f.rootDir, identity);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  const uid = process.getuid();
  Object.defineProperty(process, 'getuid', { configurable: true,
    value: mode === 'unavailable' ? undefined : () => uid + 1 });
  try {
    await assert.rejects(settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'fixture recovery']), {
      ...f.options, print() {},
    }), mode === 'unavailable' ? /POSIX UID verification.*unavailable/ : /directory owner uid/);
    assert.equal((await settleLegacyIntent(operatorArgs(f), { ...f.options, print() {} })).conclusive, true);
    assert.equal(readFileSync(amaCloserDispatchFilePath(f.rootDir, identity), 'utf8'), before);
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
    assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
    assert.deepEqual(readdirSync(join(f.rootDir, 'data')).sort(), ['ama-closer-leases', 'follow-up-jobs']);
  } finally {
    if (descriptor) Object.defineProperty(process, 'getuid', descriptor);
    else delete process.getuid;
  }
});

for (const mode of ['row', 'unreadable']) test(`operator refuses ${mode} evidence and audits apply refusal`, async t => {
  const f = fixture(t, { dispatchIdempotencyKey: mode === 'keyed' ? key : null });
  if (mode === 'row') f.insert(receipt);
  if (mode === 'unreadable') rmSync(f.options.ledgerDbPath);
  let output;
  await assert.rejects(settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'fixture recovery']), {
    ...f.options, print: text => { output = JSON.parse(text); },
  }), /Closer intent settlement refused/);
  assert.equal(f.read().state, 'dispatching');
  assert.equal(readAmaCloserLease(f.rootDir, identity).status, 'pending');
  const audit = JSON.parse(readFileSync(output.auditPath, 'utf8').trim());
  assert.match(audit.outcome, /^refused:/);
});

test('audit failure prevents operator settlement', async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  writeFileSync(join(f.rootDir, 'data', 'operator-mutations'), 'fixture obstruction');
  await assert.rejects(settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'fixture recovery']), {
    ...f.options, print() {},
  }));
  assert.equal(f.read().state, 'dispatching');
  assert.equal(readAmaCloserLease(f.rootDir, identity).status, 'pending');
});

test('legacy intent passes the whole ticket window through the SDK', async () => {
  const r = await readLaunchRequestsForTicketSinceAsync({ ticketRef: "AMA-PR-8'fixture", requestedAtOrAfter: started,
    dispatchSession: { dispatchLookup: async selector => {
      assert.deepEqual(selector, {ticket_ref: "AMA-PR-8'fixture", requested_at_or_after: new Date(started).toISOString()});
      return {schema_version:1,status:'not_found',complete:true,roots:[],items:[],retry_edges:[]};
    } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, []);
});


test('legacy absence proof does not depend on whether the original watcher is still alive', async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  const outcome = await f.reconcile({ processKillImpl: () => {} });
  assert.equal(outcome.status, 'no-launch');
  assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
});

test('automatic launch reconciliation uses the same legacy ledger proof', async t => {
  const f = fixture(t, { dispatchIdempotencyKey: null });
  const before = f.read();
  assert.deepEqual(await findActiveAmaCloserLaunches(f.rootDir, f.options), []);
  assert.deepEqual(f.read(), before, 'the fleet census excludes pre-receipt intents without mutation');
  const result = await reconcileAmaCloserDispatches(f.rootDir, f.options);
  assert.equal(result.preReceipt.noLaunch, 1);
  assert.deepEqual(result.active, []);
  assert.equal(f.read().reason, 'legacy-no-launch-proven');
  assert.equal(f.read().preReceiptReconciliation.query.ok, true);
});

test('CLOSERGATE-01: inspection pages once per intent across repeated reconciliation', async t => {
  const f = fixture(t, {}, false);
  f.options.readIntentReceiptImpl = () => ({ ok: false, reason: 'ledger-read-failed', detail: 'synthetic unavailable' });
  const pages = [];
  const deliverAlertImpl = async (text, options) => { pages.push({ text, ...options }); };
  await f.reconcile({ deliverAlertImpl });
  await f.reconcile({ deliverAlertImpl, now: '2030-01-01T00:00:00Z' });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].event, 'ama_closer.pre_receipt_inspection_required');
  assert.match(pages[0].text, /fixture\/repo#8/);
  assert.ok(pages[0].text.includes(identity.headSha));
  assert.ok(pages[0].text.includes('receipt-lookup-unreadable'));
  assert.equal(f.read().preReceiptReconciliation.alertedAt, now);
});

test('CLOSERGATE-01: dry-run never pages; failed enqueue retries without releasing ownership', async t => {
  const f = fixture(t, {}, false);
  f.options.readIntentReceiptImpl = () => ({ ok: false, reason: 'ledger-read-failed' });
  const before = f.read();
  let calls = 0;
  const deliverAlertImpl = async () => { calls++; throw Error('synthetic outbox unavailable'); };
  await f.reconcile({ dryRun: true, deliverAlertImpl });
  assert.equal(calls, 0);
  assert.deepEqual(f.read(), before);
  await f.reconcile({ deliverAlertImpl });
  assert.equal(calls, 1);
  assert.equal(f.read().preReceiptReconciliation.alertedAt, undefined);
  assert.equal(f.read().state, 'dispatching');
  await f.reconcile({ deliverAlertImpl: async () => { calls++; } });
  assert.equal(calls, 2);
  assert.equal(f.read().preReceiptReconciliation.alertedAt, now);
});

test('CLOSERGATE-01: yielding alert enqueue cannot overwrite a replacement intent', async t => {
  const f = fixture(t, {}, false);
  const result = await f.reconcile({ readIntentReceiptImpl: () => ({ ok: false, reason: 'ledger-read-failed' }), deliverAlertImpl: async () => {
    writeFileSync(amaCloserDispatchFilePath(f.rootDir, identity), JSON.stringify({ ...f.read(), replacement: true }));
  } });
  assert.equal(result.status, 'held');
  assert.equal(f.read().replacement, true);
  assert.equal(f.read().preReceiptReconciliation, undefined);
});

for (const pr of [{ state: 'closed', merged: false }, { state: 'closed', merged: true }]) {
  test(`directory reconciliation retires raw intent for ${pr.merged ? 'merged' : 'closed'} PR without paging`, async t => {
    const f = fixture(t);
    const leaseBefore = readFileSync(amaCloserLeaseFilePath(f.rootDir, identity), 'utf8');
    let stateReads = 0;
    const options = { ...f.options, readPullRequestStateImpl: async record => {
      stateReads++;
      assert.equal(record.repo, identity.repo);
      assert.equal(record.prNumber, identity.prNumber);
      return pr;
    }, readIntentReceiptImpl: () => assert.fail('terminal PR needs no receipt'),
    deliverAlertImpl: () => assert.fail('terminal PR must not page') };
    const before = f.read();
    const dry = await reconcileAmaCloserDispatches(f.rootDir, { ...options, dryRun: true });
    assert.equal(dry.preReceipt.retired, 1);
    assert.deepEqual(f.read(), before);
    const result = await reconcileAmaCloserDispatches(f.rootDir, options);
    assert.equal(result.preReceipt.retired, 1);
    assert.deepEqual(result.active, []);
    assert.equal(f.read().state, 'completed');
    assert.equal(f.read().preReceiptReconciliation.status, 'pr-terminal');
    assert.equal(f.read().retryCount, before.retryCount);
    assert.equal(f.read().dispatchIdempotencyKey, key);
    assert.equal(readFileSync(amaCloserLeaseFilePath(f.rootDir, identity), 'utf8'), leaseBefore);
    assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
    assert.equal(isActiveAmaCloserDispatchRecord(f.read()), false);
    await reconcileAmaCloserDispatches(f.rootDir, options);
    assert.equal(stateReads, 2, 'retired intents are not re-probed');
  });
}

test('default PR resolver reads bounded REST metadata rather than stored dispatch state', async t => {
  const f = fixture(t, {}, false);
  const result = await f.reconcile({ readPullRequestStateImpl: undefined,
    execFileImpl: async (command, args, options) => {
      assert.equal(command, 'gh');
      assert.deepEqual(args, ['api', 'repos/fixture/repo/pulls/8', '--jq', '{state, merged}']);
      assert.ok(options.timeout > 0 && options.timeout <= 3000);
      return { stdout: JSON.stringify({ state: 'closed', merged: true }) };
    }, deliverAlertImpl: () => assert.fail('terminal PR must not page') });
  assert.equal(result.status, 'pr-terminal');
});

test('default PR resolver retries transient GitHub failures within its bounded budget', async t => {
  const f = fixture(t, {}, false);
  let attempts = 0;
  const result = await f.reconcile({ readPullRequestStateImpl: undefined,
    execFileImpl: async (_command, _args, options) => {
      assert.ok(options.timeout > 0 && options.timeout <= 3000);
      if (++attempts === 1) throw Object.assign(new Error('temporary outage'), { stderr: 'HTTP 503' });
      return { stdout: JSON.stringify({ state: 'closed', merged: true }) };
    } });
  assert.equal(attempts, 2);
  assert.equal(result.status, 'pr-terminal');
});

test('default PR resolver stops after one transient retry', async t => {
  const f = fixture(t, {}, false);
  let attempts = 0;
  const result = await f.reconcile({ readPullRequestStateImpl: undefined,
    execFileImpl: async () => {
      attempts++;
      throw Object.assign(new Error('temporary outage'), { stderr: 'HTTP 503' });
    } });
  assert.equal(attempts, 2);
  assert.equal(result.reason, 'pr-state-unreadable');
  assert.deepEqual(f.read(), f.record);
});

for (const dryRun of [false, true]) {
  test(`local receipt recovery survives unreadable PR state (dryRun=${dryRun})`, async t => {
    const f = fixture(t);
    f.insert(receipt);
    const leaseBefore = readAmaCloserLease(f.rootDir, identity);
    const result = await f.reconcile({ dryRun,
      readPullRequestStateImpl: async () => { throw Error('GitHub unavailable'); },
      deliverAlertImpl: () => assert.fail('receipt recovery must not page') });
    assert.equal(result.status, 'receipt-recovered');
    if (dryRun) {
      assert.deepEqual(f.read(), f.record);
      assert.deepEqual(readAmaCloserLease(f.rootDir, identity), leaseBefore);
      assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
    } else {
      assert.equal(f.read().state, 'dispatched');
      assert.equal(f.read().launchRequestId, receipt.launch_request_id);
      assert.equal(readAmaCloserLease(f.rootDir, identity).lrqId, receipt.launch_request_id);
      assert.equal(readHammerRetryCapLedger(f.rootDir, identity).lifetimeAttemptCount, 1);
    }
  });
}

for (const readPullRequestStateImpl of [async () => { throw Error('unavailable'); }, async () => ({})]) {
  test('unreadable PR lifecycle evidence holds ownership without paging or mutation', async t => {
    const f = fixture(t, {}, false);
    const before = f.read();
    const result = await f.reconcile({ readPullRequestStateImpl,
      deliverAlertImpl: () => assert.fail('unreadable PR state must not page') });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'pr-state-unreadable');
    assert.deepEqual(f.read(), before);
  });
}

test('PR resolver yield preserves a concurrent record annotation before terminal retirement', async t => {
  const f = fixture(t, {}, false);
  const result = await f.reconcile({ readPullRequestStateImpl: async () => {
    writeFileSync(amaCloserDispatchFilePath(f.rootDir, identity), JSON.stringify({ ...f.read(), replacement: true }));
    return { state: 'CLOSED' };
  } });
  assert.equal(result.status, 'held');
  assert.equal(f.read().state, 'dispatching');
  assert.equal(f.read().replacement, true);
});

test('terminal PR dispatch gate retires lingering intents at every head', async t => {
  const f = fixture(t, {}, false);
  const older = { ...identity, headSha: 'b'.repeat(40) };
  updateAmaCloserDispatchRecord(f.rootDir, older, () => ({ ...f.record, ...older }));
  const result = await maybeDispatchAmaCloser({ cfg: { enabled: true },
    dispatchContext: { rootDir: f.rootDir, ...identity },
    prMetadata: { isOpen: false, state: 'MERGED', headSha: identity.headSha },
    deliverAlertImpl: () => assert.fail('terminal PR must not page') });
  assert.equal(result.reason, 'pr-not-mergeable');
  assert.equal(f.read().state, 'completed');
  assert.equal(readAmaCloserDispatchRecord(f.rootDir, older).state, 'completed');
});

test('terminal PR discovered by reconciliation stops dispatch before downstream admission', async t => {
  const f = fixture(t, {}, false);
  const result = await maybeDispatchAmaCloser({ cfg: { enabled: true },
    dispatchContext: { rootDir: f.rootDir, ...identity },
    readPullRequestStateImpl: async () => ({ state: 'CLOSED', merged: true }),
    execFileImpl: () => assert.fail('terminal PR must not reach downstream admission'),
    deliverAlertImpl: () => assert.fail('terminal PR must not page') });
  assert.equal(result.reason, 'pr-not-mergeable');
  assert.equal(result.dispatched, false);
  assert.equal(f.read().state, 'completed');
});

for (const boundary of ['receipt', 'alert']) {
  test(`lease corruption during ${boundary} yield defers without throwing or overwriting`, async t => {
    const f = fixture(t);
    const leasePath = amaCloserLeaseFilePath(f.rootDir, identity);
    const corrupt = async () => { writeFileSync(leasePath, '{bad json'); return { ok: true, rows: [] }; };
    const result = await f.reconcile(boundary === 'receipt'
      ? { readIntentReceiptImpl: corrupt } : { readIntentReceiptImpl: () => ({ ok: false }), deliverAlertImpl: corrupt });
    assert.equal(result.status, 'held');
    assert.equal(result.reason, 'intent-or-lease-changed');
    assert.deepEqual(f.read(), f.record);
    assert.equal(readFileSync(leasePath, 'utf8'), '{bad json');
  });
}

for (const elapsed of [599_999, 600_000]) test(`CLOSERINTENT-01: empty key at ${elapsed}ms respects dispatch deadline`, async t => {
  const f = fixture(t, { launchRequestId: 'lrq_conflict_predecessor' });
  const result = await f.reconcile({ now: new Date(Date.parse(started) + elapsed).toISOString() });
  assert.equal(result.status, elapsed < 600_000 ? 'unknown' : 'no-launch');
  assert.equal(f.read().state, elapsed < 600_000 ? 'dispatching' : 'no-dispatch');
  assert.equal(result.evidence.kind, 'launch-request-by-idempotency-key');
  assert.equal(result.evidence.ok, true);
  assert.equal(result.evidence.rowCount, 0);
  if (elapsed >= 600_000) {
    assert.equal(f.read().reason, 'keyed-no-launch-proven');
    assert.equal(f.read().launchRequestId, null);
    assert.equal(f.read().retryCount, 1);
    assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
    assert.equal((await f.reconcile()).status, 'unchanged');
  }
});

for (const legacy of [false, true]) test(`CLOSERINTENT-01: transient ${legacy ? 'ticket' : 'key'} read retries with load-scaled budget`, async t => {
  const f = fixture(t, legacy ? { dispatchIdempotencyKey: null } : {});
  const timeouts = [];
  const delays = [];
  const read = async args => {
    timeouts.push(args.timeoutMs);
    return timeouts.length === 1 ? { ok: false, transient: true,
      reason: 'ledger-read-failed', detail: 'psql timed out after 180000ms' } : { ok: true, rows: [] };
  };
  const result = await f.reconcile({
    loadAwareTimeoutOptions: { enabled: true, maxMultiplier: 6, loadAvg1m: 3, cpuCount: 1, cpuBusyPercent: 100 },
    delayAsyncImpl: async ms => delays.push(ms),
    ...(legacy ? { readLegacyIntentLaunchesImpl: read } : { readIntentReceiptImpl: read }),
  });
  assert.deepEqual(timeouts, [180_000, 180_000]);
  assert.deepEqual(delays, [100]);
  assert.equal(result.status, 'no-launch');
  assert.match(result.evidence.attempts[0].detail, /timed out/);
});

for (const failure of [
  { ok: false, transient: true, reason: 'ledger-read-failed', detail: 'psql timed out after 30000ms' },
  { ok: false, reason: 'ledger-query-failed', detail: 'synthetic SQL error' },
  { ok: false, reason: 'psql-not-installed', detail: 'psql is not installed or not on PATH' },
  { ok: false, reason: 'missing-ledger-target', detail: 'synthetic target missing' },
]) test(`CLOSERINTENT-01: ${failure.detail} is durable and logged only on change`, async t => {
  const f = fixture(t);
  const messages = [], delays = [];
  const extra = { readIntentReceiptImpl: async () => failure,
    delayAsyncImpl: async ms => delays.push(ms), logger: { warn: text => messages.push(JSON.parse(text)) },
    loadAwareTimeoutOptions: { enabled: false, maxMultiplier: 6 } };
  for (const minutes of [0, 1, 2]) {
    await f.reconcile({ ...extra, now: new Date(Date.parse(now) + minutes * 60_000).toISOString() });
  }
  const evidence = f.read().preReceiptReconciliation.query;
  assert.equal(evidence.ok, false);
  assert.equal(evidence.reason, failure.reason);
  assert.equal(evidence.detail, failure.detail);
  assert.equal(evidence.attempts.length, failure.transient ? 3 : 1);
  assert.deepEqual(delays, failure.transient ? [100, 200, 100, 200, 100, 200] : []);
  assert.equal(messages.filter(x => x.event === 'ama_closer.pre_receipt_reconciled').length, 1);
  await f.reconcile({ ...extra, readIntentReceiptImpl: () => ({ ...failure, detail: 'changed failure' }) });
  assert.equal(messages.filter(x => x.event === 'ama_closer.pre_receipt_reconciled').length, 2);
});

test('CLOSERINTENT-01: thrown transient exception retains details and retries', async t => {
  const f = fixture(t);
  let calls = 0;
  const result = await f.reconcile({ delayAsyncImpl: async () => {}, readIntentReceiptImpl: async () => {
    if (++calls === 1) throw Object.assign(Error('synthetic connection reset'), { code: 'ECONNRESET' });
    return { ok: true, rows: [receipt] };
  } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'receipt-recovered');
  assert.equal(result.evidence.attempts[0].detail, 'synthetic connection reset');
  assert.equal(f.read().preReceiptReconciliation.query.attempts[0].detail, 'synthetic connection reset');
});

for (const targetRepo of [undefined, null, 'repo', 'fixture/repo']) {
  test(`CLOSERINTENT-01: exact-key receipt accepts repository metadata ${targetRepo}`, async t => {
    const f = fixture(t);
    const result = await f.reconcile({ readIntentReceiptImpl: () => ({ ok: true,
      rows: [{ ...receipt, target_repo: targetRepo }] }) });
    assert.equal(result.status, 'receipt-recovered');
    assert.equal(f.read().state, 'dispatched');
    assert.equal(readAmaCloserLease(f.rootDir, identity).lrqId, receipt.launch_request_id);
  });
}

for (const missingColumn of ['target_repo', 'ticket_ref']) {
  test(`CLOSERINTENT-01: SQLite exact-key recovery with no ${missingColumn} column`, async t => {
    const f = fixture(t);
    f.insert(receipt);
    const db = new Database(f.options.ledgerDbPath);
    try { db.exec(`ALTER TABLE launch_requests DROP COLUMN ${missingColumn}`); }
    finally { db.close(); }
    const probe = await readLaunchRequestByIdempotencyKeyAsync({ ...f.options, idempotencyKey: key });
    assert.equal(probe.ok, true);
    assert.equal(probe.rows[0][missingColumn], null);
    const result = await f.reconcile();
    assert.equal(result.status, missingColumn === 'target_repo' ? 'receipt-recovered' : 'unknown');
    assert.equal(f.read().state, missingColumn === 'target_repo' ? 'dispatched' : 'dispatching');
  });
}

for (const mismatch of [{ ticket_ref: 'CONFLICT-REBASE-8' }, { ticket_ref: null, target_repo: null },
  { target_repo: 'different/repo' }, { target_repo: '' }, { head_sha: 'b'.repeat(40) }]) {
  test(`CLOSERINTENT-01: exact-key receipt rejects ${JSON.stringify(mismatch)}`, async t => {
    const f = fixture(t);
    await f.reconcile({ readIntentReceiptImpl: () => ({ ok: true, rows: [{ ...receipt, ...mismatch }] }) });
    assert.equal(f.read().state, 'dispatching');
    assert.equal(f.read().launchRequestId, undefined);
    assert.equal(readAmaCloserLease(f.rootDir, identity).lrqId, null);
    assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
  });
}

for (const keyReadable of [true, false]) test(`CLOSERINTENT-01: keyed misattribution tool uses ticket absence (key readable=${keyReadable})`, async t => {
  const f = fixture(t, { launchRequestId: 'lrq_conflict' });
  f.insert({ ...receipt, launch_request_id: 'lrq_conflict', ticket_ref: 'CONFLICT-REBASE-8' });
  const options = { ...f.options, print() {},
    ...(keyReadable ? {} : { readIntentReceiptImpl: () => ({ ok: false, reason: 'ledger-read-failed', detail: 'synthetic key read failure' }) }) };
  const before = f.read(), lease = readAmaCloserLease(f.rootDir, identity);
  const preview = await settleLegacyIntent(operatorArgs(f), options);
  assert.equal(preview.conclusive, true);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  const applied = await settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'synthetic keyed recovery']), options);
  assert.equal(applied.conclusive, true);
  assert.equal(f.read().reason, 'closer-ticket-no-launch-proven');
  assert.equal(f.read().launchRequestId, null);
  assert.equal(applied.evidence.ticketQuery.rowCount, 0);
  assert.equal(applied.evidence.ticketQuery.ok, true);
  assert.equal(applied.evidence.recordedLaunchRequestId, 'lrq_conflict');
  const audit = readFileSync(applied.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(x => x.outcome), ['settlement-authorized', 'settled-no-dispatch']);
  assert.deepEqual(audit[0].evidence, applied.evidence);
});

for (const patch of [{ ticket_ref: null }, { head_sha: 'b'.repeat(40) },
  { ticket_ref: 'FOREIGN', identity_ambiguous: true }]) {
  test(`LAC-2096: empty supplemental ticket evidence cannot settle terminal ambiguity ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t);
    const lease = readAmaCloserLease(f.rootDir, identity);
    await assert.rejects(settleLegacyIntent(operatorArgs(f), { ...f.options, print() {},
      readIntentReceiptImpl: () => ({ ok: true, rows: [{ ...receipt, status: 'succeeded', ...patch }] }),
      readLegacyIntentLaunchesImpl: () => ({ ok: true, rows: [] }),
    }), /receipt-identity-ambiguous/);
    assert.equal(f.read().state, 'dispatching');
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
    assert.equal(readHammerRetryCapLedger(f.rootDir, identity), null);
  });
}

for (const mode of ['before-deadline', 'closer-exists', 'unreadable', 'audit-failure']) {
  test(`CLOSERINTENT-01: keyed operator settlement refuses ${mode}`, async t => {
    const f = fixture(t, { launchRequestId: 'lrq_conflict' });
    f.insert({ ...receipt, launch_request_id: 'lrq_conflict', ticket_ref: 'CONFLICT-REBASE-8' });
    if (mode === 'closer-exists') f.insert({ ...receipt, idempotency_key: 'other-key' });
    if (mode === 'audit-failure') writeFileSync(join(f.rootDir, 'data', 'operator-mutations'), 'obstruction');
    const lease = readAmaCloserLease(f.rootDir, identity);
    await assert.rejects(settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'synthetic recovery']), {
      ...f.options, print() {}, ...(mode === 'before-deadline' ? { now: started } : {}),
      ...(mode === 'unreadable' ? { readLegacyIntentLaunchesImpl: () => ({ ok: false, reason: 'ledger-read-failed' }) } : {}),
    }));
    assert.equal(f.read().state, 'dispatching');
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  });
}


test('CLOSERINTENT-01: audited keyed recovery removes only a proven misattributed promoted lease', async t => {
  const f = fixture(t, { launchRequestId: 'lrq_conflict' });
  f.insert({ ...receipt, launch_request_id: 'lrq_conflict', ticket_ref: 'CONFLICT-REBASE-8' });
  updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_conflict' });
  const lease = readAmaCloserLease(f.rootDir, identity);
  const options = { ...f.options, print() {} };
  assert.equal((await settleLegacyIntent(operatorArgs(f), options)).conclusive, true);
  assert.deepEqual(readAmaCloserLease(f.rootDir, identity), lease);
  const applied = await settleLegacyIntent(operatorArgs(f, ['--apply', '--reason', 'synthetic promoted recovery']), options);
  assert.equal(applied.conclusive, true);
  assert.equal(applied.evidence.misattributedLeaseLaunchRequestId, 'lrq_conflict');
  assert.equal(f.read().state, 'no-dispatch');
  assert.equal(readAmaCloserLease(f.rootDir, identity), null);
});

// CLOSERPENDINGDEAD-01: all process observations are synthetic and bounded.
const processRow = (pid, command = 'synthetic-process', stamp = 'Thu Oct 22 10:18:18 2026') =>
  `${pid} ${stamp} ${command}\n`;
const processScan = (output = processRow(99, 'ps -axww -o pid= -o lstart= -o args=')) =>
  (command, args, options) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-axww', '-o', 'pid=', '-o', 'lstart=', '-o', 'args=']);
    assert.equal(options.timeout, 1000);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
    return output;
  };
const firstPoll = new Date(Date.parse(started) + 1000).toISOString();

test('CLOSERPENDINGDEAD-01: macOS kernel_task PID 0 permits first-poll recovery', async t => {
  const f = fixture(t);
  const result = await f.reconcile({ now: firstPoll,
    processExecFileSyncImpl: processScan(processRow(0, 'kernel_task') + processRow(99)),
  });
  assert.equal(result.status, 'no-launch');
  assert.equal(f.read().reason, 'dead-submitter-no-launch-proven');
  assert.equal(f.read().preReceiptReconciliation.processes.key.status, 'absent');
  assert.equal(f.read().retryCount, 1);
  assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
});

for (const mode of ['missing', 'null-start', 'invalid-start', 'foreign-pid', 'matching']) {
  test(`CLOSERPENDINGDEAD-01: observed watcher with ${mode} identity overrides ESRCH`, async t => {
    const dispatchWatcher = mode === 'missing' ? undefined : {
      pid: mode === 'foreign-pid' ? 54321 : 12345,
      startedAt: mode === 'null-start' ? null : mode === 'invalid-start' ? 'invalid' : started,
    };
    const f = fixture(t, { dispatchWatcher });
    const leaseBefore = readAmaCloserLease(f.rootDir, identity);
    const result = await f.reconcile({ now: firstPoll,
      processExecFileSyncImpl: processScan(processRow(0, 'kernel_task') + processRow(12345)),
    });
    const watcher = f.read().preReceiptReconciliation.processes.watcher;
    assert.equal(result.status, 'unknown');
    assert.equal(watcher.status, mode === 'matching' ? 'live' : 'unknown');
    assert.equal(watcher.reason, mode === 'matching' ? 'pid-present' : 'watcher-identity-unverified');
    assert.equal(watcher.observedStartedAt, '2026-10-22T10:18:18.000Z');
    assert.equal(f.read().state, 'dispatching');
    assert.equal(f.read().retryCount, 2);
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), leaseBefore);
  });
}

for (const reused of [false, true]) test(`CLOSERPENDINGDEAD-01: first poll re-takes dead submission (PID reused=${reused})`, async t => {
  const f = fixture(t, { dispatchWatcher: { pid: 12345, startedAt: '2026-10-22T10:18:18.000Z' },
    dispatchSubmitter: { pid: 12346, startedAt: '2026-10-22T10:18:18.000Z' } });
  const logs = [];
  const result = await f.reconcile({ now: firstPoll,
    processKillImpl: reused ? () => {} : dead,
    processExecFileSyncImpl: processScan(reused
      ? processRow(12345, 'unrelated', 'Thu Oct 22 10:18:19 2026')
        + processRow(12346, 'unrelated', 'Thu Oct 22 10:18:19 2026') : undefined),
    logger: { warn: line => logs.push(JSON.parse(line)) },
  });
  assert.equal(result.status, 'no-launch');
  assert.equal(f.read().reason, 'dead-submitter-no-launch-proven');
  assert.equal(f.read().retryCount, 1);
  assert.equal(readAmaCloserLease(f.rootDir, identity).terminalOutcome, 'deferred');
  assert.equal(result.record.preReceiptReconciliation.processes.watcher.status, 'gone');
  assert.equal(result.record.preReceiptReconciliation.processes.submitter.status, 'gone');
  assert.equal(result.evidence.rowCount, 0);
  assert.ok(logs.some(log => log.event === 'ama_closer.pre_receipt_dead_submitter_reclaimed'
    && log.query.rowCount === 0 && log.processes.key.status === 'absent'));
  assert.equal((await f.reconcile()).status, 'unchanged');
});

for (const mode of ['unrelated', 'key-continuation', 'recorded-child']) {
  test(`CLOSERPENDINGDEAD-01: multiline process arguments preserve ${mode} evidence`, async t => {
    const f = fixture(t, { dispatchSubmitter: { pid: 12346, startedAt: '2026-10-22T10:18:18.000Z' } });
    const leaseBefore = readAmaCloserLease(f.rootDir, identity);
    const output = processRow(mode === 'recorded-child' ? 12346 : 99, 'node -e "first line')
      + '\n  continuation line\n'
      + (mode === 'key-continuation' ? `hq dispatch --idempotency-key ${key}\n` : '')
      + 'last line"\n' + processRow(100);
    const result = await f.reconcile({ now: firstPoll, processExecFileSyncImpl: processScan(output) });
    const processes = f.read().preReceiptReconciliation.processes;
    assert.equal(result.status, mode === 'unrelated' ? 'no-launch' : 'unknown');
    assert.equal(processes.key.status, mode === 'key-continuation' ? 'live' : 'absent');
    assert.equal(processes.submitter.status, mode === 'recorded-child' ? 'live' : 'gone');
    assert.deepEqual(processes.key.pids, mode === 'key-continuation' ? [99] : []);
    assert.ok(!JSON.stringify(processes).includes('continuation line'), 'command lines stay private');
    if (mode !== 'unrelated') {
      assert.equal(f.read().retryCount, 2);
      assert.deepEqual(readAmaCloserLease(f.rootDir, identity), leaseBefore);
    }
  });
}

for (const mode of ['key-child', 'recorded-child', 'launch', 'watcher-live', 'scan-unreadable', 'scan-malformed', 'scan-orphan-continuation', 'scan-invalid-timestamp', 'scan-empty', 'scan-overflow', 'child-malformed', 'child-start-unreadable', 'watcher-unknown', 'ledger-unreadable']) {
  test(`CLOSERPENDINGDEAD-01: ${mode} fences early recovery until death and absence are proven`, async t => {
    const f = fixture(t, { dispatchSubmitter: { pid: 12346, startedAt: '2026-10-22T10:18:18.000Z' } });
    const extra = { now: firstPoll, processExecFileSyncImpl: processScan() };
    if (mode === 'key-child') extra.processExecFileSyncImpl = processScan(processRow(12347, `hq dispatch --idempotency-key ${key}`));
    if (mode === 'recorded-child') extra.processExecFileSyncImpl = processScan(processRow(12346));
    if (mode === 'launch') f.insert(receipt);
    if (mode === 'watcher-live') extra.processKillImpl = () => {};
    if (mode === 'scan-unreadable') extra.processExecFileSyncImpl = () => { throw Object.assign(Error('unavailable'), { code: 'ETIMEDOUT' }); };
    if (mode === 'scan-malformed') extra.processExecFileSyncImpl = processScan('truncated process output');
    if (mode === 'scan-orphan-continuation') extra.processExecFileSyncImpl = processScan('orphan continuation\n' + processRow(99));
    if (mode === 'scan-invalid-timestamp') extra.processExecFileSyncImpl = processScan(processRow(99) + processRow(100, 'synthetic-process', 'invalid timestamp value!'));
    if (mode === 'scan-empty') extra.processExecFileSyncImpl = processScan('');
    if (mode === 'scan-overflow') extra.processExecFileSyncImpl = () => { throw Object.assign(Error('buffer limit'), { code: 'ENOBUFS' }); };
    if (mode === 'child-malformed') updateAmaCloserDispatchRecord(f.rootDir, identity, current => ({ ...current, dispatchSubmitter: { pid: '12346' } }));
    if (mode === 'child-start-unreadable') {
      updateAmaCloserDispatchRecord(f.rootDir, identity, current => ({ ...current, dispatchSubmitter: { pid: 12346, startedAt: null } }));
      extra.processExecFileSyncImpl = processScan(processRow(12346));
    }
    if (mode === 'watcher-unknown') extra.processKillImpl = () => { throw Object.assign(Error('unknown'), { code: 'EIO' }); };
    if (mode === 'ledger-unreadable') extra.readIntentReceiptImpl = () => ({ ok: false, reason: 'synthetic unreadable' });
    const leaseBefore = readAmaCloserLease(f.rootDir, identity);
    const result = await f.reconcile(extra);
    assert.equal(result.status, mode === 'launch' ? 'receipt-recovered' : 'unknown');
    assert.equal(f.read().retryCount, 2);
    if (mode === 'launch') {
      assert.equal(f.read().launchRequestId, receipt.launch_request_id);
      return;
    }
    assert.deepEqual(readAmaCloserLease(f.rootDir, identity), leaseBefore);
    assert.equal(f.read().preReceiptReconciliation.deadlineAt, new Date(Date.parse(started) + 600_000).toISOString());
    // The same fenced attempt becomes recoverable on the next poll with proof.
    if (mode === 'child-malformed') updateAmaCloserDispatchRecord(f.rootDir, identity, current => ({ ...current, dispatchSubmitter: null }));
    assert.equal((await f.reconcile({ now: firstPoll, processExecFileSyncImpl: processScan() })).status, 'no-launch');
  });
}

test('CLOSERPENDINGDEAD-01: scan precedes ledger lookup so a launch committed as the child exits is recovered', async t => {
  const f = fixture(t);
  const result = await f.reconcile({ now: firstPoll, processExecFileSyncImpl: (...args) => {
    f.insert(receipt);
    return processScan()(...args);
  } });
  assert.equal(result.status, 'receipt-recovered');
  assert.equal(f.read().retryCount, 2);
});

test('CLOSERPENDINGDEAD-01: unknown process evidence retains the original deadline settlement', async t => {
  const f = fixture(t);
  const extra = { processExecFileSyncImpl: () => { throw Error('unavailable'); } };
  assert.equal((await f.reconcile({ ...extra, now: firstPoll })).status, 'unknown');
  const result = await f.reconcile({ ...extra, now });
  assert.equal(result.status, 'no-launch');
  assert.equal(f.read().reason, 'keyed-no-launch-proven');
});

for (const liveChild of [false, true]) test(`CLOSERPENDINGDEAD-01: replay after lease deferral re-proves submitter absence (live=${liveChild})`, async t => {
  const f = fixture(t);
  updateAmaCloserLease({ rootDir: f.rootDir, ...identity, status: 'terminal', terminalOutcome: 'deferred' });
  const result = await f.reconcile({ now: firstPoll,
    processExecFileSyncImpl: processScan(liveChild ? processRow(12346, `hq dispatch --idempotency-key ${key}`) : undefined),
  });
  assert.equal(result.status, liveChild ? 'unknown' : 'no-launch');
  assert.equal(f.read().retryCount, liveChild ? 2 : 1);
});

for (const replacement of ['intent', 'lease']) test(`CLOSERPENDINGDEAD-01: process scan cannot overwrite replacement ${replacement}`, async t => {
  const f = fixture(t);
  const result = await f.reconcile({ now: firstPoll, processExecFileSyncImpl: (...args) => {
    if (replacement === 'intent') writeFileSync(amaCloserDispatchFilePath(f.rootDir, identity), JSON.stringify({ ...f.read(), custom: 'replacement' }));
    else writeFileSync(amaCloserLeaseFilePath(f.rootDir, identity), JSON.stringify({ ...readAmaCloserLease(f.rootDir, identity), watcherPid: 54321 }));
    return processScan()(...args);
  } });
  assert.equal(result.reason, 'intent-or-lease-changed');
  assert.equal(f.read().state, 'dispatching');
  assert.equal(f.read().retryCount, 2);
});


test('closer receipt repository identity follows GitHub case insensitivity', () => {
  assert.equal(closerLaunchMatches({ repo: 'laceyenterprises/agent-os', prNumber: 8, headSha: 'a'.repeat(40) },
    { ticket_ref: 'AMA-PR-8', target_repo: 'LaceyEnterprises/Agent-OS', head_sha: 'a'.repeat(40) }), true);
});

for (const scenario of ['absent', 'receipt']) test(`CLOSERINTENTRECON-01 rekeyed ${scenario} preserves a raced lease`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'intent-rekey-race-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const f = seedCloserIntent(rootDir, identity, { rekeyedHead: 'b'.repeat(40), scenario });
  const before = f.lease();
  const result = await reconcilePreReceiptIntent(rootDir, identity, { ...f.options,
    now: intentExpired, leaseHeadSha: f.currentIdentity.headSha,
    readIntentReceiptImpl: async args => {
      const response = await f.options.readIntentReceiptImpl(args);
      writeFileSync(amaCloserLeaseFilePath(rootDir, f.currentIdentity), JSON.stringify({ ...before, watcherPid: 434343 }));
      return response;
    } });
  assert.equal(result.reason, 'intent-or-lease-changed');
  assert.equal(f.record().state, 'dispatching');
  assert.equal(f.record().retryCount, 2);
  assert.equal(f.lease().watcherPid, 434343);
  assert.equal(f.lease().status, 'pending');
});

test('operator settlement refuses retired ledger-target before any reconciliation', async () => {
  await assert.rejects(settleLegacyIntent(['--ledger-target', '/synthetic/canonical']),
    /--ledger-target is no longer supported/);
});


test('SDK transient classification reaches receipt-owner retries with safe persisted evidence', async t => {
  const f = fixture(t);
  let calls = 0;
  const delays = [];
  const result = await f.reconcile({
    dispatchSession: { dispatchLookup: async () => {
      if (++calls === 1) throw Object.assign(new Error('secret endpoint token'), { code: 'ECONNRESET' });
      return { schema_version: 1, status: 'not_found', complete: true, roots: [], items: [], retry_edges: [] };
    } },
    delayAsyncImpl: async ms => delays.push(ms),
  });
  assert.equal(result.status, 'no-launch');
  assert.equal(calls, 2);
  assert.deepEqual(delays, [100]);
  assert.equal(result.evidence.attempts[0].detail, 'transient dispatch lookup failure');
  assert.doesNotMatch(JSON.stringify(f.read().preReceiptReconciliation), /secret endpoint token/);
});
