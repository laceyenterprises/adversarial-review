// Merge Authority v2 pure fold (ARC-15; docs/SPEC-merge-authority-v2.md §2).
// `fold(events) → LedgerState` projects the append-only ledger into the minimal
// per-revision / per-stage / terminal state that `eligibility.mjs` reads. It is
// a PURE left-fold: deterministic in its input, no I/O, no clock, no randomness.
// Time enters only as each event's `at`. `foldFrom(snapshot, events)` folds a
// tail onto a prior snapshot WITHOUT mutating it, so a crashed executor resumes
// by re-folding — `fold(all)` and "`fold(prefix)` then `foldFrom(rest)`" are
// equal (the replay-resume invariant, HCM-01 class eliminated structurally).
//
// Contract shapes live in `../kernel/contracts.d.ts` (LedgerState).

import { isRevisionScopedEvent } from './ledger-events.mjs';

/**
 * @typedef {import('../kernel/contracts.js').FinalizationEvent} FinalizationEvent
 * @typedef {import('../kernel/contracts.js').LedgerState} LedgerState
 * @typedef {import('../kernel/contracts.js').SubjectKey} SubjectKey
 */

// Operator-override kinds that RESUME a subject out of an escalated/halted
// terminal state (merge-authority-v2 §3: "until an operator_override event
// resumes or redirects the subject"). `finalized`/`closed` are never resumed.
const RESUMING_OVERRIDE_KINDS = new Set(['resume', 'reopen', 'force-rereview', 'raise-cap', 'approve']);

/** A fresh, empty fold state. */
export function initialLedgerState() {
  return {
    subjectKey: /** @type {SubjectKey | null} */ (null),
    eventCount: 0,
    lastEventAt: /** @type {string | null} */ (null),
    currentRevision: /** @type {string | null} */ (null),
    /** @type {Record<string, RevisionState>} */
    revisions: {},
    /** @type {Record<string, StageState>} */
    stages: {},
    remediation: { dispatched: [], concluded: [] },
    operatorOverrides: [],
    /** The most recent UNRESOLVED terminal mark, or null. */
    terminal: /** @type {TerminalState | null} */ (null),
    finalized: /** @type {TerminalState | null} */ (null),
  };
}

function emptyRevisionState() {
  return { verdicts: [], checks: null, attestations: [], revisionAdvancedAt: null };
}

function emptyStageState() {
  return { budgetExhausted: false, budgetExhaustedAt: null, dispatchedRounds: 0, concludedRounds: 0 };
}

function ensureRevision(state, rev) {
  if (!Object.hasOwn(state.revisions, rev)) {
    Object.defineProperty(state.revisions, rev, {
      value: emptyRevisionState(), enumerable: true, configurable: true, writable: true,
    });
  }
  return state.revisions[rev];
}

function ensureStage(state, stageId) {
  if (!Object.hasOwn(state.stages, stageId)) {
    Object.defineProperty(state.stages, stageId, {
      value: emptyStageState(), enumerable: true, configurable: true, writable: true,
    });
  }
  return state.stages[stageId];
}

// Deep clone via structured JSON — the state is plain JSON (no functions,
// Dates, or cycles), so this is faithful and keeps `foldFrom` non-mutating.
function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Apply one event to a working state (mutates the working copy only). Kept
 * private; callers use `fold` / `foldFrom`, which clone first.
 *
 * @param {object} state working state
 * @param {FinalizationEvent} event
 */
function applyEvent(state, event) {
  state.eventCount += 1;
  state.lastEventAt = event.at;
  if (!state.subjectKey && event.subjectKey) {
    state.subjectKey = { ...event.subjectKey };
  }

  const rev = isRevisionScopedEvent(event.type) ? event.revisionRef : null;

  switch (event.type) {
    case 'revision_advanced': {
      // Head-move is an ordinary event: it does not reset budgets or verdicts;
      // it only makes `rev` the revision later eligibility folds require fresh
      // verdicts/checks at.
      state.currentRevision = event.revisionRef;
      const r = ensureRevision(state, rev);
      if (!r.revisionAdvancedAt) r.revisionAdvancedAt = event.at;
      break;
    }
    case 'verdict_recorded': {
      const r = ensureRevision(state, rev);
      r.verdicts.push({
        stageId: event.stageId,
        role: event.role,
        verdictKind: event.verdictKind,
        sourceRef: event.sourceRef,
        at: event.at,
      });
      break;
    }
    case 'checks_settled': {
      const r = ensureRevision(state, rev);
      // Last observation wins — checks re-run and settle.
      r.checks = {
        conclusion: event.conclusion,
        requiredChecksPresent: event.requiredChecksPresent === true,
        sourceRef: event.sourceRef,
        at: event.at,
      };
      break;
    }
    case 'attestation_recorded': {
      const r = ensureRevision(state, rev);
      r.attestations.push({
        kind: event.kind,
        principal: event.principal,
        sourceRef: event.sourceRef,
        at: event.at,
      });
      break;
    }
    case 'remediation_dispatched': {
      state.remediation.dispatched.push({
        revisionRef: event.revisionRef,
        round: event.round,
        idempotencyKey: event.idempotencyKey,
        stageId: event.stageId ?? null,
        final: event.final === true,
        at: event.at,
      });
      if (event.stageId) ensureStage(state, event.stageId).dispatchedRounds += 1;
      break;
    }
    case 'remediation_concluded': {
      state.remediation.concluded.push({
        revisionRef: event.revisionRef,
        round: event.round,
        outcome: event.outcome,
        stageId: event.stageId ?? null,
        at: event.at,
      });
      if (event.stageId) ensureStage(state, event.stageId).concludedRounds += 1;
      break;
    }
    case 'budget_exhausted': {
      const s = ensureStage(state, event.stageId);
      s.budgetExhausted = true;
      s.budgetExhaustedAt = event.at;
      break;
    }
    case 'operator_override': {
      const override = {
        overrideKind: event.overrideKind,
        principal: event.principal,
        reason: event.reason,
        roundCap: event.roundCap ?? null,
        revisionRef: event.revisionRef ?? null,
        at: event.at,
      };
      state.operatorOverrides.push(override);
      // A resuming override clears a non-final terminal state so eligibility
      // recomputes; it never revives a finalized/closed subject.
      if (state.terminal
        && (state.terminal.kind === 'escalated' || state.terminal.kind === 'halted')
        && RESUMING_OVERRIDE_KINDS.has(event.overrideKind)) {
        state.terminal = null;
      }
      break;
    }
    case 'finalized': {
      const mark = { kind: 'finalized', revisionRef: event.revisionRef, method: event.method, at: event.at };
      state.finalized = mark;
      state.terminal = mark;
      break;
    }
    case 'closed': {
      state.terminal = { kind: 'closed', reason: event.reason, at: event.at };
      break;
    }
    case 'escalated': {
      state.terminal = { kind: 'escalated', reason: event.reason, at: event.at };
      break;
    }
    case 'halted': {
      state.terminal = { kind: 'halted', reason: event.reason, at: event.at };
      break;
    }
    default:
      // Unknown event types are ignored rather than throwing: a forward-compat
      // ledger (a newer producer) must still fold on an older reader without
      // corrupting the projection. Validation happens at append time.
      break;
  }
}

/**
 * Fold a tail of events onto a prior snapshot, returning a NEW state. The input
 * `snapshot` is never mutated (it is deep-cloned first), so replay is safe.
 *
 * @param {object} snapshot a prior `LedgerState` (or `initialLedgerState()`)
 * @param {readonly FinalizationEvent[]} events
 * @returns {LedgerState}
 */
export function foldFrom(snapshot, events) {
  const state = cloneState(snapshot);
  for (const event of events ?? []) applyEvent(state, event);
  return state;
}

/**
 * Fold a full event list into a `LedgerState` from empty.
 *
 * @param {readonly FinalizationEvent[]} events
 * @returns {LedgerState}
 */
export function fold(events) {
  return foldFrom(initialLedgerState(), events);
}

/** Replay lane events without resetting candidate, readiness or patience. */
export function foldQueue(events, snapshot = { entries: {}, owner: null, operations: {} }) {
  const state = cloneState(snapshot);
  for (const event of events) {
    if (event.type === 'acknowledged') state.entries[event.entry.entryId] = cloneState(event.entry);
    if (event.type === 'progress') {
      const entry = state.entries[event.entryId];
      if (!entry) throw new Error('queue progress without acknowledgement');
      Object.assign(entry, cloneState(event.patch));
    }
    if (event.type.startsWith('owner-')) state.owner = cloneState(event.owner);
    if (event.type === 'operation-intent') state.operations[event.operation.operationId] = cloneState(event.operation);
    if (event.type === 'operation-result') state.operations[event.operationId].result = cloneState(event.result);
  }
  return state;
}

/** Pure publication restart classification; caller first drains/reconciles all
 * operation intents and supplies an authoritative live observation. */
export function reconcileQueuePublication(entry, observation) {
  if (!observation?.sourceRef || !observation.head || !observation.base) {
    return { phase: 'parked-infrastructure', reason: 'publication-observation-unavailable' };
  }
  if (observation.state === 'closed') return { phase: 'closed-observed', reason: 'live-closed' };
  // Merge receipt reconciliation belongs to the final merge executor; a live
  // merged state alone cannot prove the candidate or its merge SHA here.
  if (observation.state !== 'open') return { phase: 'parked-infrastructure', reason: 'terminal-state-requires-reconciliation' };
  if (![entry.candidate, entry.expectedOldHead].includes(observation.head)) {
    return { phase: 'returned-to-closer', reason: 'external-head-change' };
  }
  if (observation.base !== entry.exactBase) {
    return { phase: 'rebasing', reason: 'external-base-change', checks: null };
  }
  if (observation.head === entry.candidate) return { phase: 'waiting-checks', reason: 'candidate-already-published' };
  return { phase: 'publishing', reason: 'expected-old-head-observed' };
}
