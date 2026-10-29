// GSR-07: boot-time resume hands a suspended closer's lease back. Synthetic
// fixtures only: a temp root, an invented repo and launch ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fsExt from 'fs-ext';

import {
  acquireAmaCloserLease,
  amaCloserLeaseFilePath,
  readAmaCloserLease,
  rekeyAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath, readAmaCloserDispatchRecord } from '../src/ama/dispatch-record-read.mjs';
import {
  readoptSuspendedAmaCloserLeases,
  releaseSuspendedAmaCloserLeases,
} from '../src/ama/gsr-closer-lease.mjs';
import { main } from '../bin/gsr-closer-lease.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';

const IDENTITY = Object.freeze({
  repo: 'example/widget',
  prNumber: 7,
  headSha: 'feedfacefeedfacefeedfacefeedfacefeedface',
});
const SOURCE = 'lrq_source-0001';
const SUCCESSOR = 'lrq_successor-0002';

function dispatchedRoot(t, { lrqId = SOURCE } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'gsr-closer-lease-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  acquireAmaCloserLease({ rootDir, ...IDENTITY, watcherPid: 4242, now: '2026-01-01T00:00:00.000Z' });
  updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched', lrqId,
    now: '2026-01-01T00:01:00.000Z' });
  const recordPath = amaCloserDispatchFilePath(rootDir, IDENTITY);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify({ ...IDENTITY, state: 'dispatched',
    launchRequestId: lrqId, dispatchId: lrqId }));
  return rootDir;
}

const probe = status => () => ({ ok: true, row: { launch_request_id: SOURCE, status } });

test('a natively resumed closer re-adopts its dispatched lease in place', t => {
  const rootDir = dispatchedRoot(t);
  const result = readoptSuspendedAmaCloserLeases(rootDir, {
    launchRequestId: SOURCE, now: '2026-01-01T02:00:00.000Z' });
  assert.equal(result.outcome, 're-adopted');
  const lease = readAmaCloserLease(rootDir, IDENTITY);
  assert.equal(lease.status, 'dispatched');
  assert.equal(lease.lrqId, SOURCE);
  // The restart window is no longer charged against the reclaim age.
  assert.equal(lease.updatedAt, '2026-01-01T02:00:00.000Z');
  assert.equal(readAmaCloserDispatchRecord(rootDir, IDENTITY).launchRequestId, SOURCE);
});

test('a re-dispatched closer hands its lease and dispatch record to the successor', t => {
  const rootDir = dispatchedRoot(t);
  const result = readoptSuspendedAmaCloserLeases(rootDir, {
    launchRequestId: SOURCE, successorLaunchRequestId: SUCCESSOR });
  assert.equal(result.outcome, 're-adopted');
  assert.equal(readAmaCloserLease(rootDir, IDENTITY).lrqId, SUCCESSOR);
  const record = readAmaCloserDispatchRecord(rootDir, IDENTITY);
  assert.equal(record.launchRequestId, SUCCESSOR);
  assert.equal(record.dispatchId, SUCCESSOR);
  assert.equal(record.gsrRedispatchedFrom, SOURCE);
  // Idempotent: the lease now belongs to the successor, so a retry finds nothing.
  assert.equal(readoptSuspendedAmaCloserLeases(rootDir, {
    launchRequestId: SOURCE, successorLaunchRequestId: SUCCESSOR }).outcome, 'none');
});

test('settled leases and other launches are left alone', t => {
  const rootDir = dispatchedRoot(t, { lrqId: 'lrq_other-0003' });
  assert.equal(readoptSuspendedAmaCloserLeases(rootDir, { launchRequestId: SOURCE }).outcome, 'none');
  updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'terminal', terminalOutcome: 'succeeded' });
  const result = readoptSuspendedAmaCloserLeases(rootDir, { launchRequestId: 'lrq_other-0003' });
  assert.deepEqual(result.leases.map(lease => lease.outcome), ['unchanged']);
  assert.equal(readAmaCloserLease(rootDir, IDENTITY).terminalOutcome, 'succeeded');
});

test('successor adoption finds the original dispatch after multiple rekeys and preserves unrelated records', t => {
  const rootDir = dispatchedRoot(t);
  const middle = 'b'.repeat(40);
  const latest = 'c'.repeat(40);
  for (const [fromHeadSha, toHeadSha] of [[IDENTITY.headSha, middle], [middle, latest]]) {
    assert.equal(rekeyAmaCloserLease({ rootDir, ...IDENTITY, fromHeadSha, toHeadSha }).rekeyed, true);
  }
  const foreignRecord = { ...IDENTITY, headSha: latest, state: 'dispatched', launchRequestId: 'lrq_other' };
  writeFileSync(amaCloserDispatchFilePath(rootDir, foreignRecord), JSON.stringify(foreignRecord));
  const result = readoptSuspendedAmaCloserLeases(rootDir, {
    launchRequestId: SOURCE, successorLaunchRequestId: SUCCESSOR });
  assert.equal(result.outcome, 're-adopted');
  assert.equal(readAmaCloserLease(rootDir, { ...IDENTITY, headSha: latest }).lrqId, SUCCESSOR);
  const record = readAmaCloserDispatchRecord(rootDir, IDENTITY);
  assert.equal(record.launchRequestId, SUCCESSOR);
  assert.equal(record.dispatchId, SUCCESSOR);
  assert.equal(record.gsrRedispatchedFrom, SOURCE);
  assert.deepEqual(readAmaCloserDispatchRecord(rootDir, foreignRecord), foreignRecord);
  assert.equal(readAmaCloserDispatchRecord(rootDir, { ...IDENTITY, headSha: middle }), null);
});

for (const action of ['readopt', 'release']) {
  test(`${action} reports mutation lock contention as busy in the summary`, t => {
    const rootDir = dispatchedRoot(t);
    const fd = openSync(`${amaCloserLeaseFilePath(rootDir, IDENTITY)}.reclaim.lock`, 'a');
    fsExt.flockSync(fd, 'exnb');
    t.after(() => closeSync(fd));
    const result = action === 'readopt'
      ? readoptSuspendedAmaCloserLeases(rootDir, { launchRequestId: SOURCE })
      : releaseSuspendedAmaCloserLeases(rootDir, {
        launchRequestId: SOURCE, readLaunchRequestStatusImpl: probe('failed') });
    assert.equal(result.outcome, 'busy');
    assert.equal(result.leases[0].outcome, 'busy');
    assert.equal(readAmaCloserLease(rootDir, IDENTITY).status, 'dispatched');
  });
}

test('release reports stale ownership as busy and preserves the replacement', t => {
  const rootDir = dispatchedRoot(t);
  const result = releaseSuspendedAmaCloserLeases(rootDir, {
    launchRequestId: SOURCE,
    readLaunchRequestStatusImpl: () => {
      updateAmaCloserLease({ rootDir, ...IDENTITY, status: 'dispatched', lrqId: SUCCESSOR });
      return probe('failed')();
    },
  });
  assert.equal(result.outcome, 'busy');
  assert.equal(result.leases[0].outcome, 'busy');
  assert.equal(readAmaCloserLease(rootDir, IDENTITY).lrqId, SUCCESSOR);
});

test('release frees the lease only once the launch is proven ended', t => {
  const rootDir = dispatchedRoot(t);
  for (const readLaunchRequestStatusImpl of [probe('suspended'), probe('running'),
    probe('blocked_needs_decision'), probe('waiting_input'), probe('waiting_approval'), probe('unknown-status'),
    () => ({ ...probe('failed')(), retryChainUnreadable: true }),
    () => ({ ...probe('failed')(), retryChain: [{ launch_request_id: SUCCESSOR, status: 'blocked_needs_decision' }] }),
    () => { throw new Error('down'); }]) {
    const kept = releaseSuspendedAmaCloserLeases(rootDir, { launchRequestId: SOURCE, readLaunchRequestStatusImpl });
    assert.equal(kept.leases[0].outcome, 'retained');
    assert.equal(readAmaCloserLease(rootDir, IDENTITY).status, 'dispatched');
  }
  const released = releaseSuspendedAmaCloserLeases(rootDir, {
    launchRequestId: SOURCE, readLaunchRequestStatusImpl: probe('failed') });
  assert.equal(released.outcome, 'released');
  const lease = readAmaCloserLease(rootDir, IDENTITY);
  assert.equal(lease.status, 'terminal');
  assert.equal(lease.terminalOutcome, 'superseded');
});

test('the CLI prints one JSON result and refuses an incomplete call', async t => {
  const rootDir = dispatchedRoot(t);
  const printed = [];
  await main(['readopt', '--root-dir', rootDir, '--lrq', SOURCE, '--successor', SUCCESSOR],
    { print: line => printed.push(JSON.parse(line)) });
  assert.equal(printed[0].outcome, 're-adopted');
  assert.equal(printed[0].successorLaunchRequestId, SUCCESSOR);
  await assert.rejects(main(['readopt', '--root-dir', rootDir]), error => error.usage === true);
  await assert.rejects(main(['adopt', '--lrq', SOURCE]), error => error.usage === true);
});

test('cold release CLI registers before a synchronous authenticated ledger read', async t => {
  const rootDir = dispatchedRoot(t);
  const env = { APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/gsr-release' };
  const sdk = dispatchReadTransport.sdk();
  const calls = [];
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    ...sdk,
    connect: async config => {
      calls.push('register');
      assert.equal(config.endpoint_url, env.APP_CONTRACT_ENDPOINT_URL);
      assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, undefined);
      return { sessionToken: 'fixture-session', endpoint_url: config.endpoint_url };
    },
    readDispatchLookupSync: (selector, config) => {
      calls.push('lookup');
      assert.equal(env.ADVERSARIAL_DISPATCH_READS_ENABLED, '1');
      assert.equal(config.session_token, 'fixture-session');
      assert.deepEqual(selector, { launch_request_ids: [SOURCE], include_retry_chain: true });
      return { schema_version: 1, status: 'found', complete: true,
        items: [{ launch_request_id: SOURCE, status: 'failed' }], roots: [SOURCE], retry_edges: [] };
    },
  }));
  const printed = [];
  const result = await main(['release', '--root-dir', rootDir, '--lrq', SOURCE], {
    readOptions: { env }, print: line => printed.push(JSON.parse(line)),
  });
  assert.deepEqual(calls, ['register', 'lookup']);
  assert.equal(result.outcome, 'released');
  assert.deepEqual(printed, [result]);
  assert.equal(readAmaCloserLease(rootDir, IDENTITY).terminalOutcome, 'superseded');
});

test('release CLI refuses failed session preparation without reading or mutating the lease', async t => {
  const rootDir = dispatchedRoot(t);
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    connect: async () => { throw new Error('private bootstrap diagnostics'); },
    readDispatchLookupSync: () => assert.fail('read after failed registration'),
  }));
  const before = readAmaCloserLease(rootDir, IDENTITY);
  await assert.rejects(main(['release', '--root-dir', rootDir, '--lrq', SOURCE], {
    readOptions: { env: { APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/gsr-failure' } },
    print: () => assert.fail('printed a success result'),
  }), { message: 'dispatch-context-unavailable: session-bootstrap-failed' });
  assert.deepEqual(readAmaCloserLease(rootDir, IDENTITY), before);
});
