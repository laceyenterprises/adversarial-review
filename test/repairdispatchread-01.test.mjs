// REPAIRDISPATCHREAD-01: the in-place repair reservation must prepare the
// dispatch read context before it reads closer-launch ownership. All fixtures
// are synthetic; the SDK transport is mocked, so nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main } from '../bin/repair-in-place.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { mutateRepairEpochs, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { pendingRepairEpoch, reserveRepairEpoch } from '../src/repair-epochs.mjs';
import { pairedDispatchAbsence } from './helpers/repair-dispatch-scope.mjs';

const repo = 'example/widgets', prNumber = 23, head = 'd'.repeat(40);
const closerLaunch = 'lrq_synthetic_closer';

function exhaustedPr(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'repair-dispatch-read-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
    review_status,reviewer_head_sha,rereview_reason)
    VALUES (?,?,'2026-01-01T00:00:00Z','synthetic','open','posted',?,?)`)
    .run(repo, prNumber, head, 'closure-retry-exhausted');
  db.close();
  return rootDir;
}

function closerLease(rootDir, status = 'dispatched') {
  const path = amaCloserLeaseFilePath(rootDir, { repo, prNumber, headSha: head });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ repo, prNumber, headSha: head, status,
    lrqId: closerLaunch, acquiredAt: '2026-01-01T00:00:00Z' }));
}

// Mock only the SDK session and the physical lookup; keep the SDK's own reply
// parsing and retry-chain traversal so the real ownership rules run.
function mockSdk(t, { launchStatus = 'canceled', connect, lookup } = {}) {
  const sdk = dispatchReadTransport.sdk();
  const calls = { connect: 0, lookup: 0 };
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk,
    connect: async config => {
      calls.connect++;
      if (connect) return connect(config);
      return { sessionToken: 'synthetic-session', endpoint_url: config.endpoint_url };
    },
    readSessionDispatchLookup: async selector => {
      calls.lookup++;
      if (lookup) return lookup(selector);
      if (selector.project_ref) return pairedDispatchAbsence(selector);
      const row = { launch_request_id: selector.launch_request_ids[0], status: launchStatus,
        repo, pr_number: prNumber, ticket_ref: 'SYNTHETIC-1' };
      return { schema_version: 1, status: 'found', complete: true,
        roots: [row.launch_request_id], items: [row], retry_edges: [] };
    },
  }));
  return calls;
}
const argv = (rootDir, project = 'fixture-project') =>
  [rootDir, repo, String(prNumber), head, 'repair-submit-synthetic', 'false', '', '', project];
// A fresh endpoint per test keeps the read client's module session cache apart.
let endpoint = 0;
const freshEnv = () => ({ APP_CONTRACT_ENDPOINT_URL: `https://fixture.invalid/repair-${++endpoint}` });

test('a denied project/repository read stops a new repair before any reservation', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const before = readHammerRetryCapLedger(rootDir, identity);
  const calls = mockSdk(t, { lookup: () => {
    throw new Error('app-contract dispatch_scope_denied: synthetic entitlement denial');
  } });
  const result = await main(argv(rootDir, 'legacy-project'), { env: freshEnv() });
  assert.equal(result.ok, false, JSON.stringify({ result, ledger: readHammerRetryCapLedger(rootDir, identity), calls }));
  assert.equal(result.reason, 'repair-dispatch-read-scope-denied');
  assert.deepEqual(result.scope, { appId: 'adversarial-review', repo, projectRef: 'legacy-project' });
  assert.equal(calls.lookup, 1);
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity), before);
});

for (const [kind, reply, lookups] of [
  ['transport outage', () => { throw new Error('app-contract dispatch_read_unavailable: synthetic outage'); }, 2],
  ['unsupported selector', () => { throw new Error('app-contract invalid_dispatch_selector: old endpoint'); }, 1],
  ['filtered empty', selector => ({ ...pairedDispatchAbsence(selector), scope_complete: false }), 1],
  ['retirement-only grant', selector => pairedDispatchAbsence(selector, 'operator-exact-key'), 1],
  ['mismatched proof', selector => pairedDispatchAbsence({ ...selector, repo: 'other/widgets' }), 1],
]) test(`new repair scope stays unproven on ${kind}`, async t => {
  const rootDir = exhaustedPr(t);
  const calls = mockSdk(t, { lookup: reply });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.reason, 'repair-dispatch-read-scope-unproven');
  assert.equal(calls.lookup, lookups);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
});

test('a lease naming a canceled closer launch reads as terminal and the reservation proceeds', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const calls = mockSdk(t, { launchStatus: 'canceled' });
  const env = freshEnv();
  const result = await main(argv(rootDir), { env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.epoch.id, /^repair-/);
  assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, '1');
  assert.equal(calls.connect, 1);
  assert.equal(calls.lookup, 2);
});

for (const launchStatus of ['dispatched', 'running']) {
  test(`a live closer launch (${launchStatus}) still refuses as closer-owned-or-unknown`, async t => {
    const rootDir = exhaustedPr(t);
    closerLease(rootDir);
    mockSdk(t, { launchStatus });
    const result = await main(argv(rootDir), { env: freshEnv() });
    assert.deepEqual(result, { ok: false, reason: 'closer-owned-or-unknown' });
    assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }), null);
  });
}

test('a canceled launch with a live retry stays owned', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  mockSdk(t, { lookup: () => {
    const parent = { launch_request_id: closerLaunch, status: 'canceled', repo, pr_number: prNumber };
    const child = { launch_request_id: 'lrq_synthetic_retry', status: 'running', repo, pr_number: prNumber };
    return { schema_version: 1, status: 'found', complete: true, roots: [closerLaunch],
      items: [parent, child], retry_edges: [{ parent: closerLaunch, child: child.launch_request_id }] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.deepEqual(result, { ok: false, reason: 'closer-owned-or-unknown' });
});

for (const failure of ['transient', 'timeout', 'unproven-absence']) {
  test(`a ${failure} ownership read stays fail-closed as closer-owned-or-unknown`, async t => {
    const rootDir = exhaustedPr(t);
    closerLease(rootDir);
    mockSdk(t, { lookup: () => {
      if (failure === 'transient') throw Object.assign(new Error('synthetic outage'), { status: 503 });
      if (failure === 'timeout') throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      return { schema_version: 1, status: 'not_found', complete: true, roots: [], items: [], retry_edges: [] };
    } });
    const result = await main(argv(rootDir), { env: { ...freshEnv(), ADVERSARIAL_DISPATCH_READS_ENABLED: '1' } });
    assert.deepEqual(result, { ok: false, reason: 'closer-owned-or-unknown' });
  });
}

test('a failed context preparation refuses with the typed reason, never closer ownership', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const calls = mockSdk(t, { connect: async () => { throw new Error('synthetic bootstrap refusal'); } });
  const env = freshEnv();
  const result = await main(argv(rootDir), { env });
  assert.deepEqual(result, { ok: false, reason: 'dispatch-read-context-unavailable',
    detail: 'session-bootstrap-failed' });
  assert.equal(calls.lookup, 0);
  assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, undefined);
  assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }), null);
});

test('a preparation that leaves dispatch reads disabled refuses with the typed reason', async t => {
  const rootDir = exhaustedPr(t);
  closerLease(rootDir);
  const calls = mockSdk(t);
  for (const prepare of [async () => ({ ok: true }), () => { throw new Error('synthetic'); }]) {
    const result = await main(argv(rootDir), { env: freshEnv(), prepareDispatchReadContextImpl: prepare });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'dispatch-read-context-unavailable');
  }
  assert.equal(calls.lookup, 0);
});

test('a pending repair epoch is observed through the prepared context', async t => {
  const rootDir = exhaustedPr(t);
  const prior = reserveRepairEpoch({ rootDir, repo, prNumber, headSha: head, ownerKey: 'repair-submit-prior',
    cause: 'closure-retry-exhausted', now: '2026-01-01T00:00:00Z' }).epoch;
  const selectors = [];
  mockSdk(t, { lookup: selector => {
    selectors.push(selector);
    if (selector.project_ref) return pairedDispatchAbsence(selector);
    const row = { launch_request_id: 'lrq_synthetic_repair', status: 'canceled',
      idempotency_key: prior.ownerKey, target_repo: repo, head_sha: head, identity_ambiguous: false };
    return { schema_version: 1, status: 'found', complete: true, roots: [row.launch_request_id],
      items: [row], retry_edges: [] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.epoch.id, prior.id);
  assert.equal(selectors[0].idempotency_key, 'repair-submit-prior');
});

test('a newly observed publication fences a successor during scope verification', async t => {
  const rootDir = exhaustedPr(t);
  const identity = { repo, prNumber };
  const prior = reserveRepairEpoch({ rootDir, ...identity, headSha: head, ownerKey: 'repair-submit-prior',
    cause: 'closure-retry-exhausted' }).epoch;
  const priorLaunch = 'lrq_fixture_prior';
  const publicationHead = 'a'.repeat(40);
  mockSdk(t, { lookup: selector => {
    if (selector.project_ref) {
      mutateRepairEpochs(rootDir, identity, ledger => {
        Object.assign(ledger.repairEpochs[0], { publicationHead, publicationLaunch: priorLaunch });
      });
      return pairedDispatchAbsence(selector);
    }
    const row = { launch_request_id: priorLaunch, status: 'canceled',
      idempotency_key: prior.ownerKey, target_repo: repo, head_sha: head, identity_ambiguous: false };
    return { schema_version: 1, status: 'found', complete: true, roots: [priorLaunch],
      items: [row], retry_edges: [] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.reason, 'repair-owned');
  assert.deepEqual(readHammerRetryCapLedger(rootDir, identity).repairEpochs,
    [{ ...prior, publicationHead, publicationLaunch: priorLaunch }]);
});

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../bin/repair-in-place.mjs', import.meta.url));
const project = 'fixture-project';
const ownerKey = 'fixture-original-key';
const launch = 'lrq_fixture_owner';
const isPreflight = selector => selector.idempotency_key?.startsWith('repair-read-preflight-');

function assertScopeProbe(selector, expectedProject) {
  assert.match(selector.idempotency_key, /^repair-read-preflight-[0-9a-f-]{36}$/);
  assert.deepEqual(selector, { idempotency_key: selector.idempotency_key, project_ref: expectedProject, repo });
}

for (const [kind, lookupCount, remaining, exitCode, legacy = false] of [
  ['terminal', 3, 2, 0], ['live retry', 2, 1, 75], ['retry unavailable', 2, 1, 75],
  ['foreign head', 1, 1, 75], ['foreign repo', 1, 1, 75],
  ['grant denied', 1, 1, 75], ['filtered empty', 1, 1, 75],
  ['canonical empty', 1, 1, 75], ['moved head', 0, 1, 75],
  ['filtered empty', 1, 1, 75, true], ['canonical empty', 1, 1, 75, true],
  ['terminal', 3, 2, 0, true], ['denied successor', 3, 1, 75], ['denied initial', 1, 0, 75],
]) test(`installed SDK repair CLI ${legacy ? 'legacy unscoped ' : ''}${kind}`, async t => {
  const rootDir = exhaustedPr(t);
  const bootstrap = join(rootDir, 'apps', 'bootstrap');
  mkdirSync(bootstrap, { recursive: true });
  writeFileSync(join(bootstrap, 'adversarial-review.bearer'), 'fixture-bootstrap');
  const argvFor = (sha, key, projectRef) => [
    rootDir, repo, String(prNumber), sha, key, 'false', '', '', projectRef,
  ];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(APP_CONTRACT_|HCP_|HQ_LAUNCH_REQUEST_ID$|ADVERSARIAL_(DISPATCH_READS|WORKER_OBSERVATIONS)_ENABLED$)/.test(key)));
  const run = async (sha, key, projectRef) => {
    const options = { env: { ...env, HQ_ROOT: rootDir, APP_CONTRACT_ENDPOINT_URL: endpointUrl }, timeout: 15000 };
    const output = await execute(process.execPath, [helper, ...argvFor(sha, key, projectRef)], options)
      .then(result => ({ ...result, code: 0 }), error => error);
    assert.equal(output.stderr, '');
    return { code: output.code, receipt: JSON.parse(output.stdout) };
  };
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const selector = JSON.parse(raw);
    requests.push({ path: req.url, auth: req.headers.authorization, selector });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/register') return res.end(JSON.stringify({ session_token: 'fixture-session' }));
    const denied = kind === 'grant denied' || kind === 'denied initial'
      || (kind === 'denied successor' && isPreflight(selector));
    if (denied || (kind === 'retry unavailable' && selector.include_retry_chain)) {
      res.writeHead(403);
      return res.end(JSON.stringify({ error: { code: 'dispatch_scope_denied', message: 'synthetic denial' } }));
    }
    if (isPreflight(selector)) return res.end(JSON.stringify(pairedDispatchAbsence(selector)));
    const empty = { schema_version: 1, status: 'not_found', complete: true, items: [], roots: [], retry_edges: [] };
    if (kind === 'filtered empty') return res.end(JSON.stringify(empty));
    if (kind === 'canonical empty') return res.end(JSON.stringify({ ...empty, scope_complete: true,
      absence_proof: { version: 1, kind: 'canonical-exact-selector-absence', selector,
        // The grant identifier does not authorize retirement of repair custody.
        grant_id: 'project-repository-dispatch-read',
        observed_at: new Date().toISOString() } }));
    const row = { launch_request_id: launch, idempotency_key: ownerKey, status: 'canceled',
      target_repo: kind === 'foreign repo' ? 'other/widgets' : repo,
      head_sha: kind === 'foreign head' ? 'e'.repeat(40) : head, identity_ambiguous: false };
    const retry = selector.include_retry_chain && kind === 'live retry';
    return res.end(JSON.stringify({ ...empty, status: 'found', roots: [launch],
      items: retry ? [row, { launch_request_id: 'lrq_fixture_retry', status: 'running' }] : [row],
      retry_edges: retry ? [{ parent: launch, child: 'lrq_fixture_retry' }] : [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpointUrl = `http://127.0.0.1:${server.address().port}`;

  if (kind === 'denied initial') {
    const refused = await run(head, ownerKey, project);
    assert.equal(refused.code, 75);
    assert.equal(refused.receipt.reason, 'repair-dispatch-read-scope-denied');
    assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
    assert.deepEqual(requests.map(({ auth, path }) => [path, auth]), [
      ['/v1/register', 'Bearer fixture-bootstrap'], ['/v1/dispatch/lookup', 'Bearer fixture-session'],
    ]);
    assertScopeProbe(requests[1].selector, project);
    return;
  }
  reserveRepairEpoch({ rootDir, repo, prNumber, headSha: head, ownerKey,
    cause: 'closure-retry-exhausted', dispatchProjectRef: legacy ? undefined : project });
  if (legacy || kind === 'canonical empty') {
    mutateRepairEpochs(rootDir, { repo, prNumber }, ledger => {
      ledger.repairEpochs[0].reservedAt = '2026-01-01T00:00:00Z';
      if (legacy) {
        ledger.repairEpochs[0].ownerState = 'unknown';
        ledger.repairEpochs[0].ownerLaunch = null;
      }
    });
  }
  const before = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  const successor = await run(kind === 'moved head' ? 'e'.repeat(40) : head, 'fresh-key', 'new-project');
  assert.equal(successor.code, exitCode);
  assert.equal(successor.receipt.ok, exitCode === 0);
  if (exitCode === 75) assert.equal(successor.receipt.reason,
    kind === 'denied successor' ? 'repair-dispatch-read-scope-denied' : 'repair-owned');
  const { repairEpochs } = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  assert.equal(repairEpochs.length, remaining);
  assert.equal(repairEpochs[0].ownerKey, ownerKey);
  assert.equal(repairEpochs[0].reviewHead, null);
  assert.equal(Boolean(repairEpochs[0].terminalAt), exitCode === 0);
  if ((legacy && exitCode === 75) || kind === 'denied successor') {
    assert.deepEqual(readHammerRetryCapLedger(rootDir, { repo, prNumber }), before);
  }
  assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }).ownerKey, exitCode === 0 ? 'fresh-key' : ownerKey);
  if (!lookupCount) {
    assert.deepEqual(requests, []);
    return;
  }
  assert.equal(requests.length, 1 + lookupCount);
  assert.equal(requests[0].path, '/v1/register');
  assert.equal(requests[0].auth, 'Bearer fixture-bootstrap');
  assert.equal(requests[0].selector.app_id, 'adversarial-review');
  for (const request of requests.slice(1)) {
    assert.equal(request.path, '/v1/dispatch/lookup');
    assert.equal(request.auth, 'Bearer fixture-session');
  }
  assert.deepEqual(requests[1].selector, legacy ? { idempotency_key: ownerKey }
    : { idempotency_key: ownerKey, project_ref: project, repo });
  if (lookupCount >= 2) assert.deepEqual(requests[2].selector, {
    launch_request_ids: [launch], include_retry_chain: true,
  });
  if (lookupCount === 3) assertScopeProbe(requests[3].selector, 'new-project');
});

test('the first reservation records the exact project after an affirmative scoped read', async t => {
  const rootDir = exhaustedPr(t);
  const calls = mockSdk(t, { lookup: selector => {
    assertScopeProbe(selector, project);
    assert.equal(pendingRepairEpoch(rootDir, { repo, prNumber }), null);
    return pairedDispatchAbsence(selector);
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.ok, true);
  assert.equal(result.epoch.dispatchProjectRef, project);
  assert.equal(calls.connect, 1);
  assert.equal(calls.lookup, 1);
});

test('missing project refuses a new epoch but permits exact legacy replay', async t => {
  const rootDir = exhaustedPr(t);
  const calls = mockSdk(t, { lookup: () => { throw new Error('unavailable'); } });
  const env = freshEnv();
  const request = argv(rootDir, '');
  const refused = await main(request, { env });
  assert.equal(refused.reason, 'repair-dispatch-project-required');
  assert.equal(calls.connect, 0);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo, prNumber }), null);
  const prior = reserveRepairEpoch({ rootDir, repo, prNumber, headSha: head, ownerKey: request[4],
    cause: 'closure-retry-exhausted' }).epoch;
  const replay = await main(request, { env });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.epoch, prior);
  assert.equal(calls.lookup, 1, 'only the preexisting owner lookup is made');
});
