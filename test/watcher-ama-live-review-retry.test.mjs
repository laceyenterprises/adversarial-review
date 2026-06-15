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
      mergeable: true,
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      prAuthor: 'builder',
    },
    labelNames: [],
    repoPath: 'acme/repo',
    prNumber: 300,
    currentRevisionRef: 'head-live',
    loadConfigImpl: loadAmaEnabledConfig,
    liveReviewRetryDelaysMs: [0, 0],
    logger: { warn() {} },
  };
}

test('AMA authoritative reviewer login resolver follows canonical reviewer routing aliases', () => {
  const claudeLogins = ['lacey-claude-reviewer', 'claude-reviewer-lacey'];
  const codexLogins = ['lacey-codex-reviewer', 'codex-reviewer-lacey'];
  const cases = [
    ['claude', claudeLogins],
    ['claude-code', claudeLogins],
    ['clio-agent', claudeLogins],
    ['codex', codexLogins],
    ['gemini', codexLogins],
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
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        seenReviewStates.push(reviewState);
        return { dispatched: false, reason: reviewState.verdict };
      },
    });

    assert.equal(lookupCalls, 2);
    assert.equal(seenReviewStates[0].verdict, 'request-changes');
    assert.equal(seenReviewStates[0].headSha, 'head-live');
    assert.deepEqual(result, { dispatched: false, reason: 'request-changes', amaEnabled: true });
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
        return ['## Summary\n\nLooks settled.\n\n## Verdict\n\nComment only'];
      },
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        seenReviewStates.push(reviewState);
        return { dispatched: true, reason: reviewState.verdict };
      },
    });

    assert.deepEqual(fetchOptions?.authoritativeReviewerLogins, [
      'lacey-codex-reviewer',
      'codex-reviewer-lacey',
    ]);
    assert.equal(seenReviewStates[0].verdict, 'comment-only');
    assert.deepEqual(result, { dispatched: true, reason: 'comment-only', amaEnabled: true });
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
      maybeDispatchAmaCloserImpl: async ({ reviewState }) => {
        seenReviewStates.push(reviewState);
        return { dispatched: false, reason: reviewState.verdict || 'fail-closed' };
      },
    });

    assert.equal(lookupCalls, 3);
    assert.equal(seenReviewStates[0].verdict, '');
    assert.equal(seenReviewStates[0].headSha, 'head-live');
    assert.deepEqual(result, { dispatched: false, reason: 'fail-closed', amaEnabled: true });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
