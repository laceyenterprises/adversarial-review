import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, symlinkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  assert.deepEqual(sync.retryEdges, capture().retry_edges);
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
  assert.equal(timedOut.timedOut, true);
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
    return {sessionToken:'synthetic',endpoint_url:config.endpoint_url};
  }, readSessionDispatchLookup: async () => { if (failure) throw failure; return capture(); } }));
  const read = timeoutMs => readDispatchLaunches({}, { timeoutMs, env: { ADVERSARIAL_DISPATCH_READS_ENABLED: '1' }, connectOptions: { endpoint_url: 'synthetic://budgets' } });
  assert.equal((await read(8000)).ok, true);
  assert.equal((await read(30000)).ok, true);
  assert.equal((await read(30000)).ok, true);
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] > 0 && budgets[0] <= 8000);
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
    connect: async () => { appCalls++; return {sessionToken:'synthetic',endpoint_url:'synthetic://app'}; },
    readSessionDispatchLookup: async () => capture(),
  }));
  const selector = { launch_request_ids: ['root'] };
  const env = { ADVERSARIAL_DISPATCH_READS_ENABLED: '1', HQ_LAUNCH_REQUEST_ID: 'root', HCP_TOKEN_PATH: '/synthetic/token', HCP_TOKEN: 'primary',
    HCP_BEARER_TOKEN: 'secondary', HCP_BASE_URL: 'synthetic://hcp' };
  assert.equal((await readDispatchLaunches(selector, { env, timeoutMs: 30000 })).ok, true);
  assert.ok(calls[0].config.request_timeout_ms > 0 && calls[0].config.request_timeout_ms <= 30000);
  assert.deepEqual(calls[0], { selector, config: { token_path: '/synthetic/token', token: 'primary',
    endpoint_url: 'synthetic://hcp', request_timeout_ms: calls[0].config.request_timeout_ms } });
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
  symlinkSync(fileURLToPath(new URL('../src/load-aware-timeout.mjs', import.meta.url)),
    join(root, 'src/load-aware-timeout.mjs'));
  execFileSync('tar', ['-xzf', fileURLToPath(new URL('../vendor/agent-os-app-sdk-0.4.0.tgz', import.meta.url)),
    '-C', sdkDir, '--strip-components=1'], { timeout: 5000 });
  // Resolve the timeout helper's own dependencies beside its real source,
  // even when the outer test runner preserves symlinks for sandbox isolation.
  execFileSync(process.execPath, ['--no-preserve-symlinks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readDispatchLaunchesSync } from './src/dispatch-read-client.mjs';
    const result = readDispatchLaunchesSync({ launch_request_ids: ['synthetic'] },
      { env: { ADVERSARIAL_DISPATCH_READS_ENABLED: '1' } });
    assert.equal(result.reason, 'dispatch-read-unavailable');
  `], { cwd: root, timeout: 5000 });
});

// Negative mutations of the LAC-2120 additive producer envelope. These are
// synthetic corruption tests; end-to-end captures come from the producer suite.
function authorizedAbsence(selector) {
  return { ...absent, scope_complete: true, absence_proof: {
    version: 1, kind: 'canonical-exact-selector-absence', selector,
    grant_id: 'incident-exact-attempt', observed_at: '2026-10-26T20:02:47Z',
  } };
}
test('only exact selector-bound producer absence passes sync and async compatibility readers', async () => {
  for (const selector of [{ idempotency_key: 'key' },
    { ticket_ref: 'AMA-PR-8', requested_at_or_after: '2026-01-01T00:00:00.000Z' }]) {
    const result = authorizedAbsence(selector);
    const async = await readDispatchLaunches(selector, options(result));
    assert.equal(async.ok, true);
    assert.deepEqual(async.absenceProof, result.absence_proof);
    assert.deepEqual(readDispatchLaunchesSync(selector, options(result)), async);
  }
});
for (const mutation of [
  value => { delete value.scope_complete; },
  value => { value.scope_complete = false; },
  value => { value.scope_complete = 'true'; },
  value => { delete value.absence_proof; },
  value => { value.absence_proof.version = 2; },
  value => { value.absence_proof.kind = 'grant-filtered-empty'; },
  value => { value.absence_proof.selector.idempotency_key = 'foreign-key'; },
  value => { value.absence_proof.selector.extra = 'broader'; },
  value => { value.absence_proof.grant_id = ''; },
  value => { value.absence_proof.grant_id = ' \t\n '; },
  value => { value.absence_proof.observed_at = 'invalid'; },
  value => { value.complete = false; },
]) test('partial, unbound or malformed absence never releases the consumer hold', async () => {
  const selector = { idempotency_key: 'key' };
  const result = authorizedAbsence({ ...selector });
  mutation(result);
  assert.equal((await readDispatchLaunches(selector, options(result))).ok, false);
  assert.equal(readDispatchLaunchesSync(selector, options(result)).ok, false);
});
test('undefined selectors and missing own proof keys never certify absence', async () => {
  for (const [selector, proofSelector] of [
    [{ idempotency_key: undefined }, { other_key: 'val' }],
    [{ idempotency_key: undefined }, { idempotency_key: undefined }],
    [{ ticket_ref: undefined, requested_at_or_after: '2026-01-01T00:00:00.000Z' },
      { other_key: 'val', requested_at_or_after: '2026-01-01T00:00:00.000Z' }],
    [{ idempotency_key: 'key' }, Object.assign(Object.create({ idempotency_key: 'key' }), { other_key: 'val' })],
  ]) {
    const args = options(authorizedAbsence(proofSelector));
    assert.equal((await readDispatchLaunches(selector, args)).ok, false);
    assert.equal(readDispatchLaunchesSync(selector, args).ok, false);
  }
});
test('exact absence proof cannot authorize launch ID or retry-chain absence', async () => {
  for (const selector of [{ launch_request_ids: ['missing'] },
    { idempotency_key: 'key', include_retry_chain: true }]) {
    assert.equal((await readDispatchLaunches(selector, options(authorizedAbsence(selector)))).ok, false);
  }
});


for (const body of ['', JSON.stringify({error:{code:'dispatch_read_unavailable',message:'unavailable'}}),
  JSON.stringify({error:{code:'read_capacity_exhausted',message:'retry later'}}), '<html>busy</html>']) {
  test(`packaged SDK 503 (${body ? 'body' : 'empty'}) retries once and recovers ownership`, async t => {
    let calls = 0;
    const budgets = [];
    t.mock.method(globalThis, 'fetch', async (_url, config) => {
      calls++;
      assert.match(_url, /\/v1\/dispatch\/lookup$/);
      assert.equal(config.method, 'POST');
      return calls === 1 ? new Response(body, {status:503})
        : Response.json(capture('completed'));
    });
    const sdk = dispatchReadTransport.sdk();
    t.mock.method(dispatchReadTransport, 'sdk', () => ({...sdk,
      readSessionDispatchLookup: (selector, config) => {
        budgets.push(config.request_timeout_ms);
        return sdk.readSessionDispatchLookup(selector, config);
      },
    }));
    const probe = await readLaunchRequestStatusFromLedgerAsync({launchRequestId:'root',
      timeoutMs:1000, env:{ADVERSARIAL_DISPATCH_READS_ENABLED:'1'},
      connectOptions:{session_token:'synthetic',endpoint_url:'https://example.invalid'}});
    assert.equal(probe.ok, true);
    assert.equal(calls, 2);
    assert.ok(budgets[1] < budgets[0] && budgets[0] <= 1000);
    assert.equal(isReclaimableTerminalAmaCloserLease(
      {status:'terminal',terminalOutcome:'deferred',lrqId:'root'}, {launchStatusProbe:probe}), true);
  });
}

test('two packaged SDK 503s retain unreadable ownership with no third attempt', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', {status:503}); });
  const probe = await readLaunchRequestStatusFromLedgerAsync({launchRequestId:'root',timeoutMs:1000,
    env:{ADVERSARIAL_DISPATCH_READS_ENABLED:'1'},
    connectOptions:{session_token:'synthetic',endpoint_url:'https://example.invalid'}});
  assert.equal(calls, 2);
  assert.equal(probe.ok, false);
  assert.equal(probe.transient, true);
  assert.equal(probe.detail, 'transient dispatch lookup failure');
  assert.equal(isReclaimableTerminalAmaCloserLease(
    {status:'terminal',terminalOutcome:'deferred',lrqId:'root'}, {launchStatusProbe:probe}), false);
});

test('retry delay cannot extend a caller deadline or start work after abort', async () => {
  for (const abort of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    const dispatchSession = {dispatchLookup:async () => {
      calls++;
      if (abort) controller.abort();
      throw new Error('app-contract 503: Service Unavailable');
    }};
    const result = await readDispatchLaunches({launch_request_ids:['root']},
      {dispatchSession,timeoutMs:10,signal:controller.signal});
    assert.equal(result.ok, false);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(calls, 1);
  }
});

test('dispatch retries neither authorization failures nor unproven absence', async () => {
  for (const reply of [absent, new Error('app-contract dispatch_scope_denied: grant required')]) {
    let calls = 0;
    const result = await readDispatchLaunches({idempotency_key:'key'}, {dispatchSession:{dispatchLookup:async () => {
      calls++;
      if (reply instanceof Error) throw reply;
      return reply;
    }}});
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

for (const projectKey of ['projectRef', 'project_ref']) {
test(`CLOSERDISPATCHDEAD-01: ${projectKey} recovery selectors carry the exact grant scope and validate canonical absence`, async () => {
  for (const selector of [{ idempotency_key: 'synthetic-key' },
    { ticket_ref: 'AMA-PR-8', requested_at_or_after: '2026-01-01T00:00:00.000Z' }]) {
    const scoped = { project_ref: 'synthetic-project', repo: 'example/repo', ...selector };
    const args = { repo: scoped.repo, [projectKey]: scoped.project_ref, dispatchSession: {
      dispatchLookup: async observed => {
        assert.deepEqual(observed, scoped);
        return authorizedAbsence(scoped);
      },
    } };
    const result = selector.idempotency_key
      ? await readLaunchRequestByIdempotencyKeyAsync({ ...args, idempotencyKey: selector.idempotency_key })
      : await readLaunchRequestsForTicketSinceAsync({ ...args, ticketRef: selector.ticket_ref,
        requestedAtOrAfter: selector.requested_at_or_after });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rows, []);
    for (const changed of [{ project_ref: 'other' }, { repo: 'foreign/repo' }]) {
      assert.equal((await readDispatchLaunches(scoped, options(authorizedAbsence({ ...scoped, ...changed })))).ok, false);
    }
    assert.equal((await readDispatchLaunches(scoped, options(absent))).ok, false);
  }
});
}


test('registry readiness uses a registered async session and refreshes the sync cache on TTL expiry', async t => {
  const {ensureWorkerRegistryReady} = await import('../src/adapters/agent-runtime/local/remediation.mjs');
  const env = {APP_CONTRACT_ENDPOINT_URL: 'https://example.invalid/dispatch-registry-refresh'};
  let reads = 0, connects = 0, now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    async connect(config) { connects++; return {sessionToken: 'fixture-session', endpoint_url: config.endpoint_url}; },
    async readSessionHostServices(request, config) {
      assert.equal(request.action, 'worker_registry');
      assert.equal(config.session_token, 'fixture-session');
      return {schema_version: 1, status: 'found', data: {classes: {fixture: {defaultModel: `model-${++reads}`}}}};
    },
    readHostServicesSync() { assert.fail('sync registry transport forbidden'); },
  }));
  const read = () => dispatchReadTransport.hostServicesSync({action: 'worker_registry'}, {env});
  assert.throws(read, {code: 'registry-unavailable', failureClass: 'reviewer-model-unresolved'});
  await ensureWorkerRegistryReady({env});
  assert.equal(read().data.classes.fixture.defaultModel, 'model-1');
  now += 60_000;
  assert.throws(read, {code: 'registry-unavailable', failureClass: 'reviewer-model-unresolved'});
  await ensureWorkerRegistryReady({env: {...env}});
  assert.equal(read().data.classes.fixture.defaultModel, 'model-2');
  assert.equal(connects, 1);
});
