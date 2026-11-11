import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, promises as fsPromises } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseHolderLiveness } from '../src/ama/dispatch-submitter.mjs';
import { acquireMergeLease, inspectMergeLease, mergeLeaseFilePath, readMergeLeaseHistory, reclaimIfStale, releaseMergedPrMergeLeases } from '../src/ama/merge-lease.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { reconcileAmaCloserLeaseIntent } from '../src/ama/pre-receipt-intent.mjs';
import { reconcileAmaCloserLeaseAsync, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { seedCloserIntent, intentEarly, intentStarted } from './helpers/closer-intent-fixture.mjs';
import { readAmaAuditEntry, writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-record-read.mjs';
import { createStaleStateReaperTicker, observeDeadLeaseHolders } from '../src/recovery-reaper.mjs';

const identity = { repo: 'example/project', prNumber: 42, headSha: 'synthetic-head' };
function root(t) {
  const path = mkdtempSync(join(tmpdir(), 'leaseorphan-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('one identity predicate distinguishes death, PID reuse, live, remote and unreadable', () => {
  const holder = { pid: 123, host: hostname(), startedAt: intentStarted };
  const options = { isProcessAlive: () => true, captureProcessImpl: () => ({ startedAt: intentStarted }) };
  assert.equal(leaseHolderLiveness(holder, options), 'live');
  assert.equal(leaseHolderLiveness(holder, { ...options, isProcessAlive: () => false }), 'dead');
  assert.equal(leaseHolderLiveness(holder, { ...options, captureProcessImpl: () => ({ startedAt: intentEarly }) }), 'dead');
  assert.equal(leaseHolderLiveness({ ...holder, host: 'another-host' }, options), 'remote');
  assert.equal(leaseHolderLiveness(holder, { ...options, captureProcessImpl: () => null }), 'unknown');
  assert.equal(leaseHolderLiveness(holder, { ...options, isProcessAlive: () => { throw Error('unreadable'); } }), 'unknown');
});

for (const reused of [false, true]) test(`merge lease inspection reports ${reused ? 'reused PID' : 'dead holder'} without reclaiming`, t => {
  const rootDir = root(t);
  const held = acquireMergeLease({ rootDir, repo: identity.repo, base: 'main',
    holderPr: 42, holderHead: identity.headSha, holderPid: 424242,
    holderHost: hostname(), now: intentStarted });
  writeFileSync(held.leasePath, JSON.stringify({ ...held.lease, holderStartedAt: intentStarted }));
  const options = { rootDir, repo: identity.repo, base: 'main', now: intentEarly,
    pidAliveFn: () => reused, captureProcessImpl: () => ({ startedAt: intentEarly }) };
  const beforeHistory = readMergeLeaseHistory(rootDir, options);
  const seen = inspectMergeLease(options);
  assert.equal(seen.exists, true);
  assert.equal(seen.holderLiveness, 'dead');
  assert.deepEqual(readMergeLeaseHistory(rootDir, options), beforeHistory);
  assert.equal(reclaimIfStale(options).reclaimed, true);
  assert.equal(readMergeLeaseHistory(rootDir, { repo: identity.repo, base: 'main' }).at(-1).reason, 'dead-holder-pid');
});

for (const scenario of ['early-absent', 'receipt', 'live']) test(`closer observation before expiry: ${scenario}`, async t => {
  const rootDir = root(t);
  const f = seedCloserIntent(rootDir, identity, { scenario });
  // Complete scan with no matching child/key. The exact-key read follows it.
  f.options.processExecFileSyncImpl = () => '515151 Thu Jan  1 00:00:00 2026 synthetic-worker\n';
  const result = await reconcileAmaCloserLeaseIntent(rootDir, f.lease(), {
    ...f.options, now: intentEarly,
  });
  assert.equal(result.status, scenario === 'receipt' ? 'receipt-recovered'
    : scenario === 'live' ? 'held' : 'no-launch');
  assert.equal(f.lease().status, scenario === 'receipt' ? 'dispatched' : scenario === 'live' ? 'pending' : 'terminal');
  if (scenario === 'receipt') assert.equal(f.lease().lrqId, f.receipt.launch_request_id);
});

test('closer observation reclaims a reused watcher PID only after the child/key absence proof', async t => {
  const rootDir = root(t);
  const f = seedCloserIntent(rootDir, identity);
  const record = { ...f.record(), dispatchWatcher: { pid: 424242, startedAt: intentStarted } };
  writeFileSync(amaCloserDispatchFilePath(rootDir, identity), JSON.stringify(record));
  const result = await reconcileAmaCloserLeaseIntent(rootDir, f.lease(), {
    ...f.options, now: intentEarly, processKillImpl: () => {},
    captureProcessImpl: () => ({ startedAt: intentEarly }),
    processExecFileSyncImpl: () => '424242 Thu Jan  1 00:00:30 2026 synthetic-reused-process\n',
  });
  assert.equal(result.status, 'no-launch');
  assert.equal(f.lease().terminalOutcome, 'deferred');
  assert.equal(result.record.preReceiptReconciliation.processes.watcher.reason, 'pid-reused');
});

test('bounded watcher observations reach dead holders across ticks and restart before the age sweep', async t => {
  const rootDir = root(t);
  // More than one 50-read batch; the next tick resumes beyond terminal history.
  for (let i = 0; i < 55; i++) {
    const old = { ...identity, repo: 'aaa/history', prNumber: i + 1 };
    acquireAmaCloserLease({ rootDir, ...old, watcherPid: 424242, now: intentStarted });
    updateAmaCloserLease({ rootDir, ...old, status: 'terminal', terminalOutcome: 'deferred' });
  }
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242, now: intentStarted });
  acquireMergeLease({ rootDir, repo: identity.repo, base: 'main',
    holderPr: identity.prNumber, holderHead: identity.headSha, holderPid: 424242,
    holderHost: hostname(), now: intentStarted });
  const ticker = createStaleStateReaperTicker({ rootDir, lastRunAtMs: Date.parse(intentStarted),
    isProcessAlive: () => false, logger: { warn() {}, error() {} } });
  const result = await ticker.tick({ nowMs: Date.parse(intentEarly) });
  assert.equal(result.reason, 'interval-not-elapsed');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'pending');
  assert.equal(existsSync(mergeLeaseFilePath(rootDir, { repo: identity.repo, base: 'main' })), false);
  const restarted = createStaleStateReaperTicker({ rootDir, lastRunAtMs: Date.parse(intentStarted),
    isProcessAlive: () => false, logger: { warn() {}, error() {} } });
  assert.equal((await restarted.tick({ nowMs: Date.parse(intentEarly) + 1000 })).reason, 'interval-not-elapsed');
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'abandoned-holder-dead');
});

test('holder observation caps reads and leaves the age-pruning cursor unchanged', async t => {
  const rootDir = root(t);
  for (let prNumber = 1; prNumber <= 5; prNumber++) {
    acquireAmaCloserLease({ rootDir, ...identity, prNumber, watcherPid: 424242, now: intentStarted });
  }
  const stateDir = join(rootDir, 'data', 'recovery-reaper');
  mkdirSync(stateDir, { recursive: true });
  const ageCursorPath = join(stateDir, 'closer-lease-cursor.json');
  const ageCursor = JSON.stringify({ schemaVersion: 2, lastEntryName: 'unrelated-age-position', entriesSeen: 1 });
  writeFileSync(ageCursorPath, ageCursor);
  const reads = [];
  const options = { rootDir, now: intentEarly, entryScanLimit: 3, readLimit: 2,
    isProcessAlive: () => true, captureProcessImpl: () => null,
    readFileImpl: (path, encoding) => { reads.push(path); return fsPromises.readFile(path, encoding); } };
  const first = await observeDeadLeaseHolders(options);
  assert.equal(reads.length, 2);
  assert.ok(first.scannedEntries <= 3);
  const second = await observeDeadLeaseHolders(options);
  assert.equal(reads.length, 4);
  assert.equal(new Set(reads).size, 4, 'resume after the last parsed record');
  assert.ok(second.scannedEntries <= 3);
  assert.equal(readFileSync(ageCursorPath, 'utf8'), ageCursor);
});

test('dispatched closer survives watcher death during holder observation', async t => {
  const rootDir = root(t);
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242, now: intentStarted });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_live_worker' });
  const before = readAmaCloserLease(rootDir, identity);
  await observeDeadLeaseHolders({ rootDir, now: intentEarly, isProcessAlive: () => false });
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
});

test('inspection remains read-only and dedicated reclamation honors the holder mutation lock', t => {
  const rootDir = root(t);
  const args = { rootDir, repo: identity.repo, base: 'main', holderPr: identity.prNumber,
    holderHead: identity.headSha, holderPid: 424242, holderHost: hostname(), now: intentStarted };
  const held = acquireMergeLease(args);
  const beforeHistory = readMergeLeaseHistory(rootDir, args);
  const beforeLease = readFileSync(held.leasePath, 'utf8');
  const lockPath = `${held.leasePath}.mutation.lock`;
  writeFileSync(lockPath, JSON.stringify({ holderPid: process.pid, holderHost: hostname(),
    acquiredAt: new Date().toISOString() }));
  const probe = { rootDir, repo: identity.repo, base: 'main', now: intentEarly, pidAliveFn: () => false };
  assert.equal(inspectMergeLease(probe).exists, true);
  assert.equal(reclaimIfStale(probe).reclaimed, false);
  assert.equal(readFileSync(held.leasePath, 'utf8'), beforeLease);
  assert.deepEqual(readMergeLeaseHistory(rootDir, args), beforeHistory);
  rmSync(lockPath);
  assert.equal(inspectMergeLease(probe).exists, true);
  assert.deepEqual(readMergeLeaseHistory(rootDir, args), beforeHistory);
  assert.equal(reclaimIfStale(probe).reclaimed, true);
  assert.equal(inspectMergeLease(probe).exists, false);
  assert.deepEqual(readMergeLeaseHistory(rootDir, args).map(row => row.event), ['grant', 'steal']);
});

test('bulk merged release uses discovered repos and preserves other PR holders', t => {
  const rootDir = root(t);
  const holders = ['example/first', 'example/second', 'example/other'].map((repo, i) =>
    acquireMergeLease({ rootDir, repo, base: 'main', holderPr: i === 2 ? 99 : identity.prNumber,
      holderHead: identity.headSha, holderPid: process.pid, now: intentStarted }));
  assert.equal(releaseMergedPrMergeLeases({ rootDir, prNumber: identity.prNumber, now: intentEarly }), true);
  assert.deepEqual(holders.map(holder => existsSync(holder.leasePath)), [false, false, true]);
  for (const holder of holders.slice(0, 2)) {
    assert.equal(readMergeLeaseHistory(rootDir, holder.lease).at(-1).reason, 'holder-pr-merged');
  }
});

for (const scenario of ['missing', 'worker', 'rekeyed']) test(`ordinary successful reconciliation preserves audit provenance: ${scenario}`, async t => {
  const rootDir = root(t);
  const launchRequestId = 'lrq_normal_success';
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242, now: intentStarted });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: launchRequestId });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    launchRequestId, state: 'dispatched', lastObservedStatus: 'running' }));
  if (scenario !== 'missing') writeAmaAuditEntry({ hqRoot: rootDir, ...identity, now: intentStarted,
    attempt: { outcome: 'succeeded', reason: 'hammer-merge-completed', launchRequestId } });
  const currentIdentity = scenario === 'rekeyed' ? { ...identity, headSha: 'synthetic-rekeyed-head' } : identity;
  if (scenario === 'rekeyed') assert.equal(rekeyAmaCloserLease({ rootDir, ...identity,
    fromHeadSha: identity.headSha, toHeadSha: currentIdentity.headSha, now: intentEarly }).rekeyed, true);
  const before = readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, identity.headSha);
  assert.equal(await reconcileAmaCloserLeaseAsync({ rootDir, hqRoot: rootDir, ...identity, now: intentEarly,
    statusProbe: { ok: true, row: { launch_request_id: launchRequestId,
      ticket_ref: 'AMA-PR-42', status: 'succeeded' } },
    readMergedSignalImpl: async () => ({ ok: true }),
    cleanupScratchImpl: () => {
      assert.equal(readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, currentIdentity.headSha).status, 'succeeded');
    }, logger: { info() {}, warn() {} } }), true);
  const after = readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, currentIdentity.headSha);
  assert.equal(after.attempts.at(-1).reason, scenario === 'missing' ? 'terminal-merge-reconciliation' : 'hammer-merge-completed');
  if (scenario !== 'missing') assert.deepEqual(
    readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, identity.headSha), before);
});

test('confirmed merged controller closeout releases both leases and audits before scratch removal', async t => {
  const rootDir = root(t);
  const launchRequestId = 'lrq_synthetic_closeout';
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242, now: intentStarted });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: launchRequestId });
  const lane = acquireMergeLease({ rootDir, repo: identity.repo, base: 'main',
    holderPr: identity.prNumber, holderHead: identity.headSha, holderPid: process.pid,
    holderHost: hostname(), now: new Date().toISOString() });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    launchRequestId, state: 'dispatched', lastObservedStatus: 'running' }));
  let cleaned = 0;
  const input = { rootDir, hqRoot: rootDir, ...identity, now: intentEarly,
    statusProbe: { ok: true, row: { launch_request_id: launchRequestId,
      ticket_ref: 'AMA-PR-42', status: 'blocked_needs_decision' } },
    readPullRequestStateImpl: async () => ({ state: 'MERGED', headRefOid: identity.headSha }),
    cleanupScratchImpl: () => {
      assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'succeeded');
      assert.equal(existsSync(mergeLeaseFilePath(rootDir, lane.lease)), false);
      assert.equal(readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, identity.headSha).status, 'succeeded');
      assert.equal(readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, identity.headSha)
        .attempts.at(-1).reason, 'confirmed-merged-closeout');
      cleaned++;
    },
    logger: { info() {}, warn() {} },
  };
  assert.equal(await reconcileAmaCloserLeaseAsync(input), true);
  assert.equal(cleaned, 1);
  assert.equal(await reconcileAmaCloserLeaseAsync(input), false, 'idempotent without a PR-bound dispatch or decision');
});

test('merged closeout rereads custody after the live PR query', async t => {
  const rootDir = root(t);
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 424242, now: intentStarted });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_old' });
  const lane = acquireMergeLease({ rootDir, repo: identity.repo, base: 'main',
    holderPr: identity.prNumber, holderHead: identity.headSha, holderPid: process.pid,
    now: new Date().toISOString() });
  const result = await reconcileAmaCloserLeaseAsync({ rootDir, ...identity,
    statusProbe: { ok: true, row: { status: 'blocked_needs_decision' } },
    readPullRequestStateImpl: async () => {
      updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_successor' });
      return { state: 'MERGED' };
    }, cleanupScratchImpl: () => assert.fail('successor retains scratch') });
  assert.equal(result, false);
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'lrq_successor');
  assert.equal(existsSync(mergeLeaseFilePath(rootDir, lane.lease)), true);
});
