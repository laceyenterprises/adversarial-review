import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS,
  DEFAULT_AGY_PRINT_TIMEOUT_MS,
  DEFAULT_PROGRESS_TIMEOUT_MS,
  DEFAULT_REVIEWER_TIMEOUT_MS,
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
} from '../src/reviewer-timeout.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';

// Guards the subprocess timeout that protects spawnCaptured around the
// reviewer CLI calls. Raised 10m -> 20m on 2026-05-10 after PR #331 hit
// the 10m wall on a substantive spec diff. A future revert that drops
// it below 20m needs to fail this test, not silently shorten review
// budgets again. The progress timeout guards the separate no-output watchdog.
test('default reviewer timeout is 20 minutes', () => {
  assert.equal(DEFAULT_REVIEWER_TIMEOUT_MS, 20 * 60 * 1000);
});

test('resolveReviewerTimeoutMs falls back to default when env is unset', () => {
  assert.equal(resolveReviewerTimeoutMs({}), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs honors a positive env override', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '60000' }), 60000);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '1800000' }), 1800000);
});

test('resolveReviewerTimeoutMs falls back for integer non-positive overrides', () => {
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '0' }), DEFAULT_REVIEWER_TIMEOUT_MS);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '-1000' }), DEFAULT_REVIEWER_TIMEOUT_MS);
});

test('resolveReviewerTimeoutMs fails loud for non-integer env overrides', () => {
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '120000.7' }),
    AgentOSConfigError
  );
});

test('default reviewer progress timeout is 15 minutes', () => {
  assert.equal(DEFAULT_PROGRESS_TIMEOUT_MS, 15 * 60 * 1000);
});

test('resolveProgressTimeoutMs follows the reviewer env override parser shape', () => {
  assert.equal(resolveProgressTimeoutMs({}), DEFAULT_PROGRESS_TIMEOUT_MS);
  assert.equal(resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500' }), 2500);
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '2500.9' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: '0' }),
    AgentOSConfigError
  );
  assert.throws(
    () => resolveProgressTimeoutMs({ ADVERSARIAL_REVIEWER_PROGRESS_TIMEOUT_MS: 'nope' }),
    AgentOSConfigError
  );
});

test('default agy print timeout is independent of shared reviewer timeout', () => {
  assert.equal(DEFAULT_AGY_PRINT_TIMEOUT_MS, 19 * 60 * 1000);
  assert.equal(resolveAgyPrintTimeoutMs({}), DEFAULT_AGY_PRINT_TIMEOUT_MS);
  assert.equal(
    resolveAgyPrintTimeoutMs({ AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1500000' }),
    1_500_000,
  );
  assert.equal(
    resolveAgyPrintTimeoutMs({ ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1250000' }),
    1_250_000,
  );
});

test('agy reviewer subprocess timeout is never shorter than agy print timeout', () => {
  assert.equal(AGY_PRINT_TIMEOUT_SUBPROCESS_SLACK_MS, 30_000);
  assert.equal(
    resolveAgyReviewerSubprocessTimeoutMs(
      { AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1500000' },
      { reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS },
    ),
    1_530_000,
  );
  assert.equal(
    resolveAgyReviewerSubprocessTimeoutMs(
      { AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '60000' },
      { reviewerTimeoutMs: DEFAULT_REVIEWER_TIMEOUT_MS },
    ),
    DEFAULT_REVIEWER_TIMEOUT_MS,
  );
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginReviewerPass, reviewerPassRows, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { reapRunningReviewerPasses, resolveRunningPassTimeoutSeconds } from '../src/watcher-reaper.mjs';

test('resolveRunningPassTimeoutSeconds honors env overrides', () => {
  assert.equal(resolveRunningPassTimeoutSeconds({}), 3600);
  assert.equal(resolveRunningPassTimeoutSeconds({ AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS: '1800' }), 1800);
  assert.equal(resolveRunningPassTimeoutSeconds({ ADVERSARIAL_REVIEW_RUNNING_PASS_TIMEOUT_SECONDS: '7200' }), 7200);
  assert.throws(() => resolveRunningPassTimeoutSeconds({ AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS: 'invalid' }));
});

test('reapRunningReviewerPasses transitions old running passes to failed', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reaper-test-'));
  try {
    const now = Date.now();
    const oldDate = new Date(now - 4000 * 1000).toISOString();
    const recentDate = new Date(now - 1000 * 1000).toISOString();

    beginReviewerPass(rootDir, {
      repo: 'org/repo1',
      prNumber: 1,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: oldDate,
    });
    beginReviewerPass(rootDir, {
      repo: 'org/repo2',
      prNumber: 2,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: recentDate,
    });
    // Add an already-completed old pass to ensure it is not touched
    beginReviewerPass(rootDir, {
      repo: 'org/repo3',
      prNumber: 3,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: oldDate,
    });
    completeReviewerPass(rootDir, {
      repo: 'org/repo3',
      prNumber: 3,
      attemptNumber: 1,
      passKind: 'first-pass',
      status: 'completed',
    });

    const env = { AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS: '3600' };
    const logs = [];
    const logger = { log: (msg) => logs.push(msg) };

    const reaped = reapRunningReviewerPasses(rootDir, logger, env);
    assert.equal(reaped, 1);

    const rows = reviewerPassRows(rootDir);
    assert.equal(rows.length, 3);
    const oldRow = rows.find(r => r.pr_number === 1);
    const newRow = rows.find(r => r.pr_number === 2);
    const completedRow = rows.find(r => r.pr_number === 3);

    assert.equal(oldRow.status, 'failed');
    assert.ok(oldRow.metadata_json.includes('running-pass-timeout'));
    assert.ok(oldRow.ended_at !== null); // completed correctly

    assert.equal(newRow.status, 'running');
    assert.equal(completedRow.status, 'completed');

    assert.ok(logs.some(l => l.includes('status running->failed reason=running-pass-timeout')));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
