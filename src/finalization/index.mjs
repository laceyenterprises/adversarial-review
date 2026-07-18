// Finalization port (v2 app architecture Phase 3 / ARC-14) public surface.
// `evaluate(subjectState) → FinalizationDecision` / `execute(decision) →
// FinalizationOutcome` behind one seam per domain: trivial finalizers for
// non-code domains, and unchanged v1 AMA wrapped for `code-pr`. Contract types
// live in `../kernel/contracts.d.ts`.

export {
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
} from './finalization-port.mjs';

export { TRIVIAL_FINALIZER_MODES, createTrivialFinalizer } from './trivial-finalizer.mjs';

export {
  createV1AmaFinalizationPort,
  mapDaemonMergeDisposition,
  projectReviewState,
} from './v1-ama-wrapper.mjs';

// Merge Authority v2 core (ARC-15): the append-only finalization event ledger,
// its pure fold, and the pure eligibility decision. See
// docs/SPEC-merge-authority-v2.md §2–3.
export {
  FINALIZATION_EVENT_TYPES,
  REVISION_SCOPED_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  attestationRecorded,
  budgetExhausted,
  checksSettled,
  closed,
  escalated,
  finalized,
  halted,
  isFinalizationEvent,
  isRevisionScopedEvent,
  makeFinalizationEvent,
  operatorOverride,
  remediationConcluded,
  remediationDispatched,
  resolveSubjectKey,
  revisionAdvanced,
  verdictRecorded,
} from './ledger-events.mjs';

export { fold, foldFrom, initialLedgerState } from './ledger-fold.mjs';

export {
  DEFAULT_ELIGIBILITY_POLICY,
  ELIGIBILITY_DECISION_KINDS,
  eligible,
  makeEligibilityDecision,
  normalizePolicy,
  validateEligibilityPolicy,
} from './eligibility.mjs';

export {
  ensureFinalizationLedgerSchema,
  openFinalizationLedgerStore,
  rowToEvent,
} from './ledger-store.mjs';
