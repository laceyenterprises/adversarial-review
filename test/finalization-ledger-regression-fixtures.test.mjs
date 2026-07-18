// ARC-15 regression fixtures: each of the six v1 merge-authority failure classes
// (docs/SPEC-merge-authority-v2.md §1), replayed as a ledger, must fold to a
// SAFE decision. "Safe" = the v1 incident cannot recur: a merge is never issued
// against unsettled checks, a stale head, or an un-produced attestation; a
// converged PR is never stranded; and a clean green PR is never deadlocked.

import assert from 'node:assert/strict';
import test from 'node:test';

import { fold, foldFrom } from '../src/finalization/ledger-fold.mjs';
import { eligible } from '../src/finalization/eligibility.mjs';
import { normalizePolicy } from '../src/finalization/eligibility.mjs';
import {
  attestationRecorded,
  budgetExhausted,
  checksSettled,
  remediationConcluded,
  remediationDispatched,
  revisionAdvanced,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#1559' };
const t = (n) => new Date(Date.parse('2026-07-17T00:00:00.000Z') + n * 60000).toISOString();

// 1. Phantom die-before-merge / non-resumable close (HCM-01). v1 kept hammer
//    progress in process state; a crash between the final remediation and the
//    merge stranded a converged PR. v2: crash-resume is a replay. The executor
//    dies right after `remediation_concluded(completed)`; re-folding the durable
//    ledger yields finalize-now — the merge resumes, nothing is stranded.
test('regression: phantom die-before-merge resumes to finalize-now on replay', () => {
  const ledger = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }),
    verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 'security', role: 'r1', verdictKind: 'request-changes', sourceRef: 'rev-A' }),
    budgetExhausted(REF, { at: t(3), stageId: 'security' }),
    remediationDispatched(REF, { at: t(4), revisionRef: 'sha-A', round: 1, idempotencyKey: 'final-1', stageId: 'security', final: true }),
    remediationConcluded(REF, { at: t(5), revisionRef: 'sha-A', round: 1, outcome: 'completed', stageId: 'security' }),
    // ... executor process dies here, before issuing the merge.
  ];
  // Restart = fold from scratch, and fold-from-snapshot: both must agree and both
  // must say finalize-now (resumable, not stranded).
  const cold = eligible(fold(ledger), undefined, { observedAt: t(6) });
  const resumed = eligible(foldFrom(fold(ledger.slice(0, 4)), ledger.slice(4)), undefined, { observedAt: t(6) });
  assert.equal(cold.kind, 'finalize-now');
  assert.deepEqual(cold, resumed, 'crash-resume replay must equal a cold fold');
});

// 2. Bound-reset-on-head-move / identity head-pin (#603). v1 pinned worker
//    identity to the head at open; a head move after open broke the lookup. v2:
//    head-move is an ordinary event. A verdict recorded at sha-A does not apply
//    to sha-B; eligibility at sha-B requires a fresh verdict → wait, not a merge
//    and not a broken pin.
test('regression: identity head-pin waits for a fresh verdict after a head move', () => {
  const ledger = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }),
    verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 'security', role: 'r1', verdictKind: 'approved', sourceRef: 'rev-A' }),
    revisionAdvanced(REF, { at: t(3), revisionRef: 'sha-B', sourceRef: 'push-B' }),
    checksSettled(REF, { at: t(4), revisionRef: 'sha-B', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-B' }),
    // No verdict at sha-B yet.
  ];
  const d = eligible(fold(ledger), undefined, { observedAt: t(5) });
  assert.equal(d.kind, 'wait');
  assert.equal(d.revisionRef, 'sha-B');
  assert.match(d.reason, /no verdict at current revision/);
});

// 3. Review-ceiling + head-move deadlock (LAC-1559). v1 tracked the round
//    ceiling and the head pointer in different actors with no reconciliation, so
//    a clean, green PR became permanently un-landable once the budget was
//    exhausted at an older head. v2: budgets are counted PER STAGE while
//    eligibility is computed PER REVISION. A fresh clean verdict at the new head
//    finalizes regardless of an earlier stage exhaustion — no deadlock.
test('regression: ceiling+head-move deadlock finalizes a clean PR at the new head', () => {
  const ledger = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    verdictRecorded(REF, { at: t(1), revisionRef: 'sha-A', stageId: 'security', role: 'r1', verdictKind: 'request-changes', sourceRef: 'rev-A' }),
    budgetExhausted(REF, { at: t(2), stageId: 'security' }),
    // Head moves; a fresh review of the new head is clean and checks are green.
    revisionAdvanced(REF, { at: t(3), revisionRef: 'sha-B', sourceRef: 'push-B' }),
    checksSettled(REF, { at: t(4), revisionRef: 'sha-B', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-B' }),
    verdictRecorded(REF, { at: t(5), revisionRef: 'sha-B', stageId: 'security', role: 'r1', verdictKind: 'approved', sourceRef: 'rev-B' }),
  ];
  const d = eligible(fold(ledger), undefined, { observedAt: t(6) });
  assert.equal(d.kind, 'finalize-now', 'a clean green head must not deadlock behind a stale stage exhaustion');
  assert.equal(d.revisionRef, 'sha-B');
});

// 4. LHA premature cutover. v1's daemon required `produced` attestations that no
//    producer had ever written — a policy flag flipped ahead of the data it
//    depended on. v2: (a) config validation rejects consume_attestations with no
//    producer AT LOAD; (b) at runtime a configured-but-silent producer yields a
//    bounded wait → escalate, never an infinite stall or a merge.
test('regression: LHA cutover — config error at load, and a bounded wait at runtime', () => {
  // (a) The misconfiguration the flag flip caused is now a load-time error.
  assert.throws(() => normalizePolicy({ consumeAttestations: true, attestationProducers: [] }),
    /no attestation producer is configured/);

  // (b) Producer configured but has not emitted at this revision → wait, not merge.
  const policy = { consumeAttestations: true, attestationProducers: ['lha-signer'] };
  const ledger = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }),
    verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 'security', role: 'r1', verdictKind: 'approved', sourceRef: 'rev-A' }),
  ];
  const waiting = eligible(fold(ledger), policy, { observedAt: t(3) });
  assert.equal(waiting.kind, 'wait');
  assert.match(waiting.reason, /awaiting attestations/);
  // Never a silent merge; patience expiry escalates.
  const expired = eligible(fold(ledger), policy, { observedAt: t(24 * 60) });
  assert.equal(expired.kind, 'escalate');
});

// 5. Impatience with CI (AR#550). v1 read "checks green" as "checks I can see
//    are green" and merged before required checks existed. v2: checks_settled
//    must report requiredChecksPresent=true AND a settled conclusion; otherwise
//    the decision is a bounded wait, never a merge.
test('regression: CI impatience waits when required checks are not yet present', () => {
  const ledger = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    verdictRecorded(REF, { at: t(1), revisionRef: 'sha-A', stageId: 'security', role: 'r1', verdictKind: 'approved', sourceRef: 'rev-A' }),
    // The only checks signal so far reports the required set is NOT yet present.
    checksSettled(REF, { at: t(2), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: false, sourceRef: 'suite-A' }),
  ];
  const d = eligible(fold(ledger), undefined, { observedAt: t(3) });
  assert.equal(d.kind, 'wait');
  assert.match(d.reason, /required checks not yet present/);
});

// 6. Verdict-at-wrong-head merges. v1 misread a "remediation-stopped" / CLEAN
//    mergeState as a clean verdict, never reconciling review commit_id vs head
//    in one place. v2: a verdict is matched to a revision by construction (its
//    revisionRef must equal the candidate). A clean verdict at sha-A with the
//    head at sha-B (even with green checks at sha-B) does NOT finalize.
test('regression: verdict-at-wrong-head never merges the head on a stale verdict', () => {
  const ledger = [
    revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
    verdictRecorded(REF, { at: t(1), revisionRef: 'sha-A', stageId: 'security', role: 'r1', verdictKind: 'approved', sourceRef: 'rev-A' }),
    revisionAdvanced(REF, { at: t(2), revisionRef: 'sha-B', sourceRef: 'push-B' }),
    checksSettled(REF, { at: t(3), revisionRef: 'sha-B', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-B' }),
    // A stale approved verdict for sha-A is present in the ledger, but the head is sha-B.
  ];
  const d = eligible(fold(ledger), undefined, { observedAt: t(4) });
  assert.notEqual(d.kind, 'finalize-now', 'a stale verdict must never finalize the current head');
  assert.equal(d.kind, 'wait');
  assert.equal(d.revisionRef, 'sha-B');
  assert.match(d.reason, /no verdict at current revision/);
});
