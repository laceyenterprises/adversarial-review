import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINALIZATION_ACTION_STATUSES,
  FINALIZATION_DECISION_KINDS,
  escalate,
  finalizeNow,
  halt,
  isFinalizationDecision,
  makeDecision,
  makeOutcome,
  remediate,
  wait,
} from '../src/finalization/finalization-port.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'pr-1', revisionRef: 'rev-A' };
const OBSERVED = '2026-05-10T00:00:00.000Z';

test('the decision vocabulary is exactly the five autonomous kinds (no close)', () => {
  assert.deepEqual(
    [...FINALIZATION_DECISION_KINDS].sort(),
    ['escalate', 'finalize-now', 'halt', 'remediate', 'wait'],
  );
  assert.equal(FINALIZATION_DECISION_KINDS.includes('close'), false);
  assert.deepEqual(
    [...FINALIZATION_ACTION_STATUSES].sort(),
    ['deferred', 'executed', 'failed', 'skipped'],
  );
});

test('makeDecision carries provenance and copies kind-specific fields', () => {
  const d = makeDecision('remediate', { ref: REF }, {
    observedAt: OBSERVED,
    stageId: 'security',
    round: 2,
    reason: 'blocking finding',
  });
  assert.equal(d.kind, 'remediate');
  assert.equal(d.subjectRef, REF);
  assert.equal(d.revisionRef, 'rev-A');
  assert.equal(d.stageId, 'security');
  assert.equal(d.round, 2);
  assert.equal(d.reason, 'blocking finding');
  assert.equal(d.observedAt, OBSERVED);
  // Absent optional fields are omitted, not set to undefined.
  assert.equal('deadline' in d, false);
});

test('makeDecision accepts a bare SubjectRef and a SubjectState alike', () => {
  const fromRef = makeDecision('finalize-now', REF, { observedAt: OBSERVED });
  const fromState = makeDecision('finalize-now', { ref: REF }, { observedAt: OBSERVED });
  assert.equal(fromRef.subjectRef, REF);
  assert.equal(fromState.subjectRef, REF);
});

test('makeDecision rejects an unknown kind, a missing timestamp, and a bad ref', () => {
  assert.throws(() => makeDecision('close', REF, { observedAt: OBSERVED }), /unknown finalization decision kind/);
  assert.throws(() => makeDecision('wait', REF, {}), /observedAt/);
  assert.throws(() => makeDecision('wait', {}, { observedAt: OBSERVED }), /SubjectRef/);
});

test('per-kind constructors forward to makeDecision', () => {
  assert.equal(finalizeNow(REF, { observedAt: OBSERVED }).kind, 'finalize-now');
  assert.equal(remediate(REF, { observedAt: OBSERVED }).kind, 'remediate');
  assert.equal(wait(REF, { observedAt: OBSERVED, deadline: OBSERVED }).kind, 'wait');
  assert.equal(halt(REF, { observedAt: OBSERVED }).kind, 'halt');
  assert.equal(escalate(REF, { observedAt: OBSERVED }).kind, 'escalate');
});

test('makeOutcome validates status and action', () => {
  const d = finalizeNow(REF, { observedAt: OBSERVED });
  const o = makeOutcome(d, { status: 'executed', action: 'merge', observedAt: OBSERVED, detail: 'merged rev-A' });
  assert.equal(o.decision, d);
  assert.equal(o.status, 'executed');
  assert.equal(o.action, 'merge');
  assert.equal(o.detail, 'merged rev-A');
  assert.throws(() => makeOutcome(d, { status: 'nope', action: 'merge', observedAt: OBSERVED }), /action status/);
  assert.throws(() => makeOutcome(d, { status: 'executed', action: '', observedAt: OBSERVED }), /action/);
  assert.throws(() => makeOutcome(d, { status: 'executed', action: 'merge' }), /observedAt/);
});

test('isFinalizationDecision accepts well-formed decisions and rejects malformed ones', () => {
  assert.equal(isFinalizationDecision(finalizeNow(REF, { observedAt: OBSERVED })), true);
  assert.equal(isFinalizationDecision(null), false);
  assert.equal(isFinalizationDecision({ kind: 'close', subjectRef: REF, revisionRef: 'r', observedAt: OBSERVED }), false);
  assert.equal(isFinalizationDecision({ kind: 'wait', revisionRef: 'r', observedAt: OBSERVED }), false);
  assert.equal(isFinalizationDecision({ kind: 'wait', subjectRef: REF, revisionRef: 'r' }), false);
});
