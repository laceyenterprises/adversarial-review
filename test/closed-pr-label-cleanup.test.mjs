import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lifecycle from '../src/merge-agent-lifecycle-cleanup.mjs';
import { cancelMergeAgentDispatchOnMerge, listMergeAgentLifecycleCleanups, upsertMergeAgentLifecycleCleanup } from '../src/follow-up-merge-agent.mjs';

const identity = { repo: 'example/alpha', prNumber: 7 };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'closed-label-'));
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => { console.log = original; rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, logs };
}

test('GHSCOPE-01: closed label cleanup stops at its failure cap, backs off, and records exhaustion once', async t => {
  const { rootDir, logs } = fixture(t);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const cap = lifecycle.CLOSED_PR_LABEL_REMOVAL_MAX_FAILURES || 5;
  let calls = 0;
  upsertMergeAgentLifecycleCleanup(rootDir, { ...identity, transition: 'closed' });
  const cancelImpl = async () => {
    calls++;
    return { ...identity, attemptedAt: new Date(now).toISOString(), cancelled: true,
      labelRemovalAttempted: true, labelRemoved: false, labelRemovalError: 'synthetic transport failure',
      cleanupComplete: false, retryable: true };
  };
  for (let attempt = 0; attempt < cap; attempt++) {
    await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, nowMs: now, retryMs: 1000 });
    assert.equal(calls, attempt + 1);
    await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, nowMs: now + 999, retryMs: 1000 });
    assert.equal(calls, attempt + 1, 'no retry before backoff expires');
    now += 60 * 60_000;
  }
  for (let poll = 0; poll < 10; poll++) {
    await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, nowMs: now, retryMs: 0 });
  }
  assert.equal(calls, cap);
  const [record] = listMergeAgentLifecycleCleanups(rootDir, { includeCompleted: true });
  assert.equal(record.labelRemovalFailures, cap);
  assert.equal(record.lastResult.labelRemovalAbandoned, true);
  assert.equal(record.lastResult.labelRemoved, false, 'giving up is not a successful mutation');
  assert.equal(logs.filter(line => line.includes('label cleanup exhausted')).length, 1);
  // A later lifecycle snapshot and historical dispatch must not re-arm it.
  upsertMergeAgentLifecycleCleanup(rootDir, { ...identity, transition: 'merged' });
  await lifecycle.attemptMergeAgentLifecycleCleanup({ rootDir, ...identity, cancelImpl });
  assert.equal(calls, cap);
});

test('GHSCOPE-01: a rate-limited closed-label failure waits for reset and does not consume an attempt', async t => {
  const { rootDir } = fixture(t);
  let now = Date.parse('2026-01-01T00:00:00Z');
  const resetAt = new Date(now + 10 * 60_000).toISOString();
  let calls = 0;
  upsertMergeAgentLifecycleCleanup(rootDir, { ...identity, transition: 'merged' });
  const cancelImpl = async () => {
    calls++;
    return { ...identity, attemptedAt: new Date(now).toISOString(), cancelled: true,
      labelRemoved: false, labelRemovalAttempted: true, labelRemovalError: 'synthetic rate limit',
      rateLimited: true, retryAfter: resetAt, cleanupComplete: false, retryable: true };
  };
  await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, nowMs: now, retryMs: 0 });
  assert.equal(listMergeAgentLifecycleCleanups(rootDir)[0].labelRemovalFailures, 0);
  now += 60_000;
  await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, nowMs: now, retryMs: 0 });
  assert.equal(calls, 1);
  now = Date.parse(resetAt);
  await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, nowMs: now, retryMs: 0 });
  assert.equal(calls, 2);
});

test('GHSCOPE-01: an authoritative absent label needs no GitHub mutation after close', async t => {
  const { rootDir } = fixture(t);
  const result = await cancelMergeAgentDispatchOnMerge({ rootDir, ...identity, labelAbsent: true,
    listImpl: () => [], ghExecFileImpl: async () => assert.fail('absent label must not spend GitHub budget'),
    env: { AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: 'false' },
  });
  assert.equal(result.labelRemoved, true);
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.retryable, false);
});

test('GHSCOPE-01: the real removal helper propagates the response reset to durable cleanup pacing', async t => {
  const { rootDir } = fixture(t);
  const { withGitHubBudgetScope } = await import('../src/rate-limit-throttle.mjs');
  const now = Date.now();
  const reset = Math.ceil(now / 1000) + 600;
  let calls = 0;
  upsertMergeAgentLifecycleCleanup(rootDir, { ...identity, transition: 'closed' });
  const cancelImpl = args => cancelMergeAgentDispatchOnMerge({ ...args, listImpl: () => [],
    env: { GH_TOKEN: 'synthetic-cleanup-token', AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: 'false' },
    ghExecFileImpl: async () => {
      calls++;
      throw Object.assign(new Error('GraphQL: API rate limit exceeded'), {
        stderr: `* Request at fixture\n< HTTP/2.0 429\n< X-Ratelimit-Resource: graphql\n< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: ${reset}\n* Request took 1ms\n`,
      });
    },
  });
  await withGitHubBudgetScope({}, () => lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, nowMs: now, cancelImpl }));
  const [record] = listMergeAgentLifecycleCleanups(rootDir);
  assert.equal(record.labelRemovalFailures, 0);
  assert.equal(record.nextAttemptAt, new Date(reset * 1000).toISOString());
  await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, nowMs: now + 60_000, cancelImpl });
  assert.equal(calls, 1);
});

test('GHSCOPE-01: completion survives historical requeue but a new dispatch owns fresh cleanup', async t => {
  const { rootDir } = fixture(t);
  const { recordMergeAgentDispatch } = await import('../src/follow-up-merge-agent.mjs');
  const recordDispatch = (launchRequestId, dispatchedAt) => recordMergeAgentDispatch(rootDir,
    { ...identity, headSha: 'fixture-head' }, { launchRequestId, dispatchedAt });
  recordDispatch('synthetic-dispatch-a', '2026-01-01T00:00:00Z');
  const request = { rootDir, ...identity, transition: 'closed', pr: { headRefOid: 'fixture-head', labels: [] } };
  lifecycle.queueMergeAgentLifecycleCleanup(request);
  let calls = 0;
  const cancelImpl = async ({ labelAbsent }) => {
    calls++;
    assert.equal(labelAbsent, true);
    return { ...identity, cancelled: true, labelRemoved: true, cleanupComplete: true, retryable: false };
  };
  await lifecycle.attemptMergeAgentLifecycleCleanup({ rootDir, ...identity, cancelImpl });
  assert.equal(lifecycle.queueMergeAgentLifecycleCleanup(request), null);
  await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, retryMs: 0 });
  assert.equal(calls, 1);
  recordDispatch('synthetic-dispatch-b', '2026-01-01T01:00:00Z');
  assert.ok(lifecycle.queueMergeAgentLifecycleCleanup(request));
  await lifecycle.retryPendingMergeAgentLifecycleCleanups({ rootDir, cancelImpl, retryMs: 0 });
  assert.equal(calls, 2);
});
