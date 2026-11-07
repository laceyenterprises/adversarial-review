// REVIEWCARRY-01: a settled clean review carries forward across a head change
// that leaves the PR's own patch unchanged except for declared generated paths.
// Synthetic fixtures only; GitHub reads are served by an in-memory `get`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GENERATED_PATHS_DECLARATION,
  carryStalePostedReviewForward,
  compileGeneratedPathMatcher,
  decideReviewCarryForward,
  parseGeneratedPathsDeclaration,
  proveReviewCarryForward,
  readReviewCarryForwardRecord,
  resolveReviewCarryForward,
  reviewCarryForwardHeadProof,
  reviewCarryForwardRecordPath,
  writeReviewCarryForwardRecord,
} from '../src/review-carry-forward.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';

const REPO = 'example-org/example-repo';
const PR = 42;
const OLD_FORK = '1'.repeat(40);
const NEW_FORK = '2'.repeat(40);
const OLDER_FORK = '3'.repeat(40);
const REVIEWED = 'a'.repeat(40);
const CURRENT = 'b'.repeat(40);
const DECLARATION = 'test/fixtures/config-fingerprint.json\ndocs/catalog/\n# comment line\n';

const CLEAN_REVIEW = Object.freeze({
  verdict: 'comment-only', blockingFindingState: 'known', blockingFindingCount: 0,
  nonBlockingFindingCount: 0, remediationPending: false,
});

const featurePatch = (start, body = '+export const feature = true;') =>
  `@@ -${start},3 +${start},4 @@ export function existing() {\n context line one\n${body}\n context line two`;
const fixturePatch = value => `@@ -1,3 +1,3 @@\n {\n-  "fingerprint": "old"\n+  "fingerprint": "${value}"\n }`;

function file(filename, patch, extra = {}) {
  return { filename, status: 'modified', changes: 2, patch, ...extra };
}

function fakeGitHub({ reviewedFiles, currentFiles, reviewedFork = OLD_FORK, currentFork = NEW_FORK,
  forkStatus = 'ahead', declaration = DECLARATION } = {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (path === `repos/${REPO}/compare/main...${REVIEWED}`) {
      return { merge_base_commit: { sha: reviewedFork }, files: reviewedFiles };
    }
    if (path === `repos/${REPO}/compare/main...${CURRENT}`) {
      return { merge_base_commit: { sha: currentFork }, files: currentFiles };
    }
    if (path === `repos/${REPO}/compare/${reviewedFork}...${currentFork}`) return { status: forkStatus };
    if (path.startsWith(`repos/${REPO}/contents/${GENERATED_PATHS_DECLARATION}?ref=`)) {
      if (declaration === null) throw new Error('gh: Not Found (HTTP 404)');
      return { type: 'file', encoding: 'base64', content: Buffer.from(declaration).toString('base64') };
    }
    throw new Error(`unexpected read ${path}`);
  };
  return { get, calls };
}

const prove = (github, extra = {}) => proveReviewCarryForward({
  repo: REPO, reviewedHead: REVIEWED, currentHead: CURRENT, baseRef: 'main', get: github.get, ...extra,
});

function withRoot(fn) {
  return async () => {
    const root = mkdtempSync(join(process.env.ADVERSARIAL_REVIEW_TEST_TEMP_BASE || tmpdir(), 'reviewcarry-'));
    try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

test('a rebase-only change carries forward (hunk line numbers moved, content identical)', async () => {
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10))],
    currentFiles: [file('src/feature.mjs', featurePatch(57))],
    declaration: null,
  });
  const proof = await prove(github);
  assert.equal(proof.proven, true, proof.reason);
  assert.deepEqual(proof.excludedPathsChanged, []);
  assert.equal(decideReviewCarryForward({ settledReview: CLEAN_REVIEW, proof }).carry, true);
});

test('a generated-only conflict resolution carries forward', async () => {
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10)),
      file('test/fixtures/config-fingerprint.json', fixturePatch('reviewed'))],
    currentFiles: [file('src/feature.mjs', featurePatch(12)),
      file('test/fixtures/config-fingerprint.json', fixturePatch('regenerated-after-rebase'))],
  });
  const proof = await prove(github);
  assert.equal(proof.proven, true, proof.reason);
  assert.deepEqual(proof.excludedPathsChanged, ['test/fixtures/config-fingerprint.json']);
  assert.equal(proof.generatedPathsSource, GENERATED_PATHS_DECLARATION);
  // The declaration is read at the new merge base (a base-branch commit), never at the PR head.
  assert.ok(github.calls.includes(`repos/${REPO}/contents/${GENERATED_PATHS_DECLARATION}?ref=${NEW_FORK}`));
  assert.ok(!github.calls.some(path => path.includes(`ref=${CURRENT}`) || path.includes(`ref=${REVIEWED}`)));
});

test('a one-line change in a non-generated file does NOT carry forward', async () => {
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10)),
      file('test/fixtures/config-fingerprint.json', fixturePatch('reviewed'))],
    currentFiles: [file('src/feature.mjs', featurePatch(10, '+export const feature = false;')),
      file('test/fixtures/config-fingerprint.json', fixturePatch('regenerated'))],
  });
  const proof = await prove(github);
  assert.equal(proof.proven, false);
  assert.equal(proof.reason, 'own-patch-changed');
  assert.deepEqual(proof.changedPaths, ['src/feature.mjs']);
  assert.equal(decideReviewCarryForward({ settledReview: CLEAN_REVIEW, proof }).carry, false);
});

test('a newly touched non-generated file, or a whitespace-only edit, does NOT carry forward', async () => {
  const base = [file('src/feature.mjs', featurePatch(10))];
  const added = await prove(fakeGitHub({ reviewedFiles: base,
    currentFiles: [...base, file('src/other.mjs', '@@ -1 +1 @@\n-a\n+b')] }));
  assert.equal(added.reason, 'own-patch-changed');
  assert.deepEqual(added.changedPaths, ['src/other.mjs']);
  const whitespace = await prove(fakeGitHub({ reviewedFiles: base,
    currentFiles: [file('src/feature.mjs', featurePatch(10, '+export  const feature = true;'))] }));
  assert.equal(whitespace.reason, 'own-patch-changed');
});

test('a review with blocking findings never carries forward, and costs no GitHub read', withRoot(async (root) => {
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10))],
    currentFiles: [file('src/feature.mjs', featurePatch(10))],
  });
  const blocking = { ...CLEAN_REVIEW, verdict: 'request-changes', blockingFindingCount: 1 };
  const result = await resolveReviewCarryForward({ rootDir: root, repo: REPO, prNumber: PR,
    reviewedHead: REVIEWED, currentHead: CURRENT, baseRef: 'main', settledReview: blocking, get: github.get, logger: null });
  assert.equal(result.carried, false);
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.deepEqual(github.calls, []);
  // Even a proven patch cannot carry a blocking, unknown or pending review.
  const proof = { proven: true };
  assert.equal(decideReviewCarryForward({ settledReview: { ...CLEAN_REVIEW, verdict: 'comment-only', blockingFindingCount: 2 }, proof }).carry, false);
  assert.equal(decideReviewCarryForward({ settledReview: { ...CLEAN_REVIEW, blockingFindingState: 'unknown' }, proof }).carry, false);
  assert.equal(decideReviewCarryForward({ settledReview: { ...CLEAN_REVIEW, remediationPending: true }, proof }).carry, false);
  assert.equal(decideReviewCarryForward({ settledReview: { ...CLEAN_REVIEW, verdict: '' }, proof }).carry, false);
}));

test('the carry-forward record names both SHAs and the excluded paths, once per head', withRoot(async (root) => {
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10)),
      file('test/fixtures/config-fingerprint.json', fixturePatch('reviewed'))],
    currentFiles: [file('src/feature.mjs', featurePatch(10)),
      file('test/fixtures/config-fingerprint.json', fixturePatch('regenerated'))],
  });
  const input = { rootDir: root, repo: REPO, prNumber: PR, reviewedHead: REVIEWED, currentHead: CURRENT,
    baseRef: 'main', settledReview: CLEAN_REVIEW, get: github.get, logger: null };
  const result = await resolveReviewCarryForward(input);
  assert.equal(result.carried, true);
  const onDisk = JSON.parse(readFileSync(reviewCarryForwardRecordPath(root, { repo: REPO, prNumber: PR, currentHead: CURRENT }), 'utf8'));
  assert.equal(onDisk.reviewedHead, REVIEWED);
  assert.equal(onDisk.currentHead, CURRENT);
  assert.deepEqual(onDisk.excludedPatterns, ['test/fixtures/config-fingerprint.json', 'docs/catalog/**']);
  assert.deepEqual(onDisk.excludedPathsChanged, ['test/fixtures/config-fingerprint.json']);
  assert.equal(onDisk.carriedVerdict, 'comment-only');
  assert.equal(onDisk.reviewedMergeBase, OLD_FORK);
  assert.equal(onDisk.currentMergeBase, NEW_FORK);
  // A second tick reads the record and makes no GitHub call.
  const callsAfterFirst = github.calls.length;
  assert.equal((await resolveReviewCarryForward(input)).carried, true);
  assert.equal(github.calls.length, callsAfterFirst);
  // The record carries only its exact pair.
  assert.equal(readReviewCarryForwardRecord(root, { repo: REPO, prNumber: PR, reviewedHead: 'c'.repeat(40), currentHead: CURRENT }), null);
  assert.equal(readReviewCarryForwardRecord(root, { repo: REPO, prNumber: PR + 1, reviewedHead: REVIEWED, currentHead: CURRENT }), null);
  const headProof = reviewCarryForwardHeadProof(readReviewCarryForwardRecord(root, { repo: REPO, prNumber: PR, reviewedHead: REVIEWED, currentHead: CURRENT }));
  assert.equal(headProof.proven, true);
  assert.equal(headProof.anchorHead, REVIEWED);
  assert.equal(headProof.currentHead, CURRENT);
  assert.deepEqual(headProof.closerCommits, []);
}));

test('a record claiming a blocking or unclean carried verdict is not honoured', withRoot(async (root) => {
  const path = reviewCarryForwardRecordPath(root, { repo: REPO, prNumber: PR, currentHead: CURRENT });
  mkdirSync(join(root, 'data', 'review-carry-forward'), { recursive: true });
  const record = { schemaVersion: 1, event: 'review_carried_forward_generated_only', repo: REPO, prNumber: PR,
    reviewedHead: REVIEWED, currentHead: CURRENT, proof: 'own-patch-equal-excluding-generated-paths',
    excludedPatterns: [], excludedPathsChanged: [], carriedVerdict: 'request-changes', blockingFindingCount: 1 };
  writeFileSync(path, JSON.stringify(record));
  assert.equal(readReviewCarryForwardRecord(root, { repo: REPO, prNumber: PR, reviewedHead: REVIEWED, currentHead: CURRENT }), null);
  writeFileSync(path, JSON.stringify({ ...record, carriedVerdict: 'comment-only', blockingFindingCount: 0 }));
  assert.ok(readReviewCarryForwardRecord(root, { repo: REPO, prNumber: PR, reviewedHead: REVIEWED, currentHead: CURRENT }));
}));

test('a change only inside generated paths that adds a NEW generated path still carries forward', async () => {
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10)),
      file('docs/catalog/index.json', fixturePatch('reviewed'))],
    currentFiles: [file('src/feature.mjs', featurePatch(10)),
      file('docs/catalog/index.json', fixturePatch('regenerated')),
      file('docs/catalog/entries/new-entry.json', '@@ -0,0 +1 @@\n+{}', { status: 'added', changes: 1 })],
  });
  const proof = await prove(github);
  assert.equal(proof.proven, true, proof.reason);
  assert.deepEqual(proof.excludedPathsChanged, ['docs/catalog/entries/new-entry.json', 'docs/catalog/index.json']);
});

test('the PR cannot widen the generated list: the declaration file itself is always compared', async () => {
  const declarationEdit = file(GENERATED_PATHS_DECLARATION, '@@ -1,2 +1,3 @@\n a\n b\n+src/**');
  const proof = await prove(fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10))],
    currentFiles: [file('src/feature.mjs', featurePatch(10)), declarationEdit],
    declaration: `${DECLARATION}.adversarial-review/**\n`,
  }));
  assert.equal(proof.reason, 'own-patch-changed');
  assert.deepEqual(proof.changedPaths, [GENERATED_PATHS_DECLARATION]);
  assert.ok(proof.rejectedPatterns.some(entry => entry.reason === 'matches-declaration'));
});

test('declaration parsing refuses catch-alls, negations, traversal and self-matching patterns', () => {
  const { patterns, rejected } = parseGeneratedPathsDeclaration([
    '**', '*', '**/*', '!keep.json', '../outside/**', '.adversarial-review/**', '/generated/out.json', 'gen/',
  ]);
  assert.deepEqual(patterns, ['generated/out.json', 'gen/**']);
  assert.deepEqual(rejected.map(entry => entry.reason),
    ['catch-all', 'catch-all', 'catch-all', 'negation-unsupported', 'unsafe-path', 'matches-declaration']);
  const matches = compileGeneratedPathMatcher(['gen/**', 'fixtures/*.json']);
  assert.equal(matches('gen/a/b.txt'), true);
  assert.equal(matches('fixtures/x.json'), true);
  assert.equal(matches('fixtures/nested/x.json'), false);
  assert.equal(matches('src/gen/a.txt'), false);
  assert.equal(matches(GENERATED_PATHS_DECLARATION), false);
});

test('fail closed: reset onto an older base, unreadable patch, generated-only PR, capped list, read error', async () => {
  const same = [file('src/feature.mjs', featurePatch(10))];
  assert.equal((await prove(fakeGitHub({ reviewedFiles: same, currentFiles: same,
    currentFork: OLDER_FORK, forkStatus: 'behind' }))).reason, 'merge-base-not-forward');
  assert.equal((await prove(fakeGitHub({ reviewedFiles: same,
    currentFiles: [file('src/feature.mjs', undefined, { changes: 4 })] }))).reason, 'current-patch-patch-unavailable');
  assert.equal((await prove(fakeGitHub({
    reviewedFiles: [file('docs/catalog/index.json', fixturePatch('one'))],
    currentFiles: [file('docs/catalog/index.json', fixturePatch('two'))] }))).reason, 'own-patch-empty');
  const capped = Array.from({ length: 300 }, (_, index) => file(`src/f${index}.mjs`, '@@ -1 +1 @@\n-a\n+b'));
  assert.equal((await prove(fakeGitHub({ reviewedFiles: same, currentFiles: capped }))).reason, 'current-patch-file-list-capped');
  const broken = await proveReviewCarryForward({ repo: REPO, reviewedHead: REVIEWED, currentHead: CURRENT,
    baseRef: 'main', get: async () => { throw new Error('HTTP 502'); } });
  assert.equal(broken.reason, 'proof-read-failed');
  const declarationError = await prove({ get: async (path) => {
    if (path.includes('/contents/')) throw new Error('HTTP 500');
    return fakeGitHub({ reviewedFiles: same, currentFiles: same }).get(path);
  } });
  assert.equal(declarationError.reason, 'proof-read-failed');
});

test('watcher seam: carries only for a proven pair and never throws', withRoot(async (root) => {
  const reviewRow = { reviewer_head_sha: REVIEWED, review_status: 'posted' };
  const github = fakeGitHub({
    reviewedFiles: [file('src/feature.mjs', featurePatch(10))],
    currentFiles: [file('src/feature.mjs', featurePatch(20))],
  });
  assert.equal(await carryStalePostedReviewForward({ rootDir: root, repo: REPO, prNumber: PR, reviewRow,
    currentHead: CURRENT, baseRef: 'main', resolveSettledReview: () => CLEAN_REVIEW, get: github.get, logger: null }), true);
  assert.equal(await carryStalePostedReviewForward({ rootDir: root, repo: REPO, prNumber: PR, reviewRow,
    currentHead: 'd'.repeat(40), baseRef: 'main', resolveSettledReview: () => { throw new Error('db locked'); },
    logger: null }), false);
  // Without an injected reader, tests never reach live GitHub: no carry.
  assert.equal(await carryStalePostedReviewForward({ rootDir: root, repo: REPO, prNumber: PR, reviewRow,
    currentHead: 'e'.repeat(40), baseRef: 'main', resolveSettledReview: () => CLEAN_REVIEW, logger: null }), false);
}));

test('the gate status honours a carry-forward record for the exact pair only', () => {
  const reviewRow = { repo: REPO, pr_number: PR, review_status: 'posted', reviewer_head_sha: REVIEWED };
  const stale = pickAdversarialGateStatus({ reviewRow, headSha: CURRENT, env: {} });
  assert.equal(stale.reason, 'stale-review-head');
  const carried = pickAdversarialGateStatus({ reviewRow, headSha: CURRENT, env: {},
    reviewCarryForward: { reviewedHead: REVIEWED, currentHead: CURRENT } });
  assert.notEqual(carried.reason, 'stale-review-head');
  const otherPair = pickAdversarialGateStatus({ reviewRow, headSha: CURRENT, env: {},
    reviewCarryForward: { reviewedHead: 'c'.repeat(40), currentHead: CURRENT } });
  assert.equal(otherPair.reason, 'stale-review-head');
});

// ── Closer visibility: the real daemon clean-merge path (merge execution stubbed).

function daemonArgs(rootDir, { reviewState = {}, onAttempt }) {
  const checks = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  return {
    rootDir,
    cfg: { mergeMethod: 'squash', autonomousMergeExecutionEnabled: true, strictMode: true },
    repoPath: REPO,
    prNumber: PR,
    candidate: { baseBranch: 'main', headSha: CURRENT, statusCheckRollup: checks, mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN', prState: 'open', headRefName: 'builder/feature', labels: [] },
    gateSnapshot: { reviewedHeadSha: REVIEWED, settledReview: { verdict: 'comment-only' } },
    mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    reviewState: { headSha: REVIEWED, blockingFindingCount: 0, blockingFindingState: 'known',
      nonBlockingFindingCount: 0, nonBlockingFindingState: 'known', riskClass: 'low', ...reviewState },
    reviewStateRow: { reviewer: 'codex' },
    currentPrHeadSha: CURRENT,
    fetchRollupImpl: async () => ({ state: 'OPEN', headRefOid: CURRENT, headRefName: 'builder/feature',
      checks, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', comments: [], labels: [] }),
    fetchPrimaryChangeImpl: async ({ headSha }) => ({ headSha, hasHammerCommits: false, ciCost: { headSha, ok: true } }),
    resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: true, row: {
      launch_request_id: 'lrq_fixture', worker_class: 'codex', head_sha: CURRENT } }),
    readHeadAttestationChainForPrImpl: async () => [],
    attemptDaemonCleanMergeImpl: async (args) => {
      onAttempt(args);
      return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true, attempts: 1 };
    },
    dismissStaleRequestChangesOnResolved: false,
    logger: { warn() {}, log() {}, info() {} },
    env: { HQ_ROOT: join(rootDir, 'hq') },
  };
}

function recordCarry(rootDir) {
  return writeReviewCarryForwardRecord(rootDir, { repo: REPO, prNumber: PR, settledReview: CLEAN_REVIEW,
    proof: { proven: true, reviewedHead: REVIEWED, currentHead: CURRENT, baseRef: 'main',
      reviewedMergeBase: OLD_FORK, currentMergeBase: NEW_FORK, ownPatchDigest: 'f'.repeat(64),
      generatedPathsSource: GENERATED_PATHS_DECLARATION, excludedPatterns: ['docs/catalog/**'],
      excludedPathsChanged: ['docs/catalog/index.json'] } });
}

test('daemon clean merge: without a carry-forward record a moved head stays stale-head', withRoot(async (root) => {
  let attempted = null;
  const result = await runDaemonCleanMergeAttempt(daemonArgs(root, { onAttempt: args => { attempted = args; } }));
  assert.equal(attempted, null);
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(result.reason, 'stale-head');
}));

test('daemon clean merge: a recorded carry-forward lets the clean-merge path proceed on the live head', withRoot(async (root) => {
  assert.equal(recordCarry(root).written, true);
  let attempted = null;
  const result = await runDaemonCleanMergeAttempt(daemonArgs(root, { onAttempt: args => { attempted = args; } }));
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED, JSON.stringify(result));
  assert.equal(attempted.validatedHead, CURRENT, 'the carried review validates exactly the live head');
  assert.equal(attempted.auditMetadata.closureAuthority, 'daemon-review-carry-forward');
}));

test('daemon clean merge: an exact-head review keeps ordinary audit authority', withRoot(async (root) => {
  // A historical carry record must not relabel an exact-head clean merge.
  recordCarry(root);
  let attempted = null;
  const args = daemonArgs(root, { onAttempt: value => { attempted = value; } });
  args.gateSnapshot.reviewedHeadSha = CURRENT;
  args.reviewState.headSha = CURRENT;
  const result = await runDaemonCleanMergeAttempt(args);
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED, JSON.stringify(result));
  assert.equal(attempted.validatedHead, CURRENT);
  assert.equal(attempted.auditMetadata.closureAuthority, undefined);
}));

test('daemon clean merge: a carry-forward record never merges over a blocking finding', withRoot(async (root) => {
  recordCarry(root);
  let attempted = null;
  const result = await runDaemonCleanMergeAttempt(daemonArgs(root, {
    reviewState: { blockingFindingCount: 1 }, onAttempt: args => { attempted = args; } }));
  assert.equal(attempted, null);
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
}));
