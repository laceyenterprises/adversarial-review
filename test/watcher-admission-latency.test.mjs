import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewerAdmissionQueue } from '../src/watcher-reviewer-admission.mjs';
import { createReviewerDispatchDrain } from '../src/watcher-reviewer-dispatch.mjs';
import { createDetachedReviewerDispatchTracker } from '../src/watcher-reviewer-pool.mjs';
import { createReviewerPreflight } from '../src/reviewer-admission-lifecycle.mjs';
import { runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';
import { createWatcherLatencyMonitor } from '../src/watcher-latency.mjs';
import * as ledger from '../src/session-ledger-read-adapter.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const target = { backend: 'postgres', dsn: 'postgres://ledger.example/synthetic_ledger' };
const ok = { status: 0, stdout: '{}\n', stderr: '' };
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };

test('WATCHERLAG-01: capacity-freed admission starts within 60s while concurrent posted handlers stall for 180s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(0);
  const starts = [], logs = [];
  let handlersStarted = 0, handlersFinished = 0;
  const scheduled = [];
  const admission = createReviewerAdmissionQueue({ schedule: fn => scheduled.push(fn), logger: { ...quiet, log: line => logs.push(line) } });
  const tracker = createDetachedReviewerDispatchTracker({ onCapacityFreed: admission.capacityFreed, logger: quiet });
  admission.setDrain(createReviewerDispatchDrain({
    reviewerPoolConfig: { enabled: true, maxConcurrent: 1 }, reviewerDispatchCandidates: admission.candidates,
    detachedReviewerDispatchTracker: tracker, readWatcherDrainState: () => ({ active: false }),
    resolveGeminiCredentialConcurrencyForDispatchCandidates: async () => 1,
    prepareSpillover: async candidates => candidates, singleWaveSettleGraceMs: 0,
    splitPostReviewSettlement: true, logger: quiet,
  }));
  admission.enqueue({ repoPath: 'example/review-fixture', prNumber: 1, reviewerModel: 'claude',
    subject: { headSha: 'a'.repeat(40) },
    async run() { this.markAdmissionStarted(); starts.push(Date.now()); },
  });
  const posted = Promise.all([1, 2].map(prNumber => runPostedReviewHandlersFairly({
    handlers: [{ repoPath: 'example/closure-fixture', prNumber, async run() {
      handlersStarted++;
      await ledger.readBuildCompletionSignalForPrAsync({ repo: 'example/closure-fixture', prNumber,
        signalKind: 'merged', ledgerTarget: target, env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
        spawnAsyncImpl: () => new Promise(resolve => setTimeout(() => resolve(ok), 180_000)),
        spawnSyncImpl: () => { t.mock.timers.tick(180_000); return ok; },
      });
      handlersFinished++;
    } }], budgetMs: 240_000, handlerTimeoutMs: 200_000, minimumHandlerStartBudgetMs: 0,
    logger: quiet,
  })));
  await flush();
  assert.equal(handlersStarted, 2);
  admission.capacityFreed();
  for (const fn of scheduled.splice(0)) fn();
  await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(starts.length, 1);
  assert.ok(starts[0] < 60_000);
  assert.equal(handlersFinished, 0);
  assert.match(logs.join('\n'), /idle_ms=0/);
  t.mock.timers.tick(180_000); await flush();
  await posted;
  assert.equal(handlersFinished, 2);
});

test('WATCHERLAG-01: independent candidate preflight completes while an unrelated real child is slow', async t => {
  const root = mkdtempSync(join(tmpdir(), 'admission-child-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'psql'), '#!/bin/sh\nexec "$SYNTHETIC_NODE" -e \'setTimeout(() => process.stdout.write("{}\\n"), 250)\'\n', { mode: 0o755 });
  const previousPath = process.env.PATH, previousNode = process.env.SYNTHETIC_NODE;
  process.env.PATH = root; process.env.SYNTHETIC_NODE = process.execPath;
  t.after(() => { process.env.PATH = previousPath; if (previousNode === undefined) delete process.env.SYNTHETIC_NODE; else process.env.SYNTHETIC_NODE = previousNode; });
  const monitor = createWatcherLatencyMonitor({ logger: quiet });
  t.after(() => monitor.stop());
  let childFinished = false;
  const unrelated = ledger.readBuildCompletionSignalForPrAsync({ repo: 'example/closure-fixture', prNumber: 1,
    signalKind: 'merged', ledgerTarget: target,
    env: { PATH: root, SYNTHETIC_NODE: process.execPath, AGENT_OS_CONFIG_PATH: '/dev/null' },
  }).then(result => { childFinished = true; return result; });
  const preflight = createReviewerPreflight();
  const results = await Promise.all(['dedup', 'freshness', 'ci', 'hcp'].map(name => preflight.read(name,
    () => new Promise(resolve => setTimeout(() => resolve(name), 10)))));
  assert.equal(childFinished, false, 'preflight must not serialize behind unrelated psql');
  assert.deepEqual(results, ['dedup', 'freshness', 'ci', 'hcp']);
  assert.equal((await unrelated).ok, true);
  const measured = monitor.summary().children.psql;
  assert.equal(measured.count, 1); assert.equal(measured.completed, 1);
  assert.ok(measured.spawn.p99_ms > 0); assert.ok(measured.wall.p99_ms >= 250);
  const timedOut = await ledger.readBuildCompletionSignalForPrAsync({ repo: 'example/closure-fixture', prNumber: 1,
    signalKind: 'merged', ledgerTarget: target, timeoutMs: 30,
    env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
  });
  assert.equal(timedOut.ok, false); assert.equal(timedOut.transient, true);
  assert.match(timedOut.detail, /timed out after 30ms/);
  process.env.PATH = join(root, 'missing-bin');
  const missing = await ledger.readBuildCompletionSignalForPrAsync({ repo: 'example/closure-fixture', prNumber: 1,
    signalKind: 'merged', ledgerTarget: target, env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
  });
  assert.equal(missing.reason, 'psql-not-installed');
});

test('WATCHERLAG-01: asynchronous ledger readers preserve sync fixtures, executor precedence, SQL, selectors, and failure results', async t => {
  // A broken fixture seam must fail offline rather than query a host ledger.
  const root = mkdtempSync(join(tmpdir(), 'ledger-fixture-path-'));
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  const monitor = createWatcherLatencyMonitor({ logger: quiet });
  t.after(() => monitor.stop());
  const cases = [
    ['readBuildCompletionSignalForPr', { repo: 'example/review-fixture', prNumber: 1, signalKind: 'merged' }],
    ['readBuildCompletionProducerEvidence', { repo: 'example/review-fixture', signalKind: 'merged' }],
    ['readActiveDagRunsForPlan', { planId: 'synthetic-plan' }],
  ];
  for (const [name, selectors] of cases) {
    for (const result of [ok, { status: 1, stderr: 'permanent synthetic failure', stdout: '' }, { error: { code: 'ENOENT' } }]) {
      const calls = [];
      const exec = (...args) => { calls.push(args); return result; };
      const args = { ...selectors, ledgerTarget: target, env: { AGENT_OS_CONFIG_PATH: '/dev/null' } };
      const sync = ledger[name]({ ...args, spawnSyncImpl: exec });
      monitor.summary(); // Discard telemetry from the synchronous reference reader.
      const asyncResult = await ledger[`${name}Async`]({ ...args, spawnAsyncImpl: exec });
      assert.deepEqual(asyncResult, sync, name);
      assert.deepEqual(calls[0], calls[1], name);
      const syncFixtureResult = await ledger[`${name}Async`]({ ...args, spawnSyncImpl: exec });
      assert.equal(calls.length, 3, `${name}: sync fixture must be invoked`);
      assert.deepEqual(syncFixtureResult, sync, name);
      assert.deepEqual(calls[0], calls[2], name);
      const bothResult = await ledger[`${name}Async`]({ ...args, spawnAsyncImpl: exec,
        spawnSyncImpl: () => assert.fail(`${name}: async executor must take precedence`),
      });
      assert.equal(calls.length, 4, `${name}: async executor must be invoked`);
      assert.deepEqual(bothResult, sync, name);
      assert.deepEqual(calls[0], calls[3], name);
    }
  }
  assert.equal(monitor.summary().children.psql?.count ?? 0, 0, 'fixtures must not start real async children');
});

test('WATCHERLAG-01: pending public provenance read yields to admission and failure retains the claim', async () => {
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  let calls=0, complete=false;
  const lookup=ledger.readPrBuilderProvenanceAsync({repo:'example/review-fixture',prNumber:1,
    dispatchSession:{dispatchLookup:async()=>{calls++;await pending;throw new Error('synthetic outage');}},
  }).then(result=>{complete=true;return result;});
  await flush();assert.equal(calls,1);assert.equal(complete,false);
  release();
  assert.equal((await lookup).deferClaim,true);
});

for (const evidence of ['merged', 'unreadable', 'replacement-owner', 'replacement-status-owner']) {
  test(`WATCHERLAG-01: async closure retains lease authority across ${evidence} evidence`, async t => {
    const { reconcileAmaCloserLeaseAsync, updateAmaCloserDispatchRecord } = await import('../src/ama/dispatch-closer.mjs');
    const { acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease } = await import('../src/ama/closer-lease.mjs');
    const rootDir = mkdtempSync(join(tmpdir(), 'admission-closure-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'example/closure-fixture', prNumber: 1, headSha: 'a'.repeat(40) };
    const now = '2026-10-01T00:00:00Z';
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_synthetic', now });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched', launchRequestId: 'lrq_synthetic' }));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let queried = false;
    const lookup = reconcileAmaCloserLeaseAsync({ rootDir, hqRoot: rootDir, ...identity, now, logger: quiet,
      readLaunchRequestStatusImpl: async () => {
        if (evidence === 'replacement-status-owner') { queried = true; await gate; }
        return { ok: true, row: { status: 'succeeded', ...(evidence === 'replacement-status-owner' ? { ticket_ref: 'SYNTHETIC-OTHER' } : {}) } };
      },
      readBuildCompletionSignalForPrImpl: async () => {
        queried = true; await gate;
        return evidence === 'unreadable' ? { ok: false, reason: 'ledger-read-failed' }
          : { ok: true, row: { head_sha: identity.headSha } };
      },
      readPullRequestStateImpl: async () => null,
    });
    await flush(); assert.equal(queried, true);
    assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
    if (evidence.startsWith('replacement')) updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_replacement', now });
    release();
    assert.equal(await lookup, evidence === 'merged');
    const lease = readAmaCloserLease(rootDir, identity);
    if (evidence === 'merged') assert.equal(lease.terminalOutcome, 'succeeded');
    else assert.equal(lease.status, 'dispatched');
    if (evidence.startsWith('replacement')) assert.equal(lease.lrqId, 'lrq_replacement');
  });
}
