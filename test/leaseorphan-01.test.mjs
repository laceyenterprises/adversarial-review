import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseHolderLiveness } from '../src/ama/dispatch-submitter.mjs';
import { acquireMergeLease, inspectMergeLease, mergeLeaseFilePath, readMergeLeaseHistory } from '../src/ama/merge-lease.mjs';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { reconcileAmaCloserLeaseIntent } from '../src/ama/pre-receipt-intent.mjs';
import { reconcileAmaCloserLeaseAsync, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { seedCloserIntent, intentEarly, intentStarted } from './helpers/closer-intent-fixture.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-record-read.mjs';
import { createStaleStateReaperTicker } from '../src/recovery-reaper.mjs';

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

for (const reused of [false, true]) test(`merge lease observation reclaims ${reused ? 'reused PID' : 'dead holder'} immediately`, t => {
  const rootDir = root(t);
  const held = acquireMergeLease({ rootDir, repo: identity.repo, base: 'main',
    holderPr: 42, holderHead: identity.headSha, holderPid: 424242,
    holderHost: hostname(), now: intentStarted });
  writeFileSync(held.leasePath, JSON.stringify({ ...held.lease, holderStartedAt: intentStarted }));
  const seen = inspectMergeLease({ rootDir, repo: identity.repo, base: 'main', now: intentEarly,
    pidAliveFn: () => reused, captureProcessImpl: () => ({ startedAt: intentEarly }) });
  assert.equal(seen.exists, false);
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

test('the next watcher tick reclaims dead holders without waiting for the age sweep', async t => {
  const rootDir = root(t);
  // More than the age sweep's 50-read budget; terminal history cannot hide a
  // fresh dead owner until a later rotation.
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
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'abandoned-holder-dead');
  assert.equal(existsSync(mergeLeaseFilePath(rootDir, { repo: identity.repo, base: 'main' })), false);
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
