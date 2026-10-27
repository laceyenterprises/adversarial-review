import test from 'node:test';
import assert from 'node:assert/strict';
import {readDaemonBuildIdentity, resolveDaemonWorkerIdentityForPr} from '../src/daemon-worker-identity.mjs';
import {dispatchReadTransport} from '../src/dispatch-read-client.mjs';
import {isTransientDaemonDecline} from '../src/ama/daemon-decline.mjs';

const page = items => ({schema_version:1,observation:'provenance',status:items.length?'found':'not_found',
  complete:true,next_offset:null,scope_complete:false,mutation_authority:false,items});
const opener = {launch_request_id:'launch',worker_class:'worker',head_sha:'current',
  repo:'example/repo',pr_number:42};
const identityArgs = {repo:'example/repo',prNumber:42,currentHeadSha:'current',env:{},
  consumeHeadAttestations:false};
const noSleepRead = args => readDaemonBuildIdentity(args, {sleepImpl:async()=>{}});

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

for (const body of ['', '<html>busy</html>', JSON.stringify({error:{code:'dispatch_read_unavailable',message:'busy'}})]) {
  test('one packaged SDK 503 resolves opener in the same pass', async t => {
    let calls = 0;
    const budgets = [];
    const sdk = dispatchReadTransport.sdk();
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://example.invalid/v1/dispatch/lookup');
      const selector = JSON.parse(options.body);
      assert.equal(selector.observation, 'provenance');
      assert.equal(selector.head_sha, 'current');
      assert.equal(selector.builder_identity, undefined);
      calls++;
      return calls === 1 ? new Response(body, {status:503}) : Response.json(page([opener]));
    });
    t.mock.method(dispatchReadTransport, 'sdk', () => ({...sdk,
      readSessionDispatchLookup: (selector, options) => {
        budgets.push(options.request_timeout_ms);
        return sdk.readSessionDispatchLookup(selector, options);
      },
    }));
    const result = await resolveDaemonWorkerIdentityForPr({...identityArgs,
      env:{ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED:'1'},
      readBuildCompletionSignalForPrImpl: args => noSleepRead({...args,
        connectOptions:{session_token:'synthetic',endpoint_url:'https://example.invalid'}})});
    assert.equal(result.ok, true);
    assert.equal(result.resolvedBy, 'current-head');
    assert.equal(result.launchRequestId, 'launch');
    assert.equal(calls, 2);
    assert.ok(budgets.every(budget => budget > 0 && budget <= 2667));
  });
}

for (const failure of [
  Object.assign(new Error('synthetic 503'), {status:503}),
  new Error('app-contract dispatch_read_unavailable: synthetic outage'),
  Object.assign(new Error('synthetic timeout'), {code:'ETIMEDOUT'}),
  {}, // Unavailable observation envelope, never authoritative absence.
]) test('persistent transient identity read is bounded and retains a retryable decline detail', async () => {
  let calls = 0, healthy = false;
  const args = {...identityArgs, readBuildCompletionSignalForPrImpl:noSleepRead,
    dispatchSession:{dispatchLookup:async () => {
      calls++;
      if (healthy) return page([opener]);
      if (failure instanceof Error) throw failure;
      return failure;
    }}};
  const result = await resolveDaemonWorkerIdentityForPr(args);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'identity-read-transient');
  assert.equal(calls, 3, 'no fresh retry budget through head-independent or branch lookup');
  assert.equal(isTransientDaemonDecline({reason:'worker-identity-unresolved',reasons:[result.reason]}), true);
  healthy = true;
  assert.equal((await resolveDaemonWorkerIdentityForPr(args)).ok, true);
  assert.equal(calls, 4, 'a new pass resolves the same unchanged head');
});

test('a transient head-independent read supersedes the strict selector absence', async () => {
  const selectors = [];
  const result = await resolveDaemonWorkerIdentityForPr({...identityArgs,
    readBuildCompletionSignalForPrImpl:noSleepRead,
    dispatchSession:{dispatchLookup:async selector => {
      selectors.push(selector);
      if (selector.head_sha) return page([]);
      throw Object.assign(new Error('synthetic outage'), {status:503});
    }}});
  assert.equal(result.reason, 'identity-read-transient');
  assert.equal(selectors.length, 4);
  assert.equal(selectors.filter(selector => selector.head_sha).length, 1);
});

for (const rows of [[], [opener, {...opener,launch_request_id:'another-launch'}]]) {
  test('genuinely absent or ambiguous opener remains a permanent fail-closed park', async () => {
    let calls = 0;
    const result = await resolveDaemonWorkerIdentityForPr({...identityArgs,
      dispatchSession:{dispatchLookup:async () => { calls++; return page(rows); }}});
    assert.equal(result.ok, false);
    assert.equal(result.reason, rows.length ? 'unconfirmed-pr-opener-provenance' : 'worker-observation-inconclusive');
    assert.equal(calls, 2, 'only strict and head-independent selectors, without transport retries');
    assert.equal(isTransientDaemonDecline({reason:'worker-identity-unresolved',reasons:[result.reason]}), false);
  });
}

test('disabled observations and scope denial are never retried or classified transient', async () => {
  for (const extra of [{}, {dispatchSession:{dispatchLookup:async () => {
    throw Object.assign(new Error('synthetic denied'), {status:403});
  }}}]) {
    let calls = 0;
    const result = await readDaemonBuildIdentity({repo:'example/repo',prNumber:42,env:{},...extra}, {
      sleepImpl:async () => { calls++; },
    });
    assert.equal(result.ok, false);
    assert.notEqual(result.reason, 'identity-read-transient');
    assert.equal(calls, 0);
  }
});

test('identity retry attempts and backoff share one deadline with decreasing remaining time', async () => {
  let clock = 0;
  const budgets = [], delays = [];
  const result = await readDaemonBuildIdentity({repo:'example/repo',prNumber:42,timeoutMs:1000}, {
    nowMs:() => clock,
    sleepImpl:async ms => { delays.push(ms); clock += ms; },
    readWorkerObservationImpl:async (_selector, args) => {
      budgets.push(args.timeoutMs);
      clock += args.timeoutMs;
      return {ok:false,reason:'dispatch-read-unavailable',transient:true};
    },
  });
  assert.equal(result.reason, 'identity-read-transient');
  assert.deepEqual(budgets, [334,334,32]);
  assert.deepEqual(delays, [100,200]);
  assert.equal(clock, 1000);
});

test('a timed-out first observation leaves budget for a successful identity retry', {timeout:2000}, async () => {
  let calls = 0;
  const result = await readDaemonBuildIdentity({repo:'example/repo',prNumber:42,timeoutMs:600,
    dispatchSession:{dispatchLookup:() => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(page([opener]))}},
  {sleepImpl:async()=>{}});
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});
