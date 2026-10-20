import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';

import {
  amaCloserDispatchFilePath,
  maybeDispatchAmaCloser,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'hammer-prompt.md');
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

function eligibleInputs(rootDir) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  const reviewState = {
    verdict: 'comment-only',
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
    reviewedBy: 'synthetic-reviewer',
    reviewer: 'claude',
    parentSession: 'session:test:watcher',
    hqProject: 'adversarial-merge-authority',
    hqPath: '/bin/true-stub-hq',
    hqRoot: join(rootDir, 'hq-root'),
    hqOwnerUser: CURRENT_USER,
    currentUser: CURRENT_USER,
    rootDir,
    dispatchedAt: '2026-06-11T20:00:00Z',
  };
  return { reviewState, prMetadata, cfg, dispatchContext, headSha };
}

// UNREGREPO-01: configuration repair is repository-wide, not a transient loop.
test('UNREGREPO-01: unregistered repository pages once and resumes after registration', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'unregistered-repo-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  inputs.dispatchContext.repo = 'example/widget';
  inputs.dispatchContext.reviewedBy = 'synthetic-reviewer';
  const pages = [];
  let attempts = 0;
  let registered = false;
  const run = async (prNumber, dispatchedAt) => maybeDispatchAmaCloser({
    ...inputs,
    prMetadata: { ...inputs.prMetadata, prNumber },
    dispatchContext: { ...inputs.dispatchContext, dispatchedAt },
    execFileImpl: async (cmd, args) => {
      if (args[0] === 'fleet') return { stdout: JSON.stringify(codexAccountFixture()) };
      if (args[0] !== 'dispatch') return { stdout: '{}' };
      attempts++;
      if (registered) return { stdout: JSON.stringify({ launchRequestId: 'lrq-synthetic', dispatchId: 'dispatch-synthetic' }) };
      throw Object.assign(new Error('hq dispatch failed'), {
        stderr: '[hq] dispatch refused: repo_unregistered; retry your request after registration',
      });
    },
    deliverAlertImpl: async text => { pages.push(text); },
    writeFileImpl: () => {}, readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });
  const first = await run(41, '2026-10-16T10:00:00Z');
  assert.equal(first.reason, 'dispatch-configuration-refused:repo_unregistered');
  assert.equal(first.needsOperator, true);
  assert.equal(first.skipMergeAgent, true);
  assert.equal(attempts, 1, 'configuration refusal never uses transient immediate retries');
  await run(42, '2026-10-16T10:00:01Z');
  assert.equal(pages.length, 1, 'page is shared by PRs in the repository');
  assert.match(pages[0], /repo_unregistered/);
  assert.match(pages[0], /hq repo register/);
  const waiting = await run(41, '2026-10-16T10:00:02Z');
  assert.equal(waiting.reason, first.reason);
  assert.equal(attempts, 2, 'same PR waits for normal rewalk backoff');
  const identity = { repo: inputs.dispatchContext.repo, prNumber: 41, headSha: inputs.headSha };
  const blocked = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(blocked.closureBlocker, first.reason);
  assert.equal(blocked.retryCount, 0);
  registered = true;
  const resumed = await run(41, '2026-10-16T12:00:00Z');
  assert.equal(resumed.dispatched, true);
  const cleared = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(cleared.closureBlocker, null);
  assert.equal(pages.length, 1);
});


test('successful dispatch clears a persisted configuration blocker after registration', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'registered-repo-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  inputs.dispatchContext.repo = 'example/widget';
  const identity = { repo: 'example/widget', prNumber: 1234, headSha: inputs.headSha };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'dispatch-configuration-refused', retryCount: 0,
    reviewedSha: inputs.headSha, targetRemediationSha: inputs.headSha,
    lastAttemptedAt: '2026-06-11T18:00:00Z',
    closureBlocker: 'dispatch-configuration-refused:repo_unregistered',
    lastError: '[hq] dispatch refused: repo_unregistered',
  }));
  assert.match(JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8')).closureBlocker, /repo_unregistered/);
  const result = await maybeDispatchAmaCloser({ ...inputs,
    execFileImpl: async (cmd, args) => ({ stdout: args[0] === 'dispatch'
      ? JSON.stringify({ launchRequestId: 'lrq-synthetic', dispatchId: 'dispatch-synthetic' })
      : args[0] === 'fleet' ? JSON.stringify(codexAccountFixture()) : '{}' }),
    deliverAlertImpl: async () => {}, writeFileImpl: () => {},
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.closureBlocker, null);
});


test('repository paging receipt survives process reload and failed delivery retries', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'configuration-page-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const first = await import('../src/ama/dispatch-configuration-refusal.mjs?first-process');
  let attempts = 0;
  const options = { rootDir, repo: 'example/widget', refusal: 'repo_unregistered',
    logger: { warn() {} }, now: '2026-10-16T10:00:00Z',
    deliverAlertImpl: async () => { if (++attempts === 1) throw new Error('delivery unavailable'); } };
  await first.pageDispatchConfigurationRefusal(options);
  await Promise.all([first.pageDispatchConfigurationRefusal(options), first.pageDispatchConfigurationRefusal(options)]);
  const restarted = await import('../src/ama/dispatch-configuration-refusal.mjs?restarted-process');
  await restarted.pageDispatchConfigurationRefusal(options);
  assert.equal(attempts, 2, 'only the failed delivery is retried; persisted success survives a new module process state');
});

test('repository paging without a dispatch time persists a restart-safe timestamp', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'configuration-page-time-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let attempts = 0;
  const options = { rootDir, repo: 'example/widget', refusal: 'repo_unregistered',
    deliverAlertImpl: async () => { attempts++; } };
  const first = await import('../src/ama/dispatch-configuration-refusal.mjs?missing-time');
  const before = Date.now();
  await first.pageDispatchConfigurationRefusal(options);
  const dir = join(rootDir, 'data', 'ama-dispatch-configuration');
  const receipt = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8'));
  assert.ok(Date.parse(receipt.alertedAt) >= before && Date.parse(receipt.alertedAt) <= Date.now());
  const restarted = await import('../src/ama/dispatch-configuration-refusal.mjs?missing-time-restart');
  await restarted.pageDispatchConfigurationRefusal(options);
  assert.equal(attempts, 1);
});

test('legacy transient refusal with an exhausted slow window is reclassified and can resume', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'legacy-configuration-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const inputs = eligibleInputs(rootDir);
  inputs.dispatchContext.repo = 'example/widget';
  const identity = { repo: 'example/widget', prNumber: 1234, headSha: inputs.headSha };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'dispatch-deferred-transient', retryCount: 20,
    lastAttemptedAt: '2026-06-10T10:00:00Z', lastError: 'repo_unregistered',
    prelaunchRefusalSlowRetry: { kind: 'dispatch-refused', startedAt: '2026-06-10T10:00:00Z' },
  }));
  let pages = 0;
  const result = await maybeDispatchAmaCloser({ ...inputs,
    execFileImpl: async (cmd, args) => ({ stdout: args[0] === 'dispatch'
      ? JSON.stringify({ launchRequestId: 'lrq-synthetic', dispatchId: 'dispatch-synthetic' })
      : args[0] === 'fleet' ? JSON.stringify(codexAccountFixture()) : '{}' }),
    deliverAlertImpl: async () => { pages++; }, writeFileImpl: () => {},
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(pages, 1);
  assert.equal(result.dispatched, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.closureBlocker, null);
});
