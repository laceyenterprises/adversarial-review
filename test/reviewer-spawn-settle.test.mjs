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

test('spawnReviewer threads the reviewer worker run_id into the settled pass (WCW attribution)', async () => {
  let readBestArgs = null;
  const settled = [];
  const result = await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 21,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'sha21',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 2,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-wcw-attribution',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
          reviewBodyDelivery: 'caller-post',
          // SDK-dispatch adapter surfaces the worker's dispatch id here.
          reattachToken: 'lrq_wcw_attribution',
          spawnedAt: '2026-07-28T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    readBestReviewerEvidenceTokenUsageImpl: (args) => {
      readBestArgs = args;
      // Mimic the ledger resolving a worker_runs row from launch_request_id:
      // raw token usage carries workerRunId (before normalization strips it).
      return { workerRunId: 'run_wcw_attribution_123', input: 10, output: 20, source: 'worker-run' };
    },
    completeReviewerPassImpl: (_root, payload) => {
      settled.push(payload);
    },
  });

  assert.equal(result.ok, true);
  // The reviewer worker's dispatch id (reattachToken) must be threaded as
  // launchRequestId so the ledger read can resolve the worker_runs row.
  assert.equal(readBestArgs?.launchRequestId, 'lrq_wcw_attribution');
  // The resolved ledger run_id must be persisted to reviewer_passes.worker_run_id,
  // surviving tagTokenUsage()/normalizeTokenUsage() (which drop attribution).
  assert.equal(settled.length, 1);
  assert.equal(settled[0].workerRunId, 'run_wcw_attribution_123');
});

test('spawnReviewer settles worker_run_id null when no worker run resolves (cli-direct path)', async () => {
  const settled = [];
  const result = await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 22,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'sha22',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 2,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-wcw-null',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
          reviewBodyDelivery: 'caller-post',
          reattachToken: 'lrq_wcw_null',
          spawnedAt: '2026-07-28T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    readBestReviewerEvidenceTokenUsageImpl: () => null, // ledger cannot resolve a worker run
    completeReviewerPassImpl: (_root, payload) => {
      settled.push(payload);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].workerRunId, null);
});
