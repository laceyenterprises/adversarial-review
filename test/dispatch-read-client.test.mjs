import test from 'node:test';
import assert from 'node:assert/strict';
import { readDispatchLaunches, readDispatchLaunchesSync } from '../src/dispatch-read-client.mjs';
import { readLaunchRequestStatusFromLedger, readLaunchRequestStatusFromLedgerAsync,
  readLaunchRequestSnapshotFromLedgerAsync, readLaunchRequestByIdempotencyKeyAsync,
  readLaunchRequestsForTicketSinceAsync } from '../src/session-ledger-read-adapter.mjs';
import { withLiveLaunchRetry, launchRequestOwned } from '../src/ama/launch-request-status.mjs';

// Synthetic wire examples. Real producer captures and backend scope checks
// live in the producer repository; malformed mutations below are negative cases.
function capture(status = 'running') {
  return { schema_version: 1, status: 'found', complete: true, roots: ['root'], items: [
    { launch_request_id: 'leaf', status, ticket_ref: 'T-1', failure_detail: 'synthetic detail', head_sha: 'head', target_repo: 'example/repo' },
    { launch_request_id: 'retry', status: 'failed' },
    { launch_request_id: 'root', status: 'superseded', ticket_ref: 'T-1' },
  ], retry_edges: [{parent:'root',child:'retry'}, {parent:'retry',child:'leaf'}, {parent:'leaf',child:'root'}] };
}
const absent = {schema_version:1, status:'not_found', complete:true, roots:[], items:[], retry_edges:[]};
const offline = () => assert.fail('SQL and OS file fallbacks are forbidden');
function options(value = capture()) {
  return { dispatchSession: { dispatchLookup: async () => value },
    dispatchLookupSyncImpl: () => value, spawnSyncImpl: offline,
    ledgerTarget: { backend: 'postgres', dsn: 'invalid' }, ledgerDbPath: '/nonexistent' };
}

test('sync and async readers preserve producer identity, failure detail and cycle-safe retry ordering', async () => {
  const args = { ...options(), launchRequestId: 'root', includeRetryChain: true };
  const sync = readLaunchRequestStatusFromLedger(args);
  assert.deepEqual(await readLaunchRequestStatusFromLedgerAsync(args), sync);
  assert.deepEqual(sync.retryChain.map(row=>row.launch_request_id), ['leaf', 'retry']);
  const live = withLiveLaunchRetry(sync);
  assert.equal(live.row.head_sha, 'head');
  assert.equal(live.row.target_repo, 'example/repo');
  assert.equal(live.row.failure_detail, 'synthetic detail');
  assert.equal(live.liveRetryLaunchRequestId, 'leaf');
});
for (const status of ['blocked_needs_decision', 'waiting_approval', 'waiting_input']) {
  test(`parked retry retains ownership without rearm authority (${status})`, async () => {
    const probe = await readLaunchRequestStatusFromLedgerAsync({...options(capture(status)), launchRequestId:'root', includeRetryChain:true});
    assert.equal(launchRequestOwned(probe), true);
  });
}
test('capacity snapshot shares one SDK read across every lease and excludes unrelated launches', async () => {
  let calls=0;
  const dispatchSession={dispatchLookup:async selector=>{ calls++; assert.deepEqual(selector.launch_request_ids,['root']); return capture(); }};
  const snapshot = await readLaunchRequestSnapshotFromLedgerAsync({launchRequestIds:['root'],dispatchSession});
  const probe = await readLaunchRequestStatusFromLedgerAsync({launchSnapshot:snapshot,launchRequestId:'root', includeRetryChain:true});
  assert.equal(probe.retryChain.length,2);
  assert.equal(calls,1);
  assert.equal((await readLaunchRequestStatusFromLedgerAsync({launchSnapshot:snapshot,launchRequestId:'unknown'})).reason,'missing-launch-request-row');
});
test('idempotency recovery and legacy intent windows use scoped SDK selectors; lost responses do not dispatch', async () => {
  const calls=[];
  const dispatchSession={dispatchLookup:async selector=>{ calls.push(selector); return capture(); }};
  for(let i=0;i<2;i++) assert.equal((await readLaunchRequestByIdempotencyKeyAsync({idempotencyKey:'key',dispatchSession})).rows.length,3);
  assert.deepEqual(calls,[{idempotency_key:'key'},{idempotency_key:'key'}]);
  await readLaunchRequestsForTicketSinceAsync({ticketRef:'T-1',requestedAtOrAfter:'2026-01-01T00:00:00Z',dispatchSession});
  assert.equal(calls[2].ticket_ref,'T-1');
});
test('missing and foreign launch identities share one absence result',async()=>{
  for(const launchRequestId of ['missing','foreign']) {
    const probe=await readLaunchRequestStatusFromLedgerAsync({...options(absent),launchRequestId});
    assert.equal(probe.reason,'missing-launch-request-row');
  }
});
for(const invalid of [null, {}, {...capture(),complete:false}, {...capture(),status:'unavailable'}]) {
  test('negative malformed/unavailable projection never proves absence or releases ownership',async()=>{
    const args=options(invalid);
    assert.equal((await readDispatchLaunches({idempotency_key:'key'},args)).ok,false);
    assert.equal(readDispatchLaunchesSync({idempotency_key:'key'},args).ok,false);
  });
}
test('endpoint outage remains unavailable and never consults a ledger fallback',async()=>{
  const args={...options(),dispatchSession:{dispatchLookup:async()=>{throw new Error('outage');}},dispatchLookupSyncImpl:()=>{throw new Error('outage');}};
  assert.equal((await readLaunchRequestStatusFromLedgerAsync({...args,launchRequestId:'root'})).reason,'dispatch-read-unavailable');
  assert.equal(readLaunchRequestStatusFromLedger({...args,launchRequestId:'root'}).reason,'dispatch-read-unavailable');
});

test('asynchronous SDK launch observations yield without starting a database child',async()=>{
  let resolve, progressed=false;
  const pending=readLaunchRequestStatusFromLedgerAsync({launchRequestId:'root',
    dispatchSession:{dispatchLookup:()=>new Promise(done=>{resolve=done;})},spawnSyncImpl:offline});
  await Promise.resolve();
  progressed=true;
  resolve(capture());
  assert.equal((await pending).ok,true);
  assert.equal(progressed,true);
});
