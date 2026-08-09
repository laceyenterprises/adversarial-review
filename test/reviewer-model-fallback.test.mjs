import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recordCascadeFailure } from '../src/reviewer-cascade.mjs';
import { selectReviewerRouteForAttempt } from '../src/reviewer-route-selection.mjs';

function geminiAlwaysOnRoute() {
  return {
    builderClass: 'codex',
    tag: '[codex]',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    geminiReviewerSelection: {
      mode: 'always-on',
      replacedReviewerModel: 'claude',
      reason: 'always-on-third-reviewer',
    },
  };
}

function selectAfterFailures({
  failures,
  row = {},
  grounding = null,
  headSha = 'head-1',
  failureClass = 'reviewer-timeout',
} = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'reviewer-model-fallback-'));
  const repo = 'laceyenterprises/agent-os';
  const prNumber = 5111;
  try {
    for (let i = 0; i < failures; i += 1) {
      recordCascadeFailure(rootDir, {
        repo,
        prNumber,
        failedAt: `2026-08-09T12:0${i}:00.000Z`,
        failureClass,
      });
    }
    return selectReviewerRouteForAttempt({
      rootDir,
      repoPath: repo,
      prNumber,
      subject: { builderClass: 'codex' },
      baseRoute: geminiAlwaysOnRoute(),
      currentRow: {
        review_status: 'pending-upstream',
        reviewer: 'gemini',
        reviewer_head_sha: headSha,
        ...row,
      },
      headSha,
      env: {},
      afhGrounding: grounding,
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function selectFromFailedRow(row = {}) {
  return selectReviewerRouteForAttempt({
    rootDir: '/nonexistent-reviewer-model-fallback-root',
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5111,
    subject: { builderClass: 'codex' },
    baseRoute: geminiAlwaysOnRoute(),
    currentRow: {
      review_status: 'failed',
      reviewer: 'gemini',
      reviewer_head_sha: 'head-1',
      failure_message: '[unknown] Command failed with code null signal SIGKILL',
      ...row,
    },
    headSha: 'head-1',
    env: {},
  });
}

test('reviewer exec fallback does not switch on the first transient failure', () => {
  const route = selectAfterFailures({ failures: 1 });
  assert.equal(route.reviewerModel, 'gemini');
  assert.equal(route.reviewerModelFallback, undefined);
});

test('reviewer exec fallback switches after repeated same-model failures on the same head', () => {
  const route = selectAfterFailures({ failures: 2 });
  assert.equal(route.reviewerModel, 'claude');
  assert.equal(route.botTokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(route.reviewerModelFallback.fromReviewerModel, 'gemini');
  assert.equal(route.reviewerModelFallback.toReviewerModel, 'claude');
  assert.equal(route.reviewerModelFallback.failureClass, 'reviewer-timeout');
  assert.equal(route.reviewerModelFallback.failureCount, 2);
});

test('reviewer exec fallback uses row-level command-failed retry count for SIGKILL loops', () => {
  const firstFailure = selectFromFailedRow({ infra_auto_recover_attempts: 0 });
  assert.equal(firstFailure.reviewerModel, 'gemini');
  assert.equal(firstFailure.reviewerModelFallback, undefined);

  const secondFailure = selectFromFailedRow({ infra_auto_recover_attempts: 1 });
  assert.equal(secondFailure.reviewerModel, 'claude');
  assert.equal(secondFailure.reviewerModelFallback.failureClass, 'reviewer-command-failed');
  assert.equal(secondFailure.reviewerModelFallback.failureCount, 2);
});

test('reviewer exec fallback is keyed to the current head and failed model', () => {
  const staleHead = selectAfterFailures({
    failures: 2,
    row: { reviewer_head_sha: 'old-head' },
    headSha: 'new-head',
  });
  assert.equal(staleHead.reviewerModel, 'gemini');
  assert.equal(staleHead.reviewerModelFallback, undefined);

  const differentReviewer = selectAfterFailures({
    failures: 2,
    row: { reviewer: 'codex' },
  });
  assert.equal(differentReviewer.reviewerModel, 'gemini');
  assert.equal(differentReviewer.reviewerModelFallback, undefined);
});

test('reviewer exec fallback fails closed when no healthy alternative is available', () => {
  const route = selectAfterFailures({
    failures: 2,
    grounding: {
      available: true,
      providers: {
        anthropic: { state: 'exhausted', hardGrounded: true, softGrounded: false },
        openai: { state: 'exhausted', hardGrounded: true, softGrounded: false },
      },
    },
  });
  assert.equal(route.reviewerModel, 'gemini');
  assert.equal(route.reviewerModelFallback, undefined);
  assert.equal(route.reviewerModelFallbackSkipped.reason, 'no-healthy-alternative');
  assert.equal(route.reviewerModelFallbackSkipped.attempted.length >= 1, true);
});
