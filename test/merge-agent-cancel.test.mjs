import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cancelMergeAgentDispatch,
  parseArgs,
} from '../src/merge-agent-cancel.mjs';

test('parseArgs resolves repo, PR, hq override, and reason', () => {
  assert.deepEqual(parseArgs([
    '--repo=laceyenterprises/agent-os',
    '--pr',
    '401',
    '--hq=/opt/hq',
    'operator',
    'hold',
  ]), {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    hqPath: '/opt/hq',
    reason: 'operator hold',
  });
});

test('cancelMergeAgentDispatch delegates to merge-agent cleanup and writes receipt', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const calls = [];
  const result = await cancelMergeAgentDispatch({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    hqPath: '/usr/local/bin/hq',
    requestedAt: '2026-05-24T16:00:00.000Z',
    requestedBy: 'placey',
    reason: 'operator hold',
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    hqExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    cancelImpl: async (request) => {
      calls.push(request);
      return {
        attempted: true,
        repo: request.repo,
        prNumber: request.prNumber,
        attemptedAt: request.now,
        launchRequestId: 'lrq_merge',
        cancelled: true,
        cancelError: null,
        labelRemoved: true,
        labelRemovalError: null,
        cleanupComplete: true,
        retryable: false,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].hqPath, '/usr/local/bin/hq');
  assert.equal(calls[0].repo, 'laceyenterprises/agent-os');
  assert.equal(calls[0].prNumber, 401);
  assert.equal(calls[0].now, '2026-05-24T16:00:00.000Z');
  assert.equal(result.cancelled, true);
  assert.equal(result.launchRequestId, 'lrq_merge');
  assert.ok(result.receiptPath.includes('/data/follow-up-jobs/merge-agent-cancellations/'));
  assert.equal(existsSync(result.receiptPath), true);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'adversarial-review-merge-agent-cancellation');
  assert.equal(receipt.reason, 'operator hold');
  assert.equal(receipt.result.cleanupComplete, true);
  assert.equal(receipt.lifecycleCleanupQueued, false);
});

test('cancelMergeAgentDispatch queues watcher cleanup when operator cancel is retryable', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = await cancelMergeAgentDispatch({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    requestedAt: '2026-05-24T16:05:00.000Z',
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    hqExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    cancelImpl: async () => ({
      attempted: true,
      repo: 'laceyenterprises/agent-os',
      prNumber: 401,
      attemptedAt: '2026-05-24T16:05:00.000Z',
      launchRequestId: 'lrq_merge',
      cancelled: true,
      cancelError: null,
      labelRemoved: false,
      labelRemovalError: 'gh unavailable',
      cleanupComplete: false,
      retryable: true,
    }),
  });

  assert.equal(result.lifecycleCleanupQueued, true);
  const cleanupPath = path.join(
    rootDir,
    'data',
    'follow-up-jobs',
    'merge-agent-lifecycle-cleanups',
    'laceyenterprises__agent-os-pr-401.json'
  );
  assert.equal(existsSync(cleanupPath), true);
  const cleanup = JSON.parse(readFileSync(cleanupPath, 'utf8'));
  assert.equal(cleanup.transition, 'operator-cancel');
  assert.equal(cleanup.lastResult.retryable, true);
});
