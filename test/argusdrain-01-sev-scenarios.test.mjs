// ARGUSDRAIN-01 item 6 — the SEV's end-to-end scenario, on the real modules.
//
// agent-os#7326: adversarial-review#1172 (better-sqlite3 12.11.1 → 13.0.3) was
// completed by the auto-adjudicator as `needs_verification` / `route-for-review`
// at 2026-09-28T16:14:18Z and parked there, because nothing reviews a routed
// job. This replays that exact record through the fix:
//
//   backlog retirement reopens it (its head is live)
//   → the drain claims it and reviews it (rubric + evidence + model, CI green)
//   → the job completes `approve`; the gate reads APPROVED
//   → the watcher's per-PR pass hands it to the real daemon clean-merge path,
//     which merges under `argus-security-review` accountability.
//
// Only GitHub, the model and the final merge call are faked; the queue, drain,
// retirement, review, verdict, adjudicator and daemon-merge gate are real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { retireArgusBacklog } from '../src/argus-backlog-retirement.mjs';
import { createArgusSecurityDrain } from '../src/argus-security-drain.mjs';
import {
  completeArgusJob,
  enqueueArgusSecurityReview,
  findArgusJob,
} from '../src/argus-security-queue.mjs';
import { reviewArgusJob } from '../src/argus-security-review.mjs';
import { assessArgusVerification, gatherArgusEvidence } from '../src/argus-dependency-evidence.mjs';
import { ARGUS_VERDICT_STATES, resolveArgusSecurityVerdict } from '../src/argus-security-verdict.mjs';
import { maybeAutoAdjudicateDependencyBotArgusJob } from '../src/dependency-bot-autoadjudication.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const PR = 1172;
const HEAD = '81bb9f3f0418ac781330e3cf106456cea8ddf88e';
const BASE = 'f'.repeat(40);
const TITLE = 'chore(deps): bump better-sqlite3 from 12.11.1 to 13.0.3 in the tooling group';
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };

// The live record, as the auto-adjudicator left it (data/argus-security-jobs/
// completed/laceyenterprises__adversarial-review-pr-1172-81bb9f3f….json).
const LIVE_REASONS = [
  { trigger: 'bot-author', author: 'dependabot[bot]' },
  {
    trigger: 'manifest-change',
    ecosystems: ['npm'],
    matches: [{ path: 'package-lock.json', ecosystem: 'npm' }, { path: 'package.json', ecosystem: 'npm' }],
  },
];
const LIVE_RESULT = {
  schemaVersion: 1,
  kind: 'argus-security-result',
  verdict: 'needs_verification',
  summary: 'Dependency bot auto-adjudication withheld auto-merge: semver-major.',
  findings: [],
  triggerReasons: ['bot-author', 'manifest-change'],
  autoadjudication: {
    schemaVersion: 1,
    decision: 'route-for-review',
    reason: 'semver-major',
    inputs: {
      authorRef: 'dependabot[bot]',
      title: TITLE,
      packageName: 'better-sqlite3',
      dependencyType: 'runtime',
      fromVersion: '12.11.1',
      toVersion: '13.0.3',
      bumpKind: 'major',
      manifestReason: true,
      securitySurface: true,
    },
    completedAt: '2026-09-28T16:14:18.684Z',
  },
};

const GREEN = [{ __typename: 'CheckRun', name: 'npm test (Node 22)', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const LOCK = (version, extra = {}) => JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'adversarial-review' },
    'node_modules/better-sqlite3': { version, resolved: `https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${version}.tgz`, integrity: `sha512-${version}`, ...extra },
  },
});

async function withRoot(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'argusdrain-sev-'));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedParkedMajor(rootDir) {
  enqueueArgusSecurityReview({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, reasons: LIVE_REASONS, enqueuedAt: '2026-09-28T16:09:18.623Z', source: 'watcher-pollonce' });
  const found = findArgusJob(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD });
  completeArgusJob({ rootDir, jobPath: found.jobPath, job: found.job, completedAt: '2026-09-28T16:14:18.684Z', result: LIVE_RESULT });
}

function reviewDeps({ rubric, modelFindings = [] }) {
  const io = {
    existsImpl: (path) => path.endsWith('argus_review') || path.endsWith('.git'),
    fetchFileAtRef: async ({ path, ref }) => {
      if (path === 'package.json') return JSON.stringify({ dependencies: { 'better-sqlite3': ref === HEAD ? '^13.0.3' : '^12.11.1' } });
      return ref === HEAD ? LOCK('13.0.3') : LOCK('12.11.1', { hasInstallScript: true });
    },
    runRubric: async () => rubric,
    scanSurface: async () => ({ members: ['<constructor>', 'prepare', 'pragma', 'transaction'], filesScanned: 40 }),
    grepUsage: async () => "src/review-state.mjs:1:import Database from 'better-sqlite3';",
    fetchReleaseNotes: async () => '#### v13.0.0\nDrops Node 20; prebuilt binaries replace prebuild-install.',
    summarizeChecks: (rollup) => (rollup === GREEN ? 'SUCCESS' : 'PENDING'),
  };
  const posts = [];
  return {
    posts,
    deps: {
      fetchPullRequest: async () => ({ state: 'OPEN', headSha: HEAD, baseSha: BASE, title: TITLE, author: 'app/dependabot', changedFiles: ['package.json', 'package-lock.json'], statusCheckRollup: GREEN }),
      fetchDiff: async () => 'diff --git a/package.json b/package.json\n-    "better-sqlite3": "^12.11.1"\n+    "better-sqlite3": "^13.0.3"\n',
      resolveReviewerModels: async () => ['gemini', 'claude'],
      runReviewerModel: async ({ model }) => ({
        text: [
          '## Argus Security Review',
          'Major bump that removes the install script.',
          '## Findings JSON',
          '<argus-review-json>',
          JSON.stringify({ verdict: modelFindings.some((f) => f.severity === 'high') ? 'block' : 'approve', summary: 'Removes prebuild-install and the install script; this repo runs Node 22+.', riskDirection: 'reduced', findings: modelFindings, breakingChanges: ['drops Node 20'] }),
          '</argus-review-json>',
          '## Verdict',
          'Approve',
        ].join('\n'),
        execution: { harness: model },
      }),
      postComment: async ({ body, model }) => {
        posts.push({ body, model });
        return { ok: true, url: `https://github.com/${REPO}/pull/${PR}#issuecomment-1`, identity: 'GH_GEMINI_REVIEWER_TOKEN' };
      },
      gatherEvidence: (args) => gatherArgusEvidence({ ...args, rootDir: '/ar', io, logger: quiet }),
      assessVerification: (args) => assessArgusVerification({ ...args, summarizeChecks: io.summarizeChecks }),
    },
  };
}

function drainFor(rootDir, deps) {
  return createArgusSecurityDrain({
    rootDir,
    nowMs: () => NOW,
    logger: quiet,
    retireBacklog: ({ runningJobIds, nowMs }) => retireArgusBacklog({
      rootDir,
      runningJobIds,
      nowMs,
      logger: quiet,
      listOpenPullHeads: async () => ({ complete: true, heads: new Map([[PR, HEAD]]) }),
    }),
    runJob: ({ job }) => reviewArgusJob({ job, deps, workDir: join(rootDir, 'work'), nowMs: NOW, logger: quiet }),
  });
}

async function runDrainToCompletion(drain) {
  drain.tick();
  await drain.drain();
  drain.tick();
  await drain.drain();
}

test('SEV replay: the parked #1172 major is reviewed, approved, and merged by the daemon', async () => withRoot(async (rootDir) => {
  seedParkedMajor(rootDir);
  assert.equal(
    resolveArgusSecurityVerdict({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, nowMs: NOW }).state,
    ARGUS_VERDICT_STATES.NEEDS_VERIFICATION,
    'starts where production parked it',
  );

  const { deps, posts } = reviewDeps({
    rubric: { exitCode: 2, doc: { verdict: 'needs_verification', depth: { tier: 'deep' }, riskDirection: 'reduced', findings: [{ category: 'runtime_floor', severity: 'medium', title: 'better-sqlite3@13 rejects Node 20 and 21' }], axes: [] } },
  });
  await runDrainToCompletion(drainFor(rootDir, deps));

  const reviewed = findArgusJob(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD });
  assert.equal(reviewed.bucket, 'completed');
  assert.equal(reviewed.job.result.source, 'argus-security-drain');
  assert.equal(reviewed.job.result.verdict, 'approve');
  assert.equal(reviewed.job.result.verification.source, 'pr-head-full-suite');
  assert.equal(reviewed.job.result.reviewer.model, 'gemini');
  assert.equal(reviewed.job.priorResult.autoadjudication.reason, 'semver-major');
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /Verdict: approved/u);
  assert.match(posts[0].body, /rejects Node 20 and 21/u);

  const verdict = resolveArgusSecurityVerdict({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, nowMs: NOW });
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.APPROVED);
  assert.equal(verdict.satisfiesGate, true);

  // The watcher's next per-PR pass for the bot row.
  let mergeCall = null;
  const adjudication = await maybeAutoAdjudicateDependencyBotArgusJob({
    rootDir,
    jobRecord: reviewed,
    title: TITLE,
    authorRef: 'dependabot[bot]',
    candidate: { baseBranch: 'main', headSha: HEAD, prState: 'open' },
    gateSnapshot: null,
    mergeabilityForGate: null,
    cfg: { enabled: true, branchProtection: { required: false } },
    currentPrHeadSha: HEAD,
    logger: quiet,
    now: () => new Date(NOW).toISOString(),
    runDaemonCleanMergeAttemptImpl: (args) => runDaemonCleanMergeAttempt({
      ...args,
      fetchRollupImpl: async () => ({
        headRefOid: HEAD,
        headRefName: 'dependabot/npm_and_yarn/tooling-12345',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        checks: GREEN,
      }),
      readBuildCompletionSignalForPrImpl: () => null,
      readHeadAttestationChainForPrImpl: () => [],
      resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
      attemptDaemonCleanMergeImpl: async (mergeArgs) => {
        mergeCall = mergeArgs;
        return { disposition: 'merged', reason: 'merged', merged: true };
      },
    }),
  });

  assert.equal(adjudication.reason, 'merged');
  assert.ok(mergeCall, 'the daemon reached its merge call');
  assert.equal(mergeCall.validatedHead, HEAD);
  assert.equal(mergeCall.auditMetadata.autonomousMergeAccountability.label, 'argus-security-review');
  assert.equal(mergeCall.auditMetadata.autonomousMergeAccountability.eventId, `${reviewed.job.jobId}:argus-review`);
  const merged = findArgusJob(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD });
  assert.equal(merged.job.result.merge.merged, true);
  assert.equal(merged.job.result.merge.settled, true);
}));

test('SEV replay, hostile variant: a high install-script finding blocks, posts, and never reaches the merge path', async () => withRoot(async (rootDir) => {
  seedParkedMajor(rootDir);
  const { deps, posts } = reviewDeps({
    rubric: { exitCode: 3, doc: { verdict: 'block', depth: { tier: 'deep' }, findings: [{ category: 'install_time_execution', severity: 'high', title: 'better-sqlite3@13.0.3 adds a postinstall script' }], axes: [] } },
  });
  await runDrainToCompletion(drainFor(rootDir, deps));

  const verdict = resolveArgusSecurityVerdict({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, nowMs: NOW });
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.BLOCKED);
  assert.equal(verdict.blockingFindings[0].category, 'install_time_execution');
  assert.equal(posts.length, 1);
  assert.match(posts[0].body, /### Blocking \(high\)/u);
  assert.match(posts[0].body, /adds a postinstall script/u);

  const adjudication = await maybeAutoAdjudicateDependencyBotArgusJob({
    rootDir,
    jobRecord: findArgusJob(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD }),
    title: TITLE,
    authorRef: 'dependabot[bot]',
    candidate: { baseBranch: 'main', headSha: HEAD, prState: 'open' },
    cfg: { enabled: true },
    currentPrHeadSha: HEAD,
    logger: quiet,
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('a blocked job must never reach the merge path'),
  });
  assert.equal(adjudication.attempted, false);
}));

test('SEV replay: a model high outside the reserved categories does not block the bump', async () => withRoot(async (rootDir) => {
  seedParkedMajor(rootDir);
  const { deps } = reviewDeps({
    rubric: { exitCode: 0, doc: { verdict: 'approve', findings: [], axes: [] } },
    modelFindings: [{ category: 'breaking_change', severity: 'high', title: 'Database#pragma return shape changed' }],
  });
  await runDrainToCompletion(drainFor(rootDir, deps));
  const job = findArgusJob(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD }).job;
  assert.equal(job.result.verdict, 'approve');
  assert.equal(job.result.findings[0].severity, 'medium');
  assert.equal(job.result.findings[0].demotedFrom, 'high');
}));
