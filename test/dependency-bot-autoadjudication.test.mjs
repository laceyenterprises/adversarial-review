import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjudicateDependencyBotUpdate,
  maybeAutoAdjudicateDependencyBotArgusJob,
} from '../src/dependency-bot-autoadjudication.mjs';
import {
  completeArgusJob,
  enqueueArgusSecurityReview,
  findArgusJob,
} from '../src/argus-security-queue.mjs';
import { runDaemonCleanMergeAttempt as runDaemonCleanMergeAttemptReal } from '../src/daemon-clean-merge.mjs';
import { attemptDaemonCleanMerge } from '../src/ama/daemon-merge.mjs';
import { ARGUS_CI_WAIT_DEFERRAL_BUDGET, CI_WAIT_RETRY_MS } from '../src/argus-dependency-evidence.mjs';
import { isArgusJobClaimable } from '../src/argus-security-drain.mjs';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const REPO = 'example/dependency-fixture';

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
    fetchMergeRecoveryEvidenceImpl: async () => { throw new Error('fixture recovery evidence not supplied'); },
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
  // ARGUSDRAIN-01: routed to the Argus drain, not parked as needs_verification.
  assert.equal(result.completed, null);
  assert.equal(result.routed.job.routedForReview.reason, 'semver-major');
  assert.equal(result.routed.job.routedForReview.inputs.bumpKind, 'major');
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 963, headSha: HEAD }).bucket, 'pending');
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
  assert.equal(result.routed.job.routedForReview.reason, 'semver-major');
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 963, headSha: HEAD }).bucket, 'pending');
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
  assert.equal(result.routed.job.routedForReview.reason, 'security-surface-or-native-dependency');
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 964, headSha: HEAD }).bucket, 'pending');
}));

test('non-bot author is left pending for the normal Argus worker', async () => withRoot(async (rootDir) => {
  let mergeCalled = false;
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir),
    authorRef: 'fixture-author',
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

test('missing job paths cannot reach the pending attempt writer', async () => withRoot(async (rootDir) => {
  const args = baseArgs(rootDir);
  const before = readFileSync(args.jobRecord.jobPath, 'utf8');
  for (const jobPath of [undefined, null, '']) {
    const result = await maybeAutoAdjudicateDependencyBotArgusJob({
      ...args,
      jobRecord: { ...args.jobRecord, jobPath },
      runDaemonCleanMergeAttemptImpl: async () => assert.fail('missing path must not reach merge'),
      writeArgusJobImpl: () => assert.fail('missing path must not write an attempt'),
      completeArgusJobImpl: () => assert.fail('missing path must not complete a job'),
    });
    assert.equal(result.attempted, false);
    assert.equal(result.reason, 'no-pending-job');
    assert.equal(readFileSync(args.jobRecord.jobPath, 'utf8'), before);
  }
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
    guardStackedBaseImpl: async () => null,
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
  assert.deepEqual(result.reasons, ['ci-not-green', 'labels-unavailable']);
  assert.deepEqual(result.liveGate.requiredChecks, [pendingCheck]);
}));

// Inject history evidence so these wiring fixtures remain offline.
function runDaemonCleanMergeAttempt(args) {
  return runDaemonCleanMergeAttemptReal({
    fetchPrimaryChangeImpl: async ({ headSha }) => primaryChangeFixture(headSha),
    ...args,
  });
}

const GREEN_CHECKS = [{ __typename: 'CheckRun', name: 'fixture-suite', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const PENDING_CHECKS = [{ __typename: 'CheckRun', name: 'fixture-suite', status: 'IN_PROGRESS', conclusion: null }];
const RED_CHECKS = [{ __typename: 'CheckRun', name: 'fixture-suite', status: 'COMPLETED', conclusion: 'FAILURE' }];

const CURABLE_DECLINES = [
  ...['pr-mergeability-unknown', 'labels-unavailable', 'primary-change-read-failed',
    'history-read-failed', 'ci-cost-read-failed', 'lease-not-held'].map((gate) => ({
    disposition: 'not-taken', reason: 'not-eligible', reasons: [gate],
  })),
  ...['live-head-refresh-failed', 'live-head-unresolved', 'gate-read-failed',
    'history-read-failed', 'merge-title-missing', 'lease-acquire-error',
    'lease-contended', 'audit-init-failed'].map((reason) => ({ disposition: 'deferred', reason })),
  ...['protective-predecessor-open', 'protective-predecessor-state-unreadable']
    .map((reason) => ({ disposition: 'not-taken', reason })),
  ...[PENDING_CHECKS, [], null].map((requiredChecks) => ({
    disposition: 'not-taken', reason: 'not-eligible', reasons: ['ci-not-green'], liveGate: { requiredChecks },
  })),
  { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-mergeability-unknown', 'ci-not-green', 'labels-unavailable'],
    liveGate: { requiredChecks: PENDING_CHECKS, mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' } },
];

for (const [index, decline] of CURABLE_DECLINES.entries()) {
  test(`DEPWAIT-01 curable decline ${index}: ${decline.reasons || decline.reason} waits then merges`, async () => withRoot(async (rootDir) => {
    const args = baseArgs(rootDir);
    let clockMs = Date.parse(args.now());
    let calls = 0;
    const attempt = () => maybeAutoAdjudicateDependencyBotArgusJob({
      ...args,
      now: () => new Date(clockMs).toISOString(),
      jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }),
      runDaemonCleanMergeAttemptImpl: async () => ++calls === 1 ? decline : { disposition: 'merged', reason: 'merged' },
    });
    const first = await attempt();
    assert.equal(first.completed, null);
    assert.equal(first.pending.job.status, 'pending');
    assert.equal(first.pending.job.result, null);
    clockMs += CI_WAIT_RETRY_MS - 1;
    assert.equal((await attempt()).attempted, false);
    assert.equal(calls, 1);
    clockMs += 1;
    const next = await attempt();
    assert.equal(calls, 2);
    assert.equal(next.completed.job.result.verdict, 'approve');
    assert.equal(next.merge.disposition, 'merged');
  }));
}

const HARD_DECLINES = [
  ...['verdict-not-eligible', 'pr-not-mergeable', 'branch-protection-missing-gate',
    'stale-head', 'duplicate-family-unresolved', 'primary-change-reverted',
    'primary-change-unknown', 'ci-cost-check-failed', 'ci-cost-unauthorized', 'unknown-gate'].map((gate) => ({
    disposition: 'not-taken', reason: 'not-eligible', reasons: [gate],
  })),
  ...['blocking-findings-present', 'non-blocking-findings-present', 'findings-unknown',
    'prior-daemon-terminal-failure', 'daemon-inputs-missing', 'operator-approval-no-longer-current',
    'protective-predecessor-malformed-trailer', 'protective-predecessor-not-found'].map((reason) => ({
    disposition: 'not-taken', reason,
  })),
  { disposition: 'deferred', reason: 'pr-head-moved' },
  { disposition: 'deferred', reason: 'unknown-defer' },
  { disposition: 'deferred', reason: 'gate-read-failed', reasons: ['stale-head'] },
  { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-mergeability-unknown', 'duplicate-family-unresolved'] },
  { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-mergeability-unknown', 'ci-not-green'],
    liveGate: { requiredChecks: [...RED_CHECKS, { ...PENDING_CHECKS[0], name: 'other-suite' }] } },
];
for (const [index, decline] of HARD_DECLINES.entries()) {
  test(`DEPWAIT-01 non-curable decline ${index}: ${decline.reasons || decline.reason} completes withheld`, async () => withRoot(async (rootDir) => {
    const result = await maybeAutoAdjudicateDependencyBotArgusJob({
      ...baseArgs(rootDir), runDaemonCleanMergeAttemptImpl: async () => decline,
    });
    assert.equal(result.completed.job.result.verdict, 'needs_verification');
    assert.equal(result.completed.job.result.autoadjudication.reason, `merge-withheld-${decline.reason}`);
    assert.deepEqual(result.completed.job.result.autoadjudication.mergeReasons, decline.reasons || []);
  }));
}

test('DEPWAIT-01 shared wait budget exhausts once even when curable reasons alternate', async () => withRoot(async (rootDir) => {
  const args = baseArgs(rootDir);
  let clockMs = Date.parse(args.now());
  let calls = 0;
  const attempt = () => maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    now: () => new Date(clockMs).toISOString(),
    jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible',
      reasons: [++calls % 2 ? 'pr-mergeability-unknown' : 'labels-unavailable'] }),
  });
  for (let count = 0; count < ARGUS_CI_WAIT_DEFERRAL_BUDGET; count += 1) {
    assert.equal((await attempt()).completed, null);
    clockMs += CI_WAIT_RETRY_MS;
  }
  const exhausted = await attempt();
  assert.equal(exhausted.completed.job.result.verdict, 'needs_verification');
  assert.equal(exhausted.completed.job.result.autoadjudication.reason, 'merge-withheld-not-eligible');
  assert.equal(exhausted.completed.job.lastAutoadjudicationAttempt.deferrals, ARGUS_CI_WAIT_DEFERRAL_BUDGET);
  clockMs += CI_WAIT_RETRY_MS;
  assert.equal((await attempt()).attempted, false);
  assert.equal(calls, ARGUS_CI_WAIT_DEFERRAL_BUDGET + 1);
}));

test('DEPWAIT-01 retry uses latest CI runs and notices a missing required context', async () => withRoot(async (rootDir) => {
  const args = baseArgs(rootDir);
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    cfg: { ...args.cfg, requiredCheckContexts: ['fixture-suite', 'missing-suite'] },
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible', reasons: ['ci-not-green'],
      liveGate: { requiredChecks: [
        { ...RED_CHECKS[0], createdAt: '2026-01-01T00:00:00Z' },
        { ...GREEN_CHECKS[0], createdAt: '2026-01-01T00:01:00Z' },
      ] } }),
  });
  assert.equal(result.completed, null);
  assert.equal(result.pending.job.status, 'pending');
}));

test('DEPWAIT-01 sibling lockfile conflict preserves the existing withheld path; a bot repair gets a new job', async () => withRoot(async (rootDir) => {
  const firstArgs = baseArgs(rootDir, { prNumber: 201 });
  const siblingArgs = baseArgs(rootDir, { prNumber: 202 });
  const merged = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...firstArgs, runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'merged', reason: 'merged' }),
  });
  assert.equal(merged.completed.job.result.verdict, 'approve');

  // Both fixture jobs change package-lock.json. A true conflict needs a new
  // head; this bot-only branch currently has no conflict-repair handoff.
  const conflicted = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...siblingArgs,
    runDaemonCleanMergeAttemptImpl: async () => ({
      disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-not-mergeable'],
      liveGate: { candidateHead: HEAD, prState: 'OPEN', mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY', requiredChecks: GREEN_CHECKS },
    }),
  });
  assert.equal(conflicted.completed.job.result.autoadjudication.reason, 'merge-withheld-not-eligible');
  assert.equal(conflicted.pending, undefined);
  assert.equal(conflicted.routed, undefined);

  const repaired = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...baseArgs(rootDir, { prNumber: 202, headSha: NEXT_HEAD }),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'merged', reason: 'merged' }),
  });
  assert.notEqual(repaired.completed.job.jobId, conflicted.completed.job.jobId);
  assert.equal(repaired.completed.job.result.verdict, 'approve');
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 202, headSha: HEAD }).bucket, 'completed');
}));

async function withCompletedWithheld(rootDir, overrides = {}) {
  const args = baseArgs(rootDir, overrides);
  await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible',
      reasons: ['ci-not-green'], liveGate: { requiredChecks: RED_CHECKS } }),
  });
  return { ...args, jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: overrides.prNumber || 966, headSha: overrides.headSha || HEAD }) };
}

function recoveryEvidence(overrides = {}) {
  return { state: 'OPEN', headRefOid: HEAD, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    isDraft: false, statusCheckRollup: GREEN_CHECKS, ...overrides };
}

test('DEPWAIT-01 completed exact-head withheld approval reopens once and merges through the same daemon', async () => withRoot(async (rootDir) => {
  const args = await withCompletedWithheld(rootDir);
  const originalInputs = args.jobRecord.job.result.autoadjudication.inputs;
  let merges = 0;
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    // Recovery retains the head's recorded decision even if the title changes.
    title: 'a title edited after adjudication',
    fetchMergeRecoveryEvidenceImpl: async (repo, pr) => {
      assert.equal(repo, REPO);
      assert.equal(pr, 966);
      return recoveryEvidence();
    },
    runDaemonCleanMergeAttemptImpl: async (mergeArgs) => {
      merges += 1;
      const pending = findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD });
      assert.equal(pending.bucket, 'pending');
      assert.equal(pending.job.mergeWithheldRecovery.headSha, HEAD);
      assert.equal(isArgusJobClaimable(pending.job, { nowMs: Date.parse(args.now()) + 24 * 60 * 60 * 1000 }), false);
      assert.equal(mergeArgs.currentPrHeadSha, HEAD);
      assert.equal(mergeArgs.autonomousMergeAccountability.headSha, HEAD);
      assert.deepEqual(mergeArgs.autonomousMergeAccountability.inputs, originalInputs);
      assert.equal(mergeArgs.autonomousMergeAccountability.reason, 'non-major-dependency-bump');
      return { disposition: 'merged', reason: 'merged' };
    },
  });
  assert.equal(merges, 1);
  assert.equal(result.completed.job.result.verdict, 'approve');
  assert.equal(JSON.parse(readFileSync(result.completed.jobPath, 'utf8')).result.autoadjudication.decision,
    'approve-auto-merge', 'recovered merge persists its approval token');
  assert.deepEqual(result.completed.job.result.autoadjudication.inputs, originalInputs);
  assert.ok(result.completed.job.mergeWithheldRecovery.reopenedAt);
  assert.equal(findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }).bucket, 'completed');
}));

for (const [name, overrides] of Object.entries({
  red: { statusCheckRollup: RED_CHECKS },
  pending: { statusCheckRollup: PENDING_CHECKS },
  empty: { statusCheckRollup: [] },
  missing: { statusCheckRollup: null },
  'head moved during read': { headRefOid: NEXT_HEAD },
  unknown: { mergeable: 'UNKNOWN' },
  conflicting: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  'inconsistent dirty': { mergeStateStatus: 'DIRTY' },
  closed: { state: 'CLOSED' },
  merged: { state: 'MERGED' },
  draft: { isDraft: true },
  'newer failing rerun': { statusCheckRollup: [
    { ...GREEN_CHECKS[0], createdAt: '2026-01-01T00:00:00Z' },
    { ...RED_CHECKS[0], createdAt: '2026-01-01T00:01:00Z' },
  ] },
})) {
  test(`DEPWAIT-01 completed job is byte-untouched when recovery evidence is ${name}`, async () => withRoot(async (rootDir) => {
    const args = await withCompletedWithheld(rootDir);
    const before = readFileSync(args.jobRecord.jobPath, 'utf8');
    const result = await maybeAutoAdjudicateDependencyBotArgusJob({
      ...args,
      fetchMergeRecoveryEvidenceImpl: async () => recoveryEvidence(overrides),
      runDaemonCleanMergeAttemptImpl: async () => assert.fail('ineligible recovery must not call daemon'),
    });
    assert.equal(result.attempted, false);
    assert.equal(readFileSync(args.jobRecord.jobPath, 'utf8'), before);
  }));
}

test('DEPWAIT-01 recovery uses external checks, excludes its own pending gate, and requires named checks', async () => withRoot(async (rootDir) => {
  const args = await withCompletedWithheld(rootDir);
  const statusCheckRollup = [...GREEN_CHECKS, { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'PENDING' }];
  const before = readFileSync(args.jobRecord.jobPath, 'utf8');
  const missing = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    cfg: { ...args.cfg, requiredCheckContexts: ['missing-suite'] },
    fetchMergeRecoveryEvidenceImpl: async () => recoveryEvidence({ statusCheckRollup }),
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('missing required context'),
  });
  assert.equal(missing.attempted, false);
  assert.equal(readFileSync(args.jobRecord.jobPath, 'utf8'), before);
  const recovered = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    cfg: { ...args.cfg, requiredCheckContexts: ['fixture-suite'] },
    fetchMergeRecoveryEvidenceImpl: async () => recoveryEvidence({ statusCheckRollup }),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'merged', reason: 'merged' }),
  });
  assert.equal(recovered.completed.job.result.verdict, 'approve');
}));

test('DEPWAIT-01 a moved head leaves the old completed job untouched and creates a new job', async () => withRoot(async (rootDir) => {
  const args = await withCompletedWithheld(rootDir);
  const before = readFileSync(args.jobRecord.jobPath, 'utf8');
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args, currentPrHeadSha: NEXT_HEAD,
    fetchMergeRecoveryEvidenceImpl: async () => assert.fail('old job must not read evidence for a new head'),
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('old approval cannot merge a new head'),
  });
  assert.equal(result.attempted, false);
  assert.equal(readFileSync(args.jobRecord.jobPath, 'utf8'), before);
  assert.equal(enqueueJob(rootDir, { headSha: NEXT_HEAD }).bucket, 'pending');
}));

test('DEPWAIT-01 a second withheld result stays completed across later green polls', async () => withRoot(async (rootDir) => {
  const args = await withCompletedWithheld(rootDir);
  let reads = 0;
  let merges = 0;
  const retry = async () => maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }),
    fetchMergeRecoveryEvidenceImpl: async () => { reads += 1; return recoveryEvidence(); },
    // Recovery never bypasses live holds that the daemon reads after the suite.
    runDaemonCleanMergeAttemptImpl: async () => { merges += 1; return {
      disposition: 'not-taken', reason: 'not-eligible', reasons: ['duplicate-family-unresolved'],
    }; },
  });
  const withheldAgain = await retry();
  assert.equal(withheldAgain.completed.job.result.verdict, 'needs_verification');
  assert.ok(withheldAgain.completed.job.mergeWithheldRecovery);
  const before = readFileSync(withheldAgain.completed.jobPath, 'utf8');
  for (let i = 0; i < 3; i += 1) assert.equal((await retry()).attempted, false);
  assert.equal(reads, 1);
  assert.equal(merges, 1);
  assert.equal(readFileSync(withheldAgain.completed.jobPath, 'utf8'), before);
}));

test('DEPWAIT-01 recovered approval can wait under a fresh bounded budget without losing its once marker', async () => withRoot(async (rootDir) => {
  const args = await withCompletedWithheld(rootDir);
  let clockMs = Date.parse(args.now());
  let merges = 0;
  let reads = 0;
  const retry = async () => maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    now: () => new Date(clockMs).toISOString(),
    title: 'edited after approval',
    jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }),
    fetchMergeRecoveryEvidenceImpl: async () => { reads += 1; return recoveryEvidence(); },
    runDaemonCleanMergeAttemptImpl: async () => {
      merges += 1;
      return merges % 2
        ? { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-mergeability-unknown'] }
        : { disposition: 'deferred', reason: 'lease-contended' };
    },
  });
  for (let i = 0; i < ARGUS_CI_WAIT_DEFERRAL_BUDGET; i += 1) {
    const pending = await retry();
    assert.equal(pending.completed, null);
    assert.ok(pending.pending.job.mergeWithheldRecovery);
    const persisted = JSON.parse(readFileSync(pending.pending.jobPath, 'utf8'));
    assert.equal(persisted.lastAutoadjudicationAttempt.decision, 'approve-auto-merge');
    assert.equal(persisted.lastAutoadjudicationAttempt.deferrals, i + 1);
    assert.deepEqual(persisted.lastAutoadjudicationAttempt.inputs, args.jobRecord.job.result.autoadjudication.inputs);
    assert.equal(isArgusJobClaimable(persisted, { nowMs: clockMs + 24 * 60 * 60 * 1000 }),
      false, 'watcher retains ownership across recovered retries after bot grace expires');
    clockMs += CI_WAIT_RETRY_MS;
  }
  assert.equal((await retry()).completed.job.result.verdict, 'needs_verification');
  assert.equal((await retry()).attempted, false);
  assert.equal(reads, 1);
  assert.equal(merges, ARGUS_CI_WAIT_DEFERRAL_BUDGET + 1);
}));

for (const reason of ['semver-major', 'unparsed-dependabot-title', 'security-surface-or-native-dependency']) {
  test(`DEPWAIT-01 completed adjudicator route-for-review ${reason} never enters merge recovery`, async () => withRoot(async (rootDir) => {
    const args = baseArgs(rootDir);
    const completed = completeArgusJob({ rootDir, jobPath: args.jobRecord.jobPath, job: args.jobRecord.job,
      result: { verdict: 'needs_verification', autoadjudication: { decision: 'route-for-review', reason } } });
    const result = await maybeAutoAdjudicateDependencyBotArgusJob({
      ...args, jobRecord: { ...completed, bucket: 'completed' },
      fetchMergeRecoveryEvidenceImpl: async () => assert.fail('review decision must stand'),
      runDaemonCleanMergeAttemptImpl: async () => assert.fail('review decision must stand'),
    });
    assert.equal(result.attempted, false);
  }));
}

test('DEPWAIT-01 three approved lockfile siblings settle in lease order as each merge moves the base', async () => withRoot(async (rootDir) => {
  const siblings = [301, 302, 303].map((prNumber) => baseArgs(rootDir, { prNumber }));
  let clockMs = Date.parse(siblings[0].now());
  let baseRevision = 0;
  const observedBase = new Map(siblings.map((args) => [args.jobRecord.job.prNumber, 0]));
  const mergeOrder = [];
  for (let tick = 0; tick < 3; tick += 1) {
    for (const args of siblings) {
      const prNumber = args.jobRecord.job.prNumber;
      const record = findArgusJob(rootDir, { repo: REPO, prNumber, headSha: HEAD });
      const result = await maybeAutoAdjudicateDependencyBotArgusJob({
        ...args, jobRecord: record, now: () => new Date(clockMs).toISOString(),
        runDaemonCleanMergeAttemptImpl: async () => {
          if (observedBase.get(prNumber) !== baseRevision) {
            observedBase.set(prNumber, baseRevision);
            return { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-mergeability-unknown'],
              liveGate: { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND', requiredChecks: GREEN_CHECKS } };
          }
          mergeOrder.push(prNumber);
          baseRevision += 1;
          return { disposition: 'merged', reason: 'merged' };
        },
      });
      if (result.completed) assert.equal(result.completed.job.result.verdict, 'approve');
      if (result.pending) assert.equal(isArgusJobClaimable(result.pending.job), false, 'watcher owns the retry');
    }
    clockMs += CI_WAIT_RETRY_MS;
  }
  assert.deepEqual(mergeOrder, [301, 302, 303]);
  for (const prNumber of mergeOrder) {
    const final = findArgusJob(rootDir, { repo: REPO, prNumber, headSha: HEAD });
    assert.equal(final.bucket, 'completed');
    assert.equal(final.job.result.verdict, 'approve');
  }
}));


test('DEPWAIT-01 unavailable recovery evidence leaves completion and the once allowance untouched', async () => withRoot(async (rootDir) => {
  const args = await withCompletedWithheld(rootDir);
  const before = readFileSync(args.jobRecord.jobPath, 'utf8');
  const result = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    fetchMergeRecoveryEvidenceImpl: async () => { throw new Error('synthetic read failure'); },
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('unreadable recovery evidence'),
  });
  assert.equal(result.attempted, false);
  assert.equal(readFileSync(args.jobRecord.jobPath, 'utf8'), before);
}));

for (const [name, decline, settled] of [
  ['mergeability unknown', { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-mergeability-unknown'] }, true],
  ['pending CI', { disposition: 'not-taken', reason: 'not-eligible', reasons: ['ci-not-green'], liveGate: { requiredChecks: PENDING_CHECKS } }, false],
  ['existing defer', { disposition: 'deferred', reason: 'lease-contended' }, false],
  ['moved head', { disposition: 'deferred', reason: 'pr-head-moved' }, true],
]) {
  test(`DEPWAIT-01 reviewed major bump keeps its existing merge settlement for ${name}`, async () => withRoot(async (rootDir) => {
    const args = baseArgs(rootDir, { title: 'chore(deps): bump fixture-package from 1.0.0 to 2.0.0' });
    const completed = completeArgusJob({ rootDir, jobPath: args.jobRecord.jobPath, job: args.jobRecord.job,
      result: { source: 'argus-security-drain', verdict: 'approve', findings: [] } });
    const result = await maybeAutoAdjudicateDependencyBotArgusJob({
      ...args, jobRecord: { ...completed, bucket: 'completed' },
      fetchMergeRecoveryEvidenceImpl: async () => assert.fail('reviewed approval is not a withheld auto-adjudication'),
      runDaemonCleanMergeAttemptImpl: async () => decline,
    });
    assert.equal(result.completed.job.result.verdict, 'approve');
    assert.equal(result.completed.job.result.source, 'argus-security-drain');
    assert.equal(result.completed.job.result.merge.settled, settled);
    assert.equal(result.completed.job.mergeWithheldRecovery, undefined);
  }));
}

test('DEPWAIT-01 grouped updates remain owned by the security review drain', async () => withRoot(async (rootDir) => {
  const args = baseArgs(rootDir, { title: 'chore(deps): bump the fixture group with 2 updates' });
  const run = () => maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: 966, headSha: HEAD }),
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('grouped updates require review'),
  });
  const routed = await run();
  assert.equal(routed.routed.job.routedForReview.reason, 'unparsed-dependabot-title');
  assert.equal(isArgusJobClaimable(routed.routed.job), true);
  assert.equal((await run()).reason, 'routed-for-review');
}));

for (const [name, decline] of [
  ['strict BEHIND', { disposition: 'not-taken', reason: 'not-eligible', reasons: ['pr-not-mergeable'],
    liveGate: { prState: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', requiredChecks: GREEN_CHECKS } }],
  ['draft merge rejection', { disposition: 'failed-closed', reason: 'permanent-merge-rejection', permanent: true }],
  ['missing reasons', { disposition: 'not-taken', reason: 'not-eligible', reasons: [] }],
]) {
  test(`DEPWAIT-01 ${name} retains its existing withheld result`, async () => withRoot(async (rootDir) => {
    const result = await maybeAutoAdjudicateDependencyBotArgusJob({
      ...baseArgs(rootDir), runDaemonCleanMergeAttemptImpl: async () => decline,
    });
    assert.equal(result.completed.job.result.verdict, 'needs_verification');
    assert.equal(result.completed.job.result.autoadjudication.reason, `merge-withheld-${decline.reason}`);
  }));
}
