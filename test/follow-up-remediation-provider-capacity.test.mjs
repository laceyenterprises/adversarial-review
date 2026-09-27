import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned,
} from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-reconcile.mjs';
import { hasTerminalProviderCapacitySignal } from '../src/provider-capacity-signal.mjs';

let previousHqRoot;
let previousMaxRetries;

beforeEach(() => {
  previousHqRoot = process.env.HQ_ROOT;
  previousMaxRetries = process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES;
  process.env.HQ_ROOT = mkdtempSync(path.join(tmpdir(), 'capacity-hq-'));
});

afterEach(() => {
  if (previousHqRoot === undefined) delete process.env.HQ_ROOT;
  else process.env.HQ_ROOT = previousHqRoot;
  if (previousMaxRetries === undefined) delete process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES;
  else process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = previousMaxRetries;
});

async function reconcileDeadWorker(logText, { artifactText = null } = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'capacity-job-'));
  createFollowUpJob({
    rootDir, repo: 'laceyenterprises/clio', prNumber: 7,
    reviewerModel: 'claude', reviewBody: '## Summary\nFix the finding.',
    reviewPostedAt: '2026-06-16T08:00:00.000Z', critical: true,
  });
  const claimed = claimNextFollowUpJob({ rootDir, claimedAt: '2026-06-16T10:00:00.000Z' });
  const workspaceDir = path.join(rootDir, 'data', 'follow-up-jobs', 'workspaces', claimed.job.jobId);
  const artifactDir = path.join(workspaceDir, '.adversarial-follow-up');
  mkdirSync(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, 'codex-worker.log');
  const outputPath = path.join(artifactDir, 'codex-last-message.md');
  writeFileSync(logPath, logText);
  if (artifactText !== null) writeFileSync(outputPath, artifactText);
  const spawned = markFollowUpJobSpawned({
    jobPath: claimed.jobPath, spawnedAt: '2026-06-16T10:01:00.000Z',
    worker: {
      processId: 8123, model: 'codex',
      workspaceDir: path.relative(rootDir, workspaceDir),
      outputPath: path.relative(rootDir, outputPath),
      logPath: path.relative(rootDir, logPath),
      promptPath: path.relative(rootDir, path.join(artifactDir, 'prompt.md')),
    },
  });
  const result = await reconcileFollowUpJob({
    rootDir, jobPath: spawned.jobPath,
    now: () => '2026-06-16T10:05:00.000Z',
    isProcessAliveImpl: () => false,
    resolvePRLifecycleImpl: async () => null,
  });
  return { result, workspaceDir: path.relative(rootDir, workspaceDir) };
}

test('capacity turn.failed requeues with backoff and preserved workspace for resume', async () => {
  const { result, workspaceDir } = await reconcileDeadWorker(
    '{"type":"error","message":"Selected model is at capacity. Please try a different model."}\n'
      + '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}\n'
  );
  assert.equal(result.reconciled, false);
  assert.equal(result.reason, 'provider-capacity');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.workspaceDir, workspaceDir);
  assert.equal(result.job.remediationPlan.retryAfter, '2026-06-16T10:10:00.000Z');
  assert.equal(result.job.remediationPlan.transientRetries, 1);
  assert.equal(result.job.remediationPlan.retryHistory.at(-1).retryMetadata.code, 'provider-capacity');
  assert.equal(result.job.remediationPlan.retryHistory.at(-1).worker.workspaceDir, workspaceDir);
});

test('capacity after transient budget exhaustion fails with provider-capacity', async () => {
  process.env.ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES = '0';
  const { result } = await reconcileDeadWorker('{"type":"turn.failed","error":{"message":"backend overloaded"}}\n');
  assert.equal(result.reconciled, true);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.job.failure.code, 'provider-capacity');
});

test('missing artifact without capacity still fails as artifact-missing-completion', async () => {
  const { result } = await reconcileDeadWorker('{"type":"error","message":"Invalid request"}\n');
  assert.equal(result.reconciled, true);
  assert.equal(result.job.failure.code, 'artifact-missing-completion');
});

test('recovered Codex capacity error followed by turn completion remains an artifact failure', async () => {
  const { result } = await reconcileDeadWorker(
    '{"type":"error","message":"unexpected status 503 from provider"}\n'
      + '{"type":"turn.completed","usage":{"input_tokens":1}}\n'
  );
  assert.equal(result.reconciled, true);
  assert.equal(result.job.failure.code, 'artifact-missing-completion');
});

test('retried Claude capacity error followed by normal output remains an artifact failure', async () => {
  const { result } = await reconcileDeadWorker('API Error: 529 overloaded · Retrying...\nCompleted task.\n');
  assert.equal(result.reconciled, true);
  assert.equal(result.job.failure.code, 'artifact-missing-completion');
});

test('successful Claude result closes the capacity scan', async () => {
  const { result } = await reconcileDeadWorker(
    '{"type":"error","message":"API Error: 529 overloaded"}\n'
      + '{"type":"result","is_error":false,"result":"done"}\n'
  );
  assert.equal(result.job.failure.code, 'artifact-missing-completion');
});

test('unrelated error event does not match provider capacity', () => {
  assert.equal(hasTerminalProviderCapacitySignal('{"type":"error","message":"Invalid request"}'), false);
  assert.equal(hasTerminalProviderCapacitySignal('{"type":"turn.failed","error":{"message":"Invalid request"}}'), false);
  assert.equal(hasTerminalProviderCapacitySignal(
    '{"type":"error","message":"provider overloaded"}\n'
      + '{"type":"turn.failed","error":{"message":"Invalid request"}}'
  ), false);
});

test('structured status codes and plain stderr overload signals match', () => {
  for (const code of [429, 503, 529]) {
    assert.equal(hasTerminalProviderCapacitySignal(`{"type":"error","status":${code}}`), true);
  }
  assert.equal(hasTerminalProviderCapacitySignal('API Error 529: overloaded_error'), true);
  assert.equal(hasTerminalProviderCapacitySignal('Claude provider is overloaded'), true);
});

test('bare PR and source line numbers do not count as capacity diagnostics', () => {
  for (const line of ['pull/529', '#529', 'file.mjs:529']) {
    assert.equal(hasTerminalProviderCapacitySignal(line), false);
  }
});

test('capacity with empty completion artifact still requeues', async () => {
  const { result } = await reconcileDeadWorker('{"type":"turn.failed","message":"Selected model is at capacity"}', { artifactText: '' });
  assert.equal(result.reason, 'provider-capacity');
  assert.equal(result.job.status, 'pending');
});
