import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { maybeDispatchAmaClosureFor } from '../src/watcher.mjs';

const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';
const HEAD = 'a'.repeat(40);

function baseHammerArgs(rootDir, overrides = {}) {
  return {
    reviewState: {
      verdict: 'request changes',
      headSha: HEAD,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      ...overrides.reviewState,
    },
    prMetadata: {
      prNumber: 404,
      headSha: HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      author: 'builder',
      ...overrides.prMetadata,
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: {
        riskClasses: ['low'],
        highRiskRequiresTwoKey: false,
      },
      branchProtection: { required: false },
      ...overrides.cfg,
    },
    dispatchContext: {
      rootDir,
      repo: 'acme/repo',
      prUrl: 'https://github.com/acme/repo/pull/404',
      reviewedSha: HEAD,
      riskClass: 'low',
      requiredGateContext: 'agent-os/adversarial-gate',
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt: '2026-07-06T12:00:00Z',
      ...overrides.dispatchContext,
    },
  };
}

function testDeps({ execDelay = null } = {}) {
  const calls = [];
  let releaseExec;
  const waitForRelease = execDelay
    ? new Promise((resolve) => {
        releaseExec = resolve;
      })
    : null;
  return {
    calls,
    releaseExec,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (waitForRelease) await waitForRelease;
      return { stdout: JSON.stringify({ dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

test('MSM-04: settled review with findings dispatches exactly one hammer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-findings-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].args[deps.calls[0].args.indexOf('--worker-class') + 1], 'hammer');
  assert.equal(deps.calls[0].args[deps.calls[0].args.indexOf('--task-kind') + 1], 'merge');
});

test('MSM-04: no source path still uses the standalone closer prompt for dispatch', () => {
  const source = readFileSync(new URL('../src/ama/dispatch-closer.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('templates/ama-closer-prompt.md'), false);
  assert.equal(/const\s+TEMPLATE_PATH\b/.test(source), false);
});

test('MSM-04: stale reviewed head is terminal and does not retarget a re-hammer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-stale-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaClosureFor({
    rootDir,
    reviewStateRow: {
      review_status: 'posted',
      review_body: '## Verdict\n\nComment only\n\n## Blocking Issues\n\n- None.\n',
      reviewer_head_sha: 'old-reviewed-head',
      reviewer: 'codex',
      reviewer_login: 'codex-reviewer-lacey',
    },
    dispatchJob: {},
    candidate: {
      headSha: 'new-current-head',
      baseBranch: 'main',
      prState: 'open',
      isDraft: false,
      riskClass: 'low',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [],
      branchProtection: { requiredContexts: [] },
      prAuthor: 'builder',
    },
    labelNames: [],
    repoPath: 'acme/repo',
    prNumber: 405,
    currentRevisionRef: 'new-current-head',
    loadConfigImpl: () => ({
      getMergeAuthorityConfig() {
        return {
          enabled: true,
          workerClass: 'hammer',
          mergeMethod: 'squash',
          eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
          branchProtection: { required: false },
        };
      },
      getOrchestrationMode() {
        return 'native';
      },
    }),
    resolveReviewCycleExhaustionImpl: () => ({ reviewCycleExhausted: true, ledgerRiskClass: 'low' }),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'stale-review-head' }),
    maybeDispatchAmaCloserImpl: (payload) => maybeDispatchAmaCloser({ ...payload, ...deps }),
    fetchLatestHeadReviewBodiesImpl: async () => ['## Verdict\n\nComment only\n\n## Blocking Issues\n\n- None.\n'],
    logger: deps.logger,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('stale-review-head'));
  assert.equal(deps.calls.length, 0);
});

test('MSM-04: concurrent settle ticks for one job/head launch at most one hammer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-idempotency-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps({ execDelay: true });
  const args = baseHammerArgs(rootDir);
  const first = maybeDispatchAmaCloser({ ...args, ...deps });
  const second = maybeDispatchAmaCloser({ ...args, ...deps });
  await new Promise((resolve) => setImmediate(resolve));
  deps.releaseExec();
  const results = await Promise.all([first, second]);

  assert.equal(deps.calls.length, 1);
  assert.equal(results.filter((result) => result.dispatched).length, 1);
  assert.equal(results.filter((result) => result.reason === 'lease-held').length, 1);
});

test('MSM-04: structural hard stops still block hammer dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-hard-stop-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir, {
      prMetadata: { labels: ['do-not-merge'] },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('label-do-not-merge'));
  assert.equal(deps.calls.length, 0);
});
