import test from 'node:test';
import assert from 'node:assert/strict';
import {readWorkerObservation} from '../src/dispatch-read-client.mjs';
import {readBuildCompletionSignalForPr,readBuildCompletionSignalForPrAsync,
  readBuildCompletionProducerEvidence,readBuildCompletionProducerEvidenceAsync,readActiveDagRunsForPlan,readActiveDagRunsForPlanAsync,
  readExecutionVerdictsFromLedgerAsync} from '../src/session-ledger-read-adapter.mjs';

const page = (observation,items,more={}) => ({schema_version:1,observation,
  status:items.length?'found':'not_found',complete:true,next_offset:null,
  scope_complete:false,mutation_authority:false,items,...more});

test('production consumers link with the retained ledger compatibility exports', async()=>{
  for (const path of ['../src/watcher.mjs', '../src/follow-up-merge-agent.mjs',
    '../src/merge-agent-original-worker.mjs', '../src/reviewer-pass-tokens.mjs',
    '../scripts/backfill-reviewer-passes.mjs']) {
    await import(path);
  }
});

test('empty producer evidence preserves an absent PR number in sync and async results', async()=>{
  const args={repo:'example/repo',
    workerObservationSyncImpl:()=>page('completions',[]),
    dispatchSession:{dispatchLookup:async()=>page('completions',[])}};
  for (const result of [readBuildCompletionProducerEvidence(args),
    await readBuildCompletionProducerEvidenceAsync(args)]) {
    assert.equal(result.reason,'missing-build-completion-producer-evidence');
    assert.equal(result.prNumber,undefined);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(result)),'prNumber'),false);
  }
  assert.equal(readBuildCompletionSignalForPr({...args,prNumber:'42'}).prNumber,42);
  assert.equal((await readBuildCompletionSignalForPrAsync({...args,prNumber:'42'})).prNumber,42);
});

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


for (const [status, outcome, ok] of [
  ['found', 'allowed', true], ['not_live', 'not-live', true],
  ['scope_denied', 'scope-denied', false], ['unavailable', 'unavailable', false],
  ['unknown_future_outcome', 'unavailable', false],
]) {
  test(`DAG read maps producer ${status} explicitly in sync and async clients`, async () => {
    const reply = page('dag_runs', status === 'found' ? [{run_id:'synthetic-run',state:'running'}] : [], {status});
    const args = {planId:'synthetic-plan', workerObservationSyncImpl:() => reply,
      dispatchSession:{dispatchLookup:async () => reply}};
    const sync = readActiveDagRunsForPlan(args);
    assert.deepEqual(await readActiveDagRunsForPlanAsync(args), sync);
    assert.equal(sync.ok, ok);
    assert.equal(sync.outcome, outcome);
    assert.equal(sync.planId, 'synthetic-plan');
    if (status === 'found') assert.equal(sync.runs[0].run_id, 'synthetic-run');
    else if (ok) assert.deepEqual(sync.runs, []);
    else assert.equal(sync.runs, undefined);
  });
}

test('scope refusal and unavailable HTTP reads preserve safe, specific outcomes', async t => {
  for (const [code, outcome] of [['scope_denied','scope-denied'], ['service_unavailable','unavailable']]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({error:{code,message:'synthetic private detail'}}),
      {status:code === 'scope_denied' ? 403 : 503}));
    const result = await readActiveDagRunsForPlanAsync({planId:'synthetic-plan',
      env:{ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED:'1'},
      connectOptions:{session_token:'synthetic',endpoint_url:'https://synthetic.invalid/outcomes'}});
    assert.equal(result.outcome, outcome);
    assert.doesNotMatch(JSON.stringify(result), /private detail/);
    t.mock.restoreAll();
  }
});

test('not-live cannot override a partial page, foreign observation or a malformed envelope', async () => {
  for (const reply of [
    page('dag_runs', [{run_id:'run'}], {status:'not_live'}),
    page('dag_runs', [], {status:'not_live',mutation_authority:true}),
    page('completions', [], {status:'not_live'}),
    page('dag_runs', [], {status:'not_live',complete:false,next_offset:1}),
  ]) {
    assert.equal((await readActiveDagRunsForPlanAsync({planId:'synthetic-plan',
      dispatchSession:{dispatchLookup:async () => reply}})).outcome, 'unavailable');
  }
});
