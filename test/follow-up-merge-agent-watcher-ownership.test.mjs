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

test('recovery-first within grace: does NOT re-dispatch or escalate while the handoff window is open', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const dispatchCalls = [];
  const ghCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }), // merge-agent-dispatched cleared => merge-agent claims it handed off
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
    // 30 min after dispatch — inside the 60-min phantom-handoff grace window,
    // so a genuine in-flight recovery is never escalated out from under.
    now: '2026-05-24T00:30:00.000Z',
  });

  assert.equal(result.decision, 'skip-already-dispatched', 'recovery owns it; watcher must not re-dispatch over the handoff');
  assert.equal(dispatchCalls.length, 0);
  assert.ok(
    !ghCalls.some((a) => a.includes('--add-label') && a.includes('merge-agent-stuck')),
    'within the grace window the watcher must NOT escalate to merge-agent-stuck',
  );
  assert.equal(
    listMergeAgentDispatches(rootDir)[0].phantomHandoffObservedAt,
    '2026-05-24T00:30:00.000Z',
    'the grace window must start from the first durable phantom-handoff observation, not dispatch creation time'
  );
});

test('phantom handoff after grace: escalates an orphaned terminal-failed dispatch to merge-agent-stuck (does NOT re-dispatch)', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const dispatchCalls = [];
  const ghCalls = [];

  const firstResult = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    // dispatched marker cleared, NO merge-agent-stuck => phantom handoff: the
    // worker cleared the marker but never established recovery (the #969 orphan).
    ...makeJob({ labels: [] }),
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
    // First detection only starts the durable grace timer.
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(firstResult.decision, 'skip-already-dispatched');
  assert.ok(
    !ghCalls.some((a) => a.includes('--add-label') && a.includes('merge-agent-stuck')),
    'the first phantom-handoff observation must not escalate immediately just because the original dispatch is old',
  );

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
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push(args);
      return { stdout: '' };
    },
    // More than 60 minutes after the first durable observation, still no recovery.
    now: '2026-05-24T05:05:00.000Z',
  });

  assert.equal(result.decision, 'skip-already-dispatched', 'escalation only — the watcher must NOT re-dispatch or merge an orphaned failed worker');
  assert.equal(dispatchCalls.length, 0, 'no re-dispatch: this is fail-loud escalation, not retry');
  assert.ok(
    ghCalls.some((a) => a.includes('--add-label') && a.includes('merge-agent-stuck')),
    'a phantom-handoff orphan past grace must be labeled merge-agent-stuck for the operator',
  );
  assert.ok(
    ghCalls.some((a) => a[0] === 'pr' && a[1] === 'comment'),
    'a durable operator comment must explain the phantom-handoff escalation',
  );
});

test('phantom handoff comment failure is recorded and retried on a later tick', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  let commentAttempts = 0;

  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async () => ({ stdout: '' }),
    now: '2026-05-24T04:00:00.000Z',
  });

  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async (cmd, args) => {
      if (args[0] === 'api') return { stdout: '' };
      if (args[0] === 'pr' && args[1] === 'edit') return { stdout: '' };
      if (args[0] === 'pr' && args[1] === 'comment') {
        commentAttempts += 1;
        throw new Error('transient gh failure');
      }
      return { stdout: '' };
    },
    now: '2026-05-24T05:05:00.000Z',
  });

  let recorded = listMergeAgentDispatches(rootDir)[0];
  assert.equal(recorded.phantomHandoffCommentDelivery.posted, false);
  assert.equal(recorded.phantomHandoffCommentDelivery.attempts, 1);

  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [{ name: 'merge-agent-stuck' }] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async (cmd, args) => {
      if (args[0] === 'api') return { stdout: '' };
      if (args[0] === 'pr' && args[1] === 'comment') {
        commentAttempts += 1;
        return { stdout: 'https://github.com/owner/repo/issues/1#issuecomment-1\n' };
      }
      return { stdout: '' };
    },
    now: '2026-05-24T05:10:00.000Z',
  });

  recorded = listMergeAgentDispatches(rootDir)[0];
  assert.equal(recorded.phantomHandoffCommentDelivery.posted, true);
  assert.equal(recorded.phantomHandoffCommentDelivery.attempts, 2);
  assert.equal(commentAttempts, 2, 'the watcher must retry the owed phantom-handoff comment on later ticks');
});

test('phantom handoff persists owed comment before label add and later converges label plus comment', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const ghCalls = [];

  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async () => ({ stdout: '' }),
    now: '2026-05-24T04:00:00.000Z',
  });

  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'edit') {
        throw new Error('label add failed after ledger write');
      }
      return { stdout: '' };
    },
    now: '2026-05-24T05:05:00.000Z',
  });

  let recorded = listMergeAgentDispatches(rootDir)[0];
  assert.equal(recorded.phantomHandoffCommentDelivery.posted, false);
  assert.equal(recorded.phantomHandoffCommentDelivery.attempts, 0);
  assert.ok(
    ghCalls.some((a) => a.includes('--add-label') && a.includes('merge-agent-stuck')),
    'the watcher should still attempt the stuck label after writing the durable ledger'
  );
  assert.ok(
    !ghCalls.some((a) => a[0] === 'pr' && a[1] === 'comment'),
    'comment delivery must wait until the stuck label converges'
  );

  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    ...makeJob({ labels: [] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push(args);
      if (args[0] === 'api') return { stdout: '' };
      if (args[0] === 'pr' && args[1] === 'edit') return { stdout: '' };
      if (args[0] === 'pr' && args[1] === 'comment') {
        return { stdout: 'https://github.com/owner/repo/issues/1#issuecomment-2\n' };
      }
      return { stdout: '' };
    },
    now: '2026-05-24T05:10:00.000Z',
  });

  recorded = listMergeAgentDispatches(rootDir)[0];
  assert.equal(recorded.phantomHandoffCommentDelivery.posted, true);
  assert.equal(recorded.phantomHandoffCommentDelivery.attempts, 1);
  assert.ok(
    ghCalls.some((a) => a[0] === 'pr' && a[1] === 'comment'),
    'later ticks should finish the owed comment once the stuck label can be applied'
  );
});

test('phantom handoff is idempotent: does not re-escalate when merge-agent-stuck is already present', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = makeHqRoot('airlock');
  seedRecord(rootDir, { watcherReDispatchCount: 0 });
  const ghCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    prepareOriginalWorkerImpl: PROCEED_ORIGINAL_WORKER,
    rootDir,
    // already escalated on a prior tick — must not comment/label again.
    ...makeJob({ labels: [{ name: 'merge-agent-stuck' }] }),
    env: baseEnv(hqRoot),
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'failed' }) };
      }
      return { stdout: '{"dispatchId":"lrq_11111111-1111-1111-1111-111111111111","lrq":"lrq_11111111-1111-1111-1111-111111111111"}\n' };
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push(args);
      return { stdout: '' };
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-operator-skip', 'merge-agent-stuck is an unbypassable operator skip');
  assert.ok(
    !ghCalls.some((a) => a[0] === 'pr' && a[1] === 'comment'),
    'no duplicate escalation comment once merge-agent-stuck is already applied',
  );
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

test('malformed dispatched-label cleanup state fails closed into watcher recovery ownership', async () => {
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
  writeFileSync(
    path.join(
      rootDir,
      'data',
      'follow-up-jobs',
      'merge-agent-lifecycle-cleanups',
      'laceyenterprises__agent-os-pr-849.json',
    ),
    '{ malformed json',
  );
  const dispatchCalls = [];
  const errors = [];

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
    logger: {
      info() {},
      error(message) {
        errors.push(String(message));
      },
    },
    now: '2026-05-24T04:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch', 'malformed cleanup state must not silently wedge on skip-already-dispatched');
  assert.equal(dispatchCalls.length, 1);
  assert.equal(listMergeAgentDispatches(rootDir)[0].watcherReDispatchCount, 1);
  assert.ok(
    errors.some((message) => message.includes('failed to read merge-agent lifecycle cleanup record')),
    'malformed cleanup state must be logged loudly',
  );
});
