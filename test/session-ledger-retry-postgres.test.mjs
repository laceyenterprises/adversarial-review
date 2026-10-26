// Backend serialization, schema variants, identity claims and index use belong
// to the OS producer's disposable SQLite/Postgres tests. This client consumes
// an actual producer capture and has no database tools or OS source dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLaunchRequestStatusFromLedgerAsync, readLaunchRequestSnapshotFromLedgerAsync,
  readLaunchRequestByIdempotencyKeyAsync } from '../src/session-ledger-read-adapter.mjs';
import { withLiveLaunchRetry, launchRequestOwned } from '../src/ama/launch-request-status.mjs';
import { closerLaunchMatches } from '../src/ama/pre-receipt-intent.mjs';

const capture=JSON.parse(readFileSync(new URL('./fixtures/dispatch-lookup-v1.json',import.meta.url)));
function session(value=capture) { return {dispatchLookup:async()=>structuredClone(value)}; }

test('producer capture retains ordered retries, cycles, supersession and blocked-decision ownership',async()=>{
  const probe=await readLaunchRequestStatusFromLedgerAsync({launchRequestId:'root',includeRetryChain:true,dispatchSession:session()});
  assert.equal(probe.row.status,'superseded');
  assert.deepEqual(probe.retryChain.map(row=>row.launch_request_id),['leaf','retry']);
  assert.equal(withLiveLaunchRetry(probe).row.status,'blocked_needs_decision');
  assert.equal(launchRequestOwned(probe),true);
  assert.equal(probe.row.failure_detail,'synthetic detail');
});
test('one SDK capacity snapshot retains complete identity without per-launch transports',async()=>{
  let calls=0;
  const snapshot=await readLaunchRequestSnapshotFromLedgerAsync({launchRequestIds:['root'],dispatchSession:{dispatchLookup:async()=>{calls++;return capture;}}});
  const probe=await readLaunchRequestStatusFromLedgerAsync({launchSnapshot:snapshot,launchRequestId:'root',includeRetryChain:true});
  assert.equal(calls,1);
  assert.equal(probe.row.ticket_ref,'T-1');
  assert.equal(probe.row.head_sha,'head');
  assert.equal(probe.row.target_repo,'example/repo');
});
for(const mutation of [row=>({...row,identity_ambiguous:true}),row=>({...row,ticket_ref:'OTHER'}),row=>({...row,target_repo:'other/repo'}),row=>({...row,head_sha:'other'})]) {
  test('negative identity mutation never authorizes receipt recovery',async()=>{
    const value={...capture,items:[mutation(capture.items.find(row=>row.launch_request_id==='root'))],retry_edges:[]};
    const receipt=await readLaunchRequestByIdempotencyKeyAsync({idempotencyKey:'same-key',dispatchSession:session(value)});
    assert.equal(closerLaunchMatches({repo:'example/repo',prNumber:1,ticketRef:'T-1',headSha:'head'},receipt.rows[0]),false);
  });
}
test('endpoint failure never invokes psql or a SQLite standby',async()=>{
  const probe=await readLaunchRequestStatusFromLedgerAsync({launchRequestId:'root',includeRetryChain:true,
    dispatchSession:{dispatchLookup:async()=>{throw Error('synthetic unavailable');}},
    spawnSyncImpl:()=>assert.fail('no database transport'),ledgerTarget:{backend:'sqlite',path:'/missing'}});
  assert.equal(probe.ok,false);
  assert.equal(probe.reason,'dispatch-read-unavailable');
});
