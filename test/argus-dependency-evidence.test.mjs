// ARGUSDRAIN-01 item 2 — a semver-major bump gets a real review: materialised
// trees, the deterministic ASR-05 rubric, the repository's usage, the release
// notes, and the green full suite on the head. All I/O is injected, except the
// optional check against the real agent-os rubric package when it is present.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARGUS_CI_WAIT_DEFERRAL_BUDGET,
  assessArgusVerification,
  createDefaultArgusEvidenceIo,
  gatherArgusEvidence,
  npmManifestDirs,
  resolveArgusRubricPythonPath,
  resolveDependencyBump,
  summarizeLockfileDelta,
} from '../src/argus-dependency-evidence.mjs';
import { ARGUS_REVIEW_OUTCOME, reviewArgusJob } from '../src/argus-security-review.mjs';
import { isArgusJobClaimable, ARGUS_BOT_ADJUDICATION_GRACE_MS } from '../src/argus-security-drain.mjs';
import {
  isArgusDrainApprovalAwaitingMerge,
  maybeAutoAdjudicateDependencyBotArgusJob,
} from '../src/dependency-bot-autoadjudication.mjs';
import { completeArgusJob, enqueueArgusSecurityReview, findArgusJob } from '../src/argus-security-queue.mjs';

const REPO = 'laceyenterprises/adversarial-review';
const HEAD = '81bb9f3f0418ac781330e3cf106456cea8ddf88e';
const BASE = 'a'.repeat(40);
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };
const TITLE = 'chore(deps): bump better-sqlite3 from 12.11.1 to 13.0.3 in the tooling group';

function withRoot(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'argus-evidence-'));
  return Promise.resolve(fn(rootDir)).finally(() => rmSync(rootDir, { recursive: true, force: true }));
}

function routedJob(overrides = {}) {
  return {
    jobId: `laceyenterprises__adversarial-review-pr-1172-${HEAD}`,
    repo: REPO,
    prNumber: 1172,
    headSha: HEAD,
    status: 'in_progress',
    enqueuedAt: '2026-09-28T16:09:18.623Z',
    reasons: [
      { trigger: 'bot-author', author: 'dependabot[bot]' },
      { trigger: 'manifest-change', ecosystems: ['npm'], matches: [{ path: 'package.json' }, { path: 'package-lock.json' }] },
    ],
    routedForReview: {
      schemaVersion: 1,
      reason: 'semver-major',
      inputs: { packageName: 'better-sqlite3', fromVersion: '12.11.1', toVersion: '13.0.3', bumpKind: 'major', dependencyType: 'runtime' },
    },
    ...overrides,
  };
}

const LOCK_BASE = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'adversarial-review' },
    'node_modules/better-sqlite3': { version: '12.11.1', resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.11.1.tgz', integrity: 'sha512-a', hasInstallScript: true },
    'node_modules/prebuild-install': { version: '7.1.3', resolved: 'https://registry.npmjs.org/prebuild-install/-/prebuild-install-7.1.3.tgz', integrity: 'sha512-b' },
  },
};
const LOCK_HEAD = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'adversarial-review' },
    'node_modules/better-sqlite3': { version: '13.0.3', resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz', integrity: 'sha512-c', engines: { node: '>=22' } },
    'node_modules/node-addon-api': { version: '8.9.2', resolved: 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.9.2.tgz', integrity: 'sha512-d' },
  },
};

function fakeIo({ rubric = null, ci = 'SUCCESS', notes = '#### v13.0.0\nDrops Node 20.', files = null } = {}) {
  const calls = { rubric: [], fetched: [] };
  const store = files || {
    [`${BASE}:package.json`]: JSON.stringify({ dependencies: { 'better-sqlite3': '^12.11.1' } }),
    [`${BASE}:package-lock.json`]: JSON.stringify(LOCK_BASE),
    [`${HEAD}:package.json`]: JSON.stringify({ dependencies: { 'better-sqlite3': '^13.0.3' } }),
    [`${HEAD}:package-lock.json`]: JSON.stringify(LOCK_HEAD),
  };
  return {
    calls,
    io: {
      existsImpl: (path) => path.endsWith('argus_review') || path.endsWith('.git'),
      fetchFileAtRef: async ({ path, ref }) => {
        calls.fetched.push(`${ref}:${path}`);
        return store[`${ref}:${path}`] ?? null;
      },
      runRubric: async ({ requestPath }) => {
        calls.rubric.push(JSON.parse(readFileSync(requestPath, 'utf8')));
        if (rubric instanceof Error) throw rubric;
        return rubric || { exitCode: 2, doc: { verdict: 'needs_verification', depth: { tier: 'deep' }, riskDirection: 'reduced', findings: [{ category: 'runtime_floor', severity: 'medium', title: 'Node 20 and 21 rejected' }], axes: [] } };
      },
      scanSurface: async () => ({ package: 'better-sqlite3', members: ['<constructor>', 'prepare', 'pragma'], filesScanned: 12 }),
      grepUsage: async () => "src/review-state.mjs:3:import Database from 'better-sqlite3';",
      fetchReleaseNotes: async () => notes,
      summarizeChecks: () => ci,
    },
  };
}

const PR = {
  state: 'OPEN',
  headSha: HEAD,
  baseSha: BASE,
  title: TITLE,
  author: 'app/dependabot',
  changedFiles: ['package.json', 'package-lock.json'],
  statusCheckRollup: [],
};

test('the bump comes from the adjudicator routing, else from the Dependabot title', () => {
  assert.equal(resolveDependencyBump({ job: routedJob(), pr: PR }).source, 'dependency-bot-autoadjudication');
  const fromTitle = resolveDependencyBump({ job: routedJob({ routedForReview: undefined }), pr: PR });
  assert.equal(fromTitle.packageName, 'better-sqlite3');
  assert.equal(fromTitle.bumpKind, 'major');
  assert.equal(resolveDependencyBump({ job: routedJob({ routedForReview: undefined }), pr: { title: 'feat: human change' } }), null);
});

test('manifest directories come from changed package.json / package-lock.json paths', () => {
  assert.deepEqual(npmManifestDirs(['package-lock.json', 'tools/x/package.json', 'src/a.mjs', 'tools/x/package-lock.json']), ['', 'tools/x']);
});

test('the lockfile delta reads #909 the right way round: an install script removed, not added', () => {
  const delta = summarizeLockfileDelta({ baseLock: LOCK_BASE, headLock: LOCK_HEAD, packageName: 'better-sqlite3' });
  assert.deepEqual(delta.installScriptsAdded, []);
  assert.deepEqual(delta.installScriptsRemoved, ['better-sqlite3']);
  assert.deepEqual(delta.added, ['node-addon-api']);
  assert.deepEqual(delta.removed, ['prebuild-install']);
  assert.equal(delta.package.head.version, '13.0.3');

  const hostile = summarizeLockfileDelta({
    baseLock: LOCK_BASE,
    headLock: { packages: { ...LOCK_HEAD.packages, 'node_modules/evil': { version: '1.0.0', resolved: 'https://evil.example/evil.tgz', hasInstallScript: true } } },
  });
  assert.deepEqual(hostile.installScriptsAdded, ['evil']);
  assert.deepEqual(hostile.missingIntegrityIncoming, ['evil']);
  assert.match(hostile.nonRegistryIncoming[0], /^evil → https:\/\/evil\.example/u);
});

test('the evidence materialises both trees and runs the rubric over them', () => withRoot(async (workDir) => {
  const { io, calls } = fakeIo();
  const evidence = await gatherArgusEvidence({ job: routedJob(), pr: PR, diff: '', workDir, rootDir: '/ar', io, logger: quiet });

  assert.equal(evidence.fatal, null);
  for (const side of ['base', 'head']) {
    assert.ok(existsSync(join(workDir, 'trees', '0', side, 'package.json')));
    assert.ok(existsSync(join(workDir, 'trees', '0', side, 'package-lock.json')));
  }
  const request = calls.rubric[0];
  assert.equal(request.baseTree, 'base');
  assert.equal(request.headSha, HEAD);
  assert.deepEqual(request.triggerReasons, ['bot-author', 'manifest-change']);
  assert.deepEqual(request.consumedSurface['better-sqlite3'].members, ['<constructor>', 'prepare', 'pragma']);
  assert.equal(request.runtime.version, process.versions.node);

  assert.equal(evidence.rubric.results[0].verdict, 'needs_verification');
  assert.equal(evidence.rubricFindings[0].source, 'argus-rubric');
  assert.equal(evidence.rubricFindings[0].severity, 'medium');
  const titles = evidence.sections.map((section) => section.title);
  assert.ok(titles.includes('Dependency bump'));
  assert.ok(titles.some((title) => title.startsWith('Lockfile facts')));
  assert.ok(titles.some((title) => title.startsWith('Deterministic ASR-05 rubric')));
  assert.ok(titles.some((title) => title.startsWith('Upstream release notes')));
  assert.ok(titles.includes('CI on this head'));
  const usage = evidence.sections.find((section) => section.title.startsWith('This repository')).body;
  assert.match(usage, /import Database from 'better-sqlite3'/u);
}));

test('a rubric that crashes is fatal; a rubric that is not installed is reported, not assumed', () => withRoot(async (workDir) => {
  const crashed = await gatherArgusEvidence({
    job: routedJob(), pr: PR, diff: '', workDir, rootDir: '/ar', io: fakeIo({ rubric: new Error('Traceback') }).io, logger: quiet,
  });
  assert.match(crashed.fatal, /ASR-05 rubric failed for \.: Traceback/u);

  const { io } = fakeIo();
  const missing = await gatherArgusEvidence({
    job: routedJob(), pr: PR, diff: '', workDir, rootDir: '/ar', io: { ...io, existsImpl: () => false }, logger: quiet,
  });
  assert.equal(missing.fatal, null);
  assert.equal(missing.rubric.results[0].status, 'unavailable');
  const notes = await gatherArgusEvidence({
    job: routedJob(), pr: PR, diff: '', workDir, rootDir: '/ar', io: fakeIo({ notes: null }).io, logger: quiet,
  });
  assert.match(notes.sections.find((s) => s.title.startsWith('Upstream')).body, /^Not obtained/u);
}));

test('verification: a semver-major needs the full suite green on this head', () => {
  const cached = { dependency: resolveDependencyBump({ job: routedJob(), pr: PR }), rubric: null };
  const green = assessArgusVerification({ job: routedJob(), pr: PR, cached, summarizeChecks: () => 'SUCCESS' });
  assert.deepEqual([green.required, green.satisfied, green.source], [true, true, 'pr-head-full-suite']);

  const running = assessArgusVerification({ job: routedJob(), pr: PR, cached, summarizeChecks: () => 'PENDING' });
  assert.equal(running.defer, true);
  const exhausted = assessArgusVerification({
    job: routedJob({ drain: { deferrals: ARGUS_CI_WAIT_DEFERRAL_BUDGET } }), pr: PR, cached, summarizeChecks: () => null,
  });
  assert.deepEqual([exhausted.satisfied, exhausted.defer], [false, undefined]);
  assert.match(exhausted.detail, /never finished green/u);

  const red = assessArgusVerification({ job: routedJob(), pr: PR, cached, summarizeChecks: () => 'FAILURE' });
  assert.deepEqual([red.satisfied, red.detail.includes('FAILURE')], [false, true]);

  const additive = assessArgusVerification({ job: routedJob({ routedForReview: undefined }), pr: { title: 'x' }, cached: { dependency: null, rubric: null }, summarizeChecks: () => 'FAILURE' });
  assert.equal(additive.required, false);
});

function reviewText(doc) {
  return `## Argus Security Review\nok\n\n## Findings JSON\n<argus-review-json>\n${JSON.stringify(doc)}\n</argus-review-json>\n\n## Verdict\nApprove`;
}

function reviewDeps({ io, modelDoc, posts }) {
  return {
    fetchPullRequest: async () => PR,
    fetchDiff: async () => 'diff --git a/package.json b/package.json\n',
    resolveReviewerModels: async () => ['claude'],
    runReviewerModel: async ({ prompt }) => {
      assert.match(prompt, /Deterministic ASR-05 rubric/u);
      assert.match(prompt, /From 12\.11\.1 to 13\.0\.3 \(major, runtime dependency\)/u);
      return { text: reviewText(modelDoc) };
    },
    postComment: async ({ body }) => {
      posts.push(body);
      return { ok: true, url: 'u' };
    },
    gatherEvidence: (args) => gatherArgusEvidence({ ...args, rootDir: '/ar', io, logger: quiet }),
    assessVerification: (args) => assessArgusVerification({ ...args, summarizeChecks: io.summarizeChecks }),
  };
}

test('semver-major path: CI running defers with the review cached; CI green approves on the full suite', () => withRoot(async (workDir) => {
  const posts = [];
  let ci = 'PENDING';
  const { io } = fakeIo();
  io.summarizeChecks = () => ci;
  const deps = reviewDeps({ io, posts, modelDoc: { verdict: 'approve', summary: 'removes an install script', riskDirection: 'reduced', findings: [], breakingChanges: ['drops Node 20'] } });

  const waiting = await reviewArgusJob({ job: routedJob(), deps, workDir, nowMs: NOW, logger: quiet });
  assert.equal(waiting.kind, ARGUS_REVIEW_OUTCOME.DEFER);
  assert.equal(waiting.reason, 'ci-pending');
  assert.equal(waiting.cachedReview.dependency.bumpKind, 'major');

  ci = 'SUCCESS';
  const done = await reviewArgusJob({
    job: routedJob({ drain: { deferrals: 1, cachedReview: waiting.cachedReview } }),
    deps: { ...deps, runReviewerModel: async () => assert.fail('the cached review is reused') },
    workDir,
    nowMs: NOW + 10 * 60 * 1000,
    logger: quiet,
  });
  assert.equal(done.kind, ARGUS_REVIEW_OUTCOME.COMPLETE);
  assert.equal(done.result.verdict, 'approve');
  assert.equal(done.result.verification.source, 'pr-head-full-suite');
  assert.equal(done.result.verification.satisfied, true);
  assert.equal(done.result.dependency.packageName, 'better-sqlite3');
  assert.equal(done.result.findings.find((f) => f.source === 'argus-rubric').category, 'runtime_floor');
  assert.equal(posts.length, 1, 'a bot PR always gets its Argus comment');
  assert.match(posts[0], /Verdict: approved/u);
}));

test('semver-major path: a rubric high blocks even when the model approves', () => withRoot(async (workDir) => {
  const posts = [];
  const { io } = fakeIo({
    rubric: { exitCode: 3, doc: { verdict: 'block', findings: [{ category: 'install_time_execution', severity: 'high', title: 'evil adds postinstall' }], axes: [] } },
  });
  const deps = reviewDeps({ io, posts, modelDoc: { verdict: 'approve', summary: 'fine', findings: [] } });
  const outcome = await reviewArgusJob({ job: routedJob(), deps, workDir, nowMs: NOW, logger: quiet });
  assert.equal(outcome.result.verdict, 'block');
  assert.match(posts[0], /### Blocking \(high\)/u);
  assert.match(posts[0], /evil adds postinstall/u);
}));

test('the drain leaves a fresh bot job to the adjudicator, and never takes one its merge path owns', () => {
  const enqueuedAt = new Date(NOW).toISOString();
  const bot = { enqueuedAt, reasons: [{ trigger: 'bot-author' }] };
  assert.equal(isArgusJobClaimable(bot, { nowMs: NOW + 60_000 }), false);
  assert.equal(isArgusJobClaimable(bot, { nowMs: NOW + ARGUS_BOT_ADJUDICATION_GRACE_MS + 1 }), true);
  assert.equal(isArgusJobClaimable({ ...bot, routedForReview: { reason: 'semver-major' } }, { nowMs: NOW + 1 }), true);
  assert.equal(isArgusJobClaimable({ ...bot, lastAutoadjudicationAttempt: {} }, { nowMs: NOW + 10 * ARGUS_BOT_ADJUDICATION_GRACE_MS }), false);
  assert.equal(isArgusJobClaimable({ enqueuedAt, reasons: [{ trigger: 'sensitive-path' }] }, { nowMs: NOW }), true);
});

test('an already-routed job is left to the drain; a drain approval merges through the daemon', () => withRoot(async (rootDir) => {
  enqueueArgusSecurityReview({ rootDir, repo: REPO, prNumber: 1172, headSha: HEAD, reasons: routedJob().reasons });
  const pending = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: HEAD });
  const args = {
    rootDir,
    title: TITLE,
    authorRef: 'dependabot[bot]',
    candidate: { baseBranch: 'main', headSha: HEAD, prState: 'open' },
    cfg: { enabled: true },
    currentPrHeadSha: HEAD,
    logger: quiet,
    now: () => new Date(NOW).toISOString(),
  };

  const first = await maybeAutoAdjudicateDependencyBotArgusJob({ ...args, jobRecord: pending, runDaemonCleanMergeAttemptImpl: async () => assert.fail('no merge for a major') });
  assert.equal(first.reason, 'semver-major');
  const routed = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: HEAD });
  const second = await maybeAutoAdjudicateDependencyBotArgusJob({ ...args, jobRecord: routed, runDaemonCleanMergeAttemptImpl: async () => assert.fail('routed jobs belong to the drain') });
  assert.deepEqual(second, { attempted: false, reason: 'routed-for-review' });

  completeArgusJob({ rootDir, jobPath: routed.jobPath, job: routed.job, result: { source: 'argus-security-drain', verdict: 'approve', findings: [{ severity: 'low' }], reviewer: { model: 'gemini' } } });
  const approved = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: HEAD });
  assert.equal(isArgusDrainApprovalAwaitingMerge(approved.job), true);

  let mergeArgs = null;
  const merged = await maybeAutoAdjudicateDependencyBotArgusJob({
    ...args,
    jobRecord: approved,
    runDaemonCleanMergeAttemptImpl: async (mergeInput) => {
      mergeArgs = mergeInput;
      return { disposition: 'merged', reason: 'merged', merged: true };
    },
  });
  assert.equal(merged.reason, 'merged');
  assert.equal(mergeArgs.autonomousMergeAccountability.label, 'argus-security-review');
  assert.equal(mergeArgs.reviewState.nonBlockingFindingCount, 1);
  const after = findArgusJob(rootDir, { repo: REPO, prNumber: 1172, headSha: HEAD });
  assert.equal(after.job.result.merge.merged, true);
  assert.equal(after.job.result.merge.settled, true);
  assert.equal(isArgusDrainApprovalAwaitingMerge(after.job), false);
}));

test('the rubric package resolves beside the deployed submodule, or not at all', () => {
  assert.equal(resolveArgusRubricPythonPath({ rootDir: '/x/tools/adversarial-review', env: {}, existsImpl: (p) => p === '/x/modules/argus/lib/python/argus_review' }), '/x/modules/argus/lib/python');
  assert.equal(resolveArgusRubricPythonPath({ rootDir: '/x', env: {}, existsImpl: () => false }), null);
  assert.equal(resolveArgusRubricPythonPath({ rootDir: '/x', env: { ADVERSARIAL_ARGUS_RUBRIC_PYTHONPATH: '/p' }, existsImpl: (p) => p === '/p/argus_review' }), '/p');
});

// The deployed layout (this repo as agent-os's tools/adversarial-review
// submodule) first, then the operator's agent-os checkout.
const AGENT_OS_RUBRIC = resolveArgusRubricPythonPath({ rootDir: join(dirname(fileURLToPath(import.meta.url)), '..'), env: process.env })
  || join(homedir(), 'agent-os', 'modules', 'argus', 'lib', 'python');
const FIXTURE = join(AGENT_OS_RUBRIC, '..', '..', 'test', 'fixtures', 'security-review', 'pr-909.json');
test('the production rubric runner reads the real ASR-05 CLI (skipped where agent-os is absent)', {
  skip: !(existsSync(join(AGENT_OS_RUBRIC, 'argus_review')) && existsSync(FIXTURE)) && 'agent-os argus_review not present',
}, async () => {
  const io = createDefaultArgusEvidenceIo({ env: { ...process.env, ADVERSARIAL_ARGUS_RUBRIC_PYTHON: 'python3' } });
  const { exitCode, doc } = await io.runRubric({ requestPath: FIXTURE, pythonPath: AGENT_OS_RUBRIC });
  assert.equal(exitCode, 0);
  assert.equal(doc.verdict, 'approve');
  assert.equal(doc.riskDirection, 'reduced');
});
