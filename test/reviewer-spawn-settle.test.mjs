import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  readBestReviewerEvidenceTokenUsage,
} from '../src/reviewer-pass-tokens.mjs';
import { createSessionLedgerDb } from './helpers/session-ledger-fixtures.mjs';

function currentHead(headRefOid) {
  return async () => ({ state: 'open', mergedAt: null, closedAt: null, headRefOid });
}

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
    fetchPullRequestHeadAndStateImpl: currentHead('abc123'),
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

test('spawnReviewer discards adapter review body when current PR head moved before post', async () => {
  const posted = [];
  const result = await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 140,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'old-head',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 5,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-stale-head',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nStale finding.\n\n## Verdict\nRequest changes',
          reviewBodyDelivery: 'caller-post',
          spawnedAt: '2026-07-27T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async (payload) => {
      posted.push(payload);
    },
    fetchPullRequestHeadAndStateImpl: currentHead('new-head'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'stale-review-head');
  assert.deepEqual(posted, []);
  assert.match(result.error, /targeted stale head old-head; current head is new-head/);
});

test('settleReviewerAttempt releases stale-head reviewer claims without consuming review budget', async () => {
  const released = [];
  const markedPosted = [];
  const { settleReviewerAttempt } = await import('../src/reviewer-spawn-settle.mjs');

  settleReviewerAttempt({
    repoPath: 'laceyenterprises/demo',
    prNumber: 140,
    result: {
      ok: false,
      failureClass: 'stale-review-head',
      reviewerSessionUuid: 'stale-session',
      error: 'reviewer output targeted stale head',
    },
    statements: {
      markPosted: { run: (...args) => markedPosted.push(args) },
      releaseReviewerClaim: { run: (...args) => { released.push(args); return { changes: 1 }; } },
    },
    log: { warn() {} },
  });

  assert.deepEqual(markedPosted, []);
  assert.deepEqual(released, [['stale-session', 'laceyenterprises/demo', 140]]);
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

test('spawnReviewer resolves worker_run_id from os-dispatch launch_request_id while reattach stays on request_id', async () => {
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
          // Reattach remains keyed by request_id / idempotencyKey.
          reattachToken: 'code-pr:pr-21:sha21:review:reviewer:gemini:2',
          // The ledger worker_run is keyed by launch_request_id instead.
          launchRequestId: 'lrq_wcw_attribution',
          spawnedAt: '2026-07-28T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    fetchPullRequestHeadAndStateImpl: currentHead('sha21'),
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
  // Reattach still uses request_id, but WCW attribution must read by the real
  // launch_request_id surfaced by os-dispatch.
  assert.equal(readBestArgs?.launchRequestId, 'lrq_wcw_attribution');
  assert.equal(readBestArgs?.adapterSessionKey, 'code-pr:pr-21:sha21:review:reviewer:gemini:2');
  assert.deepEqual(readBestArgs?.sessionKeys, [
    'spawn-settle-wcw-attribution',
    'code-pr:pr-21:sha21:review:reviewer:gemini:2',
  ]);
  // The resolved ledger run_id must be persisted to reviewer_passes.worker_run_id,
  // surviving tagTokenUsage()/normalizeTokenUsage() (which drop attribution).
  assert.equal(settled.length, 1);
  assert.equal(settled[0].workerRunId, 'run_wcw_attribution_123');
  assert.equal(settled[0].metadata.launchRequestId, 'lrq_wcw_attribution');
});

test('spawnReviewer enriches adapter token usage with ledger worker_run_id without replacing counters', async () => {
  const settled = [];
  const result = await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 24,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'sha24',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 2,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-preserves-adapter-usage',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
          reviewBodyDelivery: 'caller-post',
          reattachToken: 'sdk-request-id-24',
          launchRequestId: 'lrq_sdk_24',
          tokenUsage: {
            input: 100,
            output: 50,
            cacheRead: 11,
            cacheWrite: 7,
            reasoning: 9,
            toolContext: 5,
            total: 182,
            costUSD: 0.25,
            source: 'adapter',
          },
          spawnedAt: '2026-07-28T03:00:00.000Z',
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    fetchPullRequestHeadAndStateImpl: currentHead('sha24'),
    readBestReviewerEvidenceTokenUsageImpl: () => ({
      workerRunId: 'wr_sdk_24',
      input: 1,
      output: 2,
      total: 3,
      costUSD: 0.01,
      source: 'session-ledger',
    }),
    completeReviewerPassImpl: (_root, payload) => {
      settled.push(payload);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].workerRunId, 'wr_sdk_24');
  assert.deepEqual(settled[0].tokenUsage, {
    input: 100,
    output: 50,
    cacheRead: 11,
    cacheWrite: 7,
    reasoning: 9,
    toolContext: 5,
    total: 182,
    guardrail: 182,
    costUSD: 0.25,
    usageTag: 'guardrail',
    source: 'adapter',
  });
});

test('spawnReviewer retries transient ledger contention and preserves adapter counters', async () => {
  const settled = [];
  const warnings = [];
  let lookupCalls = 0;
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    const result = await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 25,
      reviewerModel: 'gemini',
      botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
      linearTicketId: 'LAC-566',
      labels: [],
      builderTag: 'codex',
      reviewerHeadSha: 'sha25',
      reviewAttemptNumber: 1,
      reviewDbAttemptNumber: 2,
      completedRemediationRounds: 0,
      passKind: 'first-pass',
      maxRemediationRounds: 2,
      reviewerSessionUuid: 'spawn-settle-ledger-fail-open',
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          return {
            ok: true,
            reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
            reviewBodyDelivery: 'caller-post',
            reattachToken: 'sdk-request-id-25',
            launchRequestId: 'lrq_sdk_25',
            tokenUsage: { input: 8, output: 13, total: 21, source: 'adapter' },
            spawnedAt: '2026-07-28T03:00:00.000Z',
          };
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      fetchPullRequestHeadAndStateImpl: currentHead('sha25'),
      readBestReviewerEvidenceTokenUsageImpl: () => {
        lookupCalls += 1;
        if (lookupCalls < 3) throw new Error('SQLITE_BUSY');
        return { workerRunId: 'wr_sdk_25', input: 1, output: 2, source: 'session-ledger' };
      },
      ledgerLookupSleepImpl: async () => {},
      completeReviewerPassImpl: (_root, payload) => {
        settled.push(payload);
      },
    });

    assert.equal(result.ok, true);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(settled.length, 1);
  assert.equal(lookupCalls, 3);
  assert.equal(settled[0].workerRunId, 'wr_sdk_25');
  assert.deepEqual(settled[0].tokenUsage, {
    input: 8,
    output: 13,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    toolContext: null,
    total: 21,
    guardrail: 21,
    costUSD: null,
    usageTag: 'guardrail',
    source: 'adapter',
  });
  assert.equal(settled[0].tokenSource, 'adapter');
  assert.deepEqual(warnings, []);
  assert.deepEqual(settled[0].metadata.workerRunAttribution, {
    state: 'resolved',
    launchRequestId: 'lrq_sdk_25',
    workerRunId: 'wr_sdk_25',
    lookupAttempts: 3,
    lastError: null,
    retryable: false,
  });
});

test('spawnReviewer keeps retrying token-only evidence until worker attribution resolves', async () => {
  const settled = [];
  let lookupCalls = 0;
  await spawnReviewer({
    repo: 'laceyenterprises/demo',
    prNumber: 251,
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
    linearTicketId: 'LAC-566',
    labels: [],
    builderTag: 'codex',
    reviewerHeadSha: 'sha251',
    reviewAttemptNumber: 1,
    reviewDbAttemptNumber: 2,
    completedRemediationRounds: 0,
    passKind: 'first-pass',
    maxRemediationRounds: 2,
    reviewerSessionUuid: 'spawn-settle-token-before-worker-row',
    reviewerRuntimeAdapterOverride: {
      async spawnReviewer() {
        return {
          ok: true,
          reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
          reviewBodyDelivery: 'caller-post',
          reattachToken: 'sdk-request-id-251',
          launchRequestId: 'lrq_sdk_251',
          tokenUsage: { input: 8, output: 13, total: 21, source: 'adapter' },
        };
      },
    },
    postGitHubReviewWithCaptureImpl: async () => {},
    fetchPullRequestHeadAndStateImpl: currentHead('sha251'),
    readBestReviewerEvidenceTokenUsageImpl: () => {
      lookupCalls += 1;
      if (lookupCalls < 3) {
        return { input: 1, output: 2, total: 3, source: 'session-ledger' };
      }
      return {
        workerRunId: 'wr_sdk_251',
        input: 1,
        output: 2,
        total: 3,
        source: 'session-ledger',
      };
    },
    ledgerLookupSleepImpl: async () => {},
    completeReviewerPassImpl: (_root, payload) => settled.push(payload),
  });

  assert.equal(lookupCalls, 3);
  assert.equal(settled[0].workerRunId, 'wr_sdk_251');
  assert.deepEqual(settled[0].metadata.workerRunAttribution, {
    state: 'resolved',
    launchRequestId: 'lrq_sdk_251',
    workerRunId: 'wr_sdk_251',
    lookupAttempts: 3,
    lastError: null,
    retryable: false,
  });
});

test('spawnReviewer leaves repairable attribution after bounded transient ledger failures', async () => {
  const settled = [];
  const warnings = [];
  let lookupCalls = 0;
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 26,
      reviewerModel: 'gemini',
      botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
      linearTicketId: 'LAC-566',
      labels: [],
      builderTag: 'codex',
      reviewerHeadSha: 'sha26',
      reviewAttemptNumber: 1,
      reviewDbAttemptNumber: 2,
      completedRemediationRounds: 0,
      passKind: 'first-pass',
      maxRemediationRounds: 2,
      reviewerSessionUuid: 'spawn-settle-ledger-pending',
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          return {
            ok: true,
            reattachToken: 'sdk-request-id-26',
            launchRequestId: 'lrq_sdk_26',
            tokenUsage: { input: 8, output: 13, total: 21, source: 'adapter' },
          };
        },
      },
      readBestReviewerEvidenceTokenUsageImpl: () => {
        lookupCalls += 1;
        throw Object.assign(new Error('database is locked'), { code: 'EIO' });
      },
      ledgerLookupSleepImpl: async () => {},
      completeReviewerPassImpl: (_root, payload) => settled.push(payload),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lookupCalls, 3);
  assert.equal(settled[0].workerRunId, null);
  assert.equal(settled[0].metadata.launchRequestId, 'lrq_sdk_26');
  assert.deepEqual(settled[0].metadata.workerRunAttribution, {
    state: 'pending',
    launchRequestId: 'lrq_sdk_26',
    workerRunId: null,
    lookupAttempts: 3,
    lastError: 'sqlite-busy',
    retryable: true,
  });
  assert.match(warnings[0] || '', /attempts=3: sqlite-busy/);
});

test('spawnReviewer persists worker_run_id onto reviewer_passes for SDK-dispatched settles', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'spawn-settle-sdk-attribution-'));
  try {
    const ledgerDb = path.join(rootDir, 'ledger.db');
    let settledRow = null;
    createSessionLedgerDb(ledgerDb, {
      runtimeSessions: [
        {
          session_id: 'rs_sdk',
          adapter_session_key: 'sdk-request-id-21',
          total_input_tokens: 31,
          total_output_tokens: 12,
          total_cache_read_tokens: 0,
          total_cache_write_tokens: 0,
          total_cost_usd: 0.09,
          source_path: rootDir,
          started_at: '2026-07-28T03:00:00.000Z',
          ended_at: '2026-07-28T03:02:00.000Z',
        },
      ],
      workerRuns: [
        {
          run_id: 'wr_sdk_21',
          launch_request_id: 'lrq_sdk_21',
          session_id: 'rs_sdk',
          status: 'succeeded',
          token_usage_input: 31,
          token_usage_output: 12,
          token_usage_guardrail: 43,
          token_usage_cost_usd: 0.09,
          token_usage_source: 'session-ledger',
          started_at: '2026-07-28T03:00:00.000Z',
          ended_at: '2026-07-28T03:02:00.000Z',
          updated_at: '2026-07-28T03:02:00.000Z',
        },
      ],
    });
    beginReviewerPass(rootDir, {
      repo: 'laceyenterprises/demo',
      prNumber: 121,
      attemptNumber: 2,
      reviewerClass: 'gemini',
      reviewerModel: 'gemini',
      passKind: 'first-pass',
      startedAt: '2026-07-28T03:00:00.000Z',
    });

    await spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 121,
      reviewerModel: 'gemini',
      botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
      linearTicketId: 'LAC-566',
      labels: [],
      builderTag: 'codex',
      reviewerHeadSha: 'sha121',
      reviewAttemptNumber: 1,
      reviewDbAttemptNumber: 2,
      completedRemediationRounds: 0,
      passKind: 'first-pass',
      maxRemediationRounds: 2,
      reviewerSessionUuid: 'spawn-settle-sdk-attribution',
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          return {
            ok: true,
            reviewBody: '## Summary\nLooks good.\n\n## Verdict\nComment only',
            reviewBodyDelivery: 'caller-post',
            reattachToken: 'sdk-request-id-21',
            launchRequestId: 'lrq_sdk_21',
            tokenUsage: { total: 123 },
            spawnedAt: '2026-07-28T03:00:00.000Z',
          };
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      fetchPullRequestHeadAndStateImpl: currentHead('sha121'),
      readBestReviewerEvidenceTokenUsageImpl: (args) => readBestReviewerEvidenceTokenUsage({
        ...args,
        ledgerTarget: { backend: 'sqlite', path: ledgerDb },
        env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
        rootDir,
        transcriptFallback: false,
      }),
      completeReviewerPassImpl: (_root, payload) => {
        settledRow = completeReviewerPass(rootDir, payload);
        return settledRow;
      },
    });

    assert.equal(settledRow?.worker_run_id, 'wr_sdk_21');
    assert.equal(JSON.parse(settledRow?.metadata_json || '{}').launchRequestId, 'lrq_sdk_21');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('spawnReviewer settles worker_run_id null when no worker run resolves (cli-direct path)', async () => {
  const settled = [];
  let lookupLaunchRequestId = null;
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
    fetchPullRequestHeadAndStateImpl: currentHead('sha22'),
    readBestReviewerEvidenceTokenUsageImpl: ({ launchRequestId }) => {
      lookupLaunchRequestId = launchRequestId;
      // A request-shaped reattach token may collide with a real worker launch.
      // It must never be passed as the launch selector or persisted as a match.
      return launchRequestId === 'lrq_wcw_null'
        ? { workerRunId: 'wr_unrelated_collision', input: 99, output: 99 }
        : null;
    },
    ledgerLookupSleepImpl: async () => {},
    completeReviewerPassImpl: (_root, payload) => {
      settled.push(payload);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(settled.length, 1);
  assert.equal(lookupLaunchRequestId, null, 'reattach token is not a launch selector');
  assert.equal(settled[0].workerRunId, null);
  assert.equal(settled[0].metadata.launchRequestId, null);
  assert.equal(settled[0].metadata.reattachToken, 'lrq_wcw_null');
  assert.deepEqual(settled[0].metadata.workerRunAttribution, {
    state: 'not-applicable',
    launchRequestId: null,
    workerRunId: null,
    lookupAttempts: 3,
    lastError: 'worker-run-not-yet-visible',
    retryable: false,
    reason: 'missing-launch-request-id',
  });
});

test('spawnReviewer preserves worker run_id when the adapter throws (error-path attribution)', async () => {
  const settled = [];
  // spawnReviewer settles the failed pass and re-throws; the attribution run_id
  // surfaced on err.tokenUsage must survive onto the settled pass.
  await assert.rejects(
    spawnReviewer({
      repo: 'laceyenterprises/demo',
      prNumber: 23,
      reviewerModel: 'gemini',
      botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
      linearTicketId: 'LAC-566',
      labels: [],
      builderTag: 'codex',
      reviewerHeadSha: 'sha23',
      reviewAttemptNumber: 1,
      reviewDbAttemptNumber: 2,
      completedRemediationRounds: 0,
      passKind: 'first-pass',
      maxRemediationRounds: 2,
      reviewerSessionUuid: 'spawn-settle-wcw-error-path',
      reviewerRuntimeAdapterOverride: {
        async spawnReviewer() {
          // Worker crashed mid-run but surfaced its ledger run_id on the error.
          throw Object.assign(new Error('reviewer worker crashed'), {
            tokenUsage: { workerRunId: 'run_wcw_error_path', input: 3, output: 4, source: 'worker-run' },
          });
        },
      },
      postGitHubReviewWithCaptureImpl: async () => {},
      completeReviewerPassImpl: (_root, payload) => {
        settled.push(payload);
      },
    }),
    /reviewer worker crashed/,
  );

  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'failed');
  assert.equal(settled[0].workerRunId, 'run_wcw_error_path');
});
