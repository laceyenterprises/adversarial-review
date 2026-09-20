import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing as routeTesting } from '../src/reviewer-route-selection.mjs';

// Regression cover for the cross-model reviewer freeze of 2026-09-20.
//
// `transientFailureBreakdown` is keyed ONLY by failure class, with no model
// dimension. It is reviewer-agnostic on purpose: it drives the PR-level HOLD,
// which should apply to every eligible reviewer. But reviewerExecFailureSignal
// also read it to decide whether to route a SPECIFIC model away — answering a
// model-specific question with model-agnostic data.
//
// Observed: claude failed `quota-exhausted` twice on a PR, setting
// breakdown['quota-exhausted']=2. The next selection of GEMINI read that same 2
// against a threshold of 2 and failed gemini out —
// `gemini class=quota-exhausted count=2/2`. Gemini was selected 1852 times and
// produced ZERO reviews in six hours while claude carried the entire lane.
//
// This is the same cross-model freeze the code already documents for the
// 2026-08-23 codex-cap incident ("held for FOUR DAYS against gemini, which was
// uncapped and idle"), arriving through the failure COUNT rather than the retry
// TIME that was fixed then.

const { reviewerExecFailureCount, reviewerExecFailureSignal } = routeTesting;

test('one model’s failures are not counted against another', () => {
  const cascadeState = {
    transientFailureBreakdown: { 'quota-exhausted': 2 },
    transientFailureBreakdownByModel: { claude: { 'quota-exhausted': 2 } },
    lastFailureClass: 'quota-exhausted',
    lastFailureModel: 'claude',
  };
  assert.equal(reviewerExecFailureCount(cascadeState, 'quota-exhausted', 'claude'), 2);
  assert.equal(
    reviewerExecFailureCount(cascadeState, 'quota-exhausted', 'gemini'),
    0,
    'gemini must not inherit claude’s quota failures',
  );
});

test('the failing model still accumulates its own count', () => {
  const cascadeState = {
    transientFailureBreakdownByModel: { claude: { 'quota-exhausted': 3 } },
  };
  assert.equal(reviewerExecFailureCount(cascadeState, 'quota-exhausted', 'claude'), 3);
});

test('legacy state with no per-model data falls back to the flat map', () => {
  // Cascade-state files written before this change must keep their existing
  // (conservative) behaviour rather than resetting counts to zero mid-outage.
  const legacy = {
    transientFailureBreakdown: { 'reviewer-timeout': 4 },
    lastFailureClass: 'reviewer-timeout',
  };
  assert.equal(reviewerExecFailureCount(legacy, 'reviewer-timeout', 'gemini'), 4);
  assert.equal(reviewerExecFailureCount(legacy, 'reviewer-timeout', 'claude'), 4);
});

test('mixed state counts unattributed flat failures after per-model data exists', () => {
  const cascadeState = {
    transientFailureBreakdown: {
      'quota-exhausted': 1,
      'reviewer-timeout': 2,
    },
    transientFailureBreakdownByModel: {
      claude: { 'quota-exhausted': 1 },
    },
    lastFailureClass: 'reviewer-timeout',
    lastFailureModel: 'claude',
  };
  assert.equal(
    reviewerExecFailureCount(cascadeState, 'quota-exhausted', 'gemini'),
    0,
    'gemini must not inherit claude’s attributed quota failure',
  );
  assert.equal(
    reviewerExecFailureCount(cascadeState, 'reviewer-timeout', 'gemini'),
    2,
    'gemini must still see flat-only reviewer-timeout failures from unattributed writers',
  );
});

test('mixed state adds only the flat-map remainder to a model’s own count', () => {
  const cascadeState = {
    transientFailureBreakdown: { 'reviewer-timeout': 3 },
    transientFailureBreakdownByModel: {
      gemini: { 'reviewer-timeout': 1 },
      claude: { 'reviewer-timeout': 1 },
    },
  };
  assert.equal(reviewerExecFailureCount(cascadeState, 'reviewer-timeout', 'gemini'), 2);
  assert.equal(reviewerExecFailureCount(cascadeState, 'reviewer-timeout', 'codex'), 1);
});

test('signal does not prioritise a lastFailureClass belonging to a different model', () => {
  const cascadeState = {
    transientFailureBreakdown: { 'quota-exhausted': 2 },
    transientFailureBreakdownByModel: { claude: { 'quota-exhausted': 2 } },
    lastFailureClass: 'quota-exhausted',
    lastFailureModel: 'claude',
  };
  const signal = reviewerExecFailureSignal({
    cascadeState,
    currentRow: null,
    reviewerModel: 'gemini',
  });
  assert.equal(
    Number(signal?.failureCount || 0),
    0,
    'gemini must carry no exec-failure signal from claude’s failures',
  );
});

test('signal still fires for the model that actually failed', () => {
  const cascadeState = {
    transientFailureBreakdown: { 'quota-exhausted': 2 },
    transientFailureBreakdownByModel: { claude: { 'quota-exhausted': 2 } },
    lastFailureClass: 'quota-exhausted',
    lastFailureModel: 'claude',
  };
  const signal = reviewerExecFailureSignal({
    cascadeState,
    currentRow: null,
    reviewerModel: 'claude',
  });
  assert.equal(signal?.failureClass, 'quota-exhausted');
  assert.equal(Number(signal?.failureCount || 0), 2);
});

test('model matching is case- and whitespace-insensitive', () => {
  const cascadeState = {
    transientFailureBreakdownByModel: { gemini: { 'reviewer-timeout': 2 } },
  };
  assert.equal(reviewerExecFailureCount(cascadeState, 'reviewer-timeout', '  GEMINI '), 2);
});

test('an unattributed model yields no per-model count once per-model data exists', () => {
  // Some recorders legitimately have no reviewer model — e.g. routing-tier
  // readiness failures, which are not model-specific. Those stay in the flat
  // map and must not be blamed on an arbitrary model.
  const cascadeState = {
    transientFailureBreakdown: { cascade: 5 },
    transientFailureBreakdownByModel: { claude: { cascade: 5 } },
  };
  assert.equal(reviewerExecFailureCount(cascadeState, 'cascade', null), 0);
  assert.equal(reviewerExecFailureCount(cascadeState, 'cascade', ''), 0);
});
