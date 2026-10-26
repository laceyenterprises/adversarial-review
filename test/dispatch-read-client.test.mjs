import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDispatchLaunches, readDispatchLaunchesSync, dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { readLaunchRequestStatusFromLedger, readLaunchRequestStatusFromLedgerAsync,
  readLaunchRequestSnapshotFromLedgerAsync, readLaunchRequestByIdempotencyKeyAsync,
  readLaunchRequestsForTicketSinceAsync } from '../src/session-ledger-read-adapter.mjs';
import { createWatcherLatencyMonitor } from '../src/watcher-latency.mjs';
import { isReclaimableTerminalAmaCloserLease } from '../src/ama/closer-lease.mjs';
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
  assert.equal((await readLaunchRequestStatusFromLedgerAsync({launchSnapshot:snapshot,launchRequestId:'unknown'})).reason,'dispatch-read-unavailable');
});
test('idempotency recovery and legacy intent windows use scoped SDK selectors; lost responses do not dispatch', async () => {
  const calls=[];
  const dispatchSession={dispatchLookup:async selector=>{ calls.push(selector); return capture(); }};
  for(let i=0;i<2;i++) assert.equal((await readLaunchRequestByIdempotencyKeyAsync({idempotencyKey:'key',dispatchSession})).rows.length,3);
  assert.deepEqual(calls,[{idempotency_key:'key'},{idempotency_key:'key'}]);
  await readLaunchRequestsForTicketSinceAsync({ticketRef:'T-1',requestedAtOrAfter:'2026-01-01T00:00:00Z',dispatchSession});
  assert.equal(calls[2].ticket_ref,'T-1');
});
test('missing and foreign launch identities cannot certify absence or reclaim terminal ownership',async()=>{
  for(const launchRequestId of ['missing','foreign']) {
    const probe=await readLaunchRequestStatusFromLedgerAsync({...options(absent),launchRequestId});
    assert.equal(probe.reason,'dispatch-read-unavailable');
    assert.equal(isReclaimableTerminalAmaCloserLease({ status: 'terminal', terminalOutcome: 'deferred', lrqId: launchRequestId }, { launchStatusProbe: probe }), false);
    assert.equal((await readLaunchRequestByIdempotencyKeyAsync({ ...options(absent), idempotencyKey: 'key' })).ok, false);
    assert.equal((await readLaunchRequestsForTicketSinceAsync({ ...options(absent), ticketRef: 'T-1', requestedAtOrAfter: '2026-01-01T00:00:00Z' })).ok, false);
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


test('ticket windows require strings and normalize inclusive offset boundaries to UTC', async () => {
  const calls = [];
  const dispatchSession = { dispatchLookup: async selector => { calls.push(selector); return absent; } };
  const args = { ticketRef: 'T-1', dispatchSession };
  for (const requestedAtOrAfter of [null, 0, new Date(), 'invalid']) {
    assert.equal((await readLaunchRequestsForTicketSinceAsync({ ...args, requestedAtOrAfter })).ok, false);
  }
  assert.equal(calls.length, 0);
  await readLaunchRequestsForTicketSinceAsync({ ...args, requestedAtOrAfter: '2026-01-01T02:00:00+02:00' });
  assert.equal(calls[0].requested_at_or_after, '2026-01-01T00:00:00.000Z');
});

test('caller abort and timeout bound unresolved reads without accepting late absence', async () => {
  const controller = new AbortController();
  let resolve;
  const dispatchSession = { dispatchLookup: () => new Promise(done => { resolve = done; }) };
  const pending = readDispatchLaunches({ idempotency_key: 'key' }, { dispatchSession, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).detail, 'dispatch lookup aborted');
  resolve(absent);
  const timedOut = await readDispatchLaunches({}, { dispatchSession, timeoutMs: 5 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.transient, true);
  resolve(absent);
  const aborted = await readDispatchLaunches({}, { dispatchSession: { dispatchLookup: offline }, signal: controller.signal });
  assert.equal(aborted.ok, false);
});

test('session budgets follow each caller; transient and authentication failures evict cached sessions', async t => {
  const sdk = dispatchReadTransport.sdk();
  const budgets = [];
  let failure;
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk, connect: async config => {
    budgets.push(config.request_timeout_ms);
    return { dispatchLookup: async () => { if (failure) throw failure; return capture(); } };
  } }));
  const read = timeoutMs => readDispatchLaunches({}, { timeoutMs, env: { ADVERSARIAL_DISPATCH_READS_ENABLED: '1' }, connectOptions: { endpoint_url: 'synthetic://budgets' } });
  assert.equal((await read(8000)).ok, true);
  assert.equal((await read(30000)).ok, true);
  assert.equal((await read(30000)).ok, true);
  assert.deepEqual(budgets, [8000, 30000]);
  for (const error of [Object.assign(new Error('secret endpoint'), { code: 'ECONNRESET' }), new Error('app-contract 401: secret token')]) {
    failure = error;
    const result = await read(30000);
    assert.equal(result.ok, false);
    assert.equal(result.transient, error.code === 'ECONNRESET');
    assert.doesNotMatch(JSON.stringify(result), /secret|endpoint|token/);
    failure = null;
    const before = budgets.length;
    assert.equal((await read(30000)).ok, true);
    assert.equal(budgets.length, before + 1);
  }
});

test('HCP own-launch route selects credentials and never falls back on failure', async t => {
  const sdk = dispatchReadTransport.sdk();
  const calls = [];
  let fail = false, appCalls = 0;
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk,
    readHcpDispatchLookup: async (selector, config) => {
      calls.push({ selector, config });
      if (fail) throw new Error('HCP unavailable');
      return capture();
    },
    connect: async () => { appCalls++; return { dispatchLookup: async () => capture() }; },
  }));
  const selector = { launch_request_ids: ['root'] };
  const env = { ADVERSARIAL_DISPATCH_READS_ENABLED: '1', HQ_LAUNCH_REQUEST_ID: 'root', HCP_TOKEN_PATH: '/synthetic/token', HCP_TOKEN: 'primary',
    HCP_BEARER_TOKEN: 'secondary', HCP_BASE_URL: 'synthetic://hcp' };
  assert.equal((await readDispatchLaunches(selector, { env, timeoutMs: 30000 })).ok, true);
  assert.deepEqual(calls[0], { selector, config: { token_path: '/synthetic/token', token: 'primary',
    endpoint_url: 'synthetic://hcp', request_timeout_ms: 30000 } });
  delete env.HCP_TOKEN_PATH;
  delete env.HCP_TOKEN;
  assert.equal((await readDispatchLaunches(selector, { env })).ok, true);
  assert.equal(calls[1].config.token, 'secondary');
  fail = true;
  assert.equal((await readDispatchLaunches(selector, { env })).ok, false);
  assert.equal(appCalls, 0);
  for (const other of [{ launch_request_ids: ['foreign'] }, { ...selector, include_retry_chain: true },
    { launch_request_ids: ['root', 'other'] }, { idempotency_key: 'key' }]) {
    assert.equal((await readDispatchLaunches(other, { env })).ok, true);
  }
  assert.equal(appCalls, 1);
  assert.equal(calls.length, 3);
  assert.equal((await readDispatchLaunches(selector, { env, dispatchSession: options().dispatchSession })).ok, true);
  assert.equal(calls.length, 3);
});

test('missing dispatch exports degrade to unavailable after daemon module loading', async t => {
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ connect: async () => ({}) }));
  assert.equal((await readDispatchLaunches({}, { env: { ADVERSARIAL_DISPATCH_READS_ENABLED: '1' }, timeoutMs: 21 })).reason, 'dispatch-read-unavailable');
  assert.equal(readDispatchLaunchesSync({}, { env: { ADVERSARIAL_DISPATCH_READS_ENABLED: '1' } }).reason, 'dispatch-read-unavailable');
});

test('WATCHERLAG-01: sync SDK reads report node wall latency on success and failure', t => {
  const monitor = createWatcherLatencyMonitor({ logger: { log() {} } });
  t.after(() => monitor.stop());
  assert.equal(readDispatchLaunchesSync({}, options()).ok, true);
  assert.equal(readDispatchLaunchesSync({}, { dispatchLookupSyncImpl: () => { throw new Error('unavailable'); } }).ok, false);
  const measured = monitor.summary().children.node;
  assert.equal(measured.count, 2);
  assert.equal(measured.completed, 2);
  assert.ok(measured.wall.p99_ms > 0);
});


test('dispatch reads default off and rollback never loads the SDK or switches to a ledger', async t => {
  t.mock.method(dispatchReadTransport, 'sdk', offline);
  for (const flag of [undefined, '0', 'true']) {
    const env = { ADVERSARIAL_DISPATCH_READS_ENABLED: flag };
    assert.equal((await readDispatchLaunches({}, { env })).detail, 'dispatch lookup disabled');
    assert.equal(readDispatchLaunchesSync({}, { env }).detail, 'dispatch lookup disabled');
  }
});


test('an actual SDK 0.4.0 deployment loads the dispatch module and fails unavailable', t => {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-version-skew-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkDir = join(root, 'node_modules/@agent-os/app-sdk');
  mkdirSync(sdkDir, { recursive: true });
  mkdirSync(join(root, 'src'));
  for (const name of ['dispatch-read-client', 'app-sdk-loader', 'app-contract-retry', 'watcher-latency']) {
    copyFileSync(new URL(`../src/${name}.mjs`, import.meta.url), join(root, `src/${name}.mjs`));
  }
  execFileSync('tar', ['-xzf', fileURLToPath(new URL('../vendor/agent-os-app-sdk-0.4.0.tgz', import.meta.url)),
    '-C', sdkDir, '--strip-components=1'], { timeout: 5000 });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readDispatchLaunchesSync } from './src/dispatch-read-client.mjs';
    const result = readDispatchLaunchesSync({ launch_request_ids: ['synthetic'] },
      { env: { ADVERSARIAL_DISPATCH_READS_ENABLED: '1' } });
    assert.equal(result.reason, 'dispatch-read-unavailable');
  `], { cwd: root, timeout: 5000 });
});
