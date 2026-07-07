import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runBoundedReviewerDispatchQueue,
  resolveGeminiDispatchConcurrencyLimit,
  fetchGeminiCredentialConcurrency,
} from '../src/watcher-reviewer-pool.mjs';

// Track concurrent in-flight counts per model so we can assert the gemini cap
// serializes gemini reviewers WITHOUT throttling codex/claude.
function makeTracker() {
  const state = { all: 0, maxAll: 0, byModel: {}, maxByModel: {} };
  const hook = async (model) => {
    state.all += 1;
    state.maxAll = Math.max(state.maxAll, state.all);
    state.byModel[model] = (state.byModel[model] || 0) + 1;
    state.maxByModel[model] = Math.max(state.maxByModel[model] || 0, state.byModel[model]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.byModel[model] -= 1;
    state.all -= 1;
  };
  return { state, hook };
}

function candidate(prNumber, reviewerModel, hook) {
  return {
    repoPath: 'laceyenterprises/agent-os',
    prNumber,
    reviewerModel,
    subject: { createdAt: `2026-05-01T00:00:${String(prNumber).padStart(2, '0')}.000Z` },
    run: () => hook(reviewerModel),
  };
}

test('resolveGeminiDispatchConcurrencyLimit', () => {
  assert.equal(resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency: null, ceiling: 6 }), 6);
  assert.equal(resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency: '', ceiling: 6 }), 6);
  assert.equal(resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency: 'foo', ceiling: 6 }), 6);
  assert.equal(resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency: 1, ceiling: 6 }), 1);
  assert.equal(resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency: 0, ceiling: 6 }), 0);
  assert.equal(resolveGeminiDispatchConcurrencyLimit({ geminiCredentialConcurrency: 10, ceiling: 6 }), 6); // clamp to ceiling
});

test('caps concurrent gemini reviewers at the credential count, dispatches all', async () => {
  const { state, hook } = makeTracker();
  const tasks = Array.from({ length: 6 }, (_u, i) => candidate(i + 1, 'gemini', hook));
  const summary = await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 6,
    geminiCredentialConcurrency: 1,
  });
  assert.equal(summary.dispatched, 6, 'all gemini candidates eventually dispatched');
  assert.equal(state.maxByModel.gemini, 1, 'never more than 1 gemini reviewer in flight');
});

test('gemini cap does NOT throttle codex/claude reviewers behind it', async () => {
  const { state, hook } = makeTracker();
  // 3 gemini + 3 codex, pool of 6, gemini capped at 1.
  const tasks = [
    candidate(1, 'gemini', hook),
    candidate(2, 'gemini', hook),
    candidate(3, 'gemini', hook),
    candidate(4, 'codex', hook),
    candidate(5, 'codex', hook),
    candidate(6, 'codex', hook),
  ];
  const summary = await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 6,
    geminiCredentialConcurrency: 1,
  });
  assert.equal(summary.dispatched, 6);
  assert.equal(state.maxByModel.gemini, 1, 'gemini serialized to 1');
  assert.ok(state.maxByModel.codex >= 2, `codex ran in parallel (not throttled), saw ${state.maxByModel.codex}`);
  assert.ok(state.maxAll >= 2, 'overall concurrency exceeded the gemini cap (codex parallel)');
});

test('null gemini cap preserves prior behavior (gemini up to pool limit)', async () => {
  const { state, hook } = makeTracker();
  const tasks = Array.from({ length: 6 }, (_u, i) => candidate(i + 1, 'gemini', hook));
  const summary = await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 4,
    geminiCredentialConcurrency: null,
  });
  assert.equal(summary.dispatched, 6);
  assert.equal(state.maxByModel.gemini, 4, 'without a cap, gemini fills the pool');
});

test('zero gemini credentials leaves gemini candidates undispatched (no spin)', async () => {
  const { state, hook } = makeTracker();
  const tasks = [candidate(1, 'gemini', hook), candidate(2, 'codex', hook)];
  const summary = await runBoundedReviewerDispatchQueue(tasks, {
    maxConcurrent: 6,
    geminiCredentialConcurrency: 0,
  });
  // codex dispatches; gemini is left for the next tick rather than hanging.
  assert.equal(summary.dispatched, 1);
  assert.equal(state.maxByModel.codex, 1);
  assert.equal(state.maxByModel.gemini || 0, 0);
});

test('fetchGeminiCredentialConcurrency counts non-cooled credentials', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      credentials: [
        { credential_id: 'default', is_cooled: false },
        { credential_id: 'b', is_cooled: false },
        { credential_id: 'c', is_cooled: true }, // real 429 cooldown -> not usable
      ],
    }),
  });
  const n = await fetchGeminiCredentialConcurrency({ brokerUrl: 'http://broker', secret: 's', fetchImpl });
  assert.equal(n, 2);
});

test('fetchGeminiCredentialConcurrency fails open (null) on missing url / bad response / throw', async () => {
  assert.equal(await fetchGeminiCredentialConcurrency({ brokerUrl: null }), null);
  assert.equal(
    await fetchGeminiCredentialConcurrency({ brokerUrl: 'http://b', fetchImpl: async () => ({ ok: false }) }),
    null,
  );
  assert.equal(
    await fetchGeminiCredentialConcurrency({
      brokerUrl: 'http://b',
      fetchImpl: async () => {
        throw new Error('network down');
      },
    }),
    null,
  );
  assert.equal(
    await fetchGeminiCredentialConcurrency({
      brokerUrl: 'http://b',
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    }),
    null,
  );
});
