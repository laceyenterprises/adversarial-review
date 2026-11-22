import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { main as reserveRepair } from '../bin/repair-in-place.mjs';
import {
  acquireAmaCloserLease, findLiveAmaCloserLease, readAmaCloserLease,
  rekeyAmaCloserLease, updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-record-read.mjs';
import { hammerRetryCapFilePath, recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { cancelMergeAgentDispatch } from '../src/merge-agent-cancel.mjs';
import { pendingRepairEpoch } from '../src/repair-epochs.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const repo = 'example/widgets';
const prNumber = 23;
const original = 'a'.repeat(40);
const intermediate = 'b'.repeat(40);
const current = 'c'.repeat(40);
const launchRequestId = 'lrq_original';
const now = '2026-01-01T00:00:00Z';
const identity = { repo, prNumber };
let endpoint = 0;

function fixture(t, recordOverrides = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'receipted-closer-alias-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const env = { APP_CONTRACT_ENDPOINT_URL: `https://fixture.invalid/alias-${++endpoint}`, HQ_ROOT: rootDir };
  const key = { ...identity, headSha: original, rootDir, now };
  assert.equal(acquireAmaCloserLease(key).acquired, true);
  updateAmaCloserLease({ ...key, status: 'dispatched', lrqId: launchRequestId });
  for (const [fromHeadSha, toHeadSha] of [[original, intermediate], [intermediate, current]]) {
    assert.equal(rekeyAmaCloserLease({ ...key, fromHeadSha, toHeadSha }).rekeyed, true);
  }
  const recordFile = amaCloserDispatchFilePath(rootDir, key);
  mkdirSync(dirname(recordFile), { recursive: true });
  const receipt = { ...identity, headSha: original, targetRemediationSha: original, launchRequestId,
    state: 'launch-terminal', terminalLaunchStatus: 'failed', terminalOutcome: 'superseded',
    retryCount: 3, unexecutedRefundCount: 1, ...recordOverrides };
  const recordBytes = JSON.stringify(receipt);
  writeFileSync(recordFile, recordBytes);

  const leaseKey = { ...key, headSha: current };
  return {
    rootDir, env, leaseKey, recordFile, recordBytes,
    lease: () => readAmaCloserLease(rootDir, leaseKey),
    cancel: () => cancelMergeAgentDispatch({ rootDir, ...identity, env, requestedAt: now,
      ghExecFileImpl: () => assert.fail('AMA custody does not remove the legacy label'),
      hqExecFileImpl: () => assert.fail('AMA custody does not cancel a remote worker') }),
    repair: () => reserveRepair([rootDir, repo, String(prNumber), current, 'repair-fixture', 'false'], { env }),
  };
}

function reply({ row = {}, retries = [], complete = true } = {}) {
  return { schema_version: 1, status: 'found', complete, roots: [launchRequestId],
    items: [{ launch_request_id: launchRequestId, status: 'failed', ticket_ref: `AMA-PR-${prNumber}`,
      target_repo: repo, head_sha: original, failure_class: 'no_work_done', ...row }, ...retries],
    retry_edges: retries.map(child => ({ parent: launchRequestId, child: child.launch_request_id })) };
}

function sdkFixture(t, lookup = () => reply()) {
  const sdk = dispatchReadTransport.sdk();
  const calls = [];
  t.mock.method(dispatchReadTransport, 'sdk', () => ({ ...sdk,
    connect: async config => {
      assert.equal(config.app_id, 'adversarial-review');
      assert.equal(config.mode, 'agent-os');
      return { sessionToken: 'fixture-token', endpoint_url: config.endpoint_url };
    },
    readSessionDispatchLookup: async (selector, config) => {
      assert.deepEqual(selector, { launch_request_ids: [launchRequestId], include_retry_chain: true });
      assert.equal(config.session_token, 'fixture-token');
      assert.ok(config.request_timeout_ms <= 45_000);
      calls.push(selector);
      return lookup();
    },
  }));
  return calls;
}

test('native cancel receipts the released alias and preserves its original history and retry counters', async t => {
  const f = fixture(t);
  recordHammerRetryDispatch(f.rootDir, identity, { launchRequestId, jobKey: original, headSha: original, now });
  const capFile = hammerRetryCapFilePath(f.rootDir, identity);
  const capBefore = readFileSync(capFile);
  const calls = sdkFixture(t);
  assert.equal(f.lease().status, 'dispatched');
  assert.equal(f.lease().rekeyedFromHeadSha, intermediate);

  const result = await f.cancel();
  assert.deepEqual(result.closer, { released: true, reason: 'terminal-closer-alias-released',
    launchStatus: 'failed', failureClass: 'no_work_done', source: 'app-sdk',
    launchRequestId, dispatchHeadSha: original, leaseHeadSha: current });
  assert.equal(result.cancelled, false);
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.lifecycleCleanupQueued, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(result.receiptPath, 'utf8')).result.closer, result.closer);
  assert.equal(findLiveAmaCloserLease(f.rootDir, identity), null);
  assert.equal(readFileSync(f.recordFile, 'utf8'), f.recordBytes);
  assert.deepEqual(readFileSync(capFile), capBefore);
  assert.equal(acquireAmaCloserLease(f.leaseKey).acquired, true);
});

for (const [scenario, response, reason] of [
  ['running root', () => reply({ row: { status: 'running' } }), 'closer-owned-or-unsettled'],
  ['live retry', () => reply({ retries: [{ launch_request_id: 'lrq_retry', status: 'running' }] }), 'closer-owned-or-unsettled'],
  ['parked retry', () => reply({ retries: [{ launch_request_id: 'lrq_retry', status: 'blocked_needs_decision' }] }), 'closer-owned-or-unsettled'],
  ['suspended retry', () => reply({ retries: [{ launch_request_id: 'lrq_retry', status: 'suspended' }] }), 'closer-owned-or-unsettled'],
  ['successful retry', () => reply({ retries: [{ launch_request_id: 'lrq_retry', status: 'succeeded' }] }), 'closer-owned-or-unsettled'],
  ['incomplete retry read', () => reply({ complete: false }), 'closer-read-unavailable'],
  ['foreign dispatch head', () => reply({ row: { head_sha: current } }), 'closer-launch-identity-mismatch'],
  ['foreign repository', () => reply({ row: { target_repo: 'other/widgets' } }), 'closer-launch-identity-mismatch'],
]) {
  test(`${scenario} preserves custody and cannot queue cancellation against another launch`, async t => {
    const f = fixture(t);
    sdkFixture(t, response);
    const before = f.lease();
    const result = await f.cancel();
    assert.equal(result.closer.reason, reason);
    assert.equal(result.retryable, true);
    assert.equal(result.lifecycleCleanupQueued, false);
    assert.deepEqual(f.lease(), before);
    assert.equal(readFileSync(f.recordFile, 'utf8'), f.recordBytes);
  });
}

test('a sticky successful original receipt keeps custody without consulting launcher status', async t => {
  const f = fixture(t, { terminalOutcome: 'succeeded' });
  const calls = sdkFixture(t);
  assert.equal((await f.cancel()).closer.reason, 'closer-success-retained');
  assert.equal(calls.length, 0);
  assert.equal(f.lease().status, 'dispatched');
});

test('a successor on the carried head wins the owner race during the public read', async t => {
  const f = fixture(t);
  sdkFixture(t, () => {
    updateAmaCloserLease({ ...f.leaseKey, status: 'dispatched', lrqId: 'lrq_successor' });
    return reply();
  });
  const result = await f.cancel();
  assert.equal(result.closer.reason, 'closer-owner-changed');
  assert.equal(result.closer.launchRequestId, launchRequestId);
  assert.equal(result.lifecycleCleanupQueued, false);
  assert.equal(f.lease().lrqId, 'lrq_successor');
  assert.equal(readFileSync(f.recordFile, 'utf8'), f.recordBytes);
});

test('native repair admission preserves the alias on unknown evidence and reserves after fresh proof', async t => {
  const f = fixture(t);
  const db = openReviewStateDb(f.rootDir);
  ensureReviewStateSchema(db);
  try {
    db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
      review_status,reviewer_head_sha,rereview_reason) VALUES (?,?,?,'synthetic','open','posted',?,?)`)
      .run(repo, prNumber, now, current, 'closure-retry-exhausted');
  } finally { db.close(); }
  let readable = false;
  sdkFixture(t, () => readable ? reply() : reply({ complete: false }));
  assert.equal((await f.repair()).reason, 'closer-owned-or-unknown');
  assert.equal(pendingRepairEpoch(f.rootDir, identity), null);
  assert.equal(f.lease().lrqId, launchRequestId);

  readable = true;
  const result = await f.repair();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.epoch.baseHead, current);
  assert.equal(f.lease(), null);
  assert.equal(readFileSync(f.recordFile, 'utf8'), f.recordBytes);
});
