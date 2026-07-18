import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINALIZATION_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  checksSettled,
  isFinalizationEvent,
  isRevisionScopedEvent,
  makeFinalizationEvent,
  remediationDispatched,
  resolveSubjectKey,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#42', revisionRef: 'sha-A' };
const AT = '2026-07-17T00:00:00.000Z';

test('the event vocabulary is exactly the merge-authority-v2 §2 set', () => {
  assert.deepEqual(
    [...FINALIZATION_EVENT_TYPES].sort(),
    [
      'attestation_recorded', 'budget_exhausted', 'checks_settled', 'closed', 'escalated',
      'finalized', 'halted', 'operator_override', 'remediation_concluded',
      'remediation_dispatched', 'revision_advanced', 'verdict_recorded',
    ],
  );
  assert.deepEqual([...TERMINAL_EVENT_TYPES].sort(), ['closed', 'escalated', 'finalized', 'halted']);
});

test('resolveSubjectKey accepts a SubjectRef, a SubjectState, and a bare key', () => {
  assert.deepEqual(resolveSubjectKey(REF), { domainId: 'code-pr', subjectExternalId: 'owner/repo#42' });
  assert.deepEqual(resolveSubjectKey({ ref: REF }), { domainId: 'code-pr', subjectExternalId: 'owner/repo#42' });
  assert.deepEqual(
    resolveSubjectKey({ domainId: 'x', subjectExternalId: 'y' }),
    { domainId: 'x', subjectExternalId: 'y' },
  );
  assert.throws(() => resolveSubjectKey({ domainId: 'x' }), /domainId \+ subjectExternalId/);
  assert.throws(() => resolveSubjectKey(null), /domainId \+ subjectExternalId/);
});

test('makeFinalizationEvent carries the subject key, at, and type fields', () => {
  const e = verdictRecorded(REF, {
    at: AT, revisionRef: 'sha-A', stageId: 'security', role: 'reviewer-1',
    verdictKind: 'request-changes', sourceRef: 'review-commit-A',
  });
  assert.equal(e.type, 'verdict_recorded');
  assert.deepEqual(e.subjectKey, { domainId: 'code-pr', subjectExternalId: 'owner/repo#42' });
  assert.equal(e.at, AT);
  assert.equal(e.revisionRef, 'sha-A');
  assert.equal(e.verdictKind, 'request-changes');
  assert.equal(e.sourceRef, 'review-commit-A');
  // `seq` is assigned by the store, never by the constructor.
  assert.equal('seq' in e, false);
});

test('external-fact events require their sourceRef provenance', () => {
  assert.throws(
    () => verdictRecorded(REF, { at: AT, revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved' }),
    /non-empty sourceRef/,
  );
  assert.throws(
    () => checksSettled(REF, { at: AT, revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true }),
    /non-empty sourceRef/,
  );
});

test('checks_settled requires a boolean requiredChecksPresent (false is valid)', () => {
  const e = checksSettled(REF, {
    at: AT, revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: false, sourceRef: 'suite-1',
  });
  assert.equal(e.requiredChecksPresent, false);
  assert.throws(
    () => checksSettled(REF, { at: AT, revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: 'yes', sourceRef: 's' }),
    /boolean requiredChecksPresent/,
  );
});

test('remediation events require an integer round', () => {
  const e = remediationDispatched(REF, { at: AT, revisionRef: 'sha-A', round: 2, idempotencyKey: 'k-2' });
  assert.equal(e.round, 2);
  assert.throws(
    () => remediationDispatched(REF, { at: AT, revisionRef: 'sha-A', round: 1.5, idempotencyKey: 'k' }),
    /integer round/,
  );
});

test('remediation_dispatched requires a boolean final when present', () => {
  const e = remediationDispatched(REF, {
    at: AT, revisionRef: 'sha-A', round: 2, idempotencyKey: 'k-2', final: false,
  });
  assert.equal(e.final, false);
  assert.throws(
    () => remediationDispatched(REF, {
      at: AT, revisionRef: 'sha-A', round: 2, idempotencyKey: 'k-2', final: 'true',
    }),
    /boolean final/,
  );
});

test('makeFinalizationEvent rejects an unknown type and a missing at', () => {
  assert.throws(() => makeFinalizationEvent('nope', REF, { at: AT }), /unknown finalization event type/);
  assert.throws(() => makeFinalizationEvent('halted', REF, { reason: 'x' }), /`at` ISO timestamp/);
});

test('isRevisionScopedEvent distinguishes revision- from subject-scoped events', () => {
  assert.equal(isRevisionScopedEvent('verdict_recorded'), true);
  assert.equal(isRevisionScopedEvent('finalized'), true);
  assert.equal(isRevisionScopedEvent('budget_exhausted'), false);
  assert.equal(isRevisionScopedEvent('operator_override'), false);
  assert.equal(isRevisionScopedEvent('closed'), false);
});

test('isFinalizationEvent validates round-tripped events and rejects malformed ones', () => {
  const good = remediationDispatched(REF, { at: AT, revisionRef: 'sha-A', round: 1, idempotencyKey: 'k' });
  assert.equal(isFinalizationEvent(good), true);
  assert.equal(isFinalizationEvent(null), false);
  assert.equal(isFinalizationEvent({ type: 'halted', subjectKey: { domainId: 'd', subjectExternalId: 's' } }), false);
  assert.equal(isFinalizationEvent({ type: 'unknown', subjectKey: { domainId: 'd', subjectExternalId: 's' }, at: AT }), false);
  // Missing required field (reason) for a terminal event.
  assert.equal(isFinalizationEvent({ type: 'halted', subjectKey: { domainId: 'd', subjectExternalId: 's' }, at: AT }), false);
});
