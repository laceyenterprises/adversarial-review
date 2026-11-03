// Public synthetic fixtures only; no production owner state or services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatchReadTransport, readWorkerObservation, readWorkerObservationSync} from '../src/dispatch-read-client.mjs';
import {probeCapReheadOwnership} from '../src/ama/cap-rehead.mjs';
import {reapCloserHammerWorktrees} from '../src/ama/closer-worktree-reaper.mjs';
import {summarizeFirstPassCiOrphans} from '../src/review-pipeline-health.mjs';

const rows = Array.from({length:4300}, (_,i) => ({
  workspace_id:`hammer-ama-pr-${i + 1}-fixture`,worker_id:`hammer-ama-pr-${i + 1}-fixture`,
  launch_request_id:`launch-${i}`,directory_name:'checkout',present:i >= 4288,
  manifest_state:'available',repo:i >= 4288 ? 'example/repo' : 'example/other',
  branch:i >= 4288 ? 'target' : 'retired',
}));
function producer(selector, inventory=rows) {
  const selected = inventory.filter(row => (!selector.worker_id || row.worker_id === selector.worker_id)
    && (!selector.exclude_absent || row.present !== false)
    && (!selector.repo || !row.repo || row.repo === selector.repo)
    && (!selector.branch || !row.branch || row.branch === selector.branch));
  const offset = selector.offset ?? 0, limit = selector.limit ?? 50;
  const items = selected.slice(offset, offset + limit);
  const complete = offset + limit >= selected.length;
  return {schema_version:1,observation:'workspaces',status:items.length?'found':'not_found',items,
    complete,next_offset:complete ? null : offset + limit,scope_complete:false,mutation_authority:false};
}
function transport(t, inventory=rows) {
  const calls = [];
  const read = selector => { calls.push(selector); return producer(selector, inventory); };
  t.mock.method(dispatchReadTransport,'lookup',async selector => read(selector));
  t.mock.method(dispatchReadTransport,'observationSync',selector => read(selector));
  return calls;
}
const args = {repo:'example/repo',branch:'target'};
const unowned = async () => ({owned:false,uncertain:false});

test('CAPREHEAD requests its PR branch and repo and completes twelve matches among 4300 slots', async t => {
  const calls = transport(t);
  let count;
  const result = await probeCapReheadOwnership(args, {probeImpl:unowned,
    readWorkspacesImpl:async selector => {
      const result = await readWorkerObservation(selector);
      assert.equal(result.complete,true);
      count = result.rows.length;
      return result;
    },readLaunchImpl:async () => ({ok:true,row:{status:'succeeded'}})});
  assert.deepEqual(result,{owned:false,uncertain:false});
  assert.equal(count,12);
  assert.deepEqual(calls,[{observation:'workspaces',...args,limit:100,offset:0}]);
});

test('reaper requests present or unknown workspaces and completes twelve matches among 4300 slots', async t => {
  const calls = transport(t);
  const root = mkdtempSync(join(tmpdir(),'workspace-pagination-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const result = await reapCloserHammerWorktrees({hqRoot:root,cursorPath:join(root,'cursor.json'),
    repoPaths:[],limit:20,scanLimit:100,logger:{info(){},warn(){}},
    readWorkerObservationImpl:async selector => {
      const result = await readWorkerObservation(selector);
      assert.equal(result.complete,true);
      assert.equal(result.rows.length,12);
      return result;
    },execFileImpl:async () => assert.fail('no registered Git repository'),
    probeWorkerActivityImpl:async () => ({active:true,state:'active',status:'running'}),
  });
  assert.equal(result.scanned,12);
  assert.equal(result.reaped,0);
  assert.equal(calls.length,2);
  assert.ok(calls.every(selector => selector.exclude_absent === true));
});

for (const sync of [false,true]) {
  const read = (selector) => sync ? readWorkerObservationSync(selector) : readWorkerObservation(selector);
  test(`${sync?'sync':'async'} unbounded workspace listing reports partial rows and explicit truncation`, async t => {
    const calls = transport(t);
    const result = await read({observation:'workspaces'});
    assert.equal(result.ok,false);
    assert.equal(result.truncated,true);
    assert.equal(result.complete,false);
    assert.equal(result.reason,'worker-observation-truncated');
    assert.equal(result.rows.length,1000);
    assert.equal(result.nextOffset,1000);
    assert.equal(calls.length,10);
  });
  test(`${sync?'sync':'async'} scoped paging can complete beyond ten pages; exact worker needs one`, async t => {
    const calls = transport(t,rows.map(row => ({...row,repo:'example/repo',branch:'target',present:true})));
    const result = await read({observation:'workspaces',repo:'example/repo',branch:'target'});
    assert.equal(result.ok,true);
    assert.equal(result.complete,true);
    assert.equal(result.rows.length,4300);
    assert.equal(calls.length,43);
    calls.length = 0;
    assert.equal((await read({observation:'workspaces',worker_id:rows.at(-1).worker_id})).rows.length,1);
    assert.equal(calls.length,1);
  });
  test(`${sync?'sync':'async'} real outage is unavailable and has no partial success`, async t => {
    const fail = () => {throw new Error('synthetic outage');};
    t.mock.method(dispatchReadTransport,'lookup',async () => fail());
    t.mock.method(dispatchReadTransport,'observationSync',fail);
    const result = await read({observation:'workspaces'});
    assert.equal(result.ok,false);
    assert.match(result.reason,/unavailable$/);
    assert.notEqual(result.truncated,true);
    assert.equal(result.rows,undefined);
  });
}

test('CAPREHEAD cannot prove target absence from truncated rows, even if a transport says ok', async () => {
  for (const ok of [false,true]) {
    const result = await probeCapReheadOwnership(args,{probeImpl:unowned,
      readWorkspacesImpl:async () => ({ok,truncated:true,complete:false,rows:rows.slice(0,1000)}),
      readLaunchImpl:async () => assert.fail('partial inventory grants no custody absence')});
    assert.equal(result.uncertain,true);
  }
});


test('pipeline health scopes each red PR to its repository and branch and rejects truncation', t => {
  const calls = [];
  t.mock.method(dispatchReadTransport, 'observationSync', selector => {
    if (selector.observation === 'host_identity') return {schema_version:1,status:'unavailable'};
    calls.push(selector);
    return producer(selector);
  });
  const queue = {firstPassPrs:[{repo:'example/repo',prNumber:1,reviewAttempts:0,reviewerFailed:false}]};
  const options = {hqRoot:'/synthetic-unused',execFileSyncImpl:(cmd, argv) => {
    if (cmd === 'hq') return JSON.stringify({status:'running'});
    assert.equal(cmd,'gh');
    return JSON.stringify(argv.includes('checks') ? [{name:'fixture',state:'FAILURE',bucket:'fail'}]
      : {state:'OPEN',headRefName:'target',headRefOid:'a'.repeat(40)});
  }};
  const result = summarizeFirstPassCiOrphans(queue, options);
  assert.equal(result.collected,true);
  assert.equal(result.count,0);
  assert.deepEqual(calls,[{observation:'workspaces',repo:'example/repo',branch:'target',limit:100,offset:0}]);
  // A malformed/non-completing scoped stream exhausts the bounded producer budget.
  calls.length = 0;
  t.mock.method(dispatchReadTransport, 'observationSync', selector => {
    if (selector.observation === 'host_identity') return {schema_version:1,status:'unavailable'};
    calls.push(selector);
    const page = producer({...selector,offset:0});
    return {...page,items:page.items.map(row => ({...row,
      workspace_id:`${row.workspace_id}-${selector.offset}`,worker_id:`${row.worker_id}-${selector.offset}`})),
    complete:false,next_offset:selector.offset + page.items.length};
  });
  const blind = summarizeFirstPassCiOrphans(queue, options);
  assert.equal(blind.collected,false);
  assert.equal(blind.count,0);
  assert.equal(calls.length,101);
});
