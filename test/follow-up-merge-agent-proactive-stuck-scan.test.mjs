// Proactive stuck-merge-agent scan tests.
//
// 2026-05-19 incident: PR #719 merge-agent stalled for 33 min under memory
// pressure. The existing 30-min stuck Sentinel alert never fired because
// it depended on a PR-revisit happening AT the right moment. The
// proactive scan added in this PR runs every watcher tick, independent
// of which PRs the watcher happens to be polling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  scanStuckMergeAgentDispatches,
  recordMergeAgentDispatch,
  reconcileProactivePhantomHandoffs,
} from '../src/follow-up-merge-agent.mjs';

const NOW = Date.parse('2026-05-19T03:30:00Z');
const STUCK_LRQ = 'lrq_069112b8-68a3-48d8-acac-46c026c2349c';
const STUCK_DISPATCHED_AT = '2026-05-19T02:47:02.429Z'; // ~43 min before NOW
const TODAY_UTC = '2026-05-19';

function buildAuditFile(hqRoot, lrq, refusalCount) {
  const auditDir = path.join(hqRoot, 'dispatch', 'audit', TODAY_UTC);
  mkdirSync(auditDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < refusalCount; i += 1) {
    lines.push(JSON.stringify({
      actor: 'dispatch-daemon',
      createdAt: '2026-05-19T03:1' + (9 - i) + ':00Z',
      decision: 'refuse_admit_memory_pressure',
      fromState: 'requested',
      launchRequestId: lrq,
      structuredReasons: [
        { reasonCode: 'memory_pressure_elevated', severity: 'warning' },
      ],
    }));
  }
  writeFileSync(path.join(auditDir, `${lrq}.jsonl`), lines.join('\n') + '\n');
}

function writeLifecycleCleanup(rootDir, {
  repo,
  prNumber,
  headSha = null,
  completedAt = null,
  lastResult = { cleanupComplete: false, retryable: true },
}) {
  const cleanupDir = path.join(rootDir, 'data', 'follow-up-jobs', 'merge-agent-lifecycle-cleanups');
  mkdirSync(cleanupDir, { recursive: true });
  writeFileSync(
    path.join(cleanupDir, `${repo.replace(/\//g, '__')}-pr-${prNumber}.json`),
    JSON.stringify({
      schemaVersion: 1,
      repo,
      prNumber,
      headSha,
      transition: 'closed',
      queuedAt: '2026-05-19T03:25:00Z',
      completedAt,
      lastResult,
    }, null, 2) + '\n'
  );
}

test('scanStuckMergeAgentDispatches surfaces a stuck dispatch even when watcher hasn\'t revisited the PR', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    activePRs: [{
      repo: 'laceyenterprises/agent-os',
      prNumber: 719,
      headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
    }],
    hqPath: null,
    now: NOW,
  });

  assert.equal(reports.length, 1, 'one stuck dispatch should be detected');
  const r = reports[0];
  assert.equal(r.repo, 'laceyenterprises/agent-os');
  assert.equal(r.prNumber, 719);
  assert.equal(r.launchRequestId, STUCK_LRQ);
  assert.equal(r.stuckDetail.refusalCount, 6);
  assert.ok(
    r.stuckDetail.stuckForMinutes >= 40,
    `expected stuckForMinutes >= 40, got ${r.stuckDetail.stuckForMinutes}`
  );
  assert.equal(r.stuckDetail.primaryReason, 'memory_pressure_elevated');
});

test('scanStuckMergeAgentDispatches ignores historical dispatches without active lifecycle state', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    now: NOW,
  });

  assert.equal(reports.length, 0, 'historical dispatches should not be rescanned forever');
});

test('scanStuckMergeAgentDispatches includes unresolved lifecycle cleanups even without active label snapshot', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });
  writeLifecycleCleanup(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    hqPath: null,
    now: NOW,
  });

  assert.equal(reports.length, 1, 'unresolved lifecycle cleanup should keep the dispatch eligible');
});

test('scanStuckMergeAgentDispatches ignores completed lifecycle cleanup sidecars', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });
  writeLifecycleCleanup(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
    completedAt: '2026-05-19T03:28:00Z',
    lastResult: { cleanupComplete: true, retryable: false },
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    now: NOW,
  });

  assert.equal(reports.length, 0, 'completed cleanup records must not reactivate old dispatches');
});

test('scanStuckMergeAgentDispatches continues active scans when lifecycle cleanup listing fails', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    activePRs: [{
      repo: 'laceyenterprises/agent-os',
      prNumber: 719,
      headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
    }],
    now: NOW,
    listLifecycleCleanupsImpl: () => {
      throw new Error('cleanup directory temporarily unreadable');
    },
  });

  assert.equal(reports.length, 1, 'active label snapshots should still be scanned');
});

test('scanStuckMergeAgentDispatches only inspects the latest dispatch for an active PR', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const oldLrq = 'lrq_11111111-1111-1111-1111-111111111111';
  const newLrq = 'lrq_22222222-2222-2222-2222-222222222222';
  buildAuditFile(hqRoot, oldLrq, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'old-head',
  }, {
    dispatchedAt: '2026-05-19T01:00:00.000Z',
    prompt: '',
    dispatchId: oldLrq,
    launchRequestId: oldLrq,
    trigger: 'final-pass-on-budget-exhausted',
  });
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'new-head',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: newLrq,
    launchRequestId: newLrq,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    activePRs: [{ repo: 'laceyenterprises/agent-os', prNumber: 719, headSha: 'new-head' }],
    hqPath: null,
    now: NOW,
  });

  assert.equal(reports.length, 0, 'the latest dispatch has no refusal history and should win');
});

test('scanStuckMergeAgentDispatches honors live-state probe so admitted LRQs are not reclassified as stuck', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    activePRs: [{
      repo: 'laceyenterprises/agent-os',
      prNumber: 719,
      headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
    }],
    now: NOW,
    dispatchStateProbe: () => ({ status: 'running' }),
    listLifecycleCleanupsImpl: () => [],
  });

  assert.equal(reports.length, 0);
});

test('scanStuckMergeAgentDispatches reads the keyed active-head dispatch record directly', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  buildAuditFile(hqRoot, STUCK_LRQ, 6);
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot,
    activePRs: [{
      repo: 'laceyenterprises/agent-os',
      prNumber: 719,
      headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
    }],
    hqPath: null,
    now: NOW,
    listLifecycleCleanupsImpl: () => [],
  });

  assert.equal(reports.length, 1);
});

test('scanStuckMergeAgentDispatches returns empty when hqRoot is missing (OSS-safe)', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const reports = scanStuckMergeAgentDispatches({
    rootDir,
    hqRoot: null,
    now: NOW,
  });

  assert.equal(reports.length, 0, 'no hqRoot = no audit-log path; fail closed');
});

test('reconcileProactivePhantomHandoffs starts grace for a terminal current-head orphan outside the dispatched-label set', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });

  const result = await reconcileProactivePhantomHandoffs({
    rootDir,
    currentPRs: [{
      repo: 'laceyenterprises/agent-os',
      prNumber: 719,
      headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
      labels: [],
    }],
    runtimeEnv: { HQ_ROOT: hqRoot },
    hqPath: '/bin/hq-unused',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'failed' }) }),
    ghExecFileImpl: async () => {
      throw new Error('grace start should not post or label');
    },
    now: '2026-05-19T03:30:00.000Z',
  });

  assert.equal(result.inspected, 1);
  assert.equal(result.graceStarted, 1);
  assert.equal(result.escalated, 0);
  const dispatchPath = path.join(
    rootDir,
    'data',
    'follow-up-jobs',
    'merge-agent-dispatches',
    'laceyenterprises__agent-os-pr-719-c055d93d02abfb41fbab56c46ac631982f84fd66.json'
  );
  const recorded = JSON.parse(readFileSync(dispatchPath, 'utf8'));
  assert.equal(recorded.phantomHandoffObservedAt, '2026-05-19T03:30:00.000Z');
  assert.equal(recorded.phantomHandoffCommentDelivery, null);
});

test('reconcileProactivePhantomHandoffs can finish a phantom handoff after the label-add window failed earlier', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: STUCK_DISPATCHED_AT,
    prompt: '',
    dispatchId: STUCK_LRQ,
    launchRequestId: STUCK_LRQ,
    trigger: 'final-pass-on-budget-exhausted',
  });
  const dispatchPath = path.join(
    rootDir,
    'data',
    'follow-up-jobs',
    'merge-agent-dispatches',
    'laceyenterprises__agent-os-pr-719-c055d93d02abfb41fbab56c46ac631982f84fd66.json'
  );
  const existing = JSON.parse(readFileSync(dispatchPath, 'utf8'));
  existing.phantomHandoffObservedAt = '2026-05-19T02:00:00.000Z';
  existing.phantomHandoffCommentDelivery = {
    posted: false,
    reason: 'pending',
    attempts: 0,
    maxAttempts: 5,
    marker: 'marker',
    body: 'body',
    context: {
      repo: existing.repo,
      prNumber: existing.prNumber,
      revisionRef: existing.headSha,
      launchRequestId: existing.launchRequestId,
      dispatchStatus: 'failed',
    },
    attemptedAt: '2026-05-19T02:00:00.000Z',
  };
  writeFileSync(dispatchPath, JSON.stringify(existing, null, 2) + '\n');
  let commentCalls = 0;
  let labelCalls = 0;

  const result = await reconcileProactivePhantomHandoffs({
    rootDir,
    currentPRs: [{
      repo: 'laceyenterprises/agent-os',
      prNumber: 719,
      headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
      labels: [],
    }],
    runtimeEnv: { HQ_ROOT: hqRoot },
    hqPath: '/bin/hq-unused',
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'failed' }) }),
    ghExecFileImpl: async (cmd, args) => {
      if (args[0] === 'api') return { stdout: '' };
      if (args[0] === 'pr' && args[1] === 'edit') {
        labelCalls += 1;
        return { stdout: '' };
      }
      if (args[0] === 'pr' && args[1] === 'comment') {
        commentCalls += 1;
        return { stdout: 'https://github.com/owner/repo/issues/1#issuecomment-3\n' };
      }
      return { stdout: '' };
    },
    now: '2026-05-19T03:30:00.000Z',
  });

  assert.equal(result.inspected, 1);
  assert.equal(result.escalated, 1);
  assert.equal(labelCalls, 1);
  assert.equal(commentCalls, 1);
  const recorded = JSON.parse(readFileSync(dispatchPath, 'utf8'));
  assert.equal(recorded.phantomHandoffCommentDelivery.posted, true);
  assert.equal(recorded.phantomHandoffCommentDelivery.attempts, 1);
});
