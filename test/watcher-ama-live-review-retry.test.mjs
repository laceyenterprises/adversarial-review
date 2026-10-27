import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  amaAuthoritativeReviewerLoginsForModel,
  maybeDispatchAmaClosureFor,
} from '../src/watcher.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'watcher-ama-live-review-retry-'));
}

function loadAmaEnabledConfig() {
  return {
    getMergeAuthorityConfig() {
      return { enabled: true };
    },
    getOrchestrationMode() {
      return 'native';
    },
  };
}

function baseArgs(rootDir) {
  return {
    rootDir,
    reviewStateRow: {
      review_status: 'posted',
      review_body: '## Verdict\n\nComment only',
      reviewer_head_sha: 'head-live',
      reviewer: 'codex',
    },
    dispatchJob: { blockingFindingCount: 0, blockingFindingState: 'known' },
    candidate: {
      headSha: 'head-live',
      prState: 'open',
      isDraft: false,
      riskClass: 'medium',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] },
      prAuthor: 'builder',
    },
    labelNames: [],
    repoPath: 'acme/repo',
    prNumber: 300,
    currentRevisionRef: 'head-live',
    loadConfigImpl: loadAmaEnabledConfig,
    liveReviewRetryDelaysMs: [0, 0],
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'deferred', reason: 'lease-contended' }),
    logger: { warn() {} },
  };
}

test('AMA authoritative reviewer login resolver follows canonical reviewer routing aliases', () => {
  const claudeLogins = ['lacey-claude-reviewer', 'claude-reviewer-lacey'];
  const codexLogins = ['lacey-codex-reviewer', 'codex-reviewer-lacey'];
  const geminiLogins = ['lacey-gemini-reviewer', 'gemini-reviewer-lacey'];
  const cases = [
    ['claude', claudeLogins],
    ['claude-code', claudeLogins],
    ['clio-agent', claudeLogins],
    ['codex', codexLogins],
    ['gemini', geminiLogins],
    ['pi', codexLogins],
    ['opencode', codexLogins],
    ['hermes', codexLogins],
    ['unknown-model', []],
    ['', []],
  ];

  for (const [reviewerModel, expected] of cases) {
    assert.deepEqual(
      amaAuthoritativeReviewerLoginsForModel(reviewerModel),
      expected,
      reviewerModel,
    );
  }
});

test('AMA live review reconciliation uses Gemini reviewer authority for native Gemini reviews', async () => {
  const rootDir = tempRoot();
  try {
    let fetchOptions = null;
    const seenReviewStates = [];
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      reviewStateRow: {
        ...baseArgs(rootDir).reviewStateRow,
        reviewer: 'gemini',
      },
      fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, _head, options) => {
        fetchOptions = options;
        return ['## Summary\n\nLooks settled.\n\n## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.\n\n## Verdict\n\nComment only'];
      },
      requestEligibleHammerWakeImpl: ({ shared }) => {
        seenReviewStates.push(shared.snapshot.observations.reviews.value);
        return {};
      },
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        return { dispatched: true, reason: reviewState.verdict };
      },
    });

    assert.deepEqual(fetchOptions?.authoritativeReviewerLogins, [
      'lacey-gemini-reviewer',
      'gemini-reviewer-lacey',
    ]);
    assert.equal(seenReviewStates[0].verdict, 'comment-only');
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'daemon-deferred');
    assert.equal(result.nextAction.action, 'wait-for-CI');
    assert.equal(result.nextAction.reason, 'snapshot-refresh');
    assert.equal(result.closureOwner.owner, 'wait');
    assert.equal(result.closureOwner.actor, 'watcher');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('AMA live review reconciliation retries a transient lookup and lets authoritative Request changes win', async () => {
  const rootDir = tempRoot();
  try {
    let lookupCalls = 0;
    const seenReviewStates = [];
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      fetchLatestHeadReviewBodiesImpl: async () => {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          const err = new Error('socket hang up while running gh api');
          err.code = 'ECONNRESET';
          throw err;
        }
        return ['## Summary\n\nStill blocked.\n\n## Verdict\n\nRequest changes'];
      },
      requestEligibleHammerWakeImpl: ({ shared }) => {
        seenReviewStates.push(shared.snapshot.observations.reviews.value);
        return {};
      },
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        return { dispatched: false, reason: reviewState.verdict };
      },
    });

    assert.equal(lookupCalls, 2);
    assert.equal(seenReviewStates[0].verdict, 'request-changes');
    assert.equal(seenReviewStates[0].headSha, 'head-live');
    assert.equal(result.dispatched, false);
    assert.equal(result.nextAction.action, 'remediate');
    assert.equal(result.nextAction.reason, 'review-findings');
    assert.equal(result.closureOwner.owner, 'remediation');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('AMA live review reconciliation treats opencode as Codex reviewer authority', async () => {
  const rootDir = tempRoot();
  try {
    let fetchOptions = null;
    const seenReviewStates = [];
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      reviewStateRow: {
        ...baseArgs(rootDir).reviewStateRow,
        reviewer: 'opencode',
      },
      fetchLatestHeadReviewBodiesImpl: async (_repo, _pr, _head, options) => {
        fetchOptions = options;
        return ['## Summary\n\nLooks settled.\n\n## Blocking Issues\n\n- None.\n\n## Non-blocking Issues\n\n- None.\n\n## Verdict\n\nComment only'];
      },
      requestEligibleHammerWakeImpl: ({ shared }) => {
        seenReviewStates.push(shared.snapshot.observations.reviews.value);
        return {};
      },
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        return { dispatched: true, reason: reviewState.verdict };
      },
    });

    assert.deepEqual(fetchOptions?.authoritativeReviewerLogins, [
      'lacey-codex-reviewer',
      'codex-reviewer-lacey',
    ]);
    assert.equal(seenReviewStates[0].verdict, 'comment-only');
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'daemon-deferred');
    assert.equal(result.nextAction.action, 'wait-for-CI');
    assert.equal(result.nextAction.reason, 'snapshot-refresh');
    assert.equal(result.closureOwner.owner, 'wait');
    assert.equal(result.closureOwner.actor, 'watcher');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('AMA live review reconciliation fails closed after exhausting transient lookup retries', async () => {
  const rootDir = tempRoot();
  try {
    let lookupCalls = 0;
    const seenReviewStates = [];
    const result = await maybeDispatchAmaClosureFor({
      ...baseArgs(rootDir),
      fetchLatestHeadReviewBodiesImpl: async () => {
        lookupCalls += 1;
        const err = new Error('HTTP 503 from gh api');
        err.status = 503;
        throw err;
      },
      requestEligibleHammerWakeImpl: ({ shared }) => {
        seenReviewStates.push(shared.snapshot.observations.reviews.value);
        return {};
      },
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        return { dispatched: false, reason: reviewState.verdict || 'fail-closed' };
      },
    });

    assert.equal(lookupCalls, 3);
    assert.equal(seenReviewStates[0].verdict, '');
    assert.equal(seenReviewStates[0].headSha, 'head-live');
    assert.equal(result.dispatched, false);
    assert.equal(result.nextAction.action, 'review');
    assert.equal(result.nextAction.reason, 'exact-head-review');
    assert.equal(result.closureOwner.owner, 'review');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});


test('closure uses an initialized database while rereading the current round count each evaluation', async () => {
  const rootDir = tempRoot();
  try {
    let count = 40, reads = 0;
    const exhausted = [];
    // A borrowed connection exposes only the query seam: schema initialization
    // or closing this connection would fail this test.
    const reviewStateDb = { prepare(sql) {
      assert.match(sql, /SELECT COUNT\(\*\) AS count[\s\S]*FROM reviewer_passes/);
      return { get() { reads++; return { count }; } };
    } };
    const options = { ...baseArgs(rootDir), repoPath: 'fixture/project', prNumber: 1,
      reviewStateDb,
      fetchLatestHeadReviewBodiesImpl: async () => ['## Verdict\n\nComment only'],
      runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'fixture-wait' }),
      requestEligibleHammerWakeImpl: ({ shared }) => {
        exhausted.push(shared.snapshot.observations.remediation.value.roundsLeft === false);
        return {};
      },
      maybeDispatchAmaCloserImpl: async () => {
        return { dispatched: true, reason: 'fixture-dispatched' };
      },
    };
    await maybeDispatchAmaClosureFor(options);
    count = 0;
    await maybeDispatchAmaClosureFor(options);
    assert.equal(reads, 2);
    assert.deepEqual(exhausted, [true, false]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
// LAC-2072: exercise the producer contract independently of orphan recovery's
// injected facts. A final round can close review before the cycle is exhausted.
for (const reviewCycleExhausted of [false, true]) {
  for (const commentOnlyFinalRoundCompleted of [false, true]) {
    test(`AMA owner proof projects cycle=${reviewCycleExhausted}, finalRound=${commentOnlyFinalRoundCompleted}`, async t => {
      const rootDir = tempRoot();
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const seenReviewStates = [];
      const result = await maybeDispatchAmaClosureFor({
        ...baseArgs(rootDir),
        resolveReviewCycleExhaustionImpl: () => ({
          reviewCycleExhausted,
          commentOnlyFinalRoundRevisionRefs: commentOnlyFinalRoundCompleted ? ['head-live'] : [],
        }),
        fetchLatestHeadReviewBodiesImpl: async () => ['## Verdict\n\nComment only'],
        requestEligibleHammerWakeImpl: ({ shared }) => {
          seenReviewStates.push(shared.snapshot.observations.reviews.value);
          return {};
        },
        maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
          return { dispatched: false, reason: 'not-eligible' };
        },
      });

      assert.equal(seenReviewStates.length, 1);
      assert.equal(result.ownerProofFacts.reviewCycleExhausted, reviewCycleExhausted);
      assert.deepEqual(result.ownerProofFacts, {
        headSha: 'head-live', reviewedHeadSha: 'head-live', verdict: 'comment-only',
        reviewCycleExhausted, commentOnlyFinalRoundCompleted,
        checks: baseArgs(rootDir).candidate.statusCheckRollup, mergeable: 'MERGEABLE',
      });
      assert.equal(result.dispatched, false, 'routing facts do not waive closer eligibility');
    });
  }
}
