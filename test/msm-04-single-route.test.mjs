import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { __testables__, maybeDispatchAmaCloser, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
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
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/live' }),
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

test('DCR-02: merged PR does not dispatch hammer merge task', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-merged-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir, {
      dispatchContext: {
        livePrProbeImpl: async () => ({ state: 'MERGED', headBranchExists: false }),
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'live-pr-closed');
  assert.equal(result.prState, 'MERGED');
  assert.equal(deps.calls.length, 0, 'must not run hq dispatch for already-merged PR');
});

test('DCR-02: pruned head branch does not dispatch hammer merge task', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-pruned-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir, {
      dispatchContext: {
        livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: false, headRefName: 'codex/pruned' }),
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'live-head-branch-missing');
  assert.equal(result.prState, 'OPEN');
  assert.equal(deps.calls.length, 0, 'must not run hq dispatch for pruned PR branch');
});

test('DCR-02: default live probe treats git ls-remote exit 2 as pruned branch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-default-pruned-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];

  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir, {
      dispatchContext: {
        livePrProbeImpl: null,
      },
    }),
    ...testDeps(),
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh') {
        return { stdout: JSON.stringify({ state: 'OPEN', headRefName: 'codex/pruned', headRefOid: HEAD }), stderr: '' };
      }
      if (cmd === 'git') {
        throw Object.assign(new Error('no matching remote ref'), { code: 2, stderr: '' });
      }
      assert.fail(`unexpected dispatch command: ${cmd}`);
    },
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'live-head-branch-missing');
  assert.deepEqual(calls.map((call) => call.cmd), ['gh', 'git']);
});

test('DCR-02: default live probe checks fork head repository branches', async () => {
  const calls = [];

  const result = await __testables__.defaultAmaLivePrProbe({
    repo: 'acme/repo',
    prNumber: 404,
    retryDelaysMs: [],
    sleepImpl: async () => {},
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh') {
        return {
          stdout: JSON.stringify({
            state: 'OPEN',
            headRefName: 'codex/live',
            headRefOid: HEAD,
            headRepository: { nameWithOwner: 'contributor/repo' },
          }),
          stderr: '',
        };
      }
      if (cmd === 'git') {
        return { stdout: `${HEAD}\trefs/heads/codex/live\n`, stderr: '' };
      }
      assert.fail(`unexpected command: ${cmd}`);
    },
  });

  assert.equal(result.state, 'OPEN');
  assert.equal(result.headBranchExists, true);
  assert.deepEqual(calls.map((call) => call.cmd), ['gh', 'git']);
  assert.ok(calls[0].args.includes('state,headRefName,headRefOid,headRepository'));
  assert.deepEqual(calls[1].args, [
    'ls-remote',
    '--exit-code',
    '--heads',
    'https://github.com/contributor/repo.git',
    'refs/heads/codex/live',
  ]);
});

test('DCR-02: default live probe treats missing head repository as missing branch', async () => {
  const calls = [];

  const result = await __testables__.defaultAmaLivePrProbe({
    repo: 'acme/repo',
    prNumber: 404,
    retryDelaysMs: [],
    sleepImpl: async () => {},
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh') {
        return {
          stdout: JSON.stringify({
            state: 'OPEN',
            headRefName: 'codex/deleted-fork',
            headRefOid: HEAD,
            headRepository: null,
          }),
          stderr: '',
        };
      }
      assert.fail(`unexpected command: ${cmd}`);
    },
  });

  assert.equal(result.state, 'OPEN');
  assert.equal(result.headBranchExists, false);
  assert.deepEqual(calls.map((call) => call.cmd), ['gh']);
});

test('DCR-02: default live probe retries transient gh and git failures', async () => {
  const calls = [];
  const sleeps = [];

  const result = await __testables__.defaultAmaLivePrProbe({
    repo: 'acme/repo',
    prNumber: 404,
    retryDelaysMs: [1, 2],
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (cmd === 'gh' && calls.filter(call => call.cmd === 'gh').length === 1) {
        throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      }
      if (cmd === 'gh') {
        return { stdout: JSON.stringify({ state: 'OPEN', headRefName: 'codex/live', headRefOid: HEAD }), stderr: '' };
      }
      if (cmd === 'git' && calls.filter(call => call.cmd === 'git').length === 1) {
        throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EIO' });
      }
      if (cmd === 'git') {
        return { stdout: `${HEAD}\trefs/heads/codex/live\n`, stderr: '' };
      }
      assert.fail(`unexpected command: ${cmd}`);
    },
  });

  assert.equal(result.state, 'OPEN');
  assert.equal(result.headBranchExists, true);
  assert.deepEqual(calls.map(call => call.cmd), ['gh', 'gh', 'git', 'git']);
  assert.equal(calls.find(call => call.cmd === 'git')?.options?.env?.GIT_TERMINAL_PROMPT, '0');
  assert.deepEqual(sleeps, [1, 1]);
});

test('DCR-02: default live probe preserves PR state when branch probe cannot recover', async () => {
  let gitAttempts = 0;

  const result = await __testables__.defaultAmaLivePrProbe({
    repo: 'acme/repo',
    prNumber: 404,
    retryDelaysMs: [1, 2],
    sleepImpl: async () => {},
    execFileImpl: async (cmd) => {
      if (cmd === 'gh') {
        return { stdout: JSON.stringify({ state: 'OPEN', headRefName: 'codex/live', headRefOid: HEAD }), stderr: '' };
      }
      if (cmd === 'git') {
        gitAttempts += 1;
        throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
      }
      assert.fail(`unexpected command: ${cmd}`);
    },
  });

  assert.equal(result.state, 'OPEN');
  assert.equal(result.headBranchExists, null);
  assert.equal(result.headBranchProbeError, 'TLS handshake timeout');
  assert.equal(gitAttempts, 3);
});

test('MSM-04: no source path still uses the standalone closer prompt for dispatch', () => {
  const source = readFileSync(new URL('../src/ama/dispatch-closer.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('templates/ama-closer-prompt.md'), false);
  assert.equal(/const\s+TEMPLATE_PATH\b/.test(source), false);
});

test('MSM-04: stale reviewed head without closer proof does not re-hammer', async (t) => {
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
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false, reason: null }),
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

test('MSM-04: clean route reconciles existing hammer dispatch before daemon decline', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-clean-existing-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
    reviewedSha: HEAD,
    workerClass: 'hammer',
    state: 'dispatched',
    dispatchId: 'dispatch_existing',
    launchRequestId: 'lrq_existing',
    promptPath: '/tmp/hammer-prompt.md',
    retryCount: 1,
    lastObservedStatus: 'running',
  }));
  const deps = testDeps();
  deps.execFileImpl = async (cmd, args) => {
    deps.calls.push({ cmd, args });
    return { stdout: JSON.stringify({ status: 'running' }), stderr: '' };
  };
  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir, {
      reviewState: {
        verdict: 'comment-only',
        blockingFindingState: 'known',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 0,
      },
      prMetadata: {
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
        ],
        branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
      },
      cfg: {
        branchProtection: { required: true },
      },
      dispatchContext: {
        requiredGateContext: 'agent-os/adversarial-gate',
      },
    }),
    options: { env: { ADV_GATE_STATUS_CONTEXT: 'agent-os/adversarial-gate' } },
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'existing-dispatch-running');
  assert.equal(result.launchRequestId, 'lrq_existing');
  assert.equal(deps.calls.length, 1, 'existing dispatch status is probed before clean-route return');
});

test('MSM-04: merged signal tears down deterministic hammer worker before clean-route return', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-clean-merged-signal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
    reviewedSha: HEAD,
    workerClass: 'hammer',
    state: 'dispatched',
    dispatchId: 'dispatch_existing',
    launchRequestId: 'lrq_existing',
    promptPath: '/tmp/hammer-prompt.md',
    retryCount: 1,
    lastObservedStatus: 'succeeded',
  }));
  const deps = testDeps();
  deps.execFileImpl = async (cmd, args) => {
    deps.calls.push({ cmd, args });
    return { stdout: '{}', stderr: '' };
  };
  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir, {
      reviewState: {
        verdict: 'comment-only',
        blockingFindingState: 'known',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 0,
      },
      prMetadata: {
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
        ],
        branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
      },
      cfg: {
        branchProtection: { required: true },
      },
      dispatchContext: {
        requiredGateContext: 'agent-os/adversarial-gate',
      },
    }),
    options: { env: { ADV_GATE_STATUS_CONTEXT: 'agent-os/adversarial-gate' } },
    ...deps,
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: {
        repo: 'acme/repo',
        pr_number: 404,
        head_sha: HEAD,
        signal_kind: 'merged',
      },
    }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'merged-signal-present');
  assert.deepEqual(deps.calls.map((call) => call.args.slice(0, 3)), [
    ['worker', 'tear-down', 'hammer-ama-pr-404'],
  ]);
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
