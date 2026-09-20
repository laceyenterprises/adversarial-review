import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DUPLICATE_FAMILY_UNRESOLVED_REASON,
  evaluateDuplicateFamilyCandidate,
} from '../src/duplicate-family-gate.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';

const baseFamily = {
  status: 'advisory',
  selected_survivor_pr_number: null,
  report_path: null,
  operator_override_json: null,
};

test('candidate-scoped ignored override releases only its exact current head', () => {
  const family = {
    ...baseFamily,
    operator_override_json: JSON.stringify({
      disposition: 'ignored-not-duplicate', candidatePrNumber: 41, candidateHeadSha: 'head-41',
    }),
  };
  assert.equal(evaluateDuplicateFamilyCandidate(family, { prNumber: 41, headSha: 'head-41' }).held, false);
  assert.equal(evaluateDuplicateFamilyCandidate(family, { prNumber: 42, headSha: 'head-42' }).held, true);
  assert.equal(evaluateDuplicateFamilyCandidate(family, { prNumber: 41, headSha: 'moved' }).held, true);
});

test('selected survivor releases only after report path exists; losers and abandoned families stay held', () => {
  const selected = {
    ...baseFamily,
    selected_survivor_pr_number: 41,
    operator_override_json: JSON.stringify({ disposition: 'survivor-selected' }),
  };
  assert.equal(evaluateDuplicateFamilyCandidate(selected, { prNumber: 41, headSha: 'a' }).held, true);
  selected.report_path = 'docs/research/duplicate.md';
  assert.equal(evaluateDuplicateFamilyCandidate(selected, { prNumber: 41, headSha: 'a' }).held, false);
  assert.equal(evaluateDuplicateFamilyCandidate(selected, { prNumber: 42, headSha: 'b' }).held, true);
  assert.equal(evaluateDuplicateFamilyCandidate({ ...selected, status: 'abandoned' }, { prNumber: 41, headSha: 'a' }).held, true);
});

test('shared daemon/hammer predicate emits duplicate-family-unresolved', () => {
  const result = evaluateMergeEligibility({
    verdict: 'settled-success', requiredChecks: true, mergeable: true,
    branchProtectionRequired: false, candidateHead: 'head', validatedHead: 'head',
    leaseHeld: true, labels: ['duplicate-family-hold'],
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [DUPLICATE_FAMILY_UNRESOLVED_REASON]);
});

test('AMA operator-requested path cannot override duplicate-family hold', () => {
  const result = isEligibleForAmaClosure(
    { verdict: 'approved', headSha: 'head', riskClass: 'low', remediationPending: false,
      blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known' },
    { prNumber: 41, headSha: 'head', isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: ['duplicate-family-hold'], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [] } },
    { enabled: true, eligibility: { riskClasses: ['low'], fastMergeLabels: [] }, branchProtection: { required: false } },
  );
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes(DUPLICATE_FAMILY_UNRESOLVED_REASON));
});
