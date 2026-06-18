import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessRebaseRecovery,
  compareReviewedPatchIds,
  requiresRebaseRecovery,
} from '../src/ama/rebase-authority.mjs';

const REVIEWED_HEAD = '1111111111111111111111111111111111111111';
const REBASED_HEAD = '2222222222222222222222222222222222222222';
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'bin', 'ama-rebase-authority.mjs');

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ama-rebase-authority-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function runCli(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' }));
}

test('clean stale-head fixture rebases, proves content equivalence, and can merge new head', () => {
  const decision = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    mergeStateStatus: 'BEHIND',
    attempts: 1,
    reviewedPatchIds: ['patch-a', 'patch-b'],
    rebasedPatchIds: ['patch-b', 'patch-a'],
    reverifyEligible: true,
  });

  assert.equal(requiresRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    mergeStateStatus: 'BEHIND',
  }), true);
  assert.equal(decision.action, 'merge');
  assert.equal(decision.evidence, 'content_equivalent_rebased_head');
  assert.equal(decision.contentEquivalence.equivalent, true);
  assert.equal(decision.hardBlocker, false);
});

test('conflict-resolution divergence fixture refuses old review coverage', () => {
  const decision = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 1,
    reviewedPatchIds: ['patch-a', 'patch-b'],
    rebasedPatchIds: ['patch-a', 'patch-conflict-resolution-edit'],
    reverifyEligible: true,
  });

  assert.equal(decision.action, 'exact-head-validation-required');
  assert.equal(decision.reason, 'rebased-content-not-review-equivalent');
  assert.deepEqual(decision.contentEquivalence.dropped, ['patch-b']);
  assert.deepEqual(decision.contentEquivalence.added, ['patch-conflict-resolution-edit']);
});

test('HAM remediation fixture routes through terminal exact-head validation', () => {
  const needsValidation = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 1,
    hamRemediationCommit: true,
    hamTerminalRemediationValidated: false,
    reviewedPatchIds: ['patch-reviewed'],
    rebasedPatchIds: ['patch-reviewed', 'patch-ham-fix'],
    reverifyEligible: true,
  });
  assert.equal(needsValidation.action, 'exact-head-validation-required');
  assert.equal(needsValidation.reason, 'ham-remediation-requires-terminal-validation');

  const validated = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 1,
    hamRemediationCommit: true,
    hamTerminalRemediationValidated: true,
    reverifyEligible: true,
  });
  assert.equal(validated.action, 'merge');
  assert.equal(validated.evidence, 'ham_terminal_remediation_validated');
});

test('HAM remediation fixture blocks missing evidence and later non-HAM head via stale coverage', () => {
  const missingEvidence = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 1,
    hamRemediationCommit: true,
    hamTerminalRemediationValidated: false,
    reverifyEligible: true,
  });
  assert.equal(missingEvidence.action, 'exact-head-validation-required');

  const laterNonHam = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: '3333333333333333333333333333333333333333',
    attempts: 1,
    hamRemediationCommit: false,
    reviewedPatchIds: ['patch-reviewed', 'patch-ham-fix'],
    rebasedPatchIds: ['patch-reviewed', 'patch-ham-fix', 'patch-later-non-ham'],
    reverifyEligible: true,
  });
  assert.equal(laterNonHam.action, 'exact-head-validation-required');
  assert.equal(laterNonHam.reason, 'rebased-content-not-review-equivalent');
  assert.deepEqual(laterNonHam.contentEquivalence.added, ['patch-later-non-ham']);
});

test('rebase-attempt cap yields one hard blocker instead of a loop', () => {
  const decision = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 3,
    cap: 3,
    reviewedPatchIds: ['patch-a'],
    rebasedPatchIds: ['patch-a'],
    reverifyEligible: true,
  });

  assert.equal(decision.action, 'hard-blocker');
  assert.equal(decision.reason, 'rebase-attempt-cap-exceeded');
  assert.equal(decision.hardBlocker, true);
});

test('unresolvable conflict yields hard blocker without force-merge', () => {
  const decision = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 1,
    conflict: true,
    reviewedPatchIds: ['patch-a'],
    rebasedPatchIds: ['patch-a'],
    reverifyEligible: true,
  });

  assert.equal(decision.action, 'hard-blocker');
  assert.equal(decision.reason, 'unresolvable-rebase-conflict');
});

test('re-verification still blocks a non-settled-success verdict after rebase', () => {
  const decision = assessRebaseRecovery({
    reviewedHead: REVIEWED_HEAD,
    currentHead: REBASED_HEAD,
    attempts: 1,
    reviewedPatchIds: ['patch-a'],
    rebasedPatchIds: ['patch-a'],
    reverifyEligible: false,
    reverifyReasons: ['verdict-not-settled-success'],
  });

  assert.equal(decision.action, 'hard-blocker');
  assert.equal(decision.reason, 'post-rebase-verdict-not-settled-success');
  assert.deepEqual(decision.reverifyReasons, ['verdict-not-settled-success']);
});

test('patch-id equivalence is a multiset and detects dropped or added changes', () => {
  assert.equal(compareReviewedPatchIds([], []).equivalent, true);
  assert.equal(compareReviewedPatchIds(['a', 'b', 'b'], ['b', 'a', 'b']).equivalent, true);
  assert.deepEqual(compareReviewedPatchIds(['a', 'b'], ['a']).dropped, ['b']);
  assert.deepEqual(compareReviewedPatchIds(['a'], ['a', 'c']).added, ['c']);
});

test('ama-rebase-authority CLI reports stale/behind recovery need', () => withTempDir((root) => {
  const prPath = join(root, 'pr.json');
  const verdictPath = join(root, 'verdict.json');
  writeJson(prPath, { headRefOid: REBASED_HEAD, mergeStateStatus: 'CLEAN' });
  writeJson(verdictPath, { eligible: false, reasons: ['stale-review-head'] });

  const payload = runCli([
    'needs-recovery',
    '--pr', prPath,
    '--verdict', verdictPath,
    '--reviewed-sha', REVIEWED_HEAD,
  ]);

  assert.equal(payload.needed, true);
  assert.equal(payload.staleOnly, true);
  assert.equal(payload.currentHead, REBASED_HEAD);
}));

test('ama-rebase-authority CLI uses module patch-id equivalence decision', () => withTempDir((root) => {
  const prPath = join(root, 'pr.json');
  const verdictPath = join(root, 'verdict.json');
  const reviewedPath = join(root, 'reviewed.patchids');
  const rebasedPath = join(root, 'rebased.patchids');
  writeJson(prPath, { headRefOid: REBASED_HEAD, mergeStateStatus: 'BEHIND' });
  writeJson(verdictPath, { eligible: true, reasons: [] });
  writeFileSync(reviewedPath, 'patch-a\npatch-b\n');
  writeFileSync(rebasedPath, 'patch-a\npatch-c\n');

  const payload = runCli([
    'assess',
    '--pr', prPath,
    '--verdict', verdictPath,
    '--reviewed-sha', REVIEWED_HEAD,
    '--current-head', REBASED_HEAD,
    '--attempts', '1',
    '--cap', '3',
    '--reviewed-patchids', reviewedPath,
    '--rebased-patchids', rebasedPath,
    '--reverify-eligible', 'true',
  ]);

  assert.equal(payload.action, 'exact-head-validation-required');
  assert.equal(payload.reason, 'rebased-content-not-review-equivalent');
  assert.deepEqual(payload.contentEquivalence.dropped, ['patch-b']);
  assert.deepEqual(payload.contentEquivalence.added, ['patch-c']);
}));
