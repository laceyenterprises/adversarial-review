import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordHammerProgress, HAMMER_PROGRESS_MILESTONES } from '../src/ama/hammer-progress.mjs';
import { loadConfig } from '../src/config-loader.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger, evaluateHammerRetryCap } from '../src/ama/hammer-retry-cap.mjs';
import { classifyDeadHammerCause } from '../src/ama/dead-hammer-rearm.mjs';
import { writeFileSync } from 'node:fs';

test('milestones are fixed, durable, run-bound and do not move on repetition', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-progress-'));
  try {
    const env = { HQ_ROOT: root, HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HQ_WORKER_RUN_ID: 'wrun_fixture' };
    for (const milestone of HAMMER_PROGRESS_MILESTONES) {
      const first = recordHammerProgress(milestone, { env, reason: 'checks-red', now: new Date('2026-01-01T00:00:00Z') });
      const repeated = recordHammerProgress(milestone, { env, reason: 'merge-error', now: new Date('2026-01-02T00:00:00Z') });
      const receipt = JSON.parse(readFileSync(join(root, 'dispatch/lrq_fixture/hammer-progress/wrun_fixture',
        `${milestone}.json`)));
      assert.equal(receipt.at, '2026-01-01T00:00:00.000Z');
      assert.equal(receipt.runId, 'wrun_fixture');
      assert.equal(receipt.launchRequestId, 'lrq_fixture');
      assert.equal(receipt.milestone, milestone);
      assert.deepEqual(first, receipt);
      assert.deepEqual(repeated, receipt);
    }
    assert.throws(() => recordHammerProgress('tool-call', { env }));
    assert.throws(() => recordHammerProgress('terminal-stop', { env }));
    assert.throws(() => recordHammerProgress('verify-head', { env: { ...env, HQ_WORKER_RUN_ID: '../escape' } }));
    assert.throws(() => recordHammerProgress('verify-head', { env: { ...env, AGENT_OS_WORKER_LRQ_ID: 'lrq_other' } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('strict Node schema mirrors the closer budget defaults and overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-config-'));
  const topPath = join(root, 'config.yaml');
  try {
    writeFileSync(topPath, 'version: 1\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('worker_pool.hammer_limits.outcome_seconds'), 3600);
    assert.equal(cfg.get('worker_pool.hammer_limits.wall_seconds'), 10800);
    assert.equal(cfg.get('worker_pool.hammer_limits.tokens'), 40_000_000);
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  hammer_limits:\n    tokens: 42\n');
    assert.equal(loadConfig({ topPath, env: {} }).get('worker_pool.hammer_limits.tokens'), 42);
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  hammer_limits:\n    tokens: 0\n');
    assert.throws(() => loadConfig({ topPath, env: {} }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('supervisor stops remain charged to the per-PR lifetime ceiling across fresh heads', () => {
  const root = mkdtempSync(join(tmpdir(), 'hammer-lifetime-'));
  const identity = { repo: 'example/project', prNumber: 17 };
  try {
    for (const [index, cause] of ['hammer-no-outcome-progress', 'hammer-wall-clock-exceeded',
      'hammer-token-ceiling-exceeded'].entries()) {
      const head = String(index + 1).repeat(40);
      recordHammerRetryDispatch(root, identity, { jobKey: head, headSha: head,
        launchRequestId: `lrq_fixture-${index}`, lifetimeDispatchCeiling: 3 });
      assert.equal(classifyDeadHammerCause({ failureClass: cause }).infra, false);
    }
    const ledger = readHammerRetryCapLedger(root, identity);
    assert.equal(ledger.lifetimeAttemptCount, 3);
    assert.equal(evaluateHammerRetryCap(ledger, { jobKey: '4'.repeat(40), headSha: '4'.repeat(40),
      lifetimeDispatchCeiling: 3 }).lifetimeCapExhausted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
