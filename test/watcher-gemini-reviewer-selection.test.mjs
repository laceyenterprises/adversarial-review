// GMW-02 — watcher-side wiring for gemini fallback selection.
//
// `primaryReviewerQuotaCappedForRow` is the HRR quota-exhaustion signal the
// watcher feeds into `applyGeminiReviewerRoute` when `reviewer.gemini.mode`
// is `fallback`. `selectReviewerRouteForAttempt` must pass a gemini-pinned
// baseRoute through untouched (no spurious timeout fallback).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  primaryReviewerQuotaCappedForRow,
  resolveGeminiReviewerModeForWatcher,
  selectReviewerRouteForAttempt,
  shouldBypassPrimaryReviewerQuotaHold,
} from '../src/watcher.mjs';
import { applyGeminiReviewerRoute } from '../src/adapters/subject/github-pr/routing.mjs';

test('GMW-02 watcher: quota-exhausted held row signals primary reviewer capped', () => {
  const recentlyFailed = new Date(Date.now() - 60_000).toISOString();
  const cappedRow = {
    review_status: 'failed',
    reviewer: 'codex',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: recentlyFailed,
  };
  assert.equal(primaryReviewerQuotaCappedForRow(cappedRow), true);
  assert.equal(
    primaryReviewerQuotaCappedForRow(cappedRow, { expectedReviewerModel: 'codex' }),
    true,
  );
});

test('GMW-02 watcher: non-quota / healthy rows do not signal capped', () => {
  assert.equal(primaryReviewerQuotaCappedForRow(null), false);
  assert.equal(primaryReviewerQuotaCappedForRow({ review_status: 'pending' }), false);
  assert.equal(
    primaryReviewerQuotaCappedForRow({
      review_status: 'failed',
      failure_message: '[reviewer-timeout] no progress',
      failed_at: new Date().toISOString(),
    }),
    false,
  );
});

test('GMW-02 watcher: an elapsed quota window no longer signals capped', () => {
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago, past 15m window
  assert.equal(
    primaryReviewerQuotaCappedForRow({
      review_status: 'failed',
      failure_message: '[quota-exhausted] hit your usage limit',
      failed_at: longAgo,
    }),
    false,
  );
});

test('GMW-02 watcher: Gemini quota failure does not masquerade as primary quota cap', () => {
  const recentlyFailed = new Date(Date.now() - 60_000).toISOString();
  const geminiCappedRow = {
    review_status: 'failed',
    reviewer: 'gemini',
    reviewer_model: 'gemini',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: recentlyFailed,
  };

  assert.equal(
    primaryReviewerQuotaCappedForRow(geminiCappedRow, { expectedReviewerModel: 'codex' }),
    false,
  );
  assert.equal(
    primaryReviewerQuotaCappedForRow(geminiCappedRow, { expectedReviewerModel: 'gemini' }),
    true,
  );
});

test('GMW-02 watcher: fallback wiring end-to-end (capped → gemini, healthy → codex)', () => {
  const baseRoute = {
    builderClass: 'claude-code',
    tag: '[claude-code]',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  };

  const cappedRow = {
    review_status: 'failed',
    reviewer: 'codex',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const capped = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute,
    mode: 'fallback',
    primaryReviewerQuotaCapped: primaryReviewerQuotaCappedForRow(cappedRow, {
      expectedReviewerModel: baseRoute.reviewerModel,
    }),
  });
  assert.equal(capped.reviewerModel, 'gemini');

  const healthy = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute,
    mode: 'fallback',
    primaryReviewerQuotaCapped: primaryReviewerQuotaCappedForRow({ review_status: 'pending' }),
  });
  assert.equal(healthy.reviewerModel, 'codex');

  const geminiCappedRow = {
    ...cappedRow,
    reviewer: 'gemini',
  };
  const geminiAlreadyCapped = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute,
    mode: 'fallback',
    primaryReviewerQuotaCapped: primaryReviewerQuotaCappedForRow(geminiCappedRow, {
      expectedReviewerModel: baseRoute.reviewerModel,
    }),
  });
  assert.equal(geminiAlreadyCapped.reviewerModel, 'codex');
});

test('AGR-06 routing: fallback injects gemini only on primary cap; always-on injects immediately', () => {
  const baseRoute = {
    builderClass: 'codex',
    tag: '[codex]',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  };

  assert.equal(
    applyGeminiReviewerRoute({
      builderClass: 'codex',
      baseRoute,
      mode: 'fallback',
      primaryReviewerQuotaCapped: false,
    }).reviewerModel,
    'claude',
  );
  assert.equal(
    applyGeminiReviewerRoute({
      builderClass: 'codex',
      baseRoute,
      mode: 'fallback',
      primaryReviewerQuotaCapped: true,
    }).reviewerModel,
    'gemini',
  );
  assert.equal(
    applyGeminiReviewerRoute({
      builderClass: 'codex',
      baseRoute,
      mode: 'always-on',
      primaryReviewerQuotaCapped: false,
    }).reviewerModel,
    'gemini',
  );
});

test('GMW-02 watcher: fallback gemini route bypasses the original primary reviewer quota hold', () => {
  const baseRoute = {
    builderClass: 'claude-code',
    tag: '[claude-code]',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  };
  const route = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute,
    mode: 'fallback',
    primaryReviewerQuotaCapped: true,
  });
  const primaryCappedRow = {
    review_status: 'failed',
    reviewer: 'codex',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const geminiCappedRow = {
    ...primaryCappedRow,
    reviewer: 'gemini',
  };

  assert.equal(shouldBypassPrimaryReviewerQuotaHold(route, primaryCappedRow), true);
  // If a stale/reordered path ever rewrites reviewer=gemini before spawn, this
  // row must not be mistaken for primary-reviewer quota evidence.
  assert.equal(shouldBypassPrimaryReviewerQuotaHold(route, geminiCappedRow), false);
  assert.equal(
    shouldBypassPrimaryReviewerQuotaHold({
      ...route,
      geminiReviewerSelection: { mode: 'always-on', reason: 'always-on-third-reviewer' },
    }, primaryCappedRow),
    true,
  );
  assert.equal(shouldBypassPrimaryReviewerQuotaHold(baseRoute, primaryCappedRow), false);
});

test('GMW-02 watcher: always-on gemini bypasses replaced primary quota holds only', () => {
  const route = {
    builderClass: 'claude-code',
    tag: '[claude-code]',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    geminiReviewerSelection: {
      mode: 'always-on',
      replacedReviewerModel: 'codex',
      reason: 'always-on-third-reviewer',
    },
  };
  const primaryCappedRow = {
    review_status: 'failed',
    reviewer: 'codex',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const geminiCappedRow = {
    ...primaryCappedRow,
    reviewer: 'gemini',
  };

  assert.equal(shouldBypassPrimaryReviewerQuotaHold(route, primaryCappedRow), true);
  assert.equal(shouldBypassPrimaryReviewerQuotaHold(route, geminiCappedRow), false);
});

test('GMW-02 watcher: invalid gemini mode resolution fails closed to off', () => {
  const failure = new Error('reviewer.gemini.mode must be one of: off, fallback, always-on');
  const resolved = resolveGeminiReviewerModeForWatcher({
    env: { ADVERSARIAL_REVIEW_GEMINI_REVIEWER_MODE: 'typo' },
    resolver() {
      throw failure;
    },
  });

  assert.equal(resolved.mode, 'off');
  assert.equal(resolved.error, failure);
});

test('GMW-02 watcher: existing-row routing updates happen only after spawn claim', () => {
  const source = readFileSync(new URL('../src/watcher.mjs', import.meta.url), 'utf8');
  const createRowStart = source.indexOf('if (!existing) {\n        stmtCreateReviewRow.run(');
  const currentRead = source.indexOf('const current = stmtGetReviewRow.get(repoPath, prNumber);', createRowStart);
  assert.notEqual(createRowStart, -1);
  assert.notEqual(currentRead, -1);
  const preGateBlock = source.slice(createRowStart, currentRead);
  assert.doesNotMatch(preGateBlock, /stmtUpdateReviewRouting\.run/);

  const claimWin = source.indexOf('if (claim.changes === 0) {');
  const infraLog = source.indexOf('if (infraRecoveryClass) {', claimWin);
  assert.notEqual(claimWin, -1);
  assert.notEqual(infraLog, -1);
  const postClaimBlock = source.slice(claimWin, infraLog);
  assert.match(postClaimBlock, /stmtUpdateReviewRouting\.run\(route\.reviewerModel/);
});

test('GMW-02 watcher: selectReviewerRouteForAttempt passes a gemini route through', () => {
  const geminiRoute = {
    builderClass: 'claude-code',
    tag: '[claude-code]',
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    geminiReviewerSelection: { mode: 'always-on', replacedReviewerModel: 'codex', reason: 'always-on-third-reviewer' },
  };
  // No cascade state on disk for this synthetic repo → threshold path is a
  // no-op and the route is returned unchanged.
  const selected = selectReviewerRouteForAttempt({
    subject: { builderClass: 'claude-code' },
    baseRoute: geminiRoute,
    rootDir: '/nonexistent-gmw-02-root',
    repoPath: 'acme/widgets',
    prNumber: 1,
    env: {},
  });
  assert.equal(selected.reviewerModel, 'gemini');
  assert.equal(selected.botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
});
