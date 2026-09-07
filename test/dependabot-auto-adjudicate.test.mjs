import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adjudicateDependabotDependencyPr,
  attemptDependabotAutoAdjudicateMerge,
} from '../src/dependabot-auto-adjudicate.mjs';
import {
  enqueueArgusSecurityReview,
  findArgusJob,
} from '../src/argus-security-queue.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MOVED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REPO = 'laceyenterprises/adversarial-review';

function commitBody({ name, version, dependencyType, updateType }) {
  return `Bumps ${name}.

---
updated-dependencies:
- dependency-name: "${name}"
  dependency-version: ${version}
  dependency-type: ${dependencyType}
  update-type: ${updateType}
...
`;
}

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'depbot-auto-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function enqueue(root, prNumber = 966, headSha = HEAD) {
  return enqueueArgusSecurityReview({
    rootDir: root,
    repo: REPO,
    prNumber,
    headSha,
    reasons: [{ trigger: 'bot-author' }, { trigger: 'manifest-change' }],
  });
}

function greenRollup(headSha = HEAD) {
  return {
    headRefOid: headSha,
    state: 'open',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    checks: [{ __typename: 'CheckRun', name: 'npm test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
}

const mergeConfig = {
  enabled: true,
  mergeMethod: 'squash',
  autonomousMergeExecutionEnabled: true,
  mergeCapabilityEnforcement: 'observe',
  strictMode: true,
  branchProtection: { required: false },
  requiredCheckContexts: [],
};

test('dev-dependency patch/minor bump with green CI completes Argus and merges via AMA', async () => withRoot(async (root) => {
  enqueue(root);
  let mergeCalls = 0;
  const result = await attemptDependabotAutoAdjudicateMerge({
    rootDir: root,
    repoPath: REPO,
    prNumber: 966,
    headSha: HEAD,
    baseBranch: 'main',
    author: 'app/dependabot',
    title: 'chore(deps-dev): bump eslint from 10.9.1 to 10.10.0',
    commits: [{ messageBody: commitBody({
      name: 'eslint',
      version: '10.10.0',
      dependencyType: 'direct:development',
      updateType: 'version-update:semver-minor',
    }) }],
    mergeConfig,
    fetchRollupImpl: async () => greenRollup(),
    attemptDaemonCleanMergeImpl: async () => {
      mergeCalls += 1;
      return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true };
    },
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.merged, true);
  assert.equal(mergeCalls, 1);
  const job = findArgusJob(root, { repo: REPO, prNumber: 966, headSha: HEAD });
  assert.equal(job.bucket, 'completed');
  assert.equal(job.job.result.verdict, 'approve');
}));

test('runtime major bump is adjudicated but not merged', async () => withRoot(async (root) => {
  enqueue(root, 963);
  let mergeCalls = 0;
  const result = await attemptDependabotAutoAdjudicateMerge({
    rootDir: root,
    repoPath: REPO,
    prNumber: 963,
    headSha: HEAD,
    author: 'app/dependabot',
    title: 'chore(deps): bump @linear/sdk from 92.0.0 to 93.0.1',
    commits: [{ messageBody: commitBody({
      name: '@linear/sdk',
      version: '93.0.1',
      dependencyType: 'direct:production',
      updateType: 'version-update:semver-major',
    }) }],
    mergeConfig,
    fetchRollupImpl: async () => greenRollup(),
    attemptDaemonCleanMergeImpl: async () => {
      mergeCalls += 1;
      return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true };
    },
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.merged, false);
  assert.equal(result.reason, 'adjudication-not-approved');
  assert.deepEqual(result.adjudication.reasons, ['runtime-major:@linear/sdk']);
  assert.equal(mergeCalls, 0);
}));

test('safe bump with a failing required check does not merge', async () => withRoot(async (root) => {
  enqueue(root, 965);
  const result = await attemptDependabotAutoAdjudicateMerge({
    rootDir: root,
    repoPath: REPO,
    prNumber: 965,
    headSha: HEAD,
    author: 'app/dependabot',
    title: 'chore(deps-dev): bump globals from 17.11.0 to 17.12.0',
    commits: [{ messageBody: commitBody({
      name: 'globals',
      version: '17.12.0',
      dependencyType: 'direct:development',
      updateType: 'version-update:semver-minor',
    }) }],
    mergeConfig,
    fetchRollupImpl: async () => ({
      ...greenRollup(),
      mergeStateStatus: 'UNSTABLE',
      checks: [{ __typename: 'CheckRun', name: 'npm test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }),
    attemptDaemonCleanMergeImpl: async (args) => {
      assert.equal(args.liveGate.requiredChecks[0].conclusion, 'FAILURE');
      return {
        disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN,
        reason: 'not-eligible',
        reasons: ['ci-not-green'],
      };
    },
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.merged, false);
  assert.equal(result.reason, `daemon-${DAEMON_MERGE_DISPOSITION.NOT_TAKEN}`);
  assert.deepEqual(result.mergeResult.reasons, ['ci-not-green']);
}));

test('head movement between adjudication and merge blocks the merge', async () => withRoot(async (root) => {
  enqueue(root);
  const result = await attemptDependabotAutoAdjudicateMerge({
    rootDir: root,
    repoPath: REPO,
    prNumber: 966,
    headSha: HEAD,
    author: 'app/dependabot',
    title: 'chore(deps-dev): bump eslint from 10.9.1 to 10.10.0',
    commits: [{ messageBody: commitBody({
      name: 'eslint',
      version: '10.10.0',
      dependencyType: 'direct:development',
      updateType: 'version-update:semver-minor',
    }) }],
    mergeConfig,
    fetchRollupImpl: async () => greenRollup(MOVED_HEAD),
    attemptDaemonCleanMergeImpl: async () => {
      throw new Error('merge must not be attempted after a pre-merge head move');
    },
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.merged, false);
  assert.equal(result.reason, 'head-moved-before-merge');
  assert.equal(result.liveHead, MOVED_HEAD);
}));

test('native driver is not auto-approved even when Dependabot says it is dev tooling', () => {
  const adjudication = adjudicateDependabotDependencyPr({
    author: 'app/dependabot',
    title: 'chore(deps): bump better-sqlite3 from 12.11.1 to 13.0.3',
    commits: [{ messageBody: commitBody({
      name: 'better-sqlite3',
      version: '13.0.3',
      dependencyType: 'direct:production',
      updateType: 'version-update:semver-major',
    }) }],
  });

  assert.equal(adjudication.approved, false);
  assert.ok(adjudication.reasons.includes('native-driver:better-sqlite3'));
  assert.ok(adjudication.reasons.includes('runtime-major:better-sqlite3'));
});
