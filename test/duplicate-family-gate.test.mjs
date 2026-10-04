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
  content_evidence_json: JSON.stringify({ pairs: [{ corroborated: true, members: [{ prNumber: 41, headSha: 'a' }] }] }),
  selected_survivor_pr_number: null,
  report_path: null,
  operator_override_json: null,
};

test('inactive and resolved families release the duplicate-family hold', () => {
  assert.equal(evaluateDuplicateFamilyCandidate(baseFamily, { prNumber: 41, headSha: 'a' }).held, true);
  assert.equal(evaluateDuplicateFamilyCandidate({ ...baseFamily, status: 'inactive' }, { prNumber: 41, headSha: 'a' }).held, false);
  assert.equal(evaluateDuplicateFamilyCandidate({ ...baseFamily, status: 'resolved' }, { prNumber: 41, headSha: 'a' }).held, false);
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

test('identity-only and legacy evidence never impose a duplicate hold', () => {
  const result = evaluateDuplicateFamilyCandidate({ status: 'advisory', strongest_signal: 'branch-ticket' }, { prNumber: 41, headSha: 'a' });
  assert.equal(result.member, true);
  assert.equal(result.held, false);
  assert.equal(result.reason, null);
  assert.equal(result.release, 'identity-only-advisory');
});
