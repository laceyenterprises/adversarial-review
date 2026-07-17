// Shared, runtime-free building blocks for the finalization port (v2 app
// architecture Phase 3; merge-authority-v2 §3–4). This module owns the decision
// vocabulary, the decision/outcome constructors, and small validators reused by
// every port implementation (`trivial-finalizer.mjs`, `v1-ama-wrapper.mjs`) so
// the shapes cannot drift between them.
//
// It is pure: no I/O, no clock, no randomness. Callers supply the fold timestamp
// (`observedAt`) — typically the subject snapshot's `observedAt` — so decisions
// are deterministic and replay-stable, matching the pipeline kernel's discipline
// in `pipeline.mjs`. Contract shapes live in `../kernel/contracts.d.ts`.

/**
 * @typedef {import('../kernel/contracts.js').SubjectRef} SubjectRef
 * @typedef {import('../kernel/contracts.js').SubjectState} SubjectState
 * @typedef {import('../kernel/contracts.js').FinalizationDecision} FinalizationDecision
 * @typedef {import('../kernel/contracts.js').FinalizationDecisionKind} FinalizationDecisionKind
 * @typedef {import('../kernel/contracts.js').FinalizationOutcome} FinalizationOutcome
 * @typedef {import('../kernel/contracts.js').FinalizationActionStatus} FinalizationActionStatus
 */

/**
 * The autonomous decision vocabulary (merge-authority-v2 §3). `close` is
 * deliberately excluded — it is operator-override-only and never emitted by an
 * autonomous `evaluate` (see the contract note in `contracts.d.ts`).
 */
export const FINALIZATION_DECISION_KINDS = Object.freeze([
  'finalize-now',
  'remediate',
  'wait',
  'halt',
  'escalate',
]);

export const FINALIZATION_ACTION_STATUSES = Object.freeze([
  'executed',
  'deferred',
  'skipped',
  'failed',
]);

/**
 * Project a `SubjectState` (or a bare `SubjectRef`) down to the immutable
 * `{ subjectRef, revisionRef }` provenance every decision carries. Accepts a
 * state or a ref so callers on either side of the port can build decisions.
 *
 * @param {SubjectState | { ref?: SubjectRef } | SubjectRef} subject
 * @returns {{ subjectRef: SubjectRef, revisionRef: string }}
 */
function resolveProvenance(subject) {
  const ref = /** @type {SubjectRef} */ (subject && 'ref' in subject && subject.ref ? subject.ref : subject);
  if (!ref || typeof ref !== 'object' || typeof ref.domainId !== 'string') {
    throw new TypeError('finalization decision requires a SubjectRef with a domainId');
  }
  return { subjectRef: ref, revisionRef: String(ref.revisionRef ?? '') };
}

/**
 * Build a `FinalizationDecision`. `subject` may be a `SubjectState` or a
 * `SubjectRef`; `observedAt` is the fold timestamp (caller-supplied for
 * determinism). Kind-specific fields (`reason`, `stageId`, `round`, `deadline`)
 * are copied through when present and omitted otherwise.
 *
 * @param {FinalizationDecisionKind} kind
 * @param {SubjectState | SubjectRef} subject
 * @param {{ observedAt: string, reason?: string, stageId?: string,
 *   round?: number, deadline?: string }} fields
 * @returns {FinalizationDecision}
 */
export function makeDecision(kind, subject, { observedAt, reason, stageId, round, deadline } = {}) {
  if (!FINALIZATION_DECISION_KINDS.includes(kind)) {
    throw new TypeError(`unknown finalization decision kind: ${JSON.stringify(kind)}`);
  }
  if (!observedAt) {
    throw new TypeError('finalization decision requires an observedAt timestamp');
  }
  const { subjectRef, revisionRef } = resolveProvenance(subject);
  /** @type {FinalizationDecision} */
  const decision = { kind, subjectRef, revisionRef, observedAt };
  if (reason != null) decision.reason = reason;
  if (stageId != null) decision.stageId = stageId;
  if (round != null) decision.round = round;
  if (deadline != null) decision.deadline = deadline;
  return decision;
}

// Thin per-kind constructors — the common call sites. Each forwards to
// `makeDecision`, so the vocabulary lives in exactly one place.
export const finalizeNow = (subject, fields) => makeDecision('finalize-now', subject, fields);
export const remediate = (subject, fields) => makeDecision('remediate', subject, fields);
export const wait = (subject, fields) => makeDecision('wait', subject, fields);
export const halt = (subject, fields) => makeDecision('halt', subject, fields);
export const escalate = (subject, fields) => makeDecision('escalate', subject, fields);

/**
 * Build a `FinalizationOutcome` for a decision the executor acted on.
 *
 * @param {FinalizationDecision} decision
 * @param {{ status: FinalizationActionStatus, action: string, observedAt: string,
 *   detail?: string }} fields
 * @returns {FinalizationOutcome}
 */
export function makeOutcome(decision, { status, action, observedAt, detail } = {}) {
  if (!FINALIZATION_ACTION_STATUSES.includes(status)) {
    throw new TypeError(`unknown finalization action status: ${JSON.stringify(status)}`);
  }
  if (typeof action !== 'string' || action === '') {
    throw new TypeError('finalization outcome requires a non-empty action');
  }
  if (!observedAt) {
    throw new TypeError('finalization outcome requires an observedAt timestamp');
  }
  /** @type {FinalizationOutcome} */
  const outcome = { decision, status, action, observedAt };
  if (detail != null) outcome.detail = detail;
  return outcome;
}

/**
 * Structural validation of a decision: a known kind, provenance present, and a
 * fold timestamp. Used by executors that ingest decisions from another process
 * (e.g. MA-v2 shadow) before acting on them.
 *
 * @param {unknown} value
 * @returns {value is FinalizationDecision}
 */
export function isFinalizationDecision(value) {
  if (!value || typeof value !== 'object') return false;
  const decision = /** @type {FinalizationDecision} */ (value);
  if (!FINALIZATION_DECISION_KINDS.includes(decision.kind)) return false;
  if (!decision.subjectRef || typeof decision.subjectRef.domainId !== 'string') return false;
  if (typeof decision.revisionRef !== 'string') return false;
  if (typeof decision.observedAt !== 'string' || decision.observedAt === '') return false;
  return true;
}
