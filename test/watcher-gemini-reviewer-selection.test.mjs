// GMW-02 — watcher-side wiring for gemini fallback selection.
//
// `primaryReviewerQuotaCappedForRow` is the HRR quota-exhaustion signal the
// watcher feeds into `applyGeminiReviewerRoute` when `reviewer.gemini.mode`
// is `fallback`. `selectReviewerRouteForAttempt` must pass a gemini-pinned
// baseRoute through untouched (no spurious timeout fallback).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  primaryReviewerQuotaCappedForRow,
  selectReviewerRouteForAttempt,
  shouldBypassPrimaryReviewerQuotaHold,
} from '../src/watcher.mjs';
import { applyGeminiReviewerRoute } from '../src/adapters/subject/github-pr/routing.mjs';

test('GMW-02 watcher: quota-exhausted held row signals primary reviewer capped', () => {
  const recentlyFailed = new Date(Date.now() - 60_000).toISOString();
  const cappedRow = {
    review_status: 'failed',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: recentlyFailed,
  };
  assert.equal(primaryReviewerQuotaCappedForRow(cappedRow), true);
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

test('GMW-02 watcher: fallback wiring end-to-end (capped → gemini, healthy → codex)', () => {
  const baseRoute = {
    builderClass: 'claude-code',
    tag: '[claude-code]',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  };

  const cappedRow = {
    review_status: 'failed',
    failure_message: '[quota-exhausted] hit your usage limit',
    failed_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const capped = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute,
    mode: 'fallback',
    primaryReviewerQuotaCapped: primaryReviewerQuotaCappedForRow(cappedRow),
  });
  assert.equal(capped.reviewerModel, 'gemini');

  const healthy = applyGeminiReviewerRoute({
    builderClass: 'claude-code',
    baseRoute,
    mode: 'fallback',
    primaryReviewerQuotaCapped: primaryReviewerQuotaCappedForRow({ review_status: 'pending' }),
  });
  assert.equal(healthy.reviewerModel, 'codex');
});

test('GMW-02 watcher: fallback gemini route bypasses the primary reviewer quota hold', () => {
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

  assert.equal(shouldBypassPrimaryReviewerQuotaHold(route), true);
  assert.equal(
    shouldBypassPrimaryReviewerQuotaHold({
      ...route,
      geminiReviewerSelection: { mode: 'always-on', reason: 'always-on-third-reviewer' },
    }),
    false,
  );
  assert.equal(shouldBypassPrimaryReviewerQuotaHold(baseRoute), false);
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
