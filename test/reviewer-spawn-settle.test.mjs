import test from 'node:test';
import assert from 'node:assert/strict';

import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';

test('spawnReviewer posts successful adapter-produced review bodies through GitHub capture', async () => {
  const posted = [];
  const result = await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 14,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'abc123',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 3,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-posts-adapter-body',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
          reviewBodyDelivery: 'caller-post',
          reattachToken: 'lrq_spawn_settle_posts_adapter_body',
          spawnedAt: '2026-07-27T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async (payload) => {
      posted.push(payload);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].repo, 'laceyenterprises/demo');
  assert.equal(posted[0].prNumber, 14);
  assert.equal(posted[0].attemptNumber, 3);
  assert.equal(posted[0].reviewerModel, 'gemini');
  assert.equal(posted[0].reviewerHeadSha, 'abc123');
  assert.equal(posted[0].botTokenEnv, 'GH_GEMINI_REVIEWER_TOKEN');
  assert.equal(posted[0].passKind, 'first-pass');
  assert.equal(posted[0].reviewerIdentity, 'gemini-reviewer-lacey');
  assert.match(posted[0].reviewBody, /^## Verdict\nComment only/m);
});

test('spawnReviewer does not post unmarked adapter review bodies', async () => {
  const posted = [];
  const result = await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 15,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'def456',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 4,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-does-not-post-unmarked-body',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nFixture body.\n\n## Verdict\nComment only',
          reattachToken: 'fixture_spawn_settle_unmarked_body',
          spawnedAt: '2026-07-27T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async (payload) => {
      posted.push(payload);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(posted, []);
});
