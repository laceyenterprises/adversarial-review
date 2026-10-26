import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveDaemonWorkerIdentityForPr} from '../src/daemon-worker-identity.mjs';

const page = items => ({schema_version:1,observation:'provenance',status:items.length?'found':'not_found',
  complete:true,next_offset:null,scope_complete:false,mutation_authority:false,items});

test('daemon resolves build identity through SDK and preserves moved-head provenance',async()=>{
  const selectors=[];
  const result=await resolveDaemonWorkerIdentityForPr({repo:'example/repo',prNumber:42,
    currentHeadSha:'current',currentBranch:'feature',consumeHeadAttestations:false,
    env:{AGENT_OS_SESSION_LEDGER_DSN:'postgres://unavailable.invalid/ignored',
      AGENT_OS_CONFIG_PATH:'/unreadable-synthetic-config'},
    dispatchSession:{dispatchLookup:async selector=>{
      selectors.push(selector);
      return page(selector.head_sha ? [] : [{launch_request_id:'launch',worker_class:'worker',
        head_sha:'original',repo:'example/repo',pr_number:42}]);
    }}});
  assert.equal(result.ok,true);
  assert.equal(result.resolvedBy,'pr-opened-head-moved');
  assert.equal(result.headMovedAfterBuildCompletion,true);
  assert.equal(selectors.length,2);
  assert.equal(selectors[0].head_sha,'current');
  assert.equal(selectors[1].head_sha,undefined);
  assert.equal(selectors[0].pr_number,42);
});

test('daemon retains unresolved identity during SDK outage despite legacy config or worker roots',async()=>{
  const result=await resolveDaemonWorkerIdentityForPr({repo:'example/repo',prNumber:42,
    currentHeadSha:'current',currentBranch:'feature',env:{},hqRoot:'/synthetic-root',
    ledgerTarget:{backend:'sqlite',path:'/synthetic-ledger'},
    dispatchSession:{dispatchLookup:async()=>{throw new Error('synthetic endpoint outage');}}});
  assert.equal(result.ok,false);
  assert.equal(result.reason,'dispatch-read-unavailable');
  assert.equal(result.launchProvenanceReason,'dispatch-read-unavailable');
});
