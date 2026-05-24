import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  dispatchMergeAgentForPR,
  listMergeAgentDispatches,
  recordMergeAgentDispatch,
  updateMergeAgentLifecycleCleanup,
  upsertMergeAgentLifecycleCleanup,
} from '../src/follow-up-merge-agent.mjs';

const AGENT_OS_PRESENT_STUB = () => ({ present: true, source: 'test' });
const PROCEED_ORIGINAL_WORKER = () => ({ decision: 'ready' });

function makeHqRoot(owner = 'airlock') {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'hq-root-'));
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: owner }));
  return hqRoot;
}

function makeJob(overrides = {}) {
  return {
    repo: 'laceyenterprises/agent-os',
    prNumber: 849,
    branch: 'claude-code/x',
    baseBranch: 'main',
    headSha: 'head-sha-1',
    lastVerdict: 'Comment only',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    prState: 'open',
    merged: false,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 1,
    remediationMaxRounds: 1,
    operatorApproval: null,
    ...overrides,
  };
}

function seedRecord(rootDir, { watcherReDispatchCount = 0 } = {}) {
  recordMergeAgentDispatch(rootDir, makeJob(), {
    dispatchedAt: '2026-05-24T00:00:00.000Z',
    prompt: 'seed',
    dispatchId: 'lrq_94ae724b-9546-4e0c-afd3-a752304a1138',
    launchRequestId: 'lrq_94ae724b-9546-4e0c-afd3-a752304a1138',
    trigger: null,
    watcherReDispatchCount,
  });
}

function baseEnv(hqRoot) {
  return {
    HQ_ROOT: hqRoot,
    USER: 'airlock',
    MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
    MERGE_AGENT_HQ_PROJECT: 'merge-project',
  };
}

test('watcher owns outcome: re-dispatches a died-without-handoff failed worker and passes --as-owner', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const statusCalls = [];
  const dispatchCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [{ name: 'merge-agent-dispatched' }] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        statusCalls.push(args);
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      dispatchCalls.push(args);
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch', 'a died-without-handoff failed worker must be re-dispatched');
  assert.equal(dispatchCalls.length, 1, 'exactly one re-dispatch');
  assert.ok(
    statusCalls.length >= 1 && statusCalls[0].includes('--as-owner') && statusCalls[0].includes('airlock'),
    'status probe must pass --as-owner <hq owner> so the cross-account status is visible'
  );
  const records = listMergeAgentDispatches(rootDir);
  assert.equal(records[0].watcherReDispatchCount, 1, 're-dispatch increments the bounded budget');
});

test('recovery-first: does NOT re-dispatch when the merge-agent already handed off (dispatched marker cleared)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const dispatchCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }), // merge-agent-dispatched cleared => merge-agent escalated on its own
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      dispatchCalls.push(args);
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-already-dispatched', 'recovery owns it; watcher must not re-dispatch over the handoff');
  assert.equal(dispatchCalls.length, 0);
});

test('bounded: at the re-dispatch bound, hands off to operator via merge-agent-stuck instead of looping', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 2 }); // == _WATCHER_REDISPATCH_BOUND
  const dispatchCalls = [];
  const ghCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [{ name: 'merge-agent-dispatched' }] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      dispatchCalls.push(args);
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push(args);
      return { stdout: '' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-already-dispatched', 'bound exhausted => no re-dispatch');
  assert.equal(dispatchCalls.length, 0);
  assert.ok(
    ghCalls.some((a) => a.includes('--add-label') && a.includes('merge-agent-stuck')),
    'exhausting the bound must apply merge-agent-stuck for the operator'
  );
});

test('not-found dispatch (reaped) is treated as re-dispatchable under watcher ownership', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const dispatchCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [{ name: 'merge-agent-dispatched' }] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        // mirror `hq dispatch status` for a reaped id: exit 1 + not-found stderr
        const err = new Error('Command failed');
        err.code = 1;
        err.stderr = '[hq] no dispatch with id: lrq_94ae724b-9546-4e0c-afd3-a752304a1138 (or owned by another account)\n';
        throw err;
      }
      dispatchCalls.push(args);
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch', 'a reaped (not-found) dispatch is no longer live => safe to re-dispatch');
  assert.equal(dispatchCalls.length, 1);
});

test('not-found fails closed when HQ owner resolution degraded and --as-owner cannot be proven', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'hq-root-'));
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({}));
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const dispatchCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [{ name: 'merge-agent-dispatched' }] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        const err = new Error('Command failed');
        err.code = 1;
        err.stderr = '[hq] no dispatch with id: lrq_94ae724b-9546-4e0c-afd3-a752304a1138 (or owned by another account)\n';
        throw err;
      }
      dispatchCalls.push(args);
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-already-dispatched', 'without proven --as-owner visibility the watcher must fail closed');
  assert.equal(dispatchCalls.length, 0);
});

test('failed worker is still reclaimed when dispatched-label add cleanup is pending', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo: makeJob().repo,
    prNumber: makeJob().prNumber,
    transition: 'dispatched-label-add',
    headSha: makeJob().headSha,
    queuedAt: '2026-05-24T00:00:01.000Z',
  });
  updateMergeAgentLifecycleCleanup(rootDir, {
    repo: makeJob().repo,
    prNumber: makeJob().prNumber,
    attemptedAt: '2026-05-24T00:00:02.000Z',
    result: {
      attempted: true,
      cleanupComplete: false,
      retryable: true,
      transition: 'dispatched-label-add',
      labelAdded: false,
      labelAddError: 'github 502',
    },
  });
  const dispatchCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      dispatchCalls.push(args);
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch', 'pending dispatched-label cleanup must not wedge retry ownership');
  assert.equal(dispatchCalls.length, 1);
  const records = listMergeAgentDispatches(rootDir);
  assert.equal(records[0].watcherReDispatchCount, 1);
});
