import test from 'node:test';
import assert from 'node:assert/strict';
import { isHammerRemediableEligibilityMiss } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';

test('DIRTYOWN-01: CONFLICTING pushes pr-not-mergeable and is hammer remediable', () => {
  const prMetadata = {
    isOpen: true,
    isDraft: false,
    mergeableState: 'CONFLICTING'
  };
  const result = isEligibleForAmaClosure({ verdict: 'approved' }, prMetadata, { enabled: true });
  assert.equal(result.reasons.includes('pr-not-mergeable'), true);
  
  const remediable = isHammerRemediableEligibilityMiss(['pr-not-mergeable'], {});
  assert.equal(remediable, true);
});

test('DIRTYOWN-01: UNKNOWN pushes pr-mergeability-unknown and is NOT hammer remediable', () => {
  const prMetadata = {
    isOpen: true,
    isDraft: false,
    mergeableState: 'UNKNOWN'
  };
  const result = isEligibleForAmaClosure({ verdict: 'approved' }, prMetadata, { enabled: true });
  assert.equal(result.reasons.includes('pr-mergeability-unknown'), true);
  assert.equal(result.reasons.includes('pr-not-mergeable'), false);

  const remediable = isHammerRemediableEligibilityMiss(['pr-mergeability-unknown'], {});
  assert.equal(remediable, false);
});

test('DIRTYOWN-01: daemon clean path refuses UNKNOWN and CONFLICTING', () => {
  const stateUnknown = { mergeable: 'UNKNOWN' };
  const evalUnknown = evaluateMergeEligibility(stateUnknown);
  assert.equal(evalUnknown.reasons.includes('pr-mergeability-unknown'), true);
  assert.equal(evalUnknown.eligible, false);

  const stateConflicting = { mergeable: 'CONFLICTING' };
  const evalConflicting = evaluateMergeEligibility(stateConflicting);
  assert.equal(evalConflicting.reasons.includes('pr-not-mergeable'), true);
  assert.equal(evalConflicting.eligible, false);
});

test('DIRTYOWN-01: a closed PR is pr-not-mergeable even while GitHub reports UNKNOWN', () => {
  const result = evaluateMergeEligibility({ mergeable: 'UNKNOWN', prState: 'CLOSED' });
  assert.equal(result.reasons.includes('pr-not-mergeable'), true);
  assert.equal(result.reasons.includes('pr-mergeability-unknown'), false);
});
