import assert from 'node:assert/strict';
import test from 'node:test';

import { fold } from '../src/finalization/ledger-fold.mjs';
import {
  DEFAULT_ELIGIBILITY_POLICY,
  ELIGIBILITY_DECISION_KINDS,
  eligible,
  normalizePolicy,
  validateEligibilityPolicy,
} from '../src/finalization/eligibility.mjs';
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
const t = (n) => new Date(Date.parse('2026-07-17T00:00:00.000Z') + n * 60000).toISOString();

// A subject at rev sha-A with an approved verdict + green checks — the clean,
// finalize-eligible baseline the individual tests perturb.
function cleanLedger(overrides = {}) {
  const {
    verdictKind = 'approved',
    conclusion = 'success',
    requiredChecksPresent = true,
  } = overrides;
  return [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion, requiredChecksPresent, sourceRef: 'suite-A' }),
    verdictRecorded(REF, {
      at: t(2), revisionRef: 'sha-A', stageId: 'security', role: 'reviewer-1', verdictKind, sourceRef: 'review-A',
    }),
  ];
}

function decide(events, policy, options) {
  return eligible(fold(events), policy, options);
}

test('the decision vocabulary is the full §3 set including close', () => {
  assert.deepEqual(
    [...ELIGIBILITY_DECISION_KINDS].sort(),
    ['close', 'escalate', 'finalize-now', 'halt', 'remediate', 'wait'],
  );
});

test('normalizePolicy applies defaults and freezes the result', () => {
  const p = normalizePolicy();
  assert.equal(p.strictMode, true);
  assert.equal(p.exhaustionAlwaysCloses, true);
  assert.equal(p.consumeAttestations, false);
  assert.equal(Object.isFrozen(p), true);
  assert.deepEqual(DEFAULT_ELIGIBILITY_POLICY.attestationProducers, []);
});

test('consume_attestations without a producer is a config-validation error at load', () => {
  assert.throws(() => normalizePolicy({ consumeAttestations: true }), /no attestation producer is configured/);
  assert.throws(() => validateEligibilityPolicy({ consumeAttestations: true, attestationProducers: [] }), /no attestation producer/);
  // With a producer it is valid.
  assert.equal(validateEligibilityPolicy({ consumeAttestations: true, attestationProducers: ['lha-signer'] }), true);
});

test('a clean verdict with green checks finalizes', () => {
  const d = decide(cleanLedger());
  assert.equal(d.kind, 'finalize-now');
  assert.equal(d.revisionRef, 'sha-A');
});

test('a blocking verdict routes to remediate with the next round', () => {
  const d = decide(cleanLedger({ verdictKind: 'request-changes' }));
  assert.equal(d.kind, 'remediate');
  assert.equal(d.stageId, 'security');
  assert.equal(d.round, 1);
});

test('strict_mode routes a non-blocking (comment-only) verdict to remediate', () => {
  const strict = decide(cleanLedger({ verdictKind: 'comment-only' }));
  assert.equal(strict.kind, 'remediate');
  const relaxed = decide(cleanLedger({ verdictKind: 'comment-only' }), { strictMode: false });
  assert.equal(relaxed.kind, 'finalize-now');
});

test('an operator approve override lets a non-blocking verdict finalize under strict_mode', () => {
  const events = [
    ...cleanLedger({ verdictKind: 'comment-only' }),
    operatorOverride(REF, { at: t(3), overrideKind: 'approve', principal: 'operator', reason: 'comments are optional' }),
  ];
  assert.equal(decide(events).kind, 'finalize-now');
});

test('checks that are absent, not present, or still running yield a bounded wait', () => {
  const noChecks = decide([
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A' }),
    verdictRecorded(REF, { at: t(1), revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'c' }),
  ]);
  assert.equal(noChecks.kind, 'wait');
  assert.match(noChecks.reason, /checks not yet settled/);
  assert.ok(noChecks.deadline, 'wait carries a bounded deadline');

  const notPresent = decide(cleanLedger({ requiredChecksPresent: false }));
  assert.equal(notPresent.kind, 'wait');
  assert.match(notPresent.reason, /required checks not yet present/);
});

test('checks patience expiry escalates — it never merges', () => {
  const d = decide(cleanLedger({ requiredChecksPresent: false }), undefined, { observedAt: t(24 * 60) });
  assert.equal(d.kind, 'escalate');
  assert.match(d.reason, /checks patience expired/);
});

test('settled-but-failed checks route to remediation even with a clean verdict', () => {
  const d = decide(cleanLedger({ conclusion: 'failure' }));
  assert.equal(d.kind, 'remediate');
  assert.match(d.reason, /checks not green/);
});

test('no verdict at the current revision waits (verdict-at-head by construction)', () => {
  const d = decide([
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 's' }),
  ]);
  assert.equal(d.kind, 'wait');
  assert.match(d.reason, /no verdict at current revision/);
});

test('an indeterminate verdict waits, then escalates past patience', () => {
  const events = cleanLedger({ verdictKind: 'unknown' });
  assert.equal(decide(events).kind, 'wait');
  assert.equal(decide(events, undefined, { observedAt: t(24 * 60) }).kind, 'escalate');
});

test('consuming attestations waits for a missing producer and escalates on expiry', () => {
  const policy = { consumeAttestations: true, attestationProducers: ['lha-signer'] };
  const missing = decide(cleanLedger(), policy);
  assert.equal(missing.kind, 'wait');
  assert.match(missing.reason, /awaiting attestations from: lha-signer/);

  const expired = decide(cleanLedger(), policy, { observedAt: t(24 * 60) });
  assert.equal(expired.kind, 'escalate');

  const present = decide([
    ...cleanLedger(),
    attestationRecorded(REF, { at: t(3), revisionRef: 'sha-A', kind: 'produced', principal: 'lha-signer', sourceRef: 'att-A' }),
  ], policy);
  assert.equal(present.kind, 'finalize-now');
});

test('budget exhaustion drives the coverage-gated final-remediation → finalize path', () => {
  const base = [
    ...cleanLedger({ verdictKind: 'request-changes' }),
    budgetExhausted(REF, { at: t(3), stageId: 'security' }),
  ];
  // First: dispatch the final coverage-gated remediation.
  const first = decide(base);
  assert.equal(first.kind, 'remediate');
  assert.equal(first.final, true);

  // Dispatched but not concluded: wait for it to conclude.
  const dispatched = [
    ...base,
    remediationDispatched(REF, { at: t(4), revisionRef: 'sha-A', round: 1, idempotencyKey: 'final-1', stageId: 'security', final: true }),
  ];
  assert.equal(decide(dispatched).kind, 'wait');

  // Concluded with full coverage → finalize-now (lands, never abandons).
  const completed = [
    ...dispatched,
    remediationConcluded(REF, { at: t(5), revisionRef: 'sha-A', round: 1, outcome: 'completed', stageId: 'security' }),
  ];
  assert.equal(decide(completed).kind, 'finalize-now');

  // Concluded blocked (coverage operationally impossible) → halt (pages), never close.
  const blocked = [
    ...dispatched,
    remediationConcluded(REF, { at: t(5), revisionRef: 'sha-A', round: 1, outcome: 'blocked', stageId: 'security' }),
  ];
  assert.equal(decide(blocked).kind, 'halt');
});

test('exhaustion-always-closes disabled halts rather than force-landing', () => {
  const d = decide([
    ...cleanLedger({ verdictKind: 'request-changes' }),
    budgetExhausted(REF, { at: t(3), stageId: 'security' }),
  ], { exhaustionAlwaysCloses: false });
  assert.equal(d.kind, 'halt');
  assert.match(d.reason, /exhaustion-always-closes disabled/);
});

test('the kill switch intercepts every mutating decision as a fail-closed escalate', () => {
  const kill = { autonomousExecutionDisabled: true };
  assert.equal(decide(cleanLedger(), kill).kind, 'escalate'); // finalize-now intercepted
  assert.equal(decide(cleanLedger({ verdictKind: 'request-changes' }), kill).kind, 'escalate'); // remediate intercepted

  // Non-mutating decisions (wait) pass through untouched.
  const waiting = decide([
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 's' }),
  ], kill);
  assert.equal(waiting.kind, 'wait');
});

test('operator_override(close) is the only path to a close decision', () => {
  const d = decide([
    ...cleanLedger({ verdictKind: 'request-changes' }),
    operatorOverride(REF, { at: t(3), overrideKind: 'close', principal: 'operator', reason: 'obsolete PR' }),
  ]);
  assert.equal(d.kind, 'close');
  assert.equal(d.reason, 'obsolete PR');
});

test('terminal marks short-circuit: finalized→finalize-now, closed→close, escalated→escalate (no re-page), halted→halt', () => {
  const finalizedD = decide([...cleanLedger(), finalized(REF, { at: t(3), revisionRef: 'sha-A', method: 'merge' })]);
  assert.equal(finalizedD.kind, 'finalize-now');
  assert.match(finalizedD.reason, /already finalized/);

  const closedD = decide([...cleanLedger(), closed(REF, { at: t(3), reason: 'op close' })]);
  assert.equal(closedD.kind, 'close');

  const escalatedD = decide([...cleanLedger(), escalated(REF, { at: t(3), reason: 'fail-closed' })]);
  assert.equal(escalatedD.kind, 'escalate');
  assert.equal(escalatedD.final, true, 'terminal escalate is marked so the executor does not re-page');

  const haltedD = decide([...cleanLedger(), halted(REF, { at: t(3), reason: 'needs human' })]);
  assert.equal(haltedD.kind, 'halt');
});

test('no revision advanced yet yields a wait', () => {
  const d = eligible(fold([]), undefined, { observedAt: t(0) });
  assert.equal(d.kind, 'wait');
  assert.match(d.reason, /no revision advanced yet/);
});

test('eligible is deterministic in (state, policy, observedAt)', () => {
  const events = cleanLedger({ verdictKind: 'request-changes' });
  const a = eligible(fold(events), {}, { observedAt: t(10) });
  const b = eligible(fold(events), {}, { observedAt: t(10) });
  assert.deepEqual(a, b);
});
