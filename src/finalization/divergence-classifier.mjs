// Merge Authority v2 shadow mode — the divergence classifier (ARC-16;
// docs/SPEC-merge-authority-v2.md §5.2). Given a shadow pair `(v1 action, v2
// decision)` and the folded ledger state v2 decided from, classify whether the
// two systems AGREE and, when they DIVERGE, propose a bidirectional triage:
//
//   direction = 'v1-defect' | 'v2-suspect' | 'open' | 'benign'
//
// The discipline is stated in §5.2: v1 is the KNOWN-buggy system, so a
// divergence is evidence — NOT automatically a v2 defect, and (just as
// important) NOT automatically a v1 defect either. This classifier auto-attributes
// a divergence to v1 ONLY when it matches a precise, documented v1 failure-family
// signature (each of the six §1 families has a ledger-level fingerprint and an
// ARC-15 regression fixture). Everything else defaults to `open` — a human triages
// it in both directions. That default is the safety property: unknown divergences
// never silently absolve v2. See docs/finalization-shadow-divergence-triage.md.
//
// PURE: no I/O, no clock, no randomness. The bidirectional guide and human
// overrides live in the triage doc / the shadow store, not here.

import { v1ActionBucket, v2DecisionBucket } from './shadow-actions.mjs';

/**
 * @typedef {import('../kernel/contracts.js').LedgerState} LedgerState
 * @typedef {import('../kernel/contracts.js').EligibilityDecision} EligibilityDecision
 * @typedef {import('../kernel/contracts.js').ShadowV1Action} ShadowV1Action
 * @typedef {import('../kernel/contracts.js').DivergenceClassification} DivergenceClassification
 */

/** Triage directions. `open` blocks promotion; the rest are dispositioned. */
export const DIVERGENCE_DIRECTIONS = Object.freeze(['v1-defect', 'v2-suspect', 'open', 'benign']);

/**
 * The known v1 failure families from SPEC §1 (each has an ARC-15 regression
 * fixture). A divergence whose fingerprint matches one of these is auto-attributed
 * to v1 with a documented rationale. Keyed by classification `class`.
 */
export const V1_DEFECT_CLASSES = Object.freeze({
  'ci-impatience': 'AR#550',
  'verdict-at-wrong-head': 'verdict-at-wrong-head',
  'ceiling-head-move-deadlock': 'LAC-1559',
  'phantom-die-before-merge': 'HCM-01',
  'lha-premature-cutover': 'LHA',
  'identity-head-pin': '#603',
});

function reasonMentions(decision, re) {
  return re.test(String(decision?.reason ?? ''));
}

function detailMentions(action, re) {
  return re.test(String(action?.detail ?? ''));
}

// The v2 fold, on this state, is confident the subject is landable now.
function v2SaysLandable(decision) {
  return decision?.kind === 'finalize-now'
    && reasonMentions(decision, /clean verdict, green checks|validated full coverage/i);
}

// Did the head move during this subject's life (an organic head-move)?
function headMoved(state) {
  return Object.keys(state?.revisions ?? {}).length > 1;
}

/**
 * The ordered v1-defect signatures. Each predicate takes `(v1, v2, state)` and
 * returns true when the divergence fingerprint matches that failure family.
 * First match wins. Order matters: the more specific checks-then-verdict
 * fingerprints precede the broad deadlock one.
 */
const V1_DEFECT_SIGNATURES = [
  // AR#550 — v1 merged reading "checks I can see are green" as "checks green";
  // v2 correctly withholds (wait/escalate) because required checks are not
  // present-and-settled at head.
  {
    class: 'ci-impatience',
    match: (v1, v2) => v1ActionBucket(v1.kind) === 'land'
      && (v2.kind === 'wait' || v2.kind === 'escalate')
      && reasonMentions(v2, /check/i),
    reason: 'v1 merged before required checks were present and settled at head; v2 withholds (AR#550 CI-impatience class)',
  },
  // Verdict-at-wrong-head — v1 merged on a verdict from a stale revision; v2
  // finds no matching verdict AT the current revision (matched by construction).
  {
    class: 'verdict-at-wrong-head',
    match: (v1, v2) => v1ActionBucket(v1.kind) === 'land'
      && (v2.kind === 'wait' || v2.kind === 'escalate')
      && reasonMentions(v2, /verdict/i),
    reason: 'v1 merged on a verdict not pinned to the current revision; v2 requires a verdict at head (verdict-at-wrong-head class)',
  },
  // #603 identity head-pin — v1 merged/acted against a head-pinned identity that
  // broke when the head moved; v2 treats the head move as an ordinary event.
  {
    class: 'identity-head-pin',
    match: (v1, v2, state) => v1ActionBucket(v1.kind) === 'land'
      && (v2.kind === 'wait' || v2.kind === 'escalate')
      && detailMentions(v1, /identity|head[- ]?pin|bound/i)
      && headMoved(state),
    reason: 'v1 acted against a head-pinned identity across a head move; v2 folds the head move as an ordinary event (#603 identity head-pin class)',
  },
  // LHA premature cutover — v1 stalls forever awaiting a `produced` attestation
  // no producer writes; v2 escalates on bounded attestation patience.
  {
    class: 'lha-premature-cutover',
    match: (v1, v2) => v1ActionBucket(v1.kind) === 'wait'
      && v2.kind === 'escalate'
      && reasonMentions(v2, /attestation/i),
    reason: 'v1 stalled awaiting an attestation with no configured producer; v2 escalates on bounded patience rather than stalling (LHA class)',
  },
  // HCM-01 phantom die-before-merge — a converged PR stranded because v1 progress
  // lived in process state; v2 re-folds the durable ledger and finalizes. Gated
  // on an explicit stranded/crash marker so it does not swallow the deadlock class.
  {
    class: 'phantom-die-before-merge',
    match: (v1, v2) => v1ActionBucket(v1.kind) === 'wait'
      && v2SaysLandable(v2)
      && detailMentions(v1, /strand|crash|phantom|die-before/i),
    reason: 'v1 stranded a converged PR when process-state progress was lost; v2 re-folds the durable ledger and finalizes (HCM-01 phantom-die class)',
  },
  // LAC-1559 ceiling + head-move deadlock — a clean, green PR became permanently
  // un-landable under v1 because the round ceiling and head pointer lived in
  // different actors; v2 counts budget per-stage and eligibility per-revision, so
  // it finalizes the landable head.
  {
    class: 'ceiling-head-move-deadlock',
    match: (v1, v2, state) => v1ActionBucket(v1.kind) === 'wait'
      && v2SaysLandable(v2)
      && headMoved(state),
    reason: 'v1 deadlocked a clean, green PR across a head move (ceiling vs head pointer in separate actors); v2 finalizes the landable head (LAC-1559 class)',
  },
];

/**
 * Classify a shadow `(v1 action, v2 decision)` pair.
 *
 * @param {{ v1Action: ShadowV1Action, v2Decision: EligibilityDecision,
 *   state?: LedgerState | null, foldError?: boolean }} pair
 * @returns {DivergenceClassification}
 */
export function classifyDivergence({ v1Action, v2Decision, state = null, foldError = false }) {
  const v1Bucket = v1ActionBucket(v1Action?.kind);
  const v2Bucket = v2DecisionBucket(v2Decision?.kind);

  // A fold error / ledger-unavailable tick already forced v2 to the fail-closed
  // `escalate` (never a guess). If v1 also stopped, the two concur on "do not
  // mutate"; if v1 acted, that divergence MUST be triaged, never auto-absolved.
  if (foldError) {
    if (v1Bucket === 'stop') {
      return classification('agree', { direction: 'benign', class: 'fold-error', ref: null, reason: 'shadow fold errored; v2 failed closed to escalate and v1 also paged — concurrence on no mutation' });
    }
    return classification('diverge', {
      direction: 'open',
      class: 'fold-error',
      ref: null,
      reason: `shadow fold errored; v2 failed closed to escalate while v1 took a ${v1Action?.kind} action — triage the ledger and v1 both`,
    });
  }

  if (v1Bucket && v2Bucket && v1Bucket === v2Bucket) {
    return classification('agree', { direction: 'benign', class: 'concur', ref: null, reason: `v1 (${v1Action.kind}) and v2 (${v2Decision.kind}) concur on ${v1Bucket}` });
  }

  // Divergence. Try each documented v1 failure-family fingerprint in order.
  for (const sig of V1_DEFECT_SIGNATURES) {
    if (sig.match(v1Action, v2Decision, state ?? { revisions: {} })) {
      return classification('diverge', {
        direction: 'v1-defect',
        class: sig.class,
        ref: V1_DEFECT_CLASSES[sig.class] ?? null,
        reason: sig.reason,
      });
    }
  }

  // No known v1 fingerprint. Bidirectional discipline: this is `open` — a human
  // triages it toward v1, v2, or benign. It never auto-absolves either system.
  return classification('diverge', {
    direction: 'open',
    class: 'unclassified',
    ref: null,
    reason: `v1 (${v1Action?.kind}) diverges from v2 (${v2Decision?.kind}); no known v1 failure-family fingerprint — open for bidirectional triage`,
  });
}

function classification(relation, { direction, class: cls, ref, reason }) {
  // Disposition: `open` is the only one that blocks the promotion gate. An
  // auto-attributed v1-defect (or a benign concurrence) is dispositioned with a
  // documented rationale; a human may still override it via the shadow store.
  const disposition = direction === 'open' ? 'open' : 'resolved';
  return { relation, direction, class: cls, ref, disposition, reason };
}
