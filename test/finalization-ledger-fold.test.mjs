import assert from 'node:assert/strict';
import test from 'node:test';

import { fold, foldFrom, initialLedgerState } from '../src/finalization/ledger-fold.mjs';
import {
  attestationRecorded,
  budgetExhausted,
  checksSettled,
  closed,
  escalated,
  finalized,
  halted,
  operatorOverride,
  remediationConcluded,
  remediationDispatched,
  revisionAdvanced,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#7' };

// A tiny deterministic PRNG (mulberry32) so the property tests are reproducible
// without any Math.random / clock — the same discipline the fold itself keeps.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a plausible, well-formed random event sequence. Timestamps advance
// monotonically so `at` ordering matches append order (the store's `seq`).
function generateEvents(rand, count) {
  const events = [];
  let ms = Date.parse('2026-07-17T00:00:00.000Z');
  const at = () => {
    ms += 1000 + Math.floor(rand() * 60000);
    return new Date(ms).toISOString();
  };
  let rev = 0;
  const revRef = () => `sha-${rev}`;
  const stages = ['security', 'correctness'];
  const verdictKinds = ['approved', 'request-changes', 'comment-only', 'unknown'];
  const conclusions = ['success', 'failure', 'neutral', 'timed_out'];
  let round = 0;

  // Always start with a revision so revision-scoped events have a home.
  events.push(revisionAdvanced(REF, { at: at(), revisionRef: revRef(), sourceRef: `push-${rev}` }));

  for (let i = 0; i < count; i += 1) {
    const pick = rand();
    if (pick < 0.12) {
      rev += 1;
      events.push(revisionAdvanced(REF, { at: at(), revisionRef: revRef(), sourceRef: `push-${rev}` }));
    } else if (pick < 0.4) {
      const stageId = stages[Math.floor(rand() * stages.length)];
      events.push(verdictRecorded(REF, {
        at: at(), revisionRef: revRef(), stageId, role: `r-${Math.floor(rand() * 3)}`,
        verdictKind: verdictKinds[Math.floor(rand() * verdictKinds.length)], sourceRef: `review-${i}`,
      }));
    } else if (pick < 0.55) {
      events.push(checksSettled(REF, {
        at: at(), revisionRef: revRef(), conclusion: conclusions[Math.floor(rand() * conclusions.length)],
        requiredChecksPresent: rand() < 0.7, sourceRef: `suite-${i}`,
      }));
    } else if (pick < 0.65) {
      events.push(attestationRecorded(REF, {
        at: at(), revisionRef: revRef(), kind: 'produced', principal: 'lha-signer', sourceRef: `att-${i}`,
      }));
    } else if (pick < 0.75) {
      round += 1;
      events.push(remediationDispatched(REF, {
        at: at(), revisionRef: revRef(), round, idempotencyKey: `k-${i}`, stageId: stages[0],
      }));
    } else if (pick < 0.82) {
      events.push(remediationConcluded(REF, {
        at: at(), revisionRef: revRef(), round: Math.max(1, round), outcome: rand() < 0.5 ? 'completed' : 'blocked', stageId: stages[0],
      }));
    } else if (pick < 0.88) {
      events.push(budgetExhausted(REF, { at: at(), stageId: stages[Math.floor(rand() * stages.length)] }));
    } else if (pick < 0.94) {
      events.push(operatorOverride(REF, {
        at: at(), overrideKind: ['approve', 'resume', 'raise-cap'][Math.floor(rand() * 3)], principal: 'operator', reason: 'op',
      }));
    } else if (pick < 0.97) {
      events.push(escalated(REF, { at: at(), reason: 'fail-closed' }));
    } else {
      events.push(halted(REF, { at: at(), reason: 'needs human' }));
    }
  }
  return events;
}

test('fold is deterministic: same events fold to a deep-equal state', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const events = generateEvents(mulberry32(seed), 60);
    const a = fold(events);
    const b = fold(events);
    assert.deepEqual(a, b, `seed ${seed}: fold must be deterministic`);
  }
});

test('fold does not mutate its input events', () => {
  const events = generateEvents(mulberry32(99), 40);
  const snapshot = JSON.parse(JSON.stringify(events));
  fold(events);
  assert.deepEqual(events, snapshot, 'fold must not mutate the event list');
});

test('replay-resume equivalence: fold(all) === foldFrom(fold(prefix), rest) at every split', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const events = generateEvents(mulberry32(seed * 7 + 1), 50);
    const whole = fold(events);
    for (let split = 0; split <= events.length; split += 1) {
      const prefix = events.slice(0, split);
      const rest = events.slice(split);
      const resumed = foldFrom(fold(prefix), rest);
      assert.deepEqual(resumed, whole, `seed ${seed} split ${split}: replay-resume must equal a single fold`);
    }
  }
});

test('foldFrom never mutates the snapshot it resumes from', () => {
  const events = generateEvents(mulberry32(1234), 30);
  const snapshot = fold(events.slice(0, 15));
  const frozen = JSON.parse(JSON.stringify(snapshot));
  foldFrom(snapshot, events.slice(15));
  assert.deepEqual(snapshot, frozen, 'foldFrom must treat its snapshot as immutable');
});

test('empty fold is the initial state; unknown event types are ignored', () => {
  assert.deepEqual(fold([]), initialLedgerState());
  const withUnknown = fold([
    revisionAdvanced(REF, { at: '2026-07-17T00:00:00.000Z', revisionRef: 'sha-1' }),
    { type: 'future_event_kind', subjectKey: REF, at: '2026-07-17T00:01:00.000Z' },
  ]);
  assert.equal(withUnknown.currentRevision, 'sha-1');
  assert.equal(withUnknown.eventCount, 2);
});

test('head-move records a new current revision without resetting prior revisions', () => {
  const state = fold([
    revisionAdvanced(REF, { at: '2026-07-17T00:00:00.000Z', revisionRef: 'sha-A' }),
    verdictRecorded(REF, {
      at: '2026-07-17T00:01:00.000Z', revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'c-A',
    }),
    revisionAdvanced(REF, { at: '2026-07-17T00:02:00.000Z', revisionRef: 'sha-B' }),
  ]);
  assert.equal(state.currentRevision, 'sha-B');
  assert.equal(state.revisions['sha-A'].verdicts.length, 1, 'prior revision verdict is retained, not reset');
  assert.equal(state.revisions['sha-B'].verdicts.length, 0, 'new revision starts with no verdict');
});

test('a resuming operator override clears an escalated terminal, but not a finalized one', () => {
  const escalatedThenResumed = fold([
    revisionAdvanced(REF, { at: '2026-07-17T00:00:00.000Z', revisionRef: 'sha-A' }),
    escalated(REF, { at: '2026-07-17T00:01:00.000Z', reason: 'fold error' }),
    operatorOverride(REF, { at: '2026-07-17T00:02:00.000Z', overrideKind: 'resume', principal: 'op', reason: 'fixed' }),
  ]);
  assert.equal(escalatedThenResumed.terminal, null, 'resume clears an escalated terminal');

  const finalizedThenResumed = fold([
    revisionAdvanced(REF, { at: '2026-07-17T00:00:00.000Z', revisionRef: 'sha-A' }),
    finalized(REF, { at: '2026-07-17T00:01:00.000Z', revisionRef: 'sha-A', method: 'merge' }),
    operatorOverride(REF, { at: '2026-07-17T00:02:00.000Z', overrideKind: 'resume', principal: 'op', reason: 'noop' }),
  ]);
  assert.equal(finalizedThenResumed.terminal.kind, 'finalized', 'a finalized subject is never revived');
});

test('closed is terminal and sticky through the fold', () => {
  const state = fold([
    revisionAdvanced(REF, { at: '2026-07-17T00:00:00.000Z', revisionRef: 'sha-A' }),
    closed(REF, { at: '2026-07-17T00:01:00.000Z', reason: 'operator rejected' }),
  ]);
  assert.equal(state.terminal.kind, 'closed');
  assert.equal(state.terminal.reason, 'operator rejected');
});
