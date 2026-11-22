import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { main as reserveRepair } from '../bin/repair-in-place.mjs';
import {
  acquireAmaCloserLease, amaCloserLeaseFilePath, findLiveAmaCloserLease, readAmaCloserLease,
  rekeyAmaCloserLease, updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-record-read.mjs';
import { hammerRetryCapFilePath, recordHammerRetryDispatch } from '../src/ama/hammer-retry-cap.mjs';
import { tryAcquireCloserIntentLock } from '../src/ama/pre-receipt-intent.mjs';
import { dispatchReadTransport } from '../src/dispatch-read-client.mjs';
import { recordMergeAgentDispatch } from '../src/follow-up-merge-agent.mjs';
import { cancelMergeAgentDispatch } from '../src/merge-agent-cancel.mjs';
import { pendingRepairEpoch } from '../src/repair-epochs.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

const repo = 'laceyenterprises/widgets';
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
  const env = { APP_CONTRACT_ENDPOINT_URL: `https://fixture.invalid/alias-${++endpoint}`, HQ_ROOT: rootDir,
    AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0' };
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
    cancel: (options = {}) => cancelMergeAgentDispatch({ rootDir, ...identity, env, requestedAt: now,
      ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
      hqExecFileImpl: () => assert.fail('an AMA launch is never sent to merge-agent cancellation'),
      ...options }),
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
  assert.equal(result.labelRemoved, true);
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

test('alias settlement retains custody when a listed lease cannot be read during the locked scan', async t => {
  const f = fixture(t);
  sdkFixture(t, () => {
    const missing = amaCloserLeaseFilePath(f.rootDir, { ...identity, headSha: 'd'.repeat(40) });
    symlinkSync(`${missing}.absent`, missing);
    return reply();
  });
  assert.equal((await f.cancel()).closer.reason, 'closer-settlement-unavailable');
  assert.equal(f.lease().lrqId, launchRequestId);
});

test('alias settlement retains custody when the current-head dispatch record is unreadable', async t => {
  const f = fixture(t);
  sdkFixture(t, () => {
    writeFileSync(amaCloserDispatchFilePath(f.rootDir, f.leaseKey), '{');
    return reply();
  });
  assert.equal((await f.cancel()).closer.reason, 'closer-settlement-unavailable');
  assert.equal(f.lease().lrqId, launchRequestId);
});

test('alias settlement deletes the exact stored snapshot after a repository rename', async t => {
  const f = fixture(t);
  const newRepo = 'laceyenterprises/renamed-widgets';
  const lease = f.lease();
  const oldPath = amaCloserLeaseFilePath(f.rootDir, lease);
  const newPath = amaCloserLeaseFilePath(f.rootDir, { ...lease, repo: newRepo });
  writeFileSync(newPath, JSON.stringify(lease));
  rmSync(oldPath);
  writeFileSync(join(f.rootDir, 'data', 'repository-names.json'), JSON.stringify([
    { name: repo, current: newRepo, repository_id: 1 },
  ]));
  sdkFixture(t);
  assert.equal((await f.cancel({ repo: newRepo })).closer.released, true);
  assert.equal(f.lease(), null);
});

for (const [scenario, ordinaryLease, expectedCloser, legacyLabelFails, cleanupComplete] of [
  ['ordinary lease', true, 'closer-owned-or-unsettled', false, false],
  ['terminal alias', false, 'terminal-closer-alias-released', false, true],
  ['terminal alias with a label error', false, 'terminal-closer-alias-released', true, false],
]) {
  test(`operator cancel sends only the recorded merge-agent LRQ with ${scenario} custody`, async t => {
    const f = fixture(t);
    if (ordinaryLease) {
      const path = amaCloserLeaseFilePath(f.rootDir, f.leaseKey);
      const lease = f.lease();
      delete lease.rekeyedFromHeadSha;
      delete lease.supersededHeads;
      writeFileSync(path, JSON.stringify(lease));
    }
    recordMergeAgentDispatch(f.rootDir, { ...identity, headSha: current }, {
      dispatchedAt: now, launchRequestId: 'lrq_merge_agent',
    });
    const calls = sdkFixture(t);
    const commands = [];
    const result = await f.cancel({
      hqExecFileImpl: async (_, args) => { commands.push(args); return { stdout: '', stderr: '' }; },
      ghExecFileImpl: async (_, args) => {
        commands.push(args);
        if (legacyLabelFails) throw new Error('fixture label failure');
        return { stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(commands, [
      ['dispatch', 'cancel', 'lrq_merge_agent'],
      ['pr', 'edit', String(prNumber), '--repo', repo, '--remove-label', 'merge-agent-dispatched'],
    ]);
    assert.equal(result.cancelled, true);
    assert.equal(result.labelRemoved, !legacyLabelFails);
    assert.equal(result.closer.reason, expectedCloser);
    assert.equal(result.cleanupComplete, cleanupComplete);
    assert.equal(result.retryable, !cleanupComplete);
    assert.equal(result.lifecycleCleanupQueued, false);
    assert.equal(calls.length, ordinaryLease ? 0 : 1);
  });
}

function seedRepairFacts(f) {
  const db = openReviewStateDb(f.rootDir);
  ensureReviewStateSchema(db);
  try {
    db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,
      review_status,reviewer_head_sha,rereview_reason) VALUES (?,?,?,'synthetic','open','posted',?,?)`)
      .run(repo, prNumber, now, current, 'closure-retry-exhausted');
  } finally { db.close(); }
}

test('native repair admission preserves the alias on unknown evidence and reserves after fresh proof', async t => {
  const f = fixture(t);
  seedRepairFacts(f);
  let readable = false;
  sdkFixture(t, () => {
    const release = tryAcquireCloserIntentLock(f.rootDir, identity);
    assert.ok(release, 'intent lock must be free during the alias lookup');
    release();
    return readable ? reply() : reply({ complete: false });
  });
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

test('native repair uses terminal ledger evidence without deleting an alias that has no terminal receipt', async t => {
  const f = fixture(t, { state: 'dispatched' });
  seedRepairFacts(f);
  let status = 'running';
  sdkFixture(t, () => reply({ row: { status } }));
  const before = f.lease();
  assert.equal((await f.repair()).reason, 'closer-owned-or-unknown');
  assert.equal(pendingRepairEpoch(f.rootDir, identity), null);

  status = 'failed';
  const result = await f.repair();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.lease(), before);
  assert.equal(readFileSync(f.recordFile, 'utf8'), f.recordBytes);
});
