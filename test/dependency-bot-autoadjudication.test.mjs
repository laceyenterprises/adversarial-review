import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjudicateDependencyBotUpdate,
  maybeAutoAdjudicateDependencyBotArgusJob,
} from '../src/dependency-bot-autoadjudication.mjs';
import {
  enqueueArgusSecurityReview,
  findArgusJob,
} from '../src/argus-security-queue.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { attemptDaemonCleanMerge } from '../src/ama/daemon-merge.mjs';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const REPO = 'laceyenterprises/adversarial-review';

async function withRoot(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'depbot-autoadjudication-'));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function enqueueJob(rootDir, { headSha = HEAD, prNumber = 966 } = {}) {
  enqueueArgusSecurityReview({
    rootDir,
    repo: REPO,
    prNumber,
    headSha,
    reasons: [
      { trigger: 'bot-author', author: 'dependabot[bot]' },
      {
        trigger: 'manifest-change',
        ecosystems: ['npm'],
        matches: [{ path: 'package-lock.json', ecosystem: 'npm' }],
      },
    ],
  });
  return findArgusJob(rootDir, { repo: REPO, prNumber, headSha });
}

function baseArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    jobRecord: overrides.jobRecord || enqueueJob(rootDir, overrides),
    title: overrides.title || 'chore(deps-dev): bump eslint from 10.9.1 to 10.10.0',
    authorRef: 'dependabot[bot]',
    candidate: { baseBranch: 'main', headSha: overrides.headSha || HEAD, prState: 'open' },
    cfg: { enabled: true, branchProtection: { required: false } },
    currentPrHeadSha: overrides.headSha || HEAD,
    logger: { log() {}, warn() {}, error() {} },
    now: () => '2026-09-07T19:30:00.000Z',
  };
}

test('dev-dependency patch/minor bump with green CI reaches the merge route', async () => withRoot(async (rootDir) => {
  let mergeArgs = null;
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir),
    runDaemonCleanMergeAttemptImpl: async (args) => {
      mergeArgs = args;
      return { disposition: 'merged', reason: 'merged', merged: true };
    },
  });

  assert.equal(result.decision.autoMergeEligible, true);
  assert.equal(result.completed.job.result.verdict, 'approve');
  assert.equal(result.merge.disposition, 'merged');
  assert.equal(mergeArgs.autonomousMergeAccountability.headSha, HEAD);
  assert.equal(mergeArgs.reviewState.blockingFindingCount, 0);
  assert.equal(mergeArgs.reviewState.nonBlockingFindingCount, 0);
}));

test('runtime major bump is adjudicated but does not auto-merge', async () => withRoot(async (rootDir) => {
  let mergeCalled = false;
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir, {
      prNumber: 963,
      title: 'chore(deps): bump express from 4.18.2 to 5.1.0 in the server group',
    }),
    title: 'chore(deps): bump express from 4.18.2 to 5.1.0 in the server group',
    runDaemonCleanMergeAttemptImpl: async () => {
      mergeCalled = true;
      return { disposition: 'merged' };
    },
  });

  assert.equal(result.decision.autoMergeEligible, false);
  assert.equal(result.reason, 'semver-major');
  assert.equal(result.completed.job.result.verdict, 'needs_verification');
  assert.equal(mergeCalled, false);
}));

test('v0 minor bump is adjudicated as verification-required', async () => withRoot(async (rootDir) => {
  let mergeCalled = false;
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir, {
      prNumber: 963,
      title: 'chore(deps): bump experimental-sdk from 0.1.0 to 0.2.0 in the production-sdks group',
    }),
    title: 'chore(deps): bump experimental-sdk from 0.1.0 to 0.2.0 in the production-sdks group',
    runDaemonCleanMergeAttemptImpl: async () => {
      mergeCalled = true;
      return { disposition: 'merged' };
    },
  });

  assert.equal(result.decision.autoMergeEligible, false);
  assert.equal(result.reason, 'semver-major');
  assert.equal(result.decision.inputs.bumpKind, 'major');
  assert.equal(result.completed.job.result.verdict, 'needs_verification');
  assert.equal(mergeCalled, false);
}));

test('native-driver bump is adjudicated but does not auto-merge', async () => withRoot(async (rootDir) => {
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir, {
      prNumber: 964,
      title: 'chore(deps): bump better-sqlite3 from 12.11.1 to 12.12.0',
    }),
    title: 'chore(deps): bump better-sqlite3 from 12.11.1 to 12.12.0',
    runDaemonCleanMergeAttemptImpl: async () => {
      throw new Error('native-driver bump must not enter merge route');
    },
  });

  assert.equal(result.decision.autoMergeEligible, false);
  assert.equal(result.reason, 'security-surface-or-native-dependency');
  assert.equal(result.completed.job.result.verdict, 'needs_verification');
}));

test('non-bot author is left pending for the normal Argus worker', async () => withRoot(async (rootDir) => {
  let mergeCalled = false;
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir),
    authorRef: 'placey',
    runDaemonCleanMergeAttemptImpl: async () => {
      mergeCalled = true;
      return { disposition: 'merged' };
    },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'not-bot-author');
  assert.equal(result.completed, null);
  assert.equal(mergeCalled, false);
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }).bucket, 'pending');
}));

test('safe bump with a pending required check stays queued for retry', async () => withRoot(async (rootDir) => {
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir),
    runDaemonCleanMergeAttemptImpl: async () => ({
      disposition: 'not-taken',
      reason: 'not-eligible',
      merged: false,
      reasons: ['ci-not-green'],
      liveGate: {
        requiredChecks: [
          { __typename: 'CheckRun', name: 'npm test (Node 20)', status: 'IN_PROGRESS', conclusion: null },
        ],
      },
    }),
  });

  assert.equal(result.decision.autoMergeEligible, true);
  assert.equal(result.merge.merged, false);
  assert.deepEqual(result.merge.reasons, ['ci-not-green']);
  assert.equal(result.completed, null);
  assert.equal(result.pending.job.status, 'pending');
  assert.equal(result.pending.job.lastAutoadjudicationAttempt.mergeReason, 'not-eligible');
  assert.equal(result.pending.job.lastAutoadjudicationAttempt.mergeDisposition, 'not-taken');
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }).bucket, 'pending');
}));

test('safe bump with a failing required check completes as needing verification', async () => withRoot(async (rootDir) => {
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir),
    runDaemonCleanMergeAttemptImpl: async () => ({
      disposition: 'not-taken',
      reason: 'not-eligible',
      merged: false,
      reasons: ['ci-not-green'],
      liveGate: {
        requiredChecks: [
          { __typename: 'CheckRun', name: 'npm test (Node 20)', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      },
    }),
  });

  assert.equal(result.decision.autoMergeEligible, true);
  assert.equal(result.merge.merged, false);
  assert.deepEqual(result.merge.reasons, ['ci-not-green']);
  assert.equal(result.completed.job.result.verdict, 'needs_verification');
  assert.equal(result.completed.job.result.autoadjudication.reason, 'merge-withheld-not-eligible');
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }).bucket, 'completed');
}));

test('safe bump whose head moves between adjudication and merge does not merge', async () => withRoot(async (rootDir) => {
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir),
    runDaemonCleanMergeAttemptImpl: async (args) => {
      assert.equal(args.currentPrHeadSha, HEAD);
      return {
        disposition: 'deferred',
        reason: 'pr-head-moved',
        merged: false,
        snapshotHead: HEAD,
        liveHead: NEXT_HEAD,
      };
    },
  });

  assert.equal(result.decision.autoMergeEligible, true);
  assert.equal(result.merge.merged, false);
  assert.equal(result.merge.reason, 'pr-head-moved');
  assert.equal(result.completed.job.result.verdict, 'needs_verification');
  assert.equal(result.completed.job.result.autoadjudication.reason, 'merge-withheld-pr-head-moved');
}));

test('pure adjudicator records dependency type, semver, and manifest inputs', () => {
  const decision = adjudicateDependencyBotUpdate({
    title: 'chore(deps-dev): bump globals from 17.11.0 to 17.12.0',
    authorRef: 'app/dependabot',
    job: {
      reasons: [
        {
          trigger: 'manifest-change',
          ecosystems: ['npm'],
          matches: [{ path: 'package.json', ecosystem: 'npm' }],
        },
      ],
    },
  });

  assert.equal(decision.autoMergeEligible, true);
  assert.equal(decision.inputs.dependencyType, 'dev');
  assert.equal(decision.inputs.bumpKind, 'minor');
  assert.equal(decision.inputs.manifestReason, true);
});

test('daemon clean merge accepts exact-head dependency auto-adjudication accountability', async () => withRoot(async (rootDir) => {
  let captured = null;
  const result = await runDaemonCleanMergeAttempt({
    rootDir,
    cfg: { enabled: true, branchProtection: { required: false } },
    repoPath: REPO,
    prNumber: 966,
    candidate: { baseBranch: 'main', headSha: HEAD, prState: 'open' },
    gateSnapshot: { reviewedHeadSha: HEAD, settledReview: { verdict: 'settled-success' } },
    reviewState: {
      headSha: HEAD,
      riskClass: 'dependency-bot-autoadjudicated',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    reviewStateRow: { reviewer: 'argus-security' },
    currentPrHeadSha: HEAD,
    autonomousMergeAccountability: {
      label: 'dependency-bot-autoadjudication',
      actor: 'argus-security',
      eventId: 'depbot-event',
      observedAt: '2026-09-07T19:30:00.000Z',
      headSha: HEAD,
      reason: 'non-major-dependency-bump',
    },
    fetchRollupImpl: async () => ({
      headRefOid: HEAD,
      headRefName: 'dependabot/npm/eslint-10.10.0',
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }),
    readBuildCompletionSignalForPrImpl: () => null,
    readHeadAttestationChainForPrImpl: () => [],
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
    attemptDaemonCleanMergeImpl: async (args) => {
      captured = args;
      return { disposition: 'merged', reason: 'merged', merged: true };
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.equal(result.disposition, 'merged');
  assert.equal(captured.auditMetadata.mergeAccountability, 'autonomous-accountability');
  assert.equal(captured.auditMetadata.autonomousMergeAccountability.label, 'dependency-bot-autoadjudication');
  assert.equal(captured.workerIdentity.ok, false);
}));

test('daemon clean merge returns the live gate when pre-lease CI is pending', async () => withRoot(async (rootDir) => {
  const pendingCheck = { __typename: 'CheckRun', name: 'npm test (Node 20)', status: 'IN_PROGRESS', conclusion: null };
  const result = await attemptDaemonCleanMerge({
    repo: REPO,
    prNumber: 966,
    base: 'main',
    validatedHead: HEAD,
    verdict: 'settled-success',
    reviewState: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    liveGate: {
      candidateHead: HEAD,
      requiredChecks: [pendingCheck],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      prState: 'OPEN',
      branchProtectionRequiredContexts: [],
    },
    branchProtectionRequired: false,
    hqRoot: rootDir,
    fetchLiveGateImpl: async () => {
      throw new Error('pre-lease decline must not acquire lease or re-fetch');
    },
    acquireLeaseImpl: () => {
      throw new Error('pre-lease decline must not acquire lease');
    },
    releaseLeaseImpl: () => {},
    runMergeImpl: async () => {
      throw new Error('pre-lease decline must not merge');
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  assert.equal(result.disposition, 'not-taken');
  assert.equal(result.reason, 'not-eligible');
  assert.deepEqual(result.reasons, ['ci-not-green']);
  assert.deepEqual(result.liveGate.requiredChecks, [pendingCheck]);
}));
