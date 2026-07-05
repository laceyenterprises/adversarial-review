import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateMergeEligibility,
  ELIGIBLE_MERGE_VERDICTS,
  MERGE_ELIGIBILITY_REASONS,
  __testables__,
} from '../src/ama/merge-eligibility.mjs';

const HEAD = 'd1c064df0f16dff999adeb51484fcd0a8a0747b6';

// A fully-eligible snapshot: settled-success verdict, two green check-runs, an
// open MERGEABLE / non-BEHIND PR, matching heads, lease held. Every table case
// below starts from this and knocks out exactly one precondition.
function eligibleState(overrides = {}) {
  return {
    verdict: 'settled-success',
    requiredChecks: [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    prState: 'OPEN',
    candidateHead: HEAD,
    validatedHead: HEAD,
    leaseHeld: true,
    ...overrides,
  };
}

test('fully-eligible input → { eligible: true, reasons: [] }', () => {
  assert.deepEqual(evaluateMergeEligibility(eligibleState()), {
    eligible: true,
    reasons: [],
  });
});

test('#3123 reason set (settled-success + green + mergeable + head-match) → eligible', () => {
  // The canonical "everything the merge daemon cares about is satisfied" row.
  const result = evaluateMergeEligibility(eligibleState());
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test('ham_terminal_remediation_validated verdict is also eligible', () => {
  const result = evaluateMergeEligibility(
    eligibleState({ verdict: 'ham_terminal_remediation_validated' }),
  );
  assert.deepEqual(result, { eligible: true, reasons: [] });
});

// Table-driven: each single missing precondition → exactly the expected reason.
const SINGLE_MISS_CASES = [
  {
    name: 'ineligible verdict → verdict-not-eligible',
    overrides: { verdict: 'request-changes' },
    reason: 'verdict-not-eligible',
  },
  {
    name: 'empty verdict → verdict-not-eligible',
    overrides: { verdict: '' },
    reason: 'verdict-not-eligible',
  },
  {
    name: 'a failing required check → ci-not-green',
    overrides: {
      requiredChecks: [
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    },
    reason: 'ci-not-green',
  },
  {
    name: 'a pending required check → ci-not-green',
    overrides: {
      requiredChecks: [
        { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null },
      ],
    },
    reason: 'ci-not-green',
  },
  {
    name: 'no required checks reported → ci-not-green (fail closed)',
    overrides: { requiredChecks: [] },
    reason: 'ci-not-green',
  },
  {
    name: 'a red StatusContext → ci-not-green',
    overrides: {
      requiredChecks: [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' }],
    },
    reason: 'ci-not-green',
  },
  {
    name: 'CONFLICTING mergeable → pr-not-mergeable',
    overrides: { mergeable: 'CONFLICTING' },
    reason: 'pr-not-mergeable',
  },
  {
    name: 'BEHIND mergeStateStatus → pr-not-mergeable',
    overrides: { mergeStateStatus: 'BEHIND' },
    reason: 'pr-not-mergeable',
  },
  {
    name: 'closed PR → pr-not-mergeable',
    overrides: { prState: 'MERGED' },
    reason: 'pr-not-mergeable',
  },
  {
    name: 'candidate head drifted off validated head → stale-head',
    overrides: { candidateHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    reason: 'stale-head',
  },
  {
    name: 'missing validated head → stale-head (fail closed)',
    overrides: { validatedHead: '' },
    reason: 'stale-head',
  },
  {
    name: 'lease not held → lease-not-held',
    overrides: { leaseHeld: false },
    reason: 'lease-not-held',
  },
  {
    name: 'lease flag missing → lease-not-held',
    overrides: { leaseHeld: undefined },
    reason: 'lease-not-held',
  },
];

for (const { name, overrides, reason } of SINGLE_MISS_CASES) {
  test(`single miss: ${name}`, () => {
    const result = evaluateMergeEligibility(eligibleState(overrides));
    assert.equal(result.eligible, false, `${name} should be ineligible`);
    assert.deepEqual(
      result.reasons,
      [reason],
      `${name} should produce exactly [${reason}]`,
    );
  });
}

test('reasons are emitted in the stable documented order', () => {
  // Knock out every precondition at once; the reasons must appear in exactly
  // MERGE_ELIGIBILITY_REASONS order regardless of how the state is built.
  const result = evaluateMergeEligibility({
    verdict: 'request-changes',
    requiredChecks: [],
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'BEHIND',
    prState: 'CLOSED',
    candidateHead: 'aaaa',
    validatedHead: 'bbbb',
    leaseHeld: false,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [...MERGE_ELIGIBILITY_REASONS]);
});

test('empty/no state → every reason, fail closed', () => {
  const result = evaluateMergeEligibility();
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, [...MERGE_ELIGIBILITY_REASONS]);
});

test('requiredChecks accepts a pre-derived boolean', () => {
  assert.equal(
    evaluateMergeEligibility(eligibleState({ requiredChecks: true })).eligible,
    true,
  );
  assert.deepEqual(
    evaluateMergeEligibility(eligibleState({ requiredChecks: false })).reasons,
    ['ci-not-green'],
  );
});

test('mergeable accepts a boolean', () => {
  assert.equal(evaluateMergeEligibility(eligibleState({ mergeable: true })).eligible, true);
  assert.deepEqual(
    evaluateMergeEligibility(eligibleState({ mergeable: false })).reasons,
    ['pr-not-mergeable'],
  );
});

test('omitted prState skips the open check (mergeable flag alone governs)', () => {
  const result = evaluateMergeEligibility(eligibleState({ prState: undefined }));
  assert.equal(result.eligible, true);
});

test('a missing mergeStateStatus does not block when MERGEABLE', () => {
  const result = evaluateMergeEligibility(eligibleState({ mergeStateStatus: undefined }));
  assert.equal(result.eligible, true);
});

test('verdict comparison is case/space-insensitive', () => {
  assert.equal(
    evaluateMergeEligibility(eligibleState({ verdict: '  Settled-Success  ' })).eligible,
    true,
  );
});

// The predicate must be pure: no network call, no local CI run, no clock, no
// randomness. We assert by construction — patch every global side-effect channel
// to throw, and confirm the predicate still returns from the passed state alone.
test('performs NO I/O, NO CI run, NO clock, NO randomness — reads only state', () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  const originalNow = Date.now;
  globalThis.fetch = () => { throw new Error('predicate must not perform network I/O'); };
  Math.random = () => { throw new Error('predicate must not use randomness'); };
  Date.now = () => { throw new Error('predicate must not read the clock'); };
  try {
    const eligible = evaluateMergeEligibility(eligibleState());
    assert.deepEqual(eligible, { eligible: true, reasons: [] });
    const ineligible = evaluateMergeEligibility(eligibleState({ leaseHeld: false }));
    assert.deepEqual(ineligible.reasons, ['lease-not-held']);
  } finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
    Date.now = originalNow;
  }
});

test('does not mutate the passed state object', () => {
  const state = eligibleState();
  const snapshot = JSON.parse(JSON.stringify(state));
  evaluateMergeEligibility(state);
  assert.deepEqual(state, snapshot);
});

test('exported vocabulary is stable and frozen', () => {
  assert.ok(ELIGIBLE_MERGE_VERDICTS.includes('settled-success'));
  assert.ok(ELIGIBLE_MERGE_VERDICTS.includes('ham_terminal_remediation_validated'));
  // A frozen Set is still mutable via .add(); a frozen array truly is not (blocking finding #509).
  assert.throws(() => ELIGIBLE_MERGE_VERDICTS.push('request-changes'));
  assert.deepEqual(MERGE_ELIGIBILITY_REASONS, [
    'verdict-not-eligible',
    'ci-not-green',
    'pr-not-mergeable',
    'stale-head',
    'lease-not-held',
  ]);
  assert.throws(() => MERGE_ELIGIBILITY_REASONS.push('nope'));
});

// The hammer inline gate (MSM-01) required at least one check AND all green;
// the extracted classifier must reproduce that exactly.
test('classifier mirrors the hammer inline check rules', () => {
  const { requiredChecksGreen } = __testables__;
  assert.equal(requiredChecksGreen([]), false, 'empty rollup is not green');
  assert.equal(
    requiredChecksGreen([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' }]),
    true,
    'NEUTRAL conclusion counts as green',
  );
  assert.equal(
    requiredChecksGreen([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }]),
    true,
    'SKIPPED conclusion counts as green',
  );
  assert.equal(
    requiredChecksGreen([{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null }]),
    false,
    'a non-COMPLETED check-run is not green',
  );
  assert.equal(
    requiredChecksGreen([{ __typename: 'StatusContext', state: 'SUCCESS' }]),
    true,
    'a SUCCESS StatusContext is green',
  );
});
