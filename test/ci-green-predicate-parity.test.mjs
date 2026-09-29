import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCheckRollup, summarizeChecksConclusion } from '../src/checks-summary.mjs';
import { __testables__ as eligibilityTestables } from '../src/ama/eligibility.mjs';
import { evaluateMergeEligibility, __testables__ } from '../src/ama/merge-eligibility.mjs';

// CIDEDUPE-01 — the AMA closer and the merge daemon decide "CI green" with one
// predicate. SEV3 2026-09-28 (agent-os#7314): `release-freeze-gate` ran twice on
// one head; its concurrency group cancelled the first run and the second passed.
// The closer (latest run per check) read green and routed the PR to the daemon;
// the daemon (every run) read the cancelled run as red and refused, silently,
// every tick.

const { requiredChecksGreen } = __testables__;
const { classifyCiGreen } = eligibilityTestables;
const ENV = {};

function closerGreen(rollup, requiredCheckContexts = []) {
  return summarizeChecksConclusion(rollup, { env: ENV, cfg: { requiredCheckContexts } }) === 'SUCCESS';
}

function daemonGreen(rollup, requiredCheckContexts = []) {
  return requiredChecksGreen(rollup, requiredCheckContexts);
}

// `gh pr view --json statusCheckRollup` shape (the watcher candidate snapshot the
// closer reads).
function ghRun(name, conclusion, startedAt, completedAt, status = 'COMPLETED') {
  return { __typename: 'CheckRun', name, status, conclusion, startedAt, completedAt, workflowName: name };
}

// `fetchPullRequestRollup` normalized `checks` shape (the live read the daemon
// uses): `{ name, conclusion, completedAt }`, a pending run carrying its status
// in `conclusion` and no completion time.
function liveRun(name, conclusion, completedAt) {
  return { name, conclusion, completedAt };
}

// The exact #7314 check set, in both shapes.
const INCIDENT_GH = [
  ghRun('release-freeze-gate', 'CANCELLED', '2026-09-28T23:27:48Z', '2026-09-28T23:27:56Z'),
  ghRun('release-freeze-gate', 'SUCCESS', '2026-09-28T23:27:59Z', '2026-09-28T23:28:12Z'),
  ghRun('repo-guards', 'SUCCESS', '2026-09-28T23:27:40Z', '2026-09-28T23:28:30Z'),
];
const INCIDENT_LIVE = [
  liveRun('release-freeze-gate', 'CANCELLED', '2026-09-28T23:27:56Z'),
  liveRun('release-freeze-gate', 'SUCCESS', '2026-09-28T23:28:12Z'),
  liveRun('repo-guards', 'SUCCESS', '2026-09-28T23:28:30Z'),
];

test('cancelled then success of the same check is green in both predicates', () => {
  for (const [shape, rollup] of [['gh', INCIDENT_GH], ['live', INCIDENT_LIVE]]) {
    assert.equal(closerGreen(rollup), true, `closer reads the ${shape} incident rollup as green`);
    assert.equal(daemonGreen(rollup), true, `daemon reads the ${shape} incident rollup as green`);
  }
  // The daemon's full merge predicate no longer reports ci-not-green for it.
  const eligibility = evaluateMergeEligibility({
    verdict: 'settled-success',
    requiredChecks: INCIDENT_LIVE,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    prState: 'OPEN',
    branchProtectionRequired: false,
    candidateHead: 'abc',
    validatedHead: 'abc',
    leaseHeld: true,
    labels: [],
  });
  assert.deepEqual(eligibility, { eligible: true, reasons: [] });
  // And the closer's eligibility classifier agrees.
  assert.deepEqual(
    classifyCiGreen({ statusCheckRollup: INCIDENT_GH }, ENV),
    { green: true, conclusion: 'SUCCESS' },
  );
});

test('order in the rollup does not matter; the latest run by time wins', () => {
  const reversed = [...INCIDENT_LIVE].reverse();
  assert.equal(closerGreen(reversed), true);
  assert.equal(daemonGreen(reversed), true);
});

test('success then cancelled of the same check is not green in either predicate', () => {
  const gh = [
    ghRun('release-freeze-gate', 'SUCCESS', '2026-09-28T23:27:48Z', '2026-09-28T23:27:56Z'),
    ghRun('release-freeze-gate', 'CANCELLED', '2026-09-28T23:27:59Z', '2026-09-28T23:28:12Z'),
    ghRun('repo-guards', 'SUCCESS', '2026-09-28T23:27:40Z', '2026-09-28T23:28:30Z'),
  ];
  const live = [
    liveRun('release-freeze-gate', 'SUCCESS', '2026-09-28T23:27:56Z'),
    liveRun('release-freeze-gate', 'CANCELLED', '2026-09-28T23:28:12Z'),
    liveRun('repo-guards', 'SUCCESS', '2026-09-28T23:28:30Z'),
  ];
  for (const rollup of [gh, live]) {
    assert.equal(closerGreen(rollup), false);
    assert.equal(daemonGreen(rollup), false);
    assert.equal(classifyCheckRollup(rollup), 'CANCELLED');
  }
});

test('a pending latest run is not green, even over an earlier success', () => {
  // gh shape: the re-run has started (startedAt) but not finished.
  const ghRerun = [
    ghRun('ci', 'SUCCESS', '2026-09-28T23:00:00Z', '2026-09-28T23:05:00Z'),
    ghRun('ci', '', '2026-09-28T23:10:00Z', null, 'IN_PROGRESS'),
  ];
  // live shape: a pending run has no completedAt, so it is kept alongside.
  const liveRerun = [
    liveRun('ci', 'CANCELLED', '2026-09-28T23:05:00Z'),
    liveRun('ci', 'IN_PROGRESS', null),
  ];
  for (const rollup of [ghRerun, liveRerun]) {
    assert.equal(closerGreen(rollup), false);
    assert.equal(daemonGreen(rollup), false);
  }
  assert.equal(classifyCheckRollup(ghRerun), 'PENDING');
});

test('fail-closed rules survive the de-duplication', () => {
  // Empty and missing rollups are unknown, never green.
  for (const rollup of [[], undefined, null, {}]) {
    assert.equal(closerGreen(rollup), false);
    assert.equal(daemonGreen(rollup), false);
  }
  // A required context that never reported is not green, even when every
  // reported check (including a de-duplicated one) is green.
  assert.equal(closerGreen(INCIDENT_LIVE, ['release-freeze-gate', 'shellcheck']), false);
  assert.equal(daemonGreen(INCIDENT_LIVE, ['release-freeze-gate', 'shellcheck']), false);
  assert.equal(closerGreen(INCIDENT_LIVE, ['release-freeze-gate', 'repo-guards']), true);
  assert.equal(daemonGreen(INCIDENT_LIVE, ['release-freeze-gate', 'repo-guards']), true);
  // Required contexts configured, nothing reported yet → PENDING, not green.
  assert.equal(classifyCheckRollup([], { requiredContexts: ['ci'] }), 'PENDING');
  // A check-run whose status never reached COMPLETED is pending whatever its
  // conclusion field says.
  const contradictory = [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: 'SUCCESS' }];
  assert.equal(closerGreen(contradictory), false);
  assert.equal(daemonGreen(contradictory), false);
  // A StatusContext reports through `state`.
  const statusCtx = [{ __typename: 'StatusContext', context: 'ci/legacy', state: 'PENDING', conclusion: 'SUCCESS' }];
  assert.equal(closerGreen(statusCtx), false);
  assert.equal(daemonGreen(statusCtx), false);
});

test('the closer and the daemon agree on every rollup in the table', () => {
  const t = (minute) => `2026-09-28T23:${String(minute).padStart(2, '0')}:00Z`;
  const table = [
    INCIDENT_GH,
    INCIDENT_LIVE,
    [liveRun('a', 'SUCCESS', t(1)), liveRun('b', 'NEUTRAL', t(2)), liveRun('c', 'SKIPPED', t(3))],
    [liveRun('a', 'FAILURE', t(1)), liveRun('a', 'SUCCESS', t(2))],
    [liveRun('a', 'SUCCESS', t(1)), liveRun('a', 'FAILURE', t(2))],
    [liveRun('a', 'TIMED_OUT', t(1))],
    [liveRun('a', 'SUCCESS', t(1)), liveRun('b', 'QUEUED', null)],
    [{ name: 'a' }],
    [{ __typename: 'StatusContext', context: 'ci/x', state: 'SUCCESS', startedAt: t(1) }],
    [{ __typename: 'StatusContext', context: 'ci/x', state: 'ERROR', startedAt: t(1) }],
    [ghRun('a', null, t(1), t(2))],
  ];
  for (const [i, rollup] of table.entries()) {
    for (const required of [[], ['a'], ['a', 'b']]) {
      assert.equal(
        daemonGreen(rollup, required),
        closerGreen(rollup, required),
        `row ${i} required=${JSON.stringify(required)}: the two predicates disagree`,
      );
    }
  }
});
