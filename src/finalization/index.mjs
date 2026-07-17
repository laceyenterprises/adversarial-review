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
