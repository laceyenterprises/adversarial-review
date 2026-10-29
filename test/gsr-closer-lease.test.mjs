// GSR-07: boot-time resume hands a suspended closer's lease back. Synthetic
// fixtures only: a temp root, an invented repo and launch ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  acquireAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath, readAmaCloserDispatchRecord } from '../src/ama/dispatch-record-read.mjs';
import {
  readoptSuspendedAmaCloserLeases,
  releaseSuspendedAmaCloserLeases,
} from '../src/ama/gsr-closer-lease.mjs';
import { main } from '../bin/gsr-closer-lease.mjs';

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

test('release frees the lease only once the launch is proven ended', t => {
  const rootDir = dispatchedRoot(t);
  for (const readLaunchRequestStatusImpl of [probe('suspended'), probe('running'), () => { throw new Error('down'); }]) {
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

test('the CLI prints one JSON result and refuses an incomplete call', t => {
  const rootDir = dispatchedRoot(t);
  const printed = [];
  main(['readopt', '--root-dir', rootDir, '--lrq', SOURCE, '--successor', SUCCESSOR],
    { print: line => printed.push(JSON.parse(line)) });
  assert.equal(printed[0].outcome, 're-adopted');
  assert.equal(printed[0].successorLaunchRequestId, SUCCESSOR);
  assert.throws(() => main(['readopt', '--root-dir', rootDir]), error => error.usage === true);
  assert.throws(() => main(['adopt', '--lrq', SOURCE]), error => error.usage === true);
});
