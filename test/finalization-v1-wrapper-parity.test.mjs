import assert from 'node:assert/strict';
import test from 'node:test';

import { DAEMON_MERGE_DISPOSITION, isDaemonMergeReviewAllowed } from '../src/ama/daemon-merge.mjs';
import { resolveLatestVerdict } from '../src/kernel/pipeline.mjs';
import {
  createV1AmaFinalizationPort,
  mapDaemonMergeDisposition,
  projectReviewState,
} from '../src/finalization/v1-ama-wrapper.mjs';

// ---------------------------------------------------------------------------
// The parity contract (ARC-14): the wrapper adds NO merge-authority logic. For
// each recorded `code-pr` scenario we assert three things line up:
//   1. the wrapper's projection of the subject's verdict equals the recorded
//      v1-native review state,
//   2. v1's FROZEN findings gate (`isDaemonMergeReviewAllowed`) on that state
//      agrees with whether the wrapper decides `finalize-now`, and
//   3. the wrapper emits the expected decision kind.
// Because (2) routes through the unchanged v1 predicate, a bug fix to that gate
// moves the wrapper with it — the freeze holds and behavior cannot drift.
// ---------------------------------------------------------------------------

const OBSERVED = '2026-05-10T00:00:00.000Z';

function subject(overrides = {}) {
  return {
    ref: { domainId: 'code-pr', subjectExternalId: 'pr-42', revisionRef: 'rev-A' },
    lifecycle: 'reviewed',
    currentRound: 1,
    completedRemediationRounds: 0,
    maxRemediationRounds: 3,
    terminal: false,
    observedAt: OBSERVED,
    ...overrides,
  };
}

function verdict(kind, extra = {}) {
  return { kind, body: `## Verdict\n${kind}`, ...extra };
}

// Recorded scenarios: subjectState + the v1-native review state v1 would see.
const SCENARIOS = [
  {
    name: 'approved, clean → finalize-now',
    subjectState: subject({ latestVerdict: verdict('approved') }),
    v1ReviewState: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    expectKind: 'finalize-now',
  },
  {
    name: 'comment-only, no findings → finalize-now',
    subjectState: subject({ latestVerdict: verdict('comment-only') }),
    v1ReviewState: {
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    expectKind: 'finalize-now',
  },
  {
    name: 'request-changes, budget remaining → remediate',
    subjectState: subject({
      latestVerdict: verdict('request-changes', { stageId: 'code-quality' }),
      completedRemediationRounds: 1,
      maxRemediationRounds: 3,
    }),
    v1ReviewState: {
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    expectKind: 'remediate',
    expectRound: 2,
    expectStageId: 'code-quality',
  },
  {
    name: 'request-changes, budget exhausted → remediate (exhaustion final round, lands per v2 §3)',
    subjectState: subject({
      latestVerdict: verdict('request-changes', { blockingFindings: [{ problem: 'x' }, { problem: 'y' }] }),
      completedRemediationRounds: 3,
      maxRemediationRounds: 3,
    }),
    v1ReviewState: {
      blockingFindingCount: 2,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    expectKind: 'remediate',
    expectRound: 4,
    expectReason: 'exhaustion final round',
  },
  {
    name: 'unknown verdict → wait',
    subjectState: subject({ latestVerdict: verdict('unknown') }),
    v1ReviewState: { blockingFindingState: 'unknown', nonBlockingFindingState: 'unknown' },
    expectKind: 'wait',
  },
  {
    name: 'no verdict yet → wait',
    subjectState: subject({ latestVerdict: undefined, lifecycle: 'pending-review' }),
    v1ReviewState: { blockingFindingState: 'unknown', nonBlockingFindingState: 'unknown' },
    expectKind: 'wait',
  },
];

test('projection matches the recorded v1-native review state for every scenario', () => {
  for (const { name, subjectState, v1ReviewState } of SCENARIOS) {
    const projected = projectReviewState(resolveLatestVerdict(subjectState));
    assert.deepEqual(projected, v1ReviewState, name);
  }
});

test('the frozen v1 findings gate agrees with the wrapper on finalize-now for every scenario', () => {
  const port = createV1AmaFinalizationPort({ actions: stubActions() });
  for (const scenario of SCENARIOS) {
    const v1Allows = isDaemonMergeReviewAllowed(scenario.v1ReviewState, { strictMode: true });
    const decision = port.evaluate(scenario.subjectState);
    assert.equal(
      decision.kind === 'finalize-now',
      v1Allows,
      `${scenario.name}: wrapper finalize-now must equal v1 gate (${v1Allows})`,
    );
  }
});

test('the wrapper emits the expected decision kind + fields for every scenario', () => {
  const port = createV1AmaFinalizationPort({ actions: stubActions() });
  for (const scenario of SCENARIOS) {
    const d = port.evaluate(scenario.subjectState);
    assert.equal(d.kind, scenario.expectKind, scenario.name);
    assert.equal(d.subjectRef.domainId, 'code-pr');
    assert.equal(d.revisionRef, 'rev-A');
    if (scenario.expectRound != null) assert.equal(d.round, scenario.expectRound, scenario.name);
    if (scenario.expectStageId != null) assert.equal(d.stageId, scenario.expectStageId, scenario.name);
    if (scenario.expectReason != null) assert.equal(d.reason, scenario.expectReason, scenario.name);
  }
});

test('operator halt and already-terminal are handled ahead of the findings gate', () => {
  const port = createV1AmaFinalizationPort({ actions: stubActions() });
  assert.equal(port.evaluate(subject({ lifecycle: 'halted', haltReason: 'paused' })).kind, 'halt');
  assert.equal(
    port.evaluate(subject({ terminal: true, lifecycle: 'finalized', latestVerdict: verdict('approved') })).reason,
    'already terminal',
  );
});

// ---------------------------------------------------------------------------
// projectReviewState + disposition mapping — the v1 seam surfaces directly.
// ---------------------------------------------------------------------------

test('projectReviewState treats a bare request-changes (no structured findings) as one blocker', () => {
  assert.equal(projectReviewState(verdict('request-changes')).blockingFindingCount, 1);
  assert.equal(projectReviewState(verdict('request-changes', { blockingFindings: [{}, {}, {}] })).blockingFindingCount, 3);
  assert.deepEqual(projectReviewState(null), { blockingFindingState: 'unknown', nonBlockingFindingState: 'unknown' });
});

test('mapDaemonMergeDisposition maps every frozen v1 disposition and rejects the unknown', () => {
  assert.equal(mapDaemonMergeDisposition(DAEMON_MERGE_DISPOSITION.MERGED), 'executed');
  assert.equal(mapDaemonMergeDisposition(DAEMON_MERGE_DISPOSITION.FAILED_CLOSED), 'failed');
  assert.equal(mapDaemonMergeDisposition(DAEMON_MERGE_DISPOSITION.DEFERRED), 'deferred');
  assert.equal(mapDaemonMergeDisposition(DAEMON_MERGE_DISPOSITION.NOT_TAKEN), 'skipped');
  assert.throws(() => mapDaemonMergeDisposition('mystery'), /unknown daemon-merge disposition/);
});

// ---------------------------------------------------------------------------
// execute — delegation to injected v1 entrypoints (no src/ama mutation here).
// ---------------------------------------------------------------------------

function stubActions(overrides = {}) {
  return {
    merge: () => DAEMON_MERGE_DISPOSITION.MERGED,
    remediate: () => {},
    halt: () => {},
    escalate: () => {},
    ...overrides,
  };
}

test('execute finalize-now delegates to the injected v1 merge and maps its disposition', async () => {
  for (const [disposition, status] of [
    [DAEMON_MERGE_DISPOSITION.MERGED, 'executed'],
    [DAEMON_MERGE_DISPOSITION.DEFERRED, 'deferred'],
    [DAEMON_MERGE_DISPOSITION.NOT_TAKEN, 'skipped'],
    [DAEMON_MERGE_DISPOSITION.FAILED_CLOSED, 'failed'],
  ]) {
    const calls = [];
    const port = createV1AmaFinalizationPort({
      actions: stubActions({ merge: (d) => { calls.push(d); return { disposition, detail: `v1:${disposition}` }; } }),
    });
    const decision = port.evaluate(subject({ latestVerdict: verdict('approved') }));
    const outcome = await port.execute(decision);
    assert.equal(outcome.status, status, disposition);
    assert.equal(outcome.action, 'merge');
    assert.equal(outcome.detail, `v1:${disposition}`);
    assert.equal(calls.length, 1);
  }
});

test('execute finalize-now on an already-terminal subject is idempotent and never calls v1 merge', async () => {
  const calls = [];
  const port = createV1AmaFinalizationPort({ actions: stubActions({ merge: (d) => { calls.push(d); return DAEMON_MERGE_DISPOSITION.MERGED; } }) });
  const decision = port.evaluate(subject({ terminal: true, lifecycle: 'finalized' }));
  const outcome = await port.execute(decision);
  assert.equal(outcome.status, 'skipped');
  assert.match(outcome.detail, /already terminal/);
  assert.equal(calls.length, 0);
});

test('execute remediate / halt / escalate delegate to their injected v1 actions', async () => {
  const seen = [];
  const port = createV1AmaFinalizationPort({
    actions: stubActions({
      remediate: (d) => seen.push(['remediate', d.kind]),
      halt: (d) => seen.push(['halt', d.kind]),
      escalate: (d) => seen.push(['escalate', d.kind]),
    }),
  });
  const ref = subject().ref;
  const base = { subjectRef: ref, revisionRef: 'rev-A', observedAt: OBSERVED };

  const remediateOutcome = await port.execute({ ...base, kind: 'remediate', round: 1 });
  assert.equal(remediateOutcome.status, 'executed');
  assert.equal(remediateOutcome.action, 'dispatch-remediation');

  const haltOutcome = await port.execute({ ...base, kind: 'halt', reason: 'x' });
  assert.equal(haltOutcome.action, 'halt');

  const escalateOutcome = await port.execute({ ...base, kind: 'escalate', reason: 'kill switch' });
  assert.equal(escalateOutcome.action, 'escalate');

  assert.deepEqual(seen, [['remediate', 'remediate'], ['halt', 'halt'], ['escalate', 'escalate']]);
});

test('execute wait is a no-op skip that calls no v1 action', async () => {
  let called = false;
  const port = createV1AmaFinalizationPort({ actions: stubActions({ merge: () => { called = true; return DAEMON_MERGE_DISPOSITION.MERGED; } }) });
  const outcome = await port.execute({
    kind: 'wait', subjectRef: subject().ref, revisionRef: 'rev-A', observedAt: OBSERVED, reason: 'pending',
  });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.action, 'none');
  assert.equal(called, false);
});

test('execute refuses when a required v1 action is not injected (no accidental live mutation)', async () => {
  const port = createV1AmaFinalizationPort({ actions: {} });
  const decision = port.evaluate(subject({ latestVerdict: verdict('approved') }));
  await assert.rejects(() => port.execute(decision), /missing injected action "merge"/);
});
