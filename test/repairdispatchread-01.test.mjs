// REPAIRDISPATCHREAD-01: the in-place repair reservation must prepare the
// dispatch read context before it reads closer-launch ownership. All fixtures
// are synthetic; the SDK transport is mocked, so nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { main } from '../bin/repair-in-place.mjs';
import { dispatchReadTransport, prepareDispatchReadContext } from '../src/dispatch-read-client.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { pendingRepairEpoch, reserveRepairEpoch } from '../src/repair-epochs.mjs';

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
      const row = { launch_request_id: selector.launch_request_ids[0], status: launchStatus,
        repo, pr_number: prNumber, ticket_ref: 'SYNTHETIC-1' };
      return { schema_version: 1, status: 'found', complete: true,
        roots: [row.launch_request_id], items: [row], retry_edges: [] };
    },
  }));
  return calls;
}
const argv = rootDir => [rootDir, repo, String(prNumber), head, 'repair-submit-synthetic', 'false'];
// A fresh endpoint per test keeps the read client's module session cache apart.
let endpoint = 0;
const freshEnv = () => ({ APP_CONTRACT_ENDPOINT_URL: `https://fixture.invalid/repair-${++endpoint}` });

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
  assert.equal(calls.lookup, 1);
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
    if (selector.idempotency_key) {
      return { schema_version: 1, status: 'found', complete: true, roots: ['lrq_synthetic_repair'],
        items: [{ launch_request_id: 'lrq_synthetic_repair', status: 'canceled' }], retry_edges: [] };
    }
    const row = { launch_request_id: 'lrq_synthetic_repair', status: 'canceled', repo, pr_number: prNumber };
    return { schema_version: 1, status: 'found', complete: true, roots: [row.launch_request_id],
      items: [row], retry_edges: [] };
  } });
  const result = await main(argv(rootDir), { env: freshEnv() });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.notEqual(result.epoch.id, prior.id);
  assert.equal(selectors[0].idempotency_key, 'repair-submit-prior');
});

test('no lease and no pending epoch: the reservation needs no dispatch context', async t => {
  const rootDir = exhaustedPr(t);
  let prepared = 0;
  const result = await main(argv(rootDir), { env: freshEnv(),
    prepareDispatchReadContextImpl: async args => { prepared++; return prepareDispatchReadContext(args); } });
  assert.equal(result.ok, true);
  assert.equal(prepared, 0);
});
