import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  __testables__,
  AMA_CLOSER_REDISPATCH_BOUND,
  maybeDispatchAmaCloser,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { AMA_CLOSER_LEASE_STATUS, acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease } from '../src/ama/closer-lease.mjs';
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

function mechanicalHammerArgs(rootDir, overrides = {}) {
  return baseHammerArgs(rootDir, {
    ...overrides,
    reviewState: {
      verdict: 'comment-only',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      ...(overrides.reviewState || {}),
    },
    prMetadata: {
      mergeableState: 'DIRTY',
      ...(overrides.prMetadata || {}),
    },
  });
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
      return { stdout: JSON.stringify({ ticketRef: 'HAM', dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
    },
    guardStackedBaseImpl: async () => null,
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

test('MSM-04: review findings do not dispatch hammer before remediation exhaustion', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'msm-04-findings-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...baseHammerArgs(rootDir),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.equal(deps.calls.length, 0);
});

test('DCR-02: merged PR does not dispatch hammer merge task', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-merged-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...mechanicalHammerArgs(rootDir, {
      dispatchContext: {
        livePrProbeImpl: async () => ({ state: 'MERGED', headBranchExists: false }),
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'target-already-merged');
  assert.equal(result.prState, 'MERGED');
  assert.equal(deps.calls.length, 0, 'must not run hq dispatch for already-merged PR');
  const record = readAmaCloserDispatchRecord(rootDir, {
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
  });
  assert.equal(record.state, 'completed');
  assert.equal(record.status, 'target-already-merged');
  assert.equal(record.terminalOutcome, 'succeeded');
  const lease = readAmaCloserLease(rootDir, {
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
  });
  assert.equal(lease.status, AMA_CLOSER_LEASE_STATUS.TERMINAL);
  assert.equal(lease.terminalOutcome, 'succeeded');
});

test('DCR-02: pruned head branch does not dispatch hammer merge task', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-pruned-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...mechanicalHammerArgs(rootDir, {
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

test('DCR-02: stale branch-missing no-dispatch record revalidates before retry cap', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-stale-branch-missing-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  updateAmaCloserDispatchRecord(rootDir, {
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
  }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
    reviewedSha: HEAD,
    state: 'no-dispatch',
    reason: 'live-head-branch-missing',
    headBranchExists: false,
    headRefName: 'codex/live',
    retryCount: AMA_CLOSER_REDISPATCH_BOUND,
  }));

  const result = await maybeDispatchAmaCloser({
    ...mechanicalHammerArgs(rootDir, {
      dispatchContext: {
        livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/live' }),
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_hammer_1');
  assert.equal(deps.calls.length, 1, 'must re-dispatch after branch existence is revalidated');
  const record = readAmaCloserDispatchRecord(rootDir, {
    repo: 'acme/repo',
    prNumber: 404,
    headSha: HEAD,
  });
  assert.equal(record.state, 'dispatched');
  assert.equal(record.retryCount, 1);
});

test('DCR-02: default live probe treats git ls-remote exit 2 as pruned branch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dcr-02-default-pruned-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];

  const result = await maybeDispatchAmaCloser({
    ...mechanicalHammerArgs(rootDir, {
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
            autoMergeRequest: { enabledAt: '2026-07-20T12:00:00Z' },
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
  assert.ok(calls[0].args.includes('state,headRefName,headRefOid,headRepository,isCrossRepository,autoMergeRequest'));
  assert.deepEqual(result.autoMergeRequest, { enabledAt: '2026-07-20T12:00:00Z' });
  assert.deepEqual(calls[1].args, [
    'ls-remote',
    '--exit-code',
    '--heads',
    'https://github.com/contributor/repo.git',
    'refs/heads/codex/live',
  ]);
});

for (const outcome of ['exists', 'missing', 'failed', 'timeout', 'empty']) {
  test(`BRANCHPROBE-01: null head repository with ${outcome} branch confirmation`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'branchprobe-01-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const calls = [];
    const deps = testDeps();
    let confirmation = outcome;
    const args = {
      ...mechanicalHammerArgs(rootDir, { dispatchContext: { livePrProbeImpl: null } }),
      ...deps,
      execFileImpl: async (cmd, args, options) => {
        calls.push({ cmd, args, options });
        if (cmd === 'gh') return { stdout: JSON.stringify({
          state: 'OPEN', headRefName: 'synthetic/topic', headRefOid: HEAD, headRepository: null, isCrossRepository: false,
        }), stderr: '' };
        if (cmd === 'git') {
          assert.deepEqual(args, ['ls-remote', '--exit-code', '--heads',
            'https://github.com/acme/repo.git', 'refs/heads/synthetic/topic']);
          assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
          assert.ok(options.timeout > 0 && options.timeout <= 30_000);
          if (confirmation === 'missing') throw Object.assign(new Error('no matching remote ref'), { code: 2 });
          if (confirmation === 'failed') throw Object.assign(new Error('authentication failed'), { code: 128 });
          if (confirmation === 'timeout') throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
          return { stdout: confirmation === 'empty' ? '' : `${HEAD}\trefs/heads/synthetic/topic\n`, stderr: '' };
        }
        return deps.execFileImpl(cmd, args);
      },
    };
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const result = await maybeDispatchAmaCloser(args);
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    assert.deepEqual(calls.slice(0, 2).map(call => call.cmd), ['gh', 'git']);
    if (outcome === 'exists') {
      assert.equal(result.dispatched, true);
      assert.equal(record.state, 'dispatched');
      assert.equal(record.retryCount, 1);
      assert.equal(deps.calls.length, 1);
      assert.equal(readAmaCloserLease(rootDir, identity).status, AMA_CLOSER_LEASE_STATUS.DISPATCHED);
    } else if (outcome === 'missing') {
      assert.equal(result.dispatched, false);
      assert.equal(result.reason, 'live-head-branch-missing');
      assert.equal(record.state, 'no-dispatch');
      assert.equal(record.status, 'abandoned-pr-closed');
      assert.equal(record.headBranchExists, false);
      assert.equal(deps.calls.length, 0);
      assert.equal(readAmaCloserLease(rootDir, identity), null);
    } else {
      assert.equal(result.dispatched, false);
      assert.equal(result.reason, 'live-head-branch-unknown');
      assert.equal(result.skipMergeAgent, true);
      assert.equal(result.recoveryWait, true);
      assert.equal(result.retryAfterMs, 30_000);
      assert.equal(record.state, 'dispatch-deferred-transient');
      assert.equal(record.reason, 'live-head-branch-unknown');
      assert.notEqual(record.status, 'abandoned-pr-closed');
      assert.equal(record.headBranchExists, null);
      assert.equal(record.retryCount, 0, 'unlaunched probe deferrals must preserve launch budget');
      assert.equal(record.launchRequestId, null);
      assert.equal(deps.calls.length, 0);
      assert.equal(readAmaCloserLease(rootDir, identity), null, 'release the pending lease for the next poll');
      assert.match(record.lastError, outcome === 'failed' ? /authentication failed/
        : outcome === 'timeout' ? /timeout/ : /empty output/);
      assert.equal(calls.filter(call => call.cmd === 'git').length, outcome === 'timeout' ? 3 : 1);
      // Repeated unknown reads must not strand the PR at the redispatch cap.
      if (outcome === 'failed') {
        for (let i = 0; i <= AMA_CLOSER_REDISPATCH_BOUND; i++) {
          assert.equal((await maybeDispatchAmaCloser(args)).reason, 'live-head-branch-unknown');
          assert.equal(readAmaCloserDispatchRecord(rootDir, identity).retryCount, 0);
        }
      }
      confirmation = 'exists';
      assert.equal((await maybeDispatchAmaCloser(args)).dispatched, true, 'next poll resumes after recovery');
      assert.equal(readAmaCloserDispatchRecord(rootDir, identity).retryCount, 1);
    }
  });
}

test('BRANCHPROBE-01: an unidentified fork remains unknown without probing the base repository', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'branchprobe-01-fork-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const result = await maybeDispatchAmaCloser({
    ...mechanicalHammerArgs(rootDir, { dispatchContext: { livePrProbeImpl: null } }),
    ...testDeps(),
    execFileImpl: async (cmd, args) => {
      assert.equal(cmd, 'gh', 'must not infer fork deletion from the base repository');
      assert.ok(args.includes('state,headRefName,headRefOid,headRepository,isCrossRepository,autoMergeRequest'));
      return { stdout: JSON.stringify({ state: 'OPEN', headRefName: 'synthetic/topic',
        headRefOid: HEAD, headRepository: null, isCrossRepository: true }) };
    },
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'live-head-branch-unknown');
  assert.equal(result.recoveryWait, true);
  const record = readAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD });
  assert.equal(record.headBranchExists, null);
  assert.equal(record.retryCount, 0);
});

for (const recover of [false, true]) {
  test(`BRANCHPROBE-01: unresolved fork window ${recover ? 'resets on metadata recovery' : 'expires and stops probes'}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'branchprobe-fork-window-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const deps = testDeps();
    let probes = 0;
    let resolved = false;
    const args = {
      ...mechanicalHammerArgs(rootDir, { dispatchContext: { livePrProbeImpl: null } }),
      ...deps,
      execFileImpl: async (cmd, commandArgs) => {
        if (cmd === 'gh') {
          probes++;
          return { stdout: JSON.stringify({ state: 'OPEN', headRefName: 'synthetic/topic', headRefOid: HEAD,
            isCrossRepository: true, headRepository: resolved ? { nameWithOwner: 'contributor/repo' } : null }) };
        }
        if (cmd === 'git') {
          assert.equal(resolved, true, 'never probe the base repository for an unidentified fork');
          assert.ok(commandArgs.includes('https://github.com/contributor/repo.git'));
          return { stdout: `${HEAD}\trefs/heads/synthetic/topic\n` };
        }
        // A separate transient launch failure must not retain a recovered fork's clock.
        if (recover) throw Object.assign(new Error('synthetic broker throttle 429'), { code: 1 });
        return deps.execFileImpl(cmd, commandArgs);
      },
    };
    const run = at => {
      args.dispatchContext.dispatchedAt = at;
      return maybeDispatchAmaCloser(args);
    };
    assert.equal((await run('2026-07-06T12:00:00Z')).reason, 'live-head-branch-unknown');
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity).unresolvedForkHeadSince, '2026-07-06T12:00:00Z');
    assert.equal((await run('2026-07-06T17:59:59Z')).reason, 'live-head-branch-unknown');
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity).unresolvedForkHeadSince, '2026-07-06T12:00:00Z');
    if (recover) {
      resolved = true;
      await run('2026-07-06T18:00:00Z');
      assert.equal(readAmaCloserDispatchRecord(rootDir, identity).unresolvedForkHeadSince, null);
      resolved = false;
      assert.equal((await run('2026-07-06T18:01:00Z')).reason, 'live-head-branch-unknown');
      assert.equal(readAmaCloserDispatchRecord(rootDir, identity).unresolvedForkHeadSince, '2026-07-06T18:01:00Z');
      return;
    }
    const expired = await run('2026-07-06T18:00:00Z');
    assert.equal(expired.reason, 'live-head-fork-unresolved');
    assert.equal(expired.needsOperator, true);
    assert.equal(expired.skipMergeAgent, true);
    assert.notEqual(expired.recoveryWait, true);
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    assert.equal(record.state, 'no-dispatch');
    assert.equal(record.headBranchExists, null);
    assert.notEqual(record.status, 'abandoned-pr-closed');
    assert.equal(record.retryCount, 0);
    assert.equal(readAmaCloserLease(rootDir, identity), null);
    const probesAtExpiry = probes;
    assert.equal((await run('2026-07-07T12:00:00Z')).needsOperator, true);
    assert.equal(probes, probesAtExpiry, 'terminal head must not keep querying GitHub');
    assert.equal(deps.calls.length, 0, 'no hammer is launched or charged');
    // A new reviewed head has independent evidence and starts a fresh window.
    const newHead = 'b'.repeat(40);
    args.reviewState.headSha = newHead;
    args.prMetadata.headSha = newHead;
    args.dispatchContext.reviewedSha = newHead;
    args.dispatchContext.livePrProbeImpl = async () => ({ state: 'OPEN', headRefOid: newHead,
      headBranchExists: null, unresolvedForkHead: true });
    assert.equal((await run('2026-07-07T12:01:00Z')).reason, 'live-head-branch-unknown');
    assert.equal(readAmaCloserDispatchRecord(rootDir, { ...identity, headSha: newHead }).unresolvedForkHeadSince,
      '2026-07-07T12:01:00Z');
  });
}

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

test('MSM-04: HAM live gate prefers normalized rollup checks over legacy statusCheckRollup', () => {
  const checks = [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const legacy = [{ __typename: 'CheckRun', name: 'legacy', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const empty = [];
  const { resolveRollupRequiredChecks } = __testables__;

  assert.strictEqual(resolveRollupRequiredChecks({ checks, statusCheckRollup: legacy }), checks);
  assert.strictEqual(resolveRollupRequiredChecks({ checks: empty, statusCheckRollup: legacy }), empty);
  assert.strictEqual(resolveRollupRequiredChecks({ statusCheckRollup: legacy }), legacy);
  assert.strictEqual(resolveRollupRequiredChecks({}), null);
  assert.strictEqual(resolveRollupRequiredChecks(null), null);
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
  const args = mechanicalHammerArgs(rootDir);
  const first = maybeDispatchAmaCloser({ ...args, ...deps });
  const second = maybeDispatchAmaCloser({ ...args, ...deps });
  await new Promise((resolve) => setImmediate(resolve));
  deps.releaseExec();
  const results = await Promise.all([first, second]);

  assert.equal(deps.calls.length, 1);
  assert.equal(results.filter((result) => result.dispatched).length, 1);
  assert.equal(results.filter((result) =>
    ['lease-held', 'ama-closer-launch-in-progress'].includes(result.reason)).length, 1);
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


test('HAMCLOSE-01 handed Comment only findings dispatch one hammer on that exact head', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamclose-real-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  acquireAmaCloserLease(identity);
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'prior-hammer' });
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({
    repo: identity.repo, prNumber: 404, headSha: HEAD, reviewedSha: HEAD,
    launchRequestId: 'prior-hammer', state: 'dispatched', lastObservedStatus: 'succeeded',
  }));
  const deps = testDeps();
  const args = { ...baseHammerArgs(rootDir, {
    reviewState: { verdict: 'comment-only', blockingFindingCount: 0, nonBlockingFindingCount: 2 },
    prMetadata: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }] },
  }), ...deps };
  const result = await maybeDispatchAmaCloser(args);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.launchRequestId, 'lrq_hammer_1');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
  const second = await maybeDispatchAmaCloser(args);
  assert.equal(second.dispatched, false);
  assert.equal(deps.calls.filter(call => call.args[0] === 'dispatch').length, 1);
});

test('HAMCLOSE-01 handed clean review selects daemon closure without classifying its prior hammer as failed', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamclose-real-clean-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { rootDir, repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  acquireAmaCloserLease(identity);
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'prior-hammer' });
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' });
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...baseHammerArgs(rootDir, {
    reviewState: { verdict: 'approved', blockingFindingCount: 0 },
    prMetadata: { statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' }] },
  }), ...deps });
  assert.equal(result.reason, 'daemon-clean-route');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'handed-to-review');
  assert.equal(deps.calls.length, 0);
});
