import test from 'node:test';
import assert from 'node:assert/strict';
import {readWorkerObservation} from '../src/dispatch-read-client.mjs';
import {readBuildCompletionSignalForPr,readBuildCompletionSignalForPrAsync,
  readBuildCompletionProducerEvidenceAsync,readActiveDagRunsForPlanAsync,
  readExecutionVerdictsFromLedgerAsync} from '../src/session-ledger-read-adapter.mjs';

const page = (observation,items,more={}) => ({schema_version:1,observation,
  status:items.length?'found':'not_found',complete:true,next_offset:null,
  scope_complete:false,mutation_authority:false,items,...more});

test('completion repo/PR/head/signal selectors use SDK, retaining all companion receipts',async()=>{
  const calls=[];
  const args={repo:'example/repo',prNumber:1,headSha:'head',signalKind:'merged',
    dispatchSession:{dispatchLookup:async selector=>{
      calls.push(selector);
      return page('completions',[{completion_id:'completion',repo:'example/repo',pr_number:1,head_sha:'head',signal_kind:'merged'}]);
    }}};
  const result=await readBuildCompletionSignalForPrAsync(args);
  assert.equal(result.row.completion_id,'completion');
  assert.equal(calls[0].repo,'example/repo');
  assert.equal(calls[0].pr_number,1);
  assert.equal(calls[0].head_sha,'head');
  assert.equal(calls[0].signal_kind,'merged');
  await readBuildCompletionProducerEvidenceAsync(args);
  assert.equal(calls[1].pr_number,undefined);
  const sync=readBuildCompletionSignalForPr({...args,workerObservationSyncImpl:()=>page('completions',[result.row])});
  assert.equal(sync.row.completion_id,'completion');
});

test('completion capture failure after remote acceptance remains missing; an opened PR is no merge',async()=>{
  let remoteMerges=0;
  const remoteAccept=()=>{remoteMerges++;return {state:'MERGED'};};
  const remote=remoteAccept();
  const result=await readBuildCompletionSignalForPrAsync({repo:'example/repo',prNumber:1,
    dispatchSession:{dispatchLookup:async()=>page('completions',[])}});
  assert.equal(result.ok,false);
  assert.equal(result.reason,'missing-build-completion-signal');
  assert.equal(remote.state,'MERGED');
  assert.equal(remoteMerges,1);
});

test('partial multi-repository pages are collected and later failure discards early evidence',async()=>{
  const selectors=[];
  const args={repo:'example/repo',prNumber:1,dispatchSession:{dispatchLookup:async selector=>{
    selectors.push(selector);
    return selector.offset===0 ? page('completions',[{completion_id:'first'}],{complete:false,next_offset:1})
      : page('completions',[{completion_id:'companion'}]);
  }}};
  const result=await readWorkerObservation({observation:'completions',launch_request_id:'launch',limit:100},args);
  assert.deepEqual(result.rows.map(r=>r.completion_id),['first','companion']);
  assert.deepEqual(selectors.map(s=>s.offset),[0,1]);
  args.dispatchSession.dispatchLookup=async selector=>selector.offset===0
    ? page('completions',[{completion_id:'first'}],{complete:false,next_offset:1}) : Promise.reject(Error('offline'));
  const incomplete=await readWorkerObservation({observation:'completions',launch_request_id:'launch',limit:100},args);
  assert.equal(incomplete.ok,false);
  assert.equal(incomplete.rows,undefined);
});

test('DAG liveness and execution verdict reads preserve public producer semantics',async()=>{
  const args={planId:'example-plan',dispatchSession:{dispatchLookup:async selector=>
    page(selector.observation,selector.observation==='dag_runs' ? [{run_id:'run',state:'parked'}]
      : [{verdictId:'verdict',launchRequestId:'launch',verdict:'no_work',schemaVersion:1}])}};
  assert.equal((await readActiveDagRunsForPlanAsync(args)).runs[0].state,'parked');
  assert.equal((await readExecutionVerdictsFromLedgerAsync(args)).verdicts[0].verdict,'no_work');
});

test('outages ignore every obsolete credential/path/child seam and retain unavailable evidence',async()=>{
  for(const read of [readBuildCompletionSignalForPrAsync,readBuildCompletionProducerEvidenceAsync,
    readActiveDagRunsForPlanAsync,readExecutionVerdictsFromLedgerAsync]) {
    const result=await read({repo:'example/repo',prNumber:1,planId:'plan',
      ledgerTarget:{backend:'sqlite',path:'/unused'},env:{AGENT_OS_SESSION_LEDGER_DSN:'postgres://unused.invalid/db'},
      spawnSyncImpl:()=>assert.fail('database transport is forbidden'),
      dispatchSession:{dispatchLookup:async()=>{throw Error('offline');}}});
    assert.equal(result.ok,false);
    assert.equal(result.rows,undefined);
  }
});

test('latest receipt consumes one valid page without requiring the entire repository inventory',async()=>{
  let calls=0;
  const result=await readBuildCompletionProducerEvidenceAsync({repo:'example/repo',dispatchSession:{dispatchLookup:async selector=>{
    calls++;assert.equal(selector.limit,1);
    return page('completions',[{completion_id:'latest'}],{complete:false,next_offset:1});
  }}});
  assert.equal(result.ok,true);assert.equal(result.row.completion_id,'latest');
  assert.equal(result.complete,false);assert.equal(calls,1);
});
