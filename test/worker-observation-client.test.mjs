import test from 'node:test';
import assert from 'node:assert/strict';
import {readLatestWorkerRunStatusFromLedger, readLatestWorkerRunStatusFromLedgerAsync,
  readWorkerRunUsageFromLedger, readReviewerSessionUsageFromLedger} from '../src/session-ledger-read-adapter.mjs';
import {resolveDaemonWorkerIdentityForPr} from '../src/daemon-worker-identity.mjs';
import {readWorkerRunTokenUsage, readReviewerSessionTokenUsage} from '../src/reviewer-pass-tokens.mjs';
import {readWorkerObservation, readWorkerObservationSync} from '../src/dispatch-read-client.mjs';

const page = (observation, items, rest={}) => ({schema_version:1,observation,
  status:items.length?'found':'not_found',complete:true,next_offset:null,
  mutation_authority:false,scope_complete:false,items,...rest});
const worker = {run_id:'run', launch_request_id:'launch',session_id:'session',status:'running',
  token_usage_input:0,token_usage_output:null,token_usage_guardrail:null,token_usage_cost_usd:0,
  total_cache_read_tokens:0,total_cache_write_tokens:null,pid:123,liveness:'unknown',
  process:{worker_process_id:'process-new',pid:123,started_at:'2026-01-02T00:00:00Z'}};

test('session windows explicitly handle absent timestamps and inclusive overlap', t => {
  const parse = Date.parse;
  t.mock.method(Date, 'parse', value => {
    assert.equal(typeof value, 'string');
    assert.notEqual(value.trim(), '');
    return parse(value);
  });
  const start = '2026-01-02T00:00:00Z', end = '2026-01-03T00:00:00Z';
  const read = (row, bounds) => readReviewerSessionUsageFromLedger({
    adapterSessionKey:'key', ...bounds,
    workerObservationSyncImpl:()=>page('sessions',[{session_id:'session',...row}]),
  }).ok;
  for (const absent of [null, '', '   ']) {
    const row = {started_at:absent, ended_at:absent};
    assert.equal(read(row, {}), true);
    assert.equal(read(row, {endedAt:end}), true);
    assert.equal(read(row, {startedAt:start}), false);
    assert.equal(read(row, {startedAt:start,endedAt:end}), false);
    assert.equal(read({started_at:absent,ended_at:start},{startedAt:start,endedAt:end}),true);
    assert.equal(read({started_at:start,ended_at:absent},{startedAt:start,endedAt:end}),true);
  }
  assert.equal(read({started_at:end,ended_at:end},{startedAt:start,endedAt:end}),true);
  assert.equal(read({started_at:'2026-01-04T00:00:00Z'},{endedAt:end}),false);
  assert.equal(read({started_at:'2026-01-01T00:00:00Z'},{startedAt:start}),false);
  assert.equal(read({started_at:'invalid',ended_at:'invalid'},{startedAt:start,endedAt:end}),false);
});

test('async observations use the packaged SDK session and HTTP lookup without an injected dispatch session', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({url,body});
    if (url === 'https://synthetic.invalid/observations/v1/register') {
      return new Response(JSON.stringify({session_token:'synthetic-session'}));
    }
    assert.equal(url, 'https://synthetic.invalid/observations/v1/dispatch/lookup');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-session');
    assert.equal(body.offset, 0);
    return new Response(JSON.stringify(page(body.observation, [{
      workers:worker, sessions:{session_id:'session'}, provenance:{launch_request_id:'launch'},
    }[body.observation]])));
  });
  for (const observation of ['workers','sessions','provenance']) {
    const result = await readWorkerObservation({observation,limit:100}, {
      env:{ADVERSARIAL_DISPATCH_READS_ENABLED:'1'},
      connectOptions:{endpoint_url:'https://synthetic.invalid/observations',bootstrap_token:'synthetic-bootstrap'},
    });
    assert.equal(result.ok,true);
  }
  assert.equal(calls[0].body.op,'register');
  assert.deepEqual(calls.slice(1).map(call=>call.body.observation),['workers','sessions','provenance']);
  assert.equal(calls.length,4);
});

test('provenance identity is launch-scoped across pages, matching the packaged SDK validator', async () => {
  const provenance = {launch_request_id:'launch',head_sha:'head',completion_id:'completion'};
  const otherHead = {...provenance,head_sha:'other',completion_id:'other'};
  const otherLaunch = {...provenance,launch_request_id:'other-launch'};
  for (const second of [otherHead,otherLaunch]) {
    for (const paginated of [false,true]) {
      const reply = selector => paginated
        ? selector.offset === 0 ? page('provenance',[provenance],{complete:false,next_offset:1})
          : page('provenance',[second])
        : page('provenance',[provenance,second]);
      const selector = {observation:'provenance',repo:'example/repo',limit:100};
      const sync = readWorkerObservationSync(selector,{workerObservationSyncImpl:reply});
      const asyncResult = await readWorkerObservation(selector,{dispatchSession:{dispatchLookup:async selector=>reply(selector)}});
      assert.equal(sync.ok,second === otherLaunch);
      assert.deepEqual(asyncResult,sync);
      if (sync.ok) assert.deepEqual(sync.rows,[provenance,otherLaunch]);
    }
  }
});

test('public worker observations keep PID reuse evidence, unknown liveness and zero/null accounting', async()=>{
  const args={launchRequestId:'launch',workerRunId:'run',env:{},
    ledgerTarget:{backend:'postgres',dsn:'must-never-be-opened'},
    spawnSyncImpl:()=>{throw new Error('private IO forbidden');},
    workerObservationSyncImpl: selector=>{
      assert.equal(selector.observation,'workers');
      assert.equal(selector.launch_request_id,'launch');
      return page('workers',[worker]);
    }};
  const evidence = readLatestWorkerRunStatusFromLedger(args);
  assert.equal(evidence.row.process.worker_process_id,'process-new');
  assert.equal(evidence.row.liveness,'unknown');
  assert.equal(evidence.target.backend,'app-contract');
  assert.equal(readWorkerRunUsageFromLedger(args).row.token_usage_output,null);
  const usage=readWorkerRunTokenUsage(args);
  assert.equal(usage.input,0); assert.equal(usage.output,null); assert.equal(usage.costUSD,0);
  const asyncEvidence=await readLatestWorkerRunStatusFromLedgerAsync({...args,
    dispatchSession:{dispatchLookup:async()=>page('workers',[worker])}});
  assert.deepEqual(asyncEvidence,evidence);
});

test('session observations retain zero cost, and no keys or unreadable ownership returns unavailable',()=>{
  const args={adapterSessionKey:'key',workerObservationSyncImpl:selector=>{
    assert.deepEqual(selector.session_keys,['key']);
    return page('sessions',[{session_id:'session',adapter_session_key:'key',total_input_tokens:0,
      total_output_tokens:null,total_cost_usd:0}]);
  }};
  assert.equal(readReviewerSessionTokenUsage(args).costUSD,0);
  assert.equal(readReviewerSessionUsageFromLedger({workspacePath:'/synthetic-private-path'}).ok,false);
  assert.equal(readReviewerSessionUsageFromLedger({...args,
    workerObservationSyncImpl:()=>page('sessions',[])}).ok,false);
});

test('partial pages are collected in producer order and failed or malformed pages never prove absence',async()=>{
  const calls=[];
  const dispatchSession={dispatchLookup:async selector=>{
    calls.push(selector.offset);
    return selector.offset===0 ? page('workers',[worker],{complete:false,next_offset:1})
      : page('workers',[{...worker,run_id:'older'}]);
  }};
  const result=await readLatestWorkerRunStatusFromLedgerAsync({launchRequestId:'launch',dispatchSession});
  assert.deepEqual(calls,[0,1]);
  assert.equal(result.rows.length,2); assert.equal(result.row.run_id,'run');
  for (const value of [page('workers',[]), {}, page('workers',[worker],{complete:false,next_offset:0}),
    page('workers',[worker],{mutation_authority:true})]) {
    assert.equal(readLatestWorkerRunStatusFromLedger({launchRequestId:'launch',
      workerObservationSyncImpl:()=>value}).ok,false);
  }
  const failed=await readLatestWorkerRunStatusFromLedgerAsync({launchRequestId:'launch',
    dispatchSession:{dispatchLookup:async selector=>{
      if(selector.offset) throw new Error('synthetic transport outage');
      return page('workers',[worker],{complete:false,next_offset:1});
    }}});
  assert.equal(failed.ok,false);
  assert.equal(readLatestWorkerRunStatusFromLedger({launchRequestId:'launch',env:{},
    ledgerDbPath:'/missing-synthetic',spawnSyncImpl:()=>{throw new Error('forbidden');}}).ok,false);
});

test('daemon branch identity reads public provenance and never scans worker files',async()=>{
  const result=await resolveDaemonWorkerIdentityForPr({repo:'example/review',prNumber:12,
    currentHeadSha:'current',currentBranch:'feature',hqRoot:'/unreadable-synthetic-root',env:{},
    readBuildCompletionSignalForPrImpl:async()=>({ok:false,reason:'missing-build-completion-signal'}),
    dispatchSession:{dispatchLookup:async selector=>{
      assert.equal(selector.observation,'provenance');
      assert.equal(selector.repo,'example/review');
      return page('provenance',[{launch_request_id:'launch',worker_class:'worker',repo:'example/review',
        branch:'feature',head_sha:'original',pr_number:12}]);
    }}});
  assert.equal(result.ok,true);
  assert.equal(result.launchRequestId,'launch');
  assert.equal(result.launchProvenanceSource,'app-sdk');
  assert.equal('launchProvenancePath' in result,false);
});

// Observation failures must enter the owner's existing teardown hold codes.
test('public read failures preserve teardown-safe worker lookup classification',async()=>{
  const {lookupOriginalWorkerRunStatus}=await import('../src/merge-agent-original-worker.mjs');
  for(const reason of ['dispatch-read-unavailable','worker-observation-unavailable']) {
    const result=await lookupOriginalWorkerRunStatus({workspace:{launchRequestId:'launch'},
      runRecord:{runId:'run'},readLatestWorkerRunStatusImpl:async()=>({ok:false,reason})});
    assert.equal(result.found,false);
    assert.equal(result.reason,'worker-run-lookup-failed');
  }
});
