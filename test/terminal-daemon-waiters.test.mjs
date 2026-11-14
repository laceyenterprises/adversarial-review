import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parse } from 'acorn';
import {
  acquireMergeLease, daemonMergeWaiterId, mergeLeaseFilePath, readMergeLeaseWaiters,
  readDaemonMergeLeaseWaiters, releaseMergeLease, upsertMergeLeaseWaiter,
} from '../src/ama/merge-lease.mjs';
import { reconcileTerminalDaemonWaiters } from '../src/ama/terminal-daemon-waiters.mjs';
import { cancelCloserForTerminalPr } from '../src/ama/closer-terminal-cancel.mjs';
import { fetchPollingPrState } from '../src/polling-pr-state.mjs';
import { reconcileTerminalPrState } from '../src/pr-terminal-reconcile.mjs';

const head = '1402fdffb8d4d9bdd12ce3701eba60dbeecb78e3';
const otherHead = 'b'.repeat(40);
const live = { state: 'MERGED', headRefOid: head, baseRefName: 'main',
  mergedAt: '2026-11-14T07:05:30Z' };

function fixture(t, { holder = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'terminal-daemon-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const lane = { rootDir, repo: 'fixture/repo', base: 'main' };
  const held = holder ? acquireMergeLease({ ...lane, holderPr: 77, holderHead: otherHead,
    holderPid: process.pid, holderHost: hostname() }) : null;
  const now = new Date().toISOString();
  const waiterArgs = { ...lane, pr: 10793, head, waiterId: daemonMergeWaiterId(10793, head),
    priority: 'daemon', holderPid: process.pid, holderHost: hostname(),
    effectiveDeadlineSeconds: 3600, arrivedAt: now, updatedAt: now };
  const original = upsertMergeLeaseWaiter(waiterArgs).waiter;
  const next = upsertMergeLeaseWaiter({ ...lane, pr: 10789, head: otherHead,
    waiterId: 'next-closer', holderPid: process.pid, holderHost: hostname(),
    effectiveDeadlineSeconds: 3600, arrivedAt: now, updatedAt: now }).waiter;
  const sibling = upsertMergeLeaseWaiter({ ...waiterArgs, pr: 10794, head: otherHead,
    waiterId: daemonMergeWaiterId(10794, otherHead) }).waiter;
  return { lane, waiterArgs, original, next, sibling, held };
}

test('external merge leaves a dormant reservation in the old no-closer path; reconciliation restores FIFO with live PID', async t => {
  const { lane, original, next, sibling } = fixture(t);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  // This is the deployed lifecycle callback; LAC-2087's posted evaluator
  // does not run once the mirror is terminal.
  assert.equal((await cancelCloserForTerminalPr({ ...lane, prNumber: 10793,
    transition: 'merged', live })).reason, 'no-live-closer');
  const contender = { ...lane, holderPr: 10789, holderHead: otherHead,
    holderPid: process.pid, holderHost: hostname(), waiterId: next.waiterId, registerWaiter: true };
  assert.equal(acquireMergeLease(contender).acquired, false,
    'main/deployed callback leaves an empty lane blocked behind the merged PR');
  assert.deepEqual(readMergeLeaseWaiters(lane.rootDir, lane)[0], original);
  const octokit = { rest: { pulls: { get: async params => {
    assert.equal(params.owner, 'fixture');
    assert.equal(params.repo, 'repo');
    assert.equal(params.pull_number, 10793);
    return { status: 200, headers: {}, data: { state: 'closed',
      merged_at: live.mergedAt, head: { sha: head }, base: { ref: 'main' } } };
  } } } };
  const result = await reconcileTerminalDaemonWaiters({ ...lane,
    fetchLiveState: async (repo, pr) => pr === 10793
      ? fetchPollingPrState(octokit, lane.rootDir, repo, pr) : { state: 'OPEN' } });
  assert.equal(result.removed, 1);
  // Acquiring refreshed the next request, but did not alter arrival or order.
  const survivors = readMergeLeaseWaiters(lane.rootDir, lane);
  assert.deepEqual(survivors.map(w => w.waiterId), [next.waiterId, sibling.waiterId]);
  assert.equal(survivors[0].arrivedAt, next.arrivedAt);
  assert.deepEqual(survivors[1], sibling);
  assert.equal(acquireMergeLease(contender).acquired, true);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('refresh during terminal read survives exact snapshot CAS and is reconsidered next poll without open rows', async t => {
  const { lane, waiterArgs, next, sibling } = fixture(t);
  let refreshed;
  const result = await reconcileTerminalDaemonWaiters({ ...lane, fetchLiveState: async (_repo, pr) => {
    if (pr !== 10793) return { state: 'OPEN' };
    refreshed = upsertMergeLeaseWaiter({ ...waiterArgs, attempt: 2,
      updatedAt: new Date(Date.now() + 1).toISOString() }).waiter;
    return live;
  } });
  assert.equal(result.removed, 0);
  assert.deepEqual(readMergeLeaseWaiters(lane.rootDir, lane), [refreshed, next, sibling]);
  assert.equal((await reconcileTerminalDaemonWaiters({ ...lane,
    fetchLiveState: async (_repo, pr) => pr === 10793 ? live : { state: 'OPEN' } })).removed, 1);
});

for (const [name, state] of [
  ['open', { ...live, state: 'OPEN', mergedAt: null }],
  ['unknown', null],
  ['wrong head', { ...live, headRefOid: otherHead }],
  ['wrong base', { ...live, baseRefName: 'release' }],
  ['missing base', { ...live, baseRefName: null }],
  ['read failure', new Error('offline unavailable')],
]) {
  test(`${name} evidence preserves every waiter byte`, async t => {
    const { lane, original, next, sibling } = fixture(t);
    const result = await reconcileTerminalDaemonWaiters({ ...lane, logger: { warn() {} },
      fetchLiveState: async (_repo, pr) => {
        if (pr !== 10793) return { state: 'OPEN' };
        if (state instanceof Error) throw state;
        return state;
      } });
    assert.equal(result.removed, 0);
    assert.deepEqual(readMergeLeaseWaiters(lane.rootDir, lane), [original, next, sibling]);
  });
}

test('confirmed closed reservation is removed while a live holder and other waiters remain unchanged', async t => {
  const { lane, next, sibling, held } = fixture(t, { holder: true });
  assert.equal(held.acquired, true);
  const path = mergeLeaseFilePath(lane.rootDir, lane);
  const before = readFileSync(path, 'utf8');
  assert.equal((await reconcileTerminalDaemonWaiters({ ...lane,
    fetchLiveState: async (_repo, pr) => pr === 10793
      ? { ...live, state: 'CLOSED', mergedAt: null } : { state: 'OPEN' } })).removed, 1);
  assert.deepEqual(readMergeLeaseWaiters(lane.rootDir, lane), [next, sibling]);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(releaseMergeLease({ ...lane, leaseId: 'wrong', holderPr: 77,
    holderHead: otherHead, acquiredAt: held.lease.acquiredAt }).released, false);
});

test('poll lifecycle scans waiters before the empty open-row return', () => {
  const source = readFileSync(new URL('../src/pr-lifecycle-sync.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function syncPRLifecycle('));
  assert.ok(body.indexOf('await reconcileTerminalDaemonWaiters(') >= 0);
  assert.ok(body.indexOf('await reconcileTerminalDaemonWaiters(') < body.indexOf('if (openRows.length === 0)'));
});

test('daemon waiter reader rejects missing, blank and non-string roots explicitly', () => {
  assert.throws(() => readDaemonMergeLeaseWaiters(), {
    message: 'merge lease: rootDir must be a non-empty string',
  });
  for (const rootDir of [undefined, null, '', ' ', 42, {}]) {
    assert.throws(() => readDaemonMergeLeaseWaiters({ rootDir }), {
      message: 'merge lease: rootDir must be a non-empty string',
    });
  }
});

for (const failFirstRead of [false, true]) {
  test(`lifecycle shares ${failFirstRead ? 'failed' : 'open'} waiter reads and revalidates next poll`, async t => {
    const { lane, original, next, sibling } = fixture(t);
    const calls = new Map();
    const observed = [];
    let fail = failFirstRead;
    // Execute the production orchestration function with isolated storage and
    // injected I/O; both reconcilers and waiter CAS remain the real code.
    const source = readFileSync(new URL('../src/pr-lifecycle-sync.mjs', import.meta.url), 'utf8');
    const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body
      .find(node => node.declaration?.id?.name === 'syncPRLifecycle').declaration;
    const sync = runInNewContext(`(${source.slice(declaration.start, declaration.end)})`, {
      ROOT: lane.rootDir,
      stmtGetOpenPRs: { all: () => [10793, 42].map(pr_number => ({ repo: lane.repo, pr_number })) },
      fetchPollingPrState: async (_octokit, rootDir, repo, prNumber) => {
        assert.equal(rootDir, lane.rootDir);
        const key = `${repo}#${prNumber}`;
        calls.set(key, (calls.get(key) || 0) + 1);
        if (fail && prNumber === 10793) throw new Error('offline unavailable');
        return { ...live, state: 'OPEN', mergedAt: null, labels: [] };
      },
      reconcileTerminalDaemonWaiters,
      reconcileTerminalPrState,
      observeClosureLag: async state => observed.push(state.prNumber),
      persistReconcileAttestation() {},
      logLifecycleReconcileSummary() {},
      console: { warn() {} },
    });
    const first = await sync({}, {});
    assert.equal(first.stillOpen, failFirstRead ? 1 : 2);
    assert.equal(first.unresolvedCount, failFirstRead ? 1 : 0);
    for (const pr of [10793, 10794, 42]) assert.equal(calls.get(`${lane.repo}#${pr}`), 1);
    assert.deepEqual(observed, failFirstRead ? [42] : [10793, 42]);
    fail = false;
    const second = await sync({}, {});
    assert.equal(second.stillOpen, 2);
    assert.equal(second.unresolvedCount, 0);
    for (const pr of [10793, 10794, 42]) assert.equal(calls.get(`${lane.repo}#${pr}`), 2);
    assert.deepEqual(readMergeLeaseWaiters(lane.rootDir, lane), [original, next, sibling]);
  });
}
