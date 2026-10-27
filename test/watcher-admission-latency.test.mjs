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
const page = (observation,items=[]) => ({schema_version:1,observation,status:items.length?'found':'not_found',
  complete:true,next_offset:null,scope_complete:false,mutation_authority:false,items});
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
        signalKind:'merged',timeoutMs:200000,
        dispatchSession:{dispatchLookup:selector=>new Promise(resolve=>setTimeout(()=>resolve(page(selector.observation,[{completion_id:'completion'}])),180000))},
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

test('WATCHERLAG-01: independent candidate preflight completes while a public observation is slow',async()=>{
  let complete=false;
  const dispatchSession={dispatchLookup:selector=>new Promise(resolve=>setTimeout(()=>resolve(
    page(selector.observation,[{completion_id:'completion'}])),250))};
  const pending=ledger.readBuildCompletionSignalForPrAsync({repo:'example/repo',prNumber:1,dispatchSession})
    .then(result=>{complete=true;return result;});
  const preflight=createReviewerPreflight();
  const result=await Promise.all(['dedup','freshness','ci','hcp'].map(name=>preflight.read(name,
    ()=>new Promise(resolve=>setTimeout(()=>resolve(name),10)))));
  assert.equal(complete,false);
  assert.deepEqual(result,['dedup','freshness','ci','hcp']);
  assert.equal((await pending).ok,true);
  const timeout=await ledger.readBuildCompletionSignalForPrAsync({repo:'example/repo',prNumber:1,
    timeoutMs:10,dispatchSession:{dispatchLookup:()=>new Promise(resolve=>setTimeout(()=>resolve(page('completions')),30))}});
  assert.equal(timeout.ok,false);assert.equal(timeout.transient,true);
});

test('WATCHERLAG-01: sync and asynchronous public observation readers preserve selectors and failure results',async()=>{
  const cases=[['readBuildCompletionSignalForPr',{repo:'example/repo',prNumber:1}],
    ['readBuildCompletionProducerEvidence',{repo:'example/repo'}],['readActiveDagRunsForPlan',{planId:'plan'}]];
  for(const [name,args] of cases) {
    const calls=[];
    const reply=selector=>{calls.push(selector);return page(selector.observation,
      selector.observation==='dag_runs' ? [{run_id:'run',state:'parked'}] : [{completion_id:'completion'}]);};
    const sync=ledger[name]({...args,workerObservationSyncImpl:reply});
    const asyncResult=await ledger[name+'Async']({...args,dispatchSession:{dispatchLookup:async selector=>reply(selector)}});
    assert.deepEqual(asyncResult,sync);assert.deepEqual(calls[0],calls[1]);
    const unavailable=await ledger[name+'Async']({...args,dispatchSession:{dispatchLookup:async()=>{throw Error('offline');}},
      spawnSyncImpl:()=>assert.fail('no SQL fallback')});
    assert.equal(unavailable.ok,false);
  }
});

test('WATCHERLAG-01: pending public provenance read yields to admission and failure permits title review intake', async () => {
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  let calls=0, complete=false;
  const lookup=ledger.readPrBuilderProvenanceAsync({repo:'example/review-fixture',prNumber:1,
    dispatchSession:{dispatchLookup:async()=>{calls++;await pending;throw new Error('synthetic outage');}},
  }).then(result=>{complete=true;return result;});
  await flush();assert.equal(calls,1);assert.equal(complete,false);
  release();
  const result = await lookup;
  assert.equal(result.ok,false);
  assert.equal(result.reason,'dispatch-read-unavailable');
  assert.equal(result.deferClaim,false);
  assert.equal(result.launchRequestId,undefined);
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
