// Merge Authority v2 shadow mode — the recorder / harness (ARC-16;
// docs/SPEC-merge-authority-v2.md §5.1). Shadow mode ingests the live
// finalization ledger and LOGS the v2 decision WITHOUT ACTING, next to what
// frozen v1 actually did. This module produces one `ShadowObservation` per tick:
// fold the ledger → `eligible(...)` the pure decision → classify the divergence
// against the recorded v1 action → return a plain record (persisted by the
// shadow store).
//
// Shadow NEVER acts (the standing "Don't" for ARC-16). And it is FAIL-CLOSED:
// per §5.5, if the ledger is unavailable or the fold errors, v2 emits `escalate`
// — never a guess. `shadowObserve` catches both and records the escalate with a
// `foldError` marker so the divergence classifier and the report surface it for
// triage rather than silently dropping the tick.
//
// PURE decision (no clock): the caller supplies `observedAt`, exactly as the
// eligibility fold requires. The only I/O is the optional ledger read, which is
// itself wrapped fail-closed.

import { eligible, makeEligibilityDecision } from './eligibility.mjs';
import { fold } from './ledger-fold.mjs';
import { resolveSubjectKey } from './ledger-events.mjs';
import { classifyDivergence } from './divergence-classifier.mjs';
import { normalizeV1Action } from './shadow-actions.mjs';

/**
 * @typedef {import('../kernel/contracts.js').SubjectRef} SubjectRef
 * @typedef {import('../kernel/contracts.js').SubjectKey} SubjectKey
 * @typedef {import('../kernel/contracts.js').FinalizationEvent} FinalizationEvent
 * @typedef {import('../kernel/contracts.js').EligibilityPolicy} EligibilityPolicy
 * @typedef {import('../kernel/contracts.js').ShadowV1Action} ShadowV1Action
 * @typedef {import('../kernel/contracts.js').ShadowObservation} ShadowObservation
 */

/**
 * Compute the shadow v2 decision from a folded ledger, FAIL-CLOSED. Any fold
 * error becomes a fail-closed `escalate` carrying the subject/observation time —
 * never a guessed merge/remediate.
 *
 * @param {{ subjectKey: SubjectKey, events: readonly FinalizationEvent[],
 *   policy?: Partial<EligibilityPolicy>, observedAt: string }} args
 */
function shadowDecide({ subjectKey, events, policy, observedAt }) {
  try {
    const state = fold(events);
    const decision = eligible(state, policy, { observedAt });
    return { state, decision, foldError: false };
  } catch (err) {
    const decision = makeEligibilityDecision('escalate', {
      subjectKey,
      revisionRef: '',
      observedAt,
      reason: `shadow fold error (fail-closed, never a guess): ${err?.message || err}`,
    });
    return { state: null, decision, foldError: true };
  }
}

/**
 * Produce one shadow observation from an explicit event list. This is the pure
 * harness entry the replay tests drive: given the ledger events as of a tick and
 * what v1 did, it returns the `(v1 action, v2 decision)` pair with its divergence
 * classification. No persistence — the shadow store appends the result.
 *
 * @param {{
 *   subject: SubjectRef | SubjectKey,
 *   events: readonly FinalizationEvent[],
 *   v1Action: ShadowV1Action | string,
 *   observedAt: string,
 *   policy?: Partial<EligibilityPolicy>,
 * }} args
 * @returns {ShadowObservation}
 */
export function shadowObserve({ subject, events, v1Action, observedAt, policy }) {
  if (!observedAt || typeof observedAt !== 'string') {
    throw new TypeError('shadowObserve requires an `observedAt` ISO timestamp');
  }
  const subjectKey = resolveSubjectKey(subject);
  const action = normalizeV1Action(v1Action);
  const { state, decision, foldError } = shadowDecide({ subjectKey, events: events ?? [], policy, observedAt });
  const classification = classifyDivergence({ v1Action: action, v2Decision: decision, state, foldError });

  return {
    subjectKey,
    revisionRef: decision.revisionRef ?? state?.currentRevision ?? '',
    observedAt,
    v1Action: action,
    v2Decision: decision,
    classification,
    foldError,
    // Organic-observation markers the promotion gate (§5.3) counts: at least one
    // head-move and one budget-exhaustion must be observed in shadow.
    sawHeadMove: Object.keys(state?.revisions ?? {}).length > 1,
    sawExhaustion: Object.values(state?.stages ?? {}).some((s) => s?.budgetExhausted === true),
  };
}

/**
 * Ingest a live tick from a ledger store, FAIL-CLOSED on ledger unavailability.
 * Reads the subject's events and delegates to {@link shadowObserve}; if the read
 * throws (ledger unavailable, per §5.5), records a fail-closed `escalate`
 * observation rather than skipping the tick.
 *
 * @param {{
 *   ledgerStore: { read(subject: SubjectRef | SubjectKey): FinalizationEvent[] },
 *   subject: SubjectRef | SubjectKey,
 *   v1Action: ShadowV1Action | string,
 *   observedAt: string,
 *   policy?: Partial<EligibilityPolicy>,
 * }} args
 * @returns {ShadowObservation}
 */
export function shadowObserveFromStore({ ledgerStore, subject, v1Action, observedAt, policy }) {
  const subjectKey = resolveSubjectKey(subject);
  let events;
  try {
    events = ledgerStore.read(subject);
  } catch (err) {
    const action = normalizeV1Action(v1Action);
    const decision = makeEligibilityDecision('escalate', {
      subjectKey,
      revisionRef: '',
      observedAt,
      reason: `shadow ledger unavailable (fail-closed, never a guess): ${err?.message || err}`,
    });
    const classification = classifyDivergence({ v1Action: action, v2Decision: decision, state: null, foldError: true });
    return {
      subjectKey,
      revisionRef: '',
      observedAt,
      v1Action: action,
      v2Decision: decision,
      classification,
      foldError: true,
      sawHeadMove: false,
      sawExhaustion: false,
    };
  }
  return shadowObserve({ subject, events, v1Action, observedAt, policy });
}

/**
 * Replay a recorded v1 trace: a sequence of ticks, each carrying the ledger
 * events as of that tick and the v1 action taken. Returns one observation per
 * tick. The shadow harness the acceptance tests replay recorded v1 traces
 * through (mandatory test).
 *
 * @param {{
 *   subject: SubjectRef | SubjectKey,
 *   ticks: { events: readonly FinalizationEvent[], v1Action: ShadowV1Action | string, observedAt: string }[],
 *   policy?: Partial<EligibilityPolicy>,
 * }} trace
 * @returns {ShadowObservation[]}
 */
export function replayV1Trace({ subject, ticks, policy }) {
  return (ticks ?? []).map((tick) => shadowObserve({
    subject,
    events: tick.events,
    v1Action: tick.v1Action,
    observedAt: tick.observedAt,
    policy,
  }));
}
