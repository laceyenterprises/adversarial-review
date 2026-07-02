import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  amaCloserDispatchFilePath,
  isGithubRateLimitOrBrokerThrottle,
  isTransientHqDispatchError,
  maybeDispatchAmaCloser,
} from '../src/ama/dispatch-closer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'ama-closer-prompt.md');
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

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
// Budget preservation: a transient closer-dispatch failure must NOT decrement
// the persisted redispatch budget toward dispatch-retry-exhausted.
// ---------------------------------------------------------------------------

function eligibleInputs(rootDir) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  const reviewState = {
    verdict: 'approved',
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
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
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
      reviewerFamilyPolicy: 'audit_existing_gate_contract',
      ciGreenClassifier: 'existingAdversarialMergeClassifier',
    },
    branchProtection: { requiredGateContextSource: 'resolveGateStatusContext' },
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
    templatePath: TEMPLATE_PATH,
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
    writeFileImpl: () => {},
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  return { result, calls };
}

test('a rate-limit closer-dispatch failure does NOT burn the redispatch budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-transient-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/myrepo', prNumber: 1234, headSha: 'abc12345abc12345abc12345abc12345abc12345' };

  const { result } = await dispatchWithError(rootDir, () => {
    const err = new Error('hq dispatch failed');
    err.stderr = 'gh: API rate limit exceeded (HTTP 403)';
    return err;
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-deferred-transient');
  assert.equal(result.skipMergeAgent, true, 'transient failure keeps closer on the hook, suppresses merge-agent fallback');

  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.retryCount, 0, 'transient failure did not increment retryCount');
  assert.equal(record.state, 'dispatch-deferred-transient');
  assert.equal(record.lastFailureTransient, true);
});

test('a genuine (non-transient) closer-dispatch failure DOES consume the budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-genuine-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/myrepo', prNumber: 1234, headSha: 'abc12345abc12345abc12345abc12345abc12345' };

  const { result } = await dispatchWithError(rootDir, () => {
    const err = new Error('hq dispatch failed');
    err.stderr = 'fatal: unrecoverable closer provisioning error';
    return err;
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-failed');

  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.retryCount, 1, 'genuine failure increments retryCount toward the bound');
  assert.equal(record.state, 'dispatch-failed');
});
