import './helpers/load-aware-timeout-fixture.mjs';
import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/reconcile-ama-closer-dispatches.mjs';
import { closerScanBudgets, AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS, amaCloserDispatchFilePath, updateAmaCloserDispatchRecord, findActiveAmaCloserLaunches, reconcileAmaCloserDispatches } from '../src/ama/dispatch-closer.mjs';

test('CLI dry-run preserves bytes; terminal reconciliation is idempotent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amacap-reconcile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statuses = ['succeeded', 'failed', 'canceled', 'reaped_stuck_requested', 'superseded', 'operator_triage_required'];
  const paths = statuses.map((status, i) => {
    const identity = { repo: 'fixture/repo', prNumber: i + 1, headSha: 'abc' };
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, state: 'dispatched', launchRequestId: status, custom: 'preserved' }));
    return amaCloserDispatchFilePath(root, identity);
  });
  const before = paths.map(p => readFileSync(p, 'utf8'));
  const options = { ledgerTarget: join(root, 'fixture.sqlite'), now: '2026-10-03T00:00:00Z', print() {}, readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true, row: { status: launchRequestId } }) };
  assert.equal((await main(['--root-dir', root, '--dry-run'], options)).changed, 6);
  assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), before);
  assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 0);
  for (const path of paths) {
    const doc = JSON.parse(readFileSync(path));
    assert.equal(doc.state, 'launch-terminal');
    assert.equal(doc.custom, 'preserved');
    assert.equal(doc.reconciledAt, options.now);
  }
  const after = paths.map(p => readFileSync(p, 'utf8'));
  assert.equal((await main(['--root-dir', root], options)).changed, 0);
  assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), after);
});

test('missing or unreadable launch reserves fleet capacity inside the pending window', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'amacap-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = '2026-10-03T00:00:00Z';
  updateAmaCloserDispatchRecord(root, { repo: 'fixture/repo', prNumber: 1, headSha: 'abc' }, () => ({ repo: 'fixture/repo', prNumber: 1, headSha: 'abc', state: 'dispatched', launchRequestId: 'missing', lastAttemptedAt: now }));
  assert.equal((await findActiveAmaCloserLaunches(root, { now, readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'query-failed' }) }))[0].holdsCapacity, true);
  assert.equal((await findActiveAmaCloserLaunches(root, { now, readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }) }))[0].holdsCapacity, true);
  const expiredNow = new Date(Date.parse(now) + AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS).toISOString();
  assert.equal((await findActiveAmaCloserLaunches(root, { now: expiredNow, readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'query-failed' }) })).length, 0);
  assert.equal((await findActiveAmaCloserLaunches(root, { now: expiredNow, readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }) })).length, 0);
});

for (const state of ['dispatching', 'dispatched']) {
  test(`running ledger launch respects ${state} record age and latest observation`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'amacap-stale-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const identity = { repo: 'fixture/repo', prNumber: 1, headSha: 'abc' };
    const startedAt = '2026-10-03T00:00:00Z';
    const now = new Date(Date.parse(startedAt) + AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS).toISOString();
    updateAmaCloserDispatchRecord(root, identity, () => ({
      ...identity, state, launchRequestId: 'crashed', lastObservedStatus: 'running', lastAttemptedAt: startedAt,
    }));
    let probes = 0;
    const options = { now, readLaunchRequestStatusImpl: () => { probes += 1; return { ok: true, row: { status: 'running' } }; } };
    assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 0);
    assert.equal(probes, 0, 'an intent must not query a predecessor LRQ');
    assert.equal(JSON.parse(readFileSync(amaCloserDispatchFilePath(root, identity))).state, state,
      'age expiry alone does not fabricate a terminal outcome');
    updateAmaCloserDispatchRecord(root, identity, record => ({ ...record, state: 'dispatched', lastObservedAt: now }));
    assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 1,
      'a recent observation retains an older launch');
  });
}

test('shared ledger adapter reads terminal and running SQLite launches offline', async (t) => {
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const root = mkdtempSync(join(tmpdir(), 'amacap-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerDbPath = join(root, 'ledger.sqlite');
  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE launch_requests (launch_request_id TEXT, status TEXT, updated_at TEXT, terminal_at TEXT, failure_class TEXT)');
  for (const [i, status] of ['succeeded', 'running'].entries()) {
    db.prepare('INSERT INTO launch_requests VALUES (?, ?, NULL, NULL, NULL)').run(`lrq-${i}`, status);
    updateAmaCloserDispatchRecord(root, { repo: 'fixture/repo', prNumber: i + 1, headSha: 'abc' }, () => ({ repo: 'fixture/repo', prNumber: i + 1, headSha: 'abc', state: 'dispatched', launchRequestId: `lrq-${i}`, lastAttemptedAt: '2020-01-01T00:00:00Z', lastObservedAt: '2026-10-03T00:00:00Z' }));
  }
  db.close();
  const active = await findActiveAmaCloserLaunches(root, { now: '2026-10-03T00:00:00Z', ledgerDbPath, env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' } });
  assert.deepEqual(active.map(record => record.launchRequestId), ['lrq-1']);
});

test('default ledger reader merges worker PID and process status into fleet capacity evidence', async (t) => {
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const root = fixture(t, 'process-capacity');
  const ledgerDbPath = join(root, 'ledger.sqlite');
  const db = new Database(ledgerDbPath);
  try {
    db.exec(`
      CREATE TABLE launch_requests (launch_request_id TEXT, status TEXT, updated_at TEXT, terminal_at TEXT, failure_class TEXT);
      CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT, updated_at TEXT, ended_at TEXT, started_at TEXT);
      CREATE TABLE worker_processes (worker_process_id INTEGER PRIMARY KEY, launch_request_id TEXT, pid INTEGER,
        process_status TEXT, updated_at TEXT, exited_at TEXT, started_at TEXT, created_at TEXT);
    `);
    for (const [i, processStatus] of ['running', 'running', 'exited'].entries()) {
      const prNumber = i + 1;
      const lrq = `lrq-${prNumber}`;
      db.prepare('INSERT INTO launch_requests VALUES (?, ?, NULL, NULL, NULL)').run(lrq, 'running');
      db.prepare('INSERT INTO worker_runs VALUES (?, ?, ?, NULL, NULL, NULL)').run(`wr-${prNumber}`, lrq, 'running');
      db.prepare('INSERT INTO worker_processes VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)').run(prNumber, lrq, 4200 + prNumber, processStatus);
      dispatchRecord(root, prNumber);
    }
  } finally { db.close(); }
  const checkedPids = [];
  // Verify adapter evidence independently of host sampling latency. Separate
  // fixtures below exercise scan deadlines and unreadable evidence.
  const active = await findActiveAmaCloserLaunches(root, {
    now: NOW, ledgerDbPath, env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' }, scanBudgetMs: Infinity,
    processKillImpl: (pid, signal) => {
      checkedPids.push(pid);
      assert.equal(signal, 0);
      if (pid === 4202) throw Object.assign(new Error('dead fixture worker'), { code: 'ESRCH' });
    },
  });
  assert.deepEqual(checkedPids.sort(), [4201, 4202]);
  assert.deepEqual(active.sort((a, b) => a.prNumber - b.prNumber).map(({ prNumber, holdsCapacity }) =>
    [prNumber, holdsCapacity]), [[1, true], [2, true], [3, false]]);

  // Exercise the same default reader with promise-returning adapter exports.
  // The loader wraps the real offline SQLite adapter, so both awaits are
  // necessary to retain the worker PID and process status.
  const loaderPath = join(root, 'async-ledger-loader.mjs');
  writeFileSync(loaderPath, `
    export async function load(url, context, nextLoad) {
      const result = await nextLoad(url, context);
      if (!url.endsWith('/src/session-ledger-read-adapter.mjs')) return result;
      return { ...result, source: String(result.source)
        .replace('export function readLaunchRequestStatusFromLedger(', 'export async function readLaunchRequestStatusFromLedger(')
        .replace('export function readLatestWorkerRunStatusFromLedger(', 'export async function readLatestWorkerRunStatusFromLedger(') };
    }
  `);
  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import ${JSON.stringify(new URL('./helpers/dispatch-read-fixture.mjs', import.meta.url).href)};
    import { register } from 'node:module';
    import assert from 'node:assert/strict';
    register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);
    const { findActiveAmaCloserLaunches } = await import(${JSON.stringify(new URL('../src/ama/dispatch-closer.mjs', import.meta.url).href)});
    const checkedPids = [];
    const active = await findActiveAmaCloserLaunches(${JSON.stringify(root)}, {
      now: ${JSON.stringify(NOW)}, ledgerDbPath: ${JSON.stringify(ledgerDbPath)},
      scanBudgetMs: Infinity,
      env: { AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite' },
      processKillImpl: (pid, signal) => {
        checkedPids.push(pid);
        assert.equal(signal, 0);
        if (pid === 4202) throw Object.assign(new Error('dead fixture worker'), { code: 'ESRCH' });
      },
    });
    assert.deepEqual(checkedPids.sort(), [4201, 4202]);
    assert.deepEqual(active.sort((a, b) => a.prNumber - b.prNumber)
      .map(({ prNumber, holdsCapacity }) => [prNumber, holdsCapacity]), [[1, true], [2, true], [3, false]]);
  `], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
});

function fixture(t, label) {
  const root = mkdtempSync(join(tmpdir(), `amacap-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function dispatchRecord(root, prNumber, overrides = {}) {
  const identity = { repo: 'fixture/repo', prNumber, headSha: 'abc' };
  updateAmaCloserDispatchRecord(root, identity, () => ({
    ...identity, state: 'dispatched', launchRequestId: `lrq-${prNumber}`,
    lastAttemptedAt: '2026-10-03T00:00:00Z', ...overrides,
  }));
  return amaCloserDispatchFilePath(root, identity);
}

const NOW = '2026-10-03T00:00:00Z';

test('dispatch scan isolates individual unreadable results', async (t) => {
  const root = fixture(t, 'breaker');
  for (let i = 1; i <= 4; i += 1) dispatchRecord(root, i);
  let probes = 0;
  const options = { now: NOW, readLaunchRequestStatusImpl: () => {
    probes += 1;
    return { ok: false, reason: 'query-failed' };
  } };
  assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 4);
  assert.equal(probes, 4);
  options.readLaunchRequestStatusImpl = () => ({ ok: true, row: { status: 'failed' } });
  assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 0,
    'the next scan retries after the ledger recovers');
});

test('dispatch scan checks cancellation before and between ledger probes', async (t) => {
  const root = fixture(t, 'abort');
  for (let i = 1; i <= 3; i += 1) dispatchRecord(root, i);
  const controller = new AbortController();
  let probes = 0;
  const options = { now: NOW, signal: controller.signal, readLaunchRequestStatusImpl: () => {
    probes += 1;
    controller.abort(new Error('scan cancelled'));
    return { ok: true, row: { status: 'failed' } };
  } };
  await assert.rejects(findActiveAmaCloserLaunches(root, options), /scan cancelled/);
  assert.equal(probes, 1);
  await assert.rejects(findActiveAmaCloserLaunches(root, options), /scan cancelled/);
  assert.equal(probes, 1);
});

test('capacity scan skips terminal records and reclaimed leases before probing', async (t) => {
  const { acquireAmaCloserLease, updateAmaCloserLease } = await import('../src/ama/closer-lease.mjs');
  const root = fixture(t, 'lease');
  dispatchRecord(root, 1, { lastObservedStatus: 'failed' });
  dispatchRecord(root, 2);
  const identity = { rootDir: root, repo: 'fixture/repo', prNumber: 2, headSha: 'abc', now: NOW };
  assert.equal(acquireAmaCloserLease(identity).acquired, true);
  updateAmaCloserLease({ ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  let probes = 0;
  for (const scanBudgetMs of [0, Infinity]) {
    assert.deepEqual(await findActiveAmaCloserLaunches(root, { now: NOW, scanBudgetMs,
      readLaunchRequestStatusImpl: () => {
        probes += 1;
        return { ok: true, row: { status: 'running' } };
      } }), []);
  }
  assert.equal(probes, 0);
});

test('historical cleanup remains available through explicit reconciliation', async (t) => {
  const root = fixture(t, 'history');
  const path = dispatchRecord(root, 1, { lastAttemptedAt: '2020-01-01T00:00:00Z' });
  let probes = 0;
  const options = { now: NOW, readLaunchRequestStatusImpl: () => {
    probes += 1;
    return { ok: true, row: { status: 'failed' } };
  } };
  assert.deepEqual(await findActiveAmaCloserLaunches(root, options), []);
  assert.equal(probes, 0);
  assert.equal((await reconcileAmaCloserDispatches(root, options)).changed, 1);
  assert.equal(probes, 1);
  assert.equal(JSON.parse(readFileSync(path)).state, 'launch-terminal');
});

test('daemon and CLI retain unknown same-head retry intent without probing its predecessor', async (t) => {
  const root = fixture(t, 'retry');
  const path = dispatchRecord(root, 1, { state: 'dispatching', lastObservedStatus: 'failed' });
  const options = { now: NOW, readPullRequestStateImpl: async () => ({ state: 'OPEN' }), deliverAlertImpl: async () => {},
    readLaunchRequestStatusImpl: () => assert.fail('must not probe the previous LRQ') };
  assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 0);
  assert.equal((await reconcileAmaCloserDispatches(root, options)).active.length, 1);
  const record = JSON.parse(readFileSync(path));
  assert.equal(record.state, 'dispatching');
  assert.equal(record.launchRequestId, 'lrq-1');
  assert.equal(record.preReceiptReconciliation.reason, 'legacy-intent-without-key');
});

test('missing ledger row with no parseable launch timestamps stays held', async (t) => {
  const root = fixture(t, 'no-time');
  const path = dispatchRecord(root, 1, { lastAttemptedAt: 'invalid', dispatchedAt: null });
  const before = readFileSync(path, 'utf8');
  const options = { now: NOW, readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }) };
  assert.equal((await findActiveAmaCloserLaunches(root, options)).length, 1);
  assert.equal((await reconcileAmaCloserDispatches(root, options)).changed, 0);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('invalid repository and PR identities are excluded before probing', async (t) => {
  const root = fixture(t, 'malformed');
  for (const [i, overrides] of [{ repo: null }, { prNumber: 0 }, { prNumber: 1.5 }].entries()) {
    dispatchRecord(root, i + 1, overrides);
  }
  assert.deepEqual(await findActiveAmaCloserLaunches(root, { now: NOW,
    readLaunchRequestStatusImpl: () => assert.fail('must not probe malformed identity'),
  }), []);
});

test('CLI pins ledger and HQ roots and reports backend/source without credentials', async (t) => {
  const root = fixture(t, 'cli-target');
  dispatchRecord(root, 1);
  const calls = [];
  const result = await main(['--root-dir', root, '--hq-root', root, '--dry-run'], {
    now: NOW, print() {}, readLaunchRequestStatusImpl: args => {
      calls.push(args);
      return { ok: true, row: { status: 'failed' } };
    },
  });
  assert.equal(result.source, 'app-sdk');
  assert.equal(calls[0].ledgerTarget, undefined);
  assert.equal(calls[0].hqRoot, root);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.changed, 1);
});

test('concurrent terminal evidence survives the ledger probe', async (t) => {
  const root = fixture(t, 'concurrent');
  const path = dispatchRecord(root, 1);
  await reconcileAmaCloserDispatches(root, { now: NOW, readLaunchRequestStatusImpl() {
    updateAmaCloserDispatchRecord(root, { repo: 'fixture/repo', prNumber: 1, headSha: 'abc' }, doc => ({ ...doc, lastObservedStatus: 'succeeded' }));
    return { ok: true, row: { status: 'succeeded' } };
  } });
  assert.equal(JSON.parse(readFileSync(path)).lastObservedStatus, 'succeeded');
});

test('all-missing ledger cannot terminalize records; recent observations remain held', async (t) => {
  const root = fixture(t, 'all-missing');
  const path = dispatchRecord(root, 1, { lastAttemptedAt: '2020-01-01T00:00:00Z', lastObservedAt: NOW });
  const before = readFileSync(path, 'utf8');
  const result = await reconcileAmaCloserDispatches(root, { now: NOW, readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }) });
  assert.equal(result.allMissing, true);
  assert.equal(result.changed, 0);
  assert.equal(result.active.length, 1);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('scan budget stops additional queries and reconciliation logs safe metadata', async (t) => {
  const root = fixture(t, 'budget');
  dispatchRecord(root, 1);
  dispatchRecord(root, 2);
  let probes = 0;
  await reconcileAmaCloserDispatches(root, { now: NOW, scanBudgetMs: 0, readLaunchRequestStatusImpl() { probes += 1; } });
  assert.equal(probes, 0);
  const events = [];
  await reconcileAmaCloserDispatches(root, { now: NOW, log: { info: event => events.push(JSON.parse(event)) }, ledgerTarget: { backend: 'postgres', source: 'fixture', dsn: 'secret' }, readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' } }) });
  assert.equal(events.length, 3);
  assert.equal(events[0].event, 'ama_closer.launch_capacity_reconciled');
  assert.equal(JSON.stringify(events).includes('secret'), false);
});

test('snapshot timeout falls back to individual reads and isolates failure', async t => {
  const root = fixture(t, 'snapshot-timeout');
  for (let i = 1; i <= 3; i++) dispatchRecord(root, i);
  const readIds = [];
  const result = await reconcileAmaCloserDispatches(root, {
    now: NOW, useLaunchSnapshot: true, snapshotTimeoutMs: 1,
    readLaunchRequestSnapshotImpl: () => new Promise(() => {}),
    readLaunchRequestStatusImpl: ({ launchRequestId, launchSnapshot, timeoutMs }) => {
      assert.equal(launchSnapshot, null);
      assert.ok(timeoutMs > 0);
      readIds.push(launchRequestId);
      return launchRequestId === 'lrq-2' ? { ok: false } : {
        ok: true, row: { status: 'succeeded' }, retryChain: [],
      };
    },
  });
  assert.deepEqual(readIds, ['lrq-1', 'lrq-2', 'lrq-3']);
  assert.equal(result.snapshot.outcome, 'timeout');
  assert.equal(result.individualReads, 3);
  assert.equal(result.changed, 2);
  assert.equal(result.unreadable, 1);
  assert.deepEqual(result.active.map(item => item.prNumber), [2]);
});

test('snapshot timeout preserves definitive missing evidence from individual reads', async t => {
  const root = fixture(t, 'snapshot-missing');
  const missing = dispatchRecord(root, 1, { lastAttemptedAt: '2020-01-01T00:00:00Z' });
  dispatchRecord(root, 2);
  const result = await reconcileAmaCloserDispatches(root, {
    now: NOW, useLaunchSnapshot: true, snapshotTimeoutMs: 1, scanBudgetMs: Infinity,
    readLaunchRequestSnapshotImpl: () => new Promise(() => {}),
    readLaunchRequestStatusImpl: ({ launchRequestId, launchSnapshot }) => {
      assert.equal(launchSnapshot, null);
      return launchRequestId === 'lrq-1' ? { ok: false, reason: 'missing-launch-request-row' }
        : { ok: true, row: { status: 'running' }, retryChain: [] };
    },
  });
  assert.equal(result.snapshot.outcome, 'timeout');
  assert.equal(result.individualReads, 2);
  assert.equal(result.missing, 1);
  assert.equal(result.unreadable, 0);
  assert.equal(result.changed, 1);
  assert.equal(JSON.parse(readFileSync(missing)).terminalLaunchStatus, 'not-found');
  assert.deepEqual(result.active.map(item => item.prNumber), [2]);
});

for (const failure of ['timeout', 'ETIMEDOUT']) {
  test(`individual ${failure} without a snapshot retains capacity and permits sibling reads`, async t => {
    const root = fixture(t, `individual-${failure}`);
    dispatchRecord(root, 1);
    dispatchRecord(root, 2);
    const result = await reconcileAmaCloserDispatches(root, {
      now: NOW, launchReadTimeoutMs: 1, scanBudgetMs: Infinity,
      readLaunchRequestStatusImpl: ({ launchRequestId }) => {
        if (launchRequestId === 'lrq-2') return { ok: true, row: { status: 'succeeded' }, retryChain: [] };
        if (failure === 'timeout') return new Promise(() => {});
        throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      },
    });
    assert.equal(result.snapshot.outcome, 'unused');
    assert.equal(result.individualReads, 2);
    assert.equal(result.unreadable, 1);
    assert.equal(result.changed, 1);
    assert.deepEqual(result.active.map(({ prNumber, holdsCapacity }) => [prNumber, holdsCapacity]), [[1, true]]);
  });
}

test('total pass budget defers untouched records and resumes fairly', async t => {
  const root = fixture(t, 'fair-budget');
  for (let i = 1; i <= 3; i++) dispatchRecord(root, i);
  let clock = 0;
  const reads = [];
  const options = { now: NOW, nowMs: () => clock, scanBudgetMs: 10,
    readLaunchRequestStatusImpl: ({ launchRequestId }) => {
      reads.push(launchRequestId);
      clock += 10;
      return { ok: true, row: { status: 'running' }, retryChain: [] };
    } };
  const first = await reconcileAmaCloserDispatches(root, options);
  assert.equal(first.deferred, 2);
  assert.equal(first.unreadable, 0);
  assert.equal(first.changed, 0);
  assert.equal(first.active.filter(item => item.scanDeferred).length, 2);
  const second = await reconcileAmaCloserDispatches(root, options);
  assert.equal(second.deferred, 2);
  assert.deepEqual(reads, ['lrq-1', 'lrq-2']);
});

for (const capacityBudget of [0, Infinity]) {
  test(`capacity checks with budget ${capacityBudget} preserve the independent census cursor`, async t => {
    const root = fixture(t, 'capacity-cursor');
    for (let i = 1; i <= 3; i++) dispatchRecord(root, i);
    let clock = 0;
    const censusReads = [];
    const censusOptions = { now: NOW, nowMs: () => clock, scanBudgetMs: 10,
      readLaunchRequestStatusImpl: ({ launchRequestId }) => {
        censusReads.push(launchRequestId);
        clock += 10;
        return { ok: true, row: { status: 'running' }, retryChain: [] };
      } };
    const capacityReads = [];
    for (let i = 0; i < 3; i++) {
      assert.equal((await reconcileAmaCloserDispatches(root, censusOptions)).deferred, 2);
      const active = await findActiveAmaCloserLaunches(root, {
        now: NOW, scanBudgetMs: capacityBudget,
        readLaunchRequestStatusImpl: ({ launchRequestId }) => {
          capacityReads.push(launchRequestId);
          return { ok: true, row: { status: 'running' }, retryChain: [] };
        },
      });
      assert.equal(active.length, 3);
    }
    assert.deepEqual(censusReads, ['lrq-1', 'lrq-2', 'lrq-3']);
    assert.deepEqual(capacityReads, capacityBudget === 0 ? []
      : ['lrq-1', 'lrq-2', 'lrq-3', 'lrq-1', 'lrq-2', 'lrq-3', 'lrq-1', 'lrq-2', 'lrq-3']);
  });
}

test('deferred census preserves missing records until a complete mixed-evidence pass', async t => {
  const root = fixture(t, 'deferred-missing');
  dispatchRecord(root, 1);
  const missing = dispatchRecord(root, 2, { lastAttemptedAt: '2020-01-01T00:00:00Z' });
  dispatchRecord(root, 3);
  const before = readFileSync(missing, 'utf8');
  let clock = 0;
  const options = { now: NOW, nowMs: () => clock, scanBudgetMs: 10,
    readLaunchRequestStatusImpl: ({ launchRequestId }) => {
      if (launchRequestId !== 'lrq-2') return { ok: true, row: { status: 'running' }, retryChain: [] };
      clock += 10;
      return { ok: false, reason: 'missing-launch-request-row' };
    } };
  const partial = await reconcileAmaCloserDispatches(root, options);
  assert.equal(partial.deferred, 1);
  assert.equal(partial.allMissing, false);
  assert.equal(partial.missing, 1);
  assert.equal(partial.unreadable, 0);
  assert.equal(partial.changed, 0);
  assert.equal(readFileSync(missing, 'utf8'), before);
  const complete = await reconcileAmaCloserDispatches(root, { ...options, scanBudgetMs: Infinity });
  assert.equal(complete.deferred, 0);
  assert.equal(complete.changed, 1);
  assert.equal(JSON.parse(readFileSync(missing)).terminalLaunchStatus, 'not-found');
});

test('all scan budgets scale with synthetic host load', () => {
  const idle = closerScanBudgets({ loadOptions: { loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100 } });
  const busy = closerScanBudgets({ loadOptions: { loadAvg1m: 6, cpuCount: 1, cpuBusyPercent: 100 } });
  assert.deepEqual(idle, { pass: 30_000, snapshot: 10_000, launch: 8_000 });
  for (const key of Object.keys(idle)) assert.ok(busy[key] > idle[key]);
});

test('CLI apply refuses a foreign directory owner while dry-run remains available', async (t) => {
  const root = fixture(t, 'owner');
  dispatchRecord(root, 1);
  const options = { ledgerTarget: join(root, 'fixture.sqlite'), print() {}, statSyncImpl: () => ({ uid: process.getuid() + 1 }), readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' } }) };
  await assert.rejects(main(['--root-dir', root], options), /directory owner uid/);
  assert.equal((await main(['--root-dir', root, '--dry-run'], options)).dryRun, true);
});

test('mixed ledger results expire only genuinely stale missing records', async (t) => {
  const root = fixture(t, 'mixed-missing');
  const old = dispatchRecord(root, 1, { lastAttemptedAt: '2020-01-01T00:00:00Z' });
  const fresh = dispatchRecord(root, 2, { lastAttemptedAt: '2020-01-01T00:00:00Z', lastObservedAt: NOW });
  dispatchRecord(root, 3);
  const result = await reconcileAmaCloserDispatches(root, { now: NOW, readLaunchRequestStatusImpl: ({ launchRequestId }) => launchRequestId === 'lrq-3' ? { ok: true, row: { status: 'running' } } : { ok: false, reason: 'missing-launch-request-row' } });
  assert.equal(result.allMissing, false);
  assert.equal(result.changed, 1);
  assert.equal(JSON.parse(readFileSync(old)).state, 'launch-terminal');
  assert.equal(JSON.parse(readFileSync(fresh)).state, 'dispatched');
});

for (const status of ['running', 'succeeded', 'failed']) {
  test(`REBASEPROV-01 foreign ${status} launch holds no closer capacity or terminal outcome`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'foreign-closer-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const identity = { repo: 'fixture/repo', prNumber: 42, headSha: 'head' };
    updateAmaCloserDispatchRecord(root, identity, () => ({ ...identity, workerClass: 'hammer',
      state: 'dispatched', launchRequestId: 'foreign-launch', lastObservedStatus: 'running',
      lastObservedAt: '2026-01-01T00:00:00Z' }));
    const path = amaCloserDispatchFilePath(root, identity);
    const before = readFileSync(path);
    assert.equal((await findActiveAmaCloserLaunches(root, { now: '2026-01-01T00:01:00Z',
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status, ticket_ref: 'CONFLICT-PR-42-REBASE' } }),
    })).length, 0);
    assert.deepEqual(readFileSync(path), before, 'capacity reconciliation does not charge or record a hammer outcome');
  });
}

test('HAMRETRY-01: capacity excludes proven terminal launches and reserves unprobed fresh launches', async t => {
  const root = fixture(t, 'terminal-capacity');
  for (let i = 1; i <= 4; i++) dispatchRecord(root, i, { lastObservedStatus: 'starting' });
  const active = await findActiveAmaCloserLaunches(root, { now: NOW,
    readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true,
      row: { status: launchRequestId === 'lrq-4' ? 'running' : 'succeeded' } }),
  });
  assert.deepEqual(active.map(r => r.launchRequestId), ['lrq-4']);
  assert.equal(active[0].holdsCapacity, true);
  for (let i = 1; i <= 3; i++) {
    const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(root,
      { repo: 'fixture/repo', prNumber: i, headSha: 'abc' })));
    assert.equal(record.state, 'launch-terminal');
    assert.equal(record.terminalLaunchStatus, 'succeeded');
  }
  const unprobed = await findActiveAmaCloserLaunches(root, { now: NOW, scanBudgetMs: 0,
    readLaunchRequestStatusImpl: () => assert.fail('budget exhausted'),
  });
  assert.equal(unprobed.length, 1, 'unknown liveness still protects this PR from duplicate ownership');
  assert.equal(unprobed[0].holdsCapacity, true, 'unknown evidence reserves capacity within the pending window');
});

test('HAMRETRY-01: unreadable retry traversal reserves bounded capacity', async t => {
  const root = fixture(t, 'unreadable-retry-capacity');
  dispatchRecord(root, 1, { lastObservedStatus: 'starting' });
  const active = await findActiveAmaCloserLaunches(root, { now: NOW,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' }, retryChainUnreadable: true }),
  });
  assert.equal(active.length, 1);
  assert.equal(active[0].holdsCapacity, true, 'base terminality cannot release an unreadable descendant');
});

test('CLOSERGATE-01: capacity ignores legacy, keyed, orphaned and terminal-PR intents', async t => {
  const root = fixture(t, 'closergate-capacity');
  for (const [i, patch] of [
    { dispatchIdempotencyKey: null, lastAttemptedAt: '2020-01-01T00:00:00Z' },
    { dispatchIdempotencyKey: null },
    { dispatchIdempotencyKey: 'synthetic-key' },
    { dispatchIdempotencyKey: 'synthetic-inspection', preReceiptReconciliation: { status: 'inspection-required' } },
    { prState: 'MERGED' }, { prState: 'CLOSED' },
  ].entries()) dispatchRecord(root, i + 1, { state: 'dispatching', ...patch });
  const options = { now: NOW,
    readIntentReceiptImpl: () => assert.fail('capacity must not inspect unrelated intents'),
    readLaunchRequestStatusImpl: () => assert.fail('capacity must not query a predecessor LRQ') };
  for (const scanBudgetMs of [0, Infinity]) {
    assert.deepEqual(await findActiveAmaCloserLaunches(root, { ...options, scanBudgetMs }), []);
  }
});
