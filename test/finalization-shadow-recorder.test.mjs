import assert from 'node:assert/strict';
import test from 'node:test';

import {
  replayV1Trace,
  shadowObserve,
  shadowObserveFromStore,
} from '../src/finalization/shadow-recorder.mjs';
import {
  checksSettled,
  revisionAdvanced,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#612' };
const t = (n) => new Date(Date.parse('2026-07-17T00:00:00.000Z') + n * 60000).toISOString();

// A clean, green, approved head — v2 finalizes; v1 merging is concurrence.
function cleanTrace() {
  return [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }),
    verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'rev-A' }),
  ];
}

test('shadow logs the (v1 action, v2 decision) pair without acting — clean head, agree', () => {
  const obs = shadowObserve({ subject: REF, events: cleanTrace(), v1Action: 'merged', observedAt: t(3) });
  assert.equal(obs.v2Decision.kind, 'finalize-now');
  assert.equal(obs.v1Action.kind, 'merged');
  assert.equal(obs.classification.relation, 'agree');
  assert.equal(obs.subjectKey.subjectExternalId, 'owner/repo#612');
  assert.equal(obs.revisionRef, 'sha-A');
  assert.equal(obs.foldError, false);
});

test('shadow surfaces a CI-impatience divergence: v1 merged, v2 withheld (no checks yet)', () => {
  // No checks_settled at head — v2 waits on checks; v1 merged anyway.
  const events = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    verdictRecorded(REF, { at: t(1), revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'rev-A' }),
  ];
  const obs = shadowObserve({ subject: REF, events, v1Action: 'merged', observedAt: t(2) });
  assert.equal(obs.v2Decision.kind, 'wait');
  assert.match(obs.v2Decision.reason, /check/);
  assert.equal(obs.classification.relation, 'diverge');
  assert.equal(obs.classification.direction, 'v1-defect');
  assert.equal(obs.classification.class, 'ci-impatience');
});

test('shadow flags a head-move deadlock: v1 stuck waiting, v2 finalizes the clean landable head', () => {
  const events = [
    ...cleanTrace(),
    // Head moves; re-review + checks settle clean again at the new head.
    revisionAdvanced(REF, { at: t(10), revisionRef: 'sha-B', sourceRef: 'push-B' }),
    checksSettled(REF, { at: t(11), revisionRef: 'sha-B', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-B' }),
    verdictRecorded(REF, { at: t(12), revisionRef: 'sha-B', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'rev-B' }),
  ];
  const obs = shadowObserve({ subject: REF, events, v1Action: 'wait', observedAt: t(13) });
  assert.equal(obs.v2Decision.kind, 'finalize-now');
  assert.equal(obs.revisionRef, 'sha-B');
  assert.equal(obs.sawHeadMove, true);
  assert.equal(obs.classification.direction, 'v1-defect');
  assert.equal(obs.classification.class, 'ceiling-head-move-deadlock');
});

test('replay a recorded v1 trace: one observation per tick, in order', () => {
  const ticks = [
    { events: [revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A' })], v1Action: 'none', observedAt: t(1) },
    { events: cleanTrace(), v1Action: 'merged', observedAt: t(3) },
  ];
  const observations = replayV1Trace({ subject: REF, ticks });
  assert.equal(observations.length, 2);
  // Tick 1: no verdict/checks yet → v2 waits; v1 idle → concurrence.
  assert.equal(observations[0].v2Decision.kind, 'wait');
  assert.equal(observations[0].classification.relation, 'agree');
  // Tick 2: clean head → v2 finalizes; v1 merged → concurrence.
  assert.equal(observations[1].v2Decision.kind, 'finalize-now');
  assert.equal(observations[1].classification.relation, 'agree');
});

test('FAIL-CLOSED: a fold error emits escalate (never a guess), marked foldError', () => {
  // An invalid policy (consume attestations with no producer) throws inside the
  // fold; shadow must fail closed to escalate rather than guess a merge.
  const obs = shadowObserve({
    subject: REF,
    events: cleanTrace(),
    v1Action: 'merged',
    observedAt: t(3),
    policy: { consumeAttestations: true },
  });
  assert.equal(obs.v2Decision.kind, 'escalate');
  assert.equal(obs.foldError, true);
  assert.match(obs.v2Decision.reason, /fail-closed, never a guess/);
  // v1 merged while v2 could not even fold → a divergence that must be triaged.
  assert.equal(obs.classification.relation, 'diverge');
  assert.equal(obs.classification.direction, 'open');
  assert.equal(obs.classification.class, 'fold-error');
});

test('FAIL-CLOSED: an unavailable ledger emits escalate, never skips the tick', () => {
  const brokenStore = {
    read() { throw new Error('database is locked'); },
  };
  const obs = shadowObserveFromStore({ ledgerStore: brokenStore, subject: REF, v1Action: 'merged', observedAt: t(3) });
  assert.equal(obs.v2Decision.kind, 'escalate');
  assert.equal(obs.foldError, true);
  assert.match(obs.v2Decision.reason, /ledger unavailable/);
  assert.equal(obs.classification.class, 'fold-error');
});

test('shadowObserve requires an observedAt (the fold reads no clock)', () => {
  assert.throws(
    () => shadowObserve({ subject: REF, events: cleanTrace(), v1Action: 'merged' }),
    /observedAt/,
  );
});

test('an unknown v1 action kind fails loud rather than silently becoming an agree', () => {
  assert.throws(
    () => shadowObserve({ subject: REF, events: cleanTrace(), v1Action: 'merged-ish', observedAt: t(3) }),
    /unknown v1 action kind/,
  );
});
