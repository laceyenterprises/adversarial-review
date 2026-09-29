import test from 'node:test';
import assert from 'node:assert/strict';
import { isHammerRemediableEligibilityMiss } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { closureGateMergeability } from '../src/github-mergeability.mjs';

const HEAD = 'a'.repeat(40);

// Otherwise fully eligible, so the mergeability gate is the only possible miss.
function eligibleState(overrides = {}) {
  return {
    verdict: 'settled-success',
    requiredChecks: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    prState: 'OPEN',
    branchProtectionRequired: true,
    requiredGateContext: 'agent-os/adversarial-gate',
    branchProtectionRequiredContexts: ['agent-os/adversarial-gate'],
    candidateHead: HEAD,
    validatedHead: HEAD,
    leaseHeld: true,
    labels: [],
    ...overrides,
  };
}

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

test('DIRTYOWN-01: daemon clean path refuses UNKNOWN and CONFLICTING with exact reasons', () => {
  assert.deepEqual(evaluateMergeEligibility(eligibleState({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })), {
    eligible: false,
    reasons: ['pr-mergeability-unknown'],
  });
  assert.deepEqual(evaluateMergeEligibility(eligibleState({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })), {
    eligible: false,
    reasons: ['pr-not-mergeable'],
  });
});

test('DIRTYOWN-01: a closed PR is pr-not-mergeable even while GitHub reports UNKNOWN', () => {
  assert.deepEqual(evaluateMergeEligibility(eligibleState({ mergeable: 'UNKNOWN', prState: 'CLOSED' })).reasons, [
    'pr-not-mergeable',
  ]);
});

test('DIRTYOWN-01: closer and daemon classify a raw UNKNOWN the same way', () => {
  for (const mergeStateStatus of ['CLEAN', 'UNKNOWN', '']) {
    const read = { mergeable: 'UNKNOWN', mergeStateStatus };
    assert.equal(closureGateMergeability(read), 'UNKNOWN', `closer: UNKNOWN+${mergeStateStatus || 'empty'}`);
    assert.deepEqual(
      evaluateMergeEligibility(eligibleState(read)).reasons,
      ['pr-mergeability-unknown'],
      `daemon: UNKNOWN+${mergeStateStatus || 'empty'}`,
    );
    const closer = isEligibleForAmaClosure(
      { verdict: 'approved' },
      { isOpen: true, isDraft: false, mergeableState: closureGateMergeability(read) },
      { enabled: true },
    );
    assert.equal(closer.reasons.includes('pr-mergeability-unknown'), true);
    assert.equal(closer.reasons.includes('pr-not-mergeable'), false);
  }
  // Resolved reads are unchanged from the watcher's normalization.
  assert.equal(closureGateMergeability({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }), 'MERGEABLE');
  assert.equal(closureGateMergeability({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), 'CONFLICTING');
  assert.equal(closureGateMergeability({ mergeable: '', mergeStateStatus: 'CLEAN' }), 'MERGEABLE');
});
