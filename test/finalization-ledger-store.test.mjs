import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { openFinalizationLedgerStore, rowToEvent } from '../src/finalization/ledger-store.mjs';
import { fold } from '../src/finalization/ledger-fold.mjs';
import { eligible } from '../src/finalization/eligibility.mjs';
import {
  checksSettled,
  finalized,
  remediationDispatched,
  revisionAdvanced,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#7' };
const OTHER = { domainId: 'code-pr', subjectExternalId: 'owner/repo#8' };
const t = (n) => new Date(Date.parse('2026-07-17T00:00:00.000Z') + n * 60000).toISOString();

function memStore() {
  return openFinalizationLedgerStore({ db: new Database(':memory:') });
}

test('append assigns a monotonic seq and read returns events in append order', () => {
  const store = memStore();
  store.append(revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }));
  store.append(checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }));
  store.append(verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'rev-A' }));

  const events = store.read(REF);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ['revision_advanced', 'checks_settled', 'verdict_recorded']);
  assert.ok(events[0].seq < events[1].seq && events[1].seq < events[2].seq, 'seq is strictly increasing');
  store.close();
});

test('a full field set round-trips through the store faithfully', () => {
  const store = memStore();
  const original = verdictRecorded(REF, {
    at: t(2), revisionRef: 'sha-A', stageId: 'security', role: 'reviewer-1', verdictKind: 'request-changes', sourceRef: 'rev-commit-A',
  });
  store.append(original);
  const [read] = store.read(REF);
  const { seq, ...withoutSeq } = read;
  assert.deepEqual(withoutSeq, original, 'every field survives the DB round-trip');
  assert.equal(typeof seq, 'number');
  store.close();
});

test('append is idempotent on idempotencyKey — a replayed dispatch does not double-append', () => {
  const store = memStore();
  const dispatch = remediationDispatched(REF, { at: t(4), revisionRef: 'sha-A', round: 1, idempotencyKey: 'final-1', stageId: 's' });
  const first = store.append(dispatch);
  const second = store.append(dispatch); // replay with same key

  const events = store.read(REF);
  assert.equal(events.length, 1, 'the replayed dispatch is not stored twice');
  assert.equal(first.seq, second.seq, 'the replay returns the already-stored row');
  store.close();
});

test('the ledger is per-subject: reads never cross subject keys', () => {
  const store = memStore();
  store.append(revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A' }));
  store.append(revisionAdvanced(OTHER, { at: t(0), revisionRef: 'sha-Z' }));
  assert.equal(store.read(REF).length, 1);
  assert.equal(store.read(REF)[0].revisionRef, 'sha-A');
  assert.equal(store.read(OTHER)[0].revisionRef, 'sha-Z');
  store.close();
});

test('read → fold → eligible works end to end from persisted rows', () => {
  const store = memStore();
  store.append(revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }));
  store.append(checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }));
  store.append(verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'rev-A' }));

  const decision = eligible(fold(store.read(REF)), undefined, { observedAt: t(3) });
  assert.equal(decision.kind, 'finalize-now');
  store.close();
});

test('rowToEvent reconstructs a validated event from a raw row', () => {
  const event = rowToEvent({
    seq: 12,
    domain_id: 'code-pr',
    subject_external_id: 'owner/repo#7',
    event_type: 'finalized',
    revision_ref: 'sha-A',
    at: t(9),
    source_ref: null,
    idempotency_key: null,
    payload_json: JSON.stringify({ method: 'merge' }),
  });
  assert.equal(event.type, 'finalized');
  assert.equal(event.method, 'merge');
  assert.equal(event.revisionRef, 'sha-A');
  assert.equal(event.seq, 12);
});

test('append re-validates at the write boundary and rejects a malformed event', () => {
  const store = memStore();
  assert.throws(
    () => store.append({ type: 'halted', subjectKey: REF, at: t(0) }), // missing reason
    /non-empty reason/,
  );
  assert.equal(store.read(REF).length, 0, 'nothing malformed lands in the ledger');
  store.close();
});

test('a finalized subject folds to a terminal finalize-now decision from the store', () => {
  const store = memStore();
  store.append(revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A' }));
  store.append(finalized(REF, { at: t(1), revisionRef: 'sha-A', method: 'merge' }));
  const decision = eligible(fold(store.read(REF)), undefined, { observedAt: t(2) });
  assert.equal(decision.kind, 'finalize-now');
  assert.match(decision.reason, /already finalized/);
  store.close();
});
