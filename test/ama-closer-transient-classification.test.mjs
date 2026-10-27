import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import { evaluateNoProgressLane, readNoProgressLane, recordNoProgressLaneRun } from '../src/watcher-no-progress-lane.mjs';
import { readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { createAmaHammerBackgroundQueue } from '../src/ama-hammer-background-dispatch.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  amaCloserDispatchFilePath,
  parseHqDispatchDrainRefusal,
  readAmaCloserDispatchRecord,
  updateAmaCloserDispatchRecord,
  isGithubRateLimitOrBrokerThrottle,
  isTransientHqDispatchError,
  HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
  maybeDispatchAmaCloser,
  resolveHamTerminalRemediationEvidence,
} from '../src/ama/dispatch-closer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'hammer-prompt.md');
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

const VERIFIED_HAM_COMMIT = {
  sha: 'def67890def67890def67890def67890def67890',
  parentSha: 'abc12345abc12345abc12345abc12345abc12345',
  message: [
    'HAM terminal remediation',
    '',
    'Worker-Class: hammer',
    'Worker-Ticket: HAM',
    'Reviewed-Head: abc12345abc12345abc12345abc12345abc12345',
    'Closed-By: hammer (adversarial-pipe-mode)',
    'Remediated-Findings: 1 addressed (1 blocking, 0 non-blocking)',
  ].join('\n'),
  trailers: {
    'worker-class': 'hammer',
    'worker-ticket': 'HAM',
    'reviewed-head': 'abc12345abc12345abc12345abc12345abc12345',
    'closed-by': 'hammer (adversarial-pipe-mode)',
    'remediated-findings': '1 addressed (1 blocking, 0 non-blocking)',
  },
  author: 'the-hammer-lacey[bot]',
  committer: 'the-hammer-lacey[bot]',
  changedFiles: ['src/auth.js'],
};

const VERIFIED_HAM_AUDIT_BODY = [
  HAM_TERMINAL_REMEDIATION_AUDIT_MARKER,
  '',
  '## Hammer remediation audit',
  '',
  '**Findings addressed**',
  '- **Auth path not threaded** (blocking) - src/auth.js fixed the auth path.',
  '',
  'Doc-currency: not applicable for changed files src/auth.js.',
  '',
  '<sub>',
  'HAM-Terminal-Remediation-Head: def67890def67890def67890def67890def67890',
  'HAM-Base-Head: abc12345abc12345abc12345abc12345abc12345',
  'HAM-Validated-Head: def67890def67890def67890def67890def67890',
  'Remediated-Findings: 1 addressed (1 blocking, 0 non-blocking)',
  'Closed-By: hammer (adversarial-pipe-mode)',
  '</sub>',
].join('\n');

test('resolveHamTerminalRemediationEvidence builds claim and ground truth from injected commit and audit seams', async () => {
  let fetchedCommit = false;
  let fetchedRollup = false;
  const result = await resolveHamTerminalRemediationEvidence({
    reviewState: { headSha: VERIFIED_HAM_COMMIT.parentSha },
    prMetadata: { headSha: VERIFIED_HAM_COMMIT.sha },
    repoPath: 'laceyenterprises/example',
    prNumber: 5270,
    fetchHeadCloserVerifiedCommitImpl: async () => {
      fetchedCommit = true;
      return VERIFIED_HAM_COMMIT;
    },
    fetchPullRequestRollupImpl: async () => {
      fetchedRollup = true;
      return {
        comments: [
          {
            id: 'old',
            author: { login: 'the-hammer-lacey[bot]' },
            body: 'not the marker',
            createdAt: '2026-08-12T10:00:00Z',
          },
          {
            id: 'IC_ham_audit',
            author: { login: 'the-hammer-lacey[bot]' },
            body: VERIFIED_HAM_AUDIT_BODY,
            createdAt: '2026-08-12T10:05:00Z',
          },
        ],
      };
    },
  });

  assert.equal(fetchedCommit, true);
  assert.equal(fetchedRollup, true);
  assert.equal(result.hamTerminalRemediation.commit.sha, VERIFIED_HAM_COMMIT.sha);
  assert.equal(result.hamTerminalRemediation.auditComment.body, VERIFIED_HAM_AUDIT_BODY);
  assert.deepEqual(result.hamTerminalRemediation.auditComment.docCurrency, {
    status: 'not_applicable',
    changedFiles: ['src/auth.js'],
  });
  assert.deepEqual(result.hamTerminalRemediation.auditComment.findings, [
    {
      title: 'Auth path not threaded',
      blocking: true,
      file: 'src/auth.js',
      addressed: true,
    },
  ]);
  assert.equal(result.hamTerminalRemediationGroundTruth.commit, VERIFIED_HAM_COMMIT);
  assert.deepEqual(result.hamTerminalRemediationGroundTruth.auditComment, {
    id: 'IC_ham_audit',
    author: 'the-hammer-lacey[bot]',
    body: VERIFIED_HAM_AUDIT_BODY,
    createdAt: '2026-08-12T10:05:00Z',
  });
});

test('resolveHamTerminalRemediationEvidence does not build evidence for an external stale-head push', async () => {
  let fetchedRollup = false;
  const result = await resolveHamTerminalRemediationEvidence({
    reviewState: { headSha: VERIFIED_HAM_COMMIT.parentSha },
    prMetadata: { headSha: VERIFIED_HAM_COMMIT.sha },
    repoPath: 'laceyenterprises/example',
    prNumber: 5270,
    fetchHeadCloserVerifiedCommitImpl: async () => ({
      ...VERIFIED_HAM_COMMIT,
      message: 'human push',
      trailers: {},
      committer: 'some-human-contributor',
    }),
    fetchPullRequestRollupImpl: async () => {
      fetchedRollup = true;
      return { comments: [] };
    },
  });

  assert.equal(result, null);
  assert.equal(fetchedRollup, true, 'no-diff validation needs the live audit even without a HAM tip');
});

test('resolveHamTerminalRemediationEvidence rejects linked foreign provenance despite terminal trailers', async () => {
  for (const field of ['author', 'committer']) {
    const result = await resolveHamTerminalRemediationEvidence({
      reviewState: { headSha: VERIFIED_HAM_COMMIT.parentSha },
      prMetadata: { headSha: VERIFIED_HAM_COMMIT.sha },
      repoPath: 'laceyenterprises/example',
      prNumber: 5270,
      fetchHeadCloserVerifiedCommitImpl: async () => ({
        ...VERIFIED_HAM_COMMIT,
        [field]: 'some-human-contributor',
      }),
      fetchPullRequestRollupImpl: async () => ({ comments: [] }),
    });
    assert.equal(result, null, field);
  }
});

test('resolveHamTerminalRemediationEvidence propagates transient commit fetch errors', async () => {
  const err = new Error('TLS handshake timeout');
  err.stderr = 'TLS handshake timeout';
  await assert.rejects(
    resolveHamTerminalRemediationEvidence({
      reviewState: { headSha: VERIFIED_HAM_COMMIT.parentSha },
      prMetadata: { headSha: VERIFIED_HAM_COMMIT.sha },
      repoPath: 'laceyenterprises/example',
      prNumber: 5270,
      fetchHeadCloserVerifiedCommitImpl: async () => {
        throw err;
      },
    }),
    /TLS handshake timeout/,
  );
});

function exactHeadOptions(execFileImpl, signal) {
  return {
    reviewState: { headSha: VERIFIED_HAM_COMMIT.parentSha },
    prMetadata: { headSha: VERIFIED_HAM_COMMIT.sha, baseRefName: 'release' },
    repoPath: 'fixture/repo', prNumber: 5270, env: { PATH: process.env.PATH, GH_TOKEN: 'fixture-token' },
    execFileImpl, signal,
    fetchHeadCloserVerifiedCommitImpl: async () => VERIFIED_HAM_COMMIT,
    fetchPullRequestRollupImpl: async () => ({ comments: [{
      author: 'the-hammer-lacey[bot]',
      body: VERIFIED_HAM_AUDIT_BODY.split('\n').filter(line => !line.startsWith('HAM-Base-Head:')).join('\n'),
    }] }),
  };
}

test('exact-head daemon range reads retry TLS failures and retain timeout, auth and cancellation', async () => {
  const calls = new Map();
  const controller = new AbortController();
  const range = await resolveHamTerminalRemediationEvidence(exactHeadOptions(async (command, args, options) => {
    assert.equal(command, 'gh');
    assert.equal(options.timeout, 15000);
    assert.equal(options.env.GH_TOKEN, 'fixture-token');
    assert.equal(options.signal, controller.signal);
    const path = args[1];
    calls.set(path, (calls.get(path) || 0) + 1);
    if (calls.get(path) === 1) throw Object.assign(new Error('TLS handshake timeout'), { stderr: 'TLS handshake timeout' });
    return { stdout: JSON.stringify(path.endsWith('/commits/release') ? { sha: 'base' } : {
      status: 'ahead', total_commits: 1, commits: [{ sha: VERIFIED_HAM_COMMIT.sha,
        author: { login: 'lacey-codex-agent[bot]' }, committer: { login: 'web-flow' },
        commit: { verification: { verified: true, reason: 'valid' } } }],
    }) };
  }, controller.signal));
  assert.equal(range.hamTerminalRemediationGroundTruth.range.verified, true);
  assert.equal(calls.size, 3);
  assert.deepEqual([...calls.values()], [2, 2, 2]);
});

for (const transient of [true, false]) {
  test(`exact-head daemon range fails closed after ${transient ? 'bounded transient retries' : 'one permanent permission error'}`, async () => {
    let attempts = 0;
    const error = Object.assign(new Error(transient ? 'HTTP 503' : 'HTTP 403 Forbidden'), {
      stderr: transient ? 'HTTP 503' : 'HTTP 403 Forbidden',
    });
    await assert.rejects(resolveHamTerminalRemediationEvidence(exactHeadOptions(async () => {
      attempts++;
      throw error;
    })), caught => caught === error);
    assert.equal(attempts, transient ? 3 : 1);
  });
}

test('exact-head daemon range cancellation prevents any GitHub subprocess', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveHamTerminalRemediationEvidence(exactHeadOptions(
    async () => assert.fail('aborted range must not call gh'), controller.signal)), { name: 'AbortError' });
});

// ---------------------------------------------------------------------------
// Classifier: rate-limit / 429 / 503 are transient; genuine auth is not.
// ---------------------------------------------------------------------------

test('isGithubRateLimitOrBrokerThrottle recognizes throttle + broker signals', () => {
  for (const msg of [
    'gh: API rate limit exceeded (HTTP 403)',
    'You have exceeded a secondary rate limit. Please wait',
    'GraphQL: API rate limit already exceeded for user ID 282134940',
    'HTTP 429 Too Many Requests',
    'abuse detection mechanism triggered',
    'You have submitted too quickly; retry your request',
    'oauth broker fetch failed: HTTP 503 service unavailable',
    'broker unavailable',
  ]) {
    assert.equal(isGithubRateLimitOrBrokerThrottle(msg), true, `expected transient: ${msg}`);
    assert.equal(isTransientHqDispatchError({ stderr: msg }), true, `expected transient err: ${msg}`);
  }
});

test('isGithubRateLimitOrBrokerThrottle does NOT match genuine auth failures', () => {
  for (const msg of [
    'Bad credentials (HTTP 401)',
    'fatal: could not read Username for https://github.com',
    'requires authentication',
    'worker provision failed: merge conflict',
    '',
    null,
  ]) {
    assert.equal(isGithubRateLimitOrBrokerThrottle(msg), false, `must not be throttle: ${msg}`);
  }
});

test('isGithubRateLimitOrBrokerThrottle accepts both string and error-object shapes', () => {
  assert.equal(isGithubRateLimitOrBrokerThrottle({ message: 'API rate limit exceeded' }), true);
  assert.equal(isGithubRateLimitOrBrokerThrottle({ stdout: 'secondary rate limit' }), true);
  assert.equal(isGithubRateLimitOrBrokerThrottle({ status: 429, message: 'request failed' }), true);
  assert.equal(isGithubRateLimitOrBrokerThrottle({ statusCode: 429, message: 'request failed' }), true);
  assert.equal(isGithubRateLimitOrBrokerThrottle('plain string with rate limit'), true);
});

test('isTransientHqDispatchError recognizes transient diagnostics after a non-matching first line', () => {
  assert.equal(
    isTransientHqDispatchError('Bad request.\nresource temporarily unavailable while tearing down worker'),
    true,
  );
  assert.equal(
    isTransientHqDispatchError({
      stderr: 'fatal: unable to access https://github.com/acme/repo.git/: connection reset by peer',
    }),
    true,
  );
});

test('isGithubRateLimitOrBrokerThrottle does NOT match unrelated bare 429 text', () => {
  for (const msg of [
    'wrote 429 bytes before exiting',
    'line 429: assertion failed',
    'processed 429 records',
  ]) {
    assert.equal(isGithubRateLimitOrBrokerThrottle(msg), false, `must not be throttle: ${msg}`);
  }
});

// ---------------------------------------------------------------------------
// Budget preservation: a transient hammer-dispatch failure must NOT decrement
// the persisted redispatch budget toward dispatch-retry-exhausted.
// ---------------------------------------------------------------------------

function eligibleInputs(rootDir) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  const reviewState = {
    verdict: 'comment-only',
    reviewCycleExhausted: true,
    headSha,
    riskClass: 'low',
    remediationPending: false,
    blockingFindingState: 'known',
    blockingFindingCount: 0,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    operatorApprovedEvidence: null,
    prAuthor: 'codex-worker-bot',
    reviewerFamily: 'claude',
  };
  const prMetadata = {
    prNumber: 1234,
    headSha,
    isOpen: true,
    isDraft: false,
    mergeableState: 'MERGEABLE',
    labels: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'integration', conclusion: 'FAILURE' },
    ],
    branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
    author: 'codex-worker-bot',
  };
  const cfg = {
    enabled: true,
    workerClass: 'hammer',
    mergeMethod: 'squash',
    eligibility: {
      riskClasses: ['low'],
      fastMergeLabels: ['fast-merge:test-fixtures', 'fast-merge:docs'],
    },
    branchProtection: {},
  };
  const dispatchContext = {
    repo: 'acme/myrepo',
    prUrl: 'https://github.com/acme/myrepo/pull/1234',
    reviewedSha: headSha,
    riskClass: 'low',
    requiredGateContext: 'agent-os/adversarial-gate',
    reviewedBy: 'claude-reviewer-lacey',
    reviewer: 'claude',
    parentSession: 'session:test:watcher',
    hqProject: 'adversarial-merge-authority',
    hqPath: '/bin/true-stub-hq',
    hqRoot: join(rootDir, 'hq-root'),
    hqOwnerUser: CURRENT_USER,
    currentUser: CURRENT_USER,
    rootDir,
    livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: headSha, headBranchExists: true, headRefName: 'synthetic-branch' }),
    dispatchedAt: '2026-06-11T20:00:00Z',
  };
  return { reviewState, prMetadata, cfg, dispatchContext, headSha };
}

async function dispatchWithError(rootDir, errFactory) {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleInputs(rootDir);
  const calls = [];
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    throw errFactory();
  };
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl,
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    writeFileImpl: () => {},
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });
  return { result, calls };
}

test('an interrupted dispatch with rate-limit text preserves unknown ownership and its conservative attempt charge', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-transient-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/myrepo', prNumber: 1234, headSha: 'abc12345abc12345abc12345abc12345abc12345' };
  const { result } = await dispatchWithError(rootDir, () => Object.assign(new Error('hq dispatch interrupted'), {
    code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true,
    stdout: '{"partial":true}', stderr: 'gh: API rate limit exceeded (HTTP 403)',
  }));
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'existing-dispatch-unknown');
  assert.equal(result.skipMergeAgent, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.retryCount, 1, 'partial diagnostics cannot prove no launch or authorize a refund');
  assert.equal(record.state, 'dispatching');
  assert.equal(record.dispatchPhase, 'submitting');
  assert.ok(record.dispatchIdempotencyKey);
  assert.equal(record.lastError, null);
});

test('BUG-2: an hq drain-in-effect hammer-dispatch refusal is transient (no merge-agent fallback, budget preserved)', () => {
  const drainStderr =
    "[hq] dispatch refused: drain in effect (epoch=515, started_at=2026-07-19T11:41:22Z, " +
    "started_by=operator:airlock, reason='main-catchup pass for SHA ddcb9eaec732').";
  assert.equal(isTransientHqDispatchError({ code: 6, stderr: drainStderr }), true, 'drain refusal must be transient');
  assert.equal(
    isTransientHqDispatchError('hq dispatch failed\ncode: 6\n' + drainStderr),
    true,
    'drain refusal transient even after a non-matching first line',
  );
});

test('BUG-2: drain transient classifier is anchored to hq refusal lines', () => {
  assert.equal(
    isTransientHqDispatchError({
      stderr: "worker branch 'feature/drain in effect' failed normal validation",
    }),
    false,
    'user-controlled branch/path text must not trigger drain retry classification',
  );
  assert.equal(
    isTransientHqDispatchError({
      stderr: "payload said dispatch refused: drain in effect, but hq returned validation failure",
    }),
    false,
    'unprefixed prose must not trigger drain retry classification',
  );
});

test('DRAINDEFER-01: exit 6 drain refusal persists epoch, releases lease and preserves lane counters', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  const identity = { repo: inputs.dispatchContext.repo, prNumber: inputs.prMetadata.prNumber, headSha: inputs.headSha };
  const logger = { warn() {}, log() {}, error() {} };
  const handler = { repoPath: identity.repo, ...identity };
  const gate = createNoProgressLaneGate({ rootDir, logger, readReviewRow: () => ({ review_status: 'posted' }) });
  await gate.record(handler);
  await gate.record(handler);
  const before = readNoProgressLane(rootDir, identity);
  const { result, calls } = await dispatchWithError(rootDir, () =>
    Object.assign(new Error('dispatch refused'), { code: 6,
      stderr: '[hq] dispatch refused: drain in effect (epoch=42, reason=synthetic-repo_unregistered-branch_holder_blocked-uq_worker_runs_live_logical_job)' }));
  assert.equal(result.reason, 'deferred-by-drain');
  assert.equal(result.drainEpoch, '42');
  assert.equal(result.skipMergeAgent, true);
  assert.equal(calls.filter(call => call.args[0] === 'dispatch').length, 1, 'a drain waits for the next pass, without inline transient retries');
  const record = readAmaCloserDispatchRecord(rootDir, identity);
  assert.equal(record.retryCount, 0);
  assert.equal(record.state, 'deferred-by-drain');
  assert.equal(record.drainEpoch, '42');
  assert.equal(readAmaCloserLease(rootDir, identity), null);
  for (let pass = 0; pass < 6; pass++) {
    assert.equal(gate.evaluate(handler).run, true);
    await gate.record(handler, { value: { amaClosureResult: result } });
  }
  assert.deepEqual(readNoProgressLane(rootDir, identity), before, 'drain leaves the entire counter ledger untouched');

  const statusCalls = [];
  const waiting = await maybeDispatchAmaCloser({ ...inputs, logger,
    execFileImpl: async (_cmd, args, options) => {
      assert.equal(options.cwd, resolve(REPO_ROOT, '../..'));
      statusCalls.push(args);
      return { stdout: JSON.stringify({ isDraining: true, epoch: 43 }) };
    } });
  assert.equal(waiting.reason, 'deferred-by-drain');
  assert.equal(waiting.drainEpoch, '43', 'a replacement drain still blocks dispatch');
  assert.deepEqual(statusCalls, [['dispatch', 'drain-status', '--no-reap', '--root', inputs.dispatchContext.hqRoot]]);
  const refreshed = readAmaCloserDispatchRecord(rootDir, identity);
  assert.equal(refreshed.retryCount, record.retryCount);
  assert.equal(refreshed.drainEpoch, '43');
  assert.ok(Date.parse(refreshed.updatedAt) >= Date.parse(record.updatedAt));
  assert.equal(readAmaCloserLease(rootDir, identity), null);
});

test('DRAINDEFER-01: drain epochs preserve numeric, formatted and alphanumeric tokens', () => {
  for (const epoch of ['515', 'deploy-a9', '2026-10-18T02:00:00Z', '9-next']) {
    for (const suffix of [', reason=deploy)', ')', ' extra']) {
      const stderr = `[hq] dispatch refused: drain in effect (epoch=${epoch}${suffix}`;
      assert.deepEqual(parseHqDispatchDrainRefusal({ code: 6, stderr }), { epoch });
      assert.deepEqual(parseHqDispatchDrainRefusal(`code: 6\nstderr: ${stderr}`), { epoch });
    }
  }
  assert.deepEqual(parseHqDispatchDrainRefusal({ code: 6, stderr: '[hq] dispatch refused: drain in effect' }), { epoch: null });
});

test('DRAINDEFER-01: other exit-6 refusals and wrong-code drain text keep existing handling', async t => {
  assert.deepEqual(parseHqDispatchDrainRefusal({ code: 6, stderr: 'dispatch refused: drain in effect (epoch=9)' }), { epoch: '9' });
  for (const err of [
    { code: 1, stderr: '[hq] dispatch refused: drain in effect (epoch=9)' },
    { stderr: '[hq] dispatch refused: drain in effect (epoch=9)' },
    { code: 6, stderr: '[hq] dispatch refused: drain unavailable' },
    { code: 6, stderr: 'payload: dispatch refused: drain in effect (epoch=9)' },
    { code: 6, stderr: '[hq] dispatch refused: provision slot busy' },
  ]) {
    assert.equal(parseHqDispatchDrainRefusal(err), null);
    assert.equal(isTransientHqDispatchError(err), false);
  }
  for (const [stderr, expected] of [
    ['temporary failure: synthetic dispatcher unavailable', 'dispatch-deferred-transient'],
    ['[hq] dispatch refused: dispatch_preflight_timeout: stage=synthetic (30s admission budget)', 'dispatch-deferred-transient'],
    ['[hq] dispatch refused: worker-class fallback unavailable: retained workspace requires synthetic class', 'dispatch-failed'],
    ['dispatch refused: synthetic admission refusal', 'dispatch-failed'],
    ['payload: dispatch refused: drain in effect (epoch=9)', 'dispatch-failed'],
  ]) {
    const rootDir = mkdtempSync(join(tmpdir(), 'ama-other-refusal-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const { result } = await dispatchWithError(rootDir, () => Object.assign(new Error('dispatch refused'), { code: 6, stderr }));
    assert.equal(result.reason, expected);
    const inputs = eligibleInputs(rootDir);
    const gate = createNoProgressLaneGate({ rootDir, logger: { warn() {}, log() {} },
      readReviewRow: () => ({ review_status: 'posted' }) });
    const handler = { repoPath: inputs.dispatchContext.repo, prNumber: inputs.prMetadata.prNumber, headSha: inputs.headSha };
    for (let pass = 0; pass < 5; pass++) await gate.record(handler, { value: { amaClosureResult: result } });
    assert.equal(readNoProgressLane(rootDir, { repo: handler.repoPath, prNumber: handler.prNumber }).lane, 'slow');
  }
});

test('DRAINDEFER-01: fresh drain bypass preserves pre-existing debt, other heads and refusals stay slow', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-lane-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { headSha, dispatchContext, prMetadata } = eligibleInputs(rootDir);
  const identity = { repo: dispatchContext.repo, prNumber: prMetadata.prNumber, headSha };
  const handler = { repoPath: identity.repo, ...identity };
  const logger = { warn() {}, log() {} };
  for (let pass = 0; pass < 6; pass++) recordNoProgressLaneRun(rootDir, identity,
    { headSha, fingerprint: 'unchanged', logger });
  const slow = readNoProgressLane(rootDir, identity);
  assert.equal(evaluateNoProgressLane(slow, { headSha }).due, false);
  const gate = createNoProgressLaneGate({ rootDir, logger, readReviewRow: () => null });
  for (const record of [
    { state: 'dispatch-deferred-transient', lastError: 'code: 6\nstderr: temporary failure' },
    { state: 'deferred-by-drain', headSha: 'd'.repeat(40) },
  ]) {
    const key = { ...identity, headSha: record.headSha || headSha };
    updateAmaCloserDispatchRecord(rootDir, key, () => ({ ...key, ...record }));
    assert.equal(gate.evaluate(handler).run, false);
  }
  const beforeDrain = readNoProgressLane(rootDir, identity);
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatch-deferred-transient',
    updatedAt: new Date().toISOString(), lastError: 'code: 6\nstderr: [hq] dispatch refused: drain in effect (epoch=42)' }));
  assert.equal(gate.evaluate(handler).lane, 'active');
  assert.equal(gate.evaluate(handler).run, true);
  assert.deepEqual(readNoProgressLane(rootDir, identity), beforeDrain, 'pre-existing debt is preserved during the bypass');
});

test('a genuine (non-transient) hammer-dispatch failure DOES consume the budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-genuine-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/myrepo', prNumber: 1234, headSha: 'abc12345abc12345abc12345abc12345abc12345' };

  const { result } = await dispatchWithError(rootDir, () => {
    const err = new Error('hq dispatch failed');
    err.stderr = 'fatal: unrecoverable hammer provisioning error';
    return err;
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-failed');

  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.retryCount, 1, 'genuine failure increments retryCount toward the bound');
  assert.equal(record.state, 'dispatch-failed');
});

test('maybeDispatchAmaCloser refuses invalid PR numbers before dispatch setup', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-invalid-pr-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleInputs(rootDir);
  let execCalls = 0;
  let templateReads = 0;

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata: { ...prMetadata, prNumber: 'not-a-number' },
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      execCalls += 1;
      return { stdout: '{"dispatchId":"dispatch_unexpected"}', stderr: '' };
    },
    writeFileImpl: () => {},
    readTemplateImpl: () => {
      templateReads += 1;
      return readFileSync(HAMMER_TEMPLATE_PATH, 'utf8');
    },
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'invalid-pr-number');
  assert.equal(execCalls, 0);
  assert.equal(templateReads, 0);
});


test('HAMINTENT: the closer holds an intent reversal with scoped operator recovery', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-intent-escalation-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  const primaryChange = { ...primaryChangeFixture(inputs.prMetadata.headSha), finalFiles: [] };
  const result = await maybeDispatchAmaCloser({ ...inputs, options: { primaryChange },
    execFileImpl: async () => { assert.fail('intent reversal must not dispatch or merge'); },
  });
  assert.equal(result.reason, 'primary-change-repair-required');
  assert.equal(result.exactHeadReview, undefined, 'builder refusal cannot authorize HAM exact-head recovery');
  assert.equal(result.missingEvidence.evidence, 'reversal-authorization');
  assert.equal(result.needsOperator, true);
  assert.equal(result.dispatched, false);
  assert.ok(result.reasons.includes('primary-change-reverted'));
});

test('primary-change closer refusals do not page before orphan attempts exhaust', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-background-refusals-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  const queue = createAmaHammerBackgroundQueue();
  let pages = 0;
  const key = `${inputs.dispatchContext.repo}#${inputs.prMetadata.prNumber}@${inputs.headSha}`;
  for (let observation = 1; observation <= 4; observation += 1) {
    queue.submit({ key, run: () => maybeDispatchAmaCloser({ ...inputs,
      options: { primaryChange: { ...primaryChangeFixture(inputs.headSha), finalFiles: [] } },
      deliverAlertImpl: async (_text, options) => {
        pages += 1;
        assert.equal(options.event, 'ama_primary_change_refusal_exhausted');
        assert.equal(options.payload.severity, 'SEV1');
      },
      logger: { error() {}, warn() {} },
      execFileImpl: async () => assert.fail('a preservation refusal must not dispatch'),
    }) });
    await queue.drain();
    assert.equal(queue.takeSettled(key).result.reason, 'primary-change-repair-required');
    assert.equal(queue.takeSettled(key), null, 'the next cycle must re-run the closer');
    assert.equal(pages, 0);
  }
});

test('ownerproof recovery cannot waive unproven primary reversal', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-orphan-repair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  let prompt;
  const calls = [];
  const result = await maybeDispatchAmaCloser({ ...inputs,
    options: { primaryChange: { ...primaryChangeFixture(inputs.headSha), finalFiles: [] } },
    dispatchContext: { ...inputs.dispatchContext, orphanRecovery: { ownerProof: true, headSha: inputs.headSha } },
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
    writeFileImpl: (_dir, _path, body) => { prompt = body; },
    execFileImpl: async (_cmd, args) => { calls.push(args); throw new Error('test provisioning refusal'); },
  });
  assert.equal(result.reason, 'primary-change-repair-required');
  assert.equal(result.needsOperator, true);
  assert.equal(result.dispatched, false);
  assert.deepEqual(calls, []);
  assert.equal(prompt, undefined);
});

test('ownerproof evidence retains the shared observer for pending CI', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-orphan-mechanical-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  inputs.prMetadata.statusCheckRollup = [{ name: 'test', status: 'IN_PROGRESS' }];
  let prompt;
  const calls = [];
  await maybeDispatchAmaCloser({ ...inputs,
    options: { primaryChange: primaryChangeFixture(inputs.headSha) },
    dispatchContext: { ...inputs.dispatchContext, orphanRecovery: { ownerProof: true, headSha: inputs.headSha } },
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
    writeFileImpl: (_dir, _path, body) => { prompt = body; },
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'fleet') return { stdout: JSON.stringify(codexAccountFixture()) };
      calls.push(args); throw new Error('test provisioning refusal');
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(prompt, undefined);
});

for (const state of ['deferred-by-drain', 'dispatch-deferred-transient']) {
  test(`DRAINDEFER-01: ${state} bypass expires without a closer invocation`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-expiry-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const { headSha, dispatchContext, prMetadata } = eligibleInputs(rootDir);
    const identity = { repo: dispatchContext.repo, prNumber: prMetadata.prNumber, headSha };
    const handler = { repoPath: identity.repo, ...identity };
    let clock = Date.parse('2026-10-18T00:00:00Z');
    const logger = { warn() {}, log() {} };
    const gate = createNoProgressLaneGate({ rootDir, logger, now: () => new Date(clock).toISOString(), readReviewRow: () => null });
    for (let i = 0; i < 6; i++) await gate.record(handler);
    const before = readNoProgressLane(rootDir, identity);
    const seed = updatedAt => updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state, updatedAt,
      lastError: 'code: 6\nstderr: [hq] dispatch refused: drain in effect (epoch=42)' }));
    seed(new Date(clock).toISOString());
    assert.equal(gate.evaluate(handler).reason, 'deferred-by-drain');
    await gate.record(handler);
    assert.deepEqual(readNoProgressLane(rootDir, identity), before);
    clock += 300_000;
    // record() must also account normally without evaluate() retiring the hint first.
    await gate.record(handler);
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity).state, 'no-dispatch');
    assert.equal(readNoProgressLane(rootDir, identity).noProgressTicks, before.noProgressTicks + 1);
    seed(new Date(clock - 300_000).toISOString());
    assert.equal(gate.evaluate(handler).run, false);
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity).reason, 'drain-wait-ended');
    for (const updatedAt of [null, 'bad-date', new Date(clock + 1).toISOString()]) {
      seed(updatedAt);
      assert.notEqual(gate.evaluate(handler).reason, 'deferred-by-drain');
    }
  });
}

test('DRAINDEFER-01: disabled closer retires a fresh drain hint and restores backoff', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-disabled-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  const identity = { repo: inputs.dispatchContext.repo, prNumber: inputs.prMetadata.prNumber, headSha: inputs.headSha };
  const handler = { repoPath: identity.repo, ...identity };
  const gate = createNoProgressLaneGate({ rootDir, readReviewRow: () => null, logger: { warn() {}, log() {} } });
  for (let i = 0; i < 6; i++) await gate.record(handler);
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'deferred-by-drain', updatedAt: new Date().toISOString() }));
  assert.equal(gate.evaluate(handler).reason, 'deferred-by-drain');
  const result = await maybeDispatchAmaCloser({ ...inputs, cfg: { enabled: false },
    readDispatchDrainStatusImpl: async () => assert.fail('disabled closer must not poll'),
    execFileImpl: async () => assert.fail('disabled closer must not dispatch') });
  assert.equal(result.reason, 'ama-disabled');
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity).state, 'no-dispatch');
  assert.equal(gate.evaluate(handler).run, false);
});


for (const outcome of ['preserved', 'reverted', 'unknown', 'read-failed']) {
  test(`CLOSURESPLIT-01: real dispatcher refreshes inherited refusal: ${outcome}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closure-split-dispatch-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const inputs = eligibleInputs(rootDir);
    inputs.prMetadata.statusCheckRollup = [{ name: 'test', conclusion: 'SUCCESS' },
      { name: 'agent-os/adversarial-gate', conclusion: 'SUCCESS' }];
    const { headSha } = inputs;
    const snapshot = deriveNextActionSnapshot({ subjectKey: `${inputs.dispatchContext.repo}#1234`, head: headSha,
      observedAt: inputs.dispatchContext.dispatchedAt, observations: {
        pr: { headSha, state: 'OPEN', mergeable: 'MERGEABLE', labels: [] },
        reviews: inputs.reviewState, checks: { conclusion: 'SUCCESS' },
        policy: { autonomousMergeExecutionEnabled: true },
        leases: { closer: null }, launches: { closer: null },
        progress: { primaryChange: { ok: false, reason: 'primary-change-reverted', headSha } },
      } });
    const shared = { snapshot, decision: nextAction(snapshot) };
    assert.equal(shared.decision.reason, 'primary-change-repair');
    let reads = 0;
    const evidence = outcome === 'preserved' ? primaryChangeFixture(headSha)
      : outcome === 'reverted' ? { ...primaryChangeFixture(headSha), finalFiles: [] }
        : { headSha, ...(outcome === 'read-failed' ? { readFailed: true } : {}) };
    const result = await maybeDispatchAmaCloser({ ...inputs, sharedNextAction: shared,
      fetchPrimaryChangeImpl: async args => { reads++; assert.equal(args.headSha, headSha); return evidence; },
      execFileImpl: async () => assert.fail('no dispatch or merge on this admission result'),
      readTemplateImpl: () => assert.fail('mismatch/refusal precedes prompt construction'),
    });
    assert.equal(reads, 1);
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, outcome === 'preserved' ? 'closure-decision-mismatch'
      : outcome === 'read-failed' ? 'gate-read-failed' : 'primary-change-repair-required');
    if (outcome === 'preserved') {
      assert.equal(result.nextActionShared.decision.action, 'daemon-merge');
      assert.equal(result.decisionMismatch.selectedKey, shared.decision.decisionKey);
      assert.equal(result.nextActionShared.snapshot.observations.progress.value.primaryChange.ok, true);
    }
    assert.equal(readAmaCloserLease(rootDir, { repo: inputs.dispatchContext.repo, prNumber: 1234, headSha }), null);
  });
}
