// Merge Authority v2 finalization event vocabulary (ARC-15;
// docs/SPEC-merge-authority-v2.md §2). Pure, runtime-free constructors and
// validators for the append-only per-subject ledger. Actors only ever APPEND
// observations of these shapes; eligibility is a pure fold over them
// (`ledger-fold.mjs` → `eligibility.mjs`). No I/O, no clock, no randomness —
// every event carries its own `at` timestamp so time enters the fold only as
// data, and every external fact carries its `sourceRef` provenance so "verdict
// at head" is verified by construction rather than by scraping a log line.
//
// Contract shapes live in `../kernel/contracts.d.ts` (FinalizationEvent*).

/**
 * @typedef {import('../kernel/contracts.js').SubjectRef} SubjectRef
 * @typedef {import('../kernel/contracts.js').FinalizationEvent} FinalizationEvent
 * @typedef {import('../kernel/contracts.js').FinalizationEventType} FinalizationEventType
 * @typedef {import('../kernel/contracts.js').SubjectKey} SubjectKey
 */

/**
 * The append-only event vocabulary (merge-authority-v2 §2). Order is stable and
 * exported so the store, the fold, and tests agree on exactly one set.
 */
export const FINALIZATION_EVENT_TYPES = Object.freeze([
  'revision_advanced',
  'verdict_recorded',
  'checks_settled',
  'attestation_recorded',
  'remediation_dispatched',
  'remediation_concluded',
  'budget_exhausted',
  'operator_override',
  'finalized',
  'closed',
  'escalated',
  'halted',
]);

const EVENT_TYPE_SET = new Set(FINALIZATION_EVENT_TYPES);

/** Events pinned to a specific revision (fold indexes them under `revisionRef`). */
export const REVISION_SCOPED_EVENT_TYPES = Object.freeze([
  'revision_advanced',
  'verdict_recorded',
  'checks_settled',
  'attestation_recorded',
  'remediation_dispatched',
  'remediation_concluded',
  'finalized',
]);

const REVISION_SCOPED_SET = new Set(REVISION_SCOPED_EVENT_TYPES);

/** Terminal marks — a finalized/closed subject is done; escalated/halted page. */
export const TERMINAL_EVENT_TYPES = Object.freeze(['finalized', 'closed', 'escalated', 'halted']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Resolve a subject identity from a `SubjectRef`, a `SubjectState`, or a bare
 * `{ domainId, subjectExternalId }`. The ledger keys every row on this pair.
 *
 * @param {SubjectRef | { ref?: SubjectRef } | SubjectKey} subject
 * @returns {SubjectKey}
 */
export function resolveSubjectKey(subject) {
  const ref = subject && typeof subject === 'object' && 'ref' in subject && subject.ref
    ? subject.ref
    : subject;
  if (!ref || typeof ref !== 'object') {
    throw new TypeError('finalization event requires a subject with domainId + subjectExternalId');
  }
  const domainId = ref.domainId;
  const subjectExternalId = ref.subjectExternalId;
  if (!isNonEmptyString(domainId) || !isNonEmptyString(subjectExternalId)) {
    throw new TypeError('finalization event requires a subject with domainId + subjectExternalId');
  }
  return { domainId, subjectExternalId };
}

// Per-type required fields beyond the common `{ subjectKey, at }`. `sourceRef`
// is required on the external-fact events so provenance can never be dropped.
const REQUIRED_FIELDS = Object.freeze({
  revision_advanced: ['revisionRef'],
  verdict_recorded: ['revisionRef', 'stageId', 'role', 'verdictKind', 'sourceRef'],
  checks_settled: ['revisionRef', 'conclusion', 'requiredChecksPresent', 'sourceRef'],
  attestation_recorded: ['revisionRef', 'kind', 'principal', 'sourceRef'],
  remediation_dispatched: ['revisionRef', 'round', 'idempotencyKey'],
  remediation_concluded: ['revisionRef', 'round', 'outcome'],
  budget_exhausted: ['stageId'],
  operator_override: ['overrideKind', 'principal', 'reason'],
  finalized: ['revisionRef', 'method'],
  closed: ['reason'],
  escalated: ['reason'],
  halted: ['reason'],
});

// The optional fields each event type may carry (copied through when present).
const OPTIONAL_FIELDS = Object.freeze({
  revision_advanced: ['sourceRef'],
  verdict_recorded: [],
  checks_settled: [],
  attestation_recorded: [],
  remediation_dispatched: ['stageId', 'final', 'sourceRef'],
  remediation_concluded: ['stageId', 'sourceRef'],
  budget_exhausted: ['sourceRef'],
  operator_override: ['revisionRef', 'roundCap', 'sourceRef'],
  finalized: ['sourceRef'],
  closed: ['sourceRef'],
  escalated: ['sourceRef'],
  halted: ['sourceRef'],
});

function assertRequired(type, fields) {
  for (const key of REQUIRED_FIELDS[type]) {
    const value = fields[key];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`finalization ${type} event requires a non-empty ${key}`);
    }
  }
  // `requiredChecksPresent` and `final` are booleans — validate shape, not truthiness.
  if (type === 'checks_settled' && typeof fields.requiredChecksPresent !== 'boolean') {
    throw new TypeError('finalization checks_settled event requires a boolean requiredChecksPresent');
  }
  if (type === 'remediation_dispatched' && fields.final !== undefined
    && typeof fields.final !== 'boolean') {
    throw new TypeError('finalization remediation_dispatched event requires a boolean final');
  }
  if ((type === 'remediation_dispatched' || type === 'remediation_concluded')
    && !Number.isInteger(fields.round)) {
    throw new TypeError(`finalization ${type} event requires an integer round`);
  }
}

/**
 * Build a validated, plain `FinalizationEvent`. Pure: no `seq` is assigned here
 * (the store assigns it on append) and no clock is read — `at` is required.
 *
 * @param {FinalizationEventType} type
 * @param {SubjectRef | SubjectKey} subject
 * @param {{ at: string } & Record<string, unknown>} fields
 * @returns {FinalizationEvent}
 */
export function makeFinalizationEvent(type, subject, fields = {}) {
  if (!EVENT_TYPE_SET.has(type)) {
    throw new TypeError(`unknown finalization event type: ${JSON.stringify(type)}`);
  }
  if (!isNonEmptyString(fields.at)) {
    throw new TypeError('finalization event requires an `at` ISO timestamp');
  }
  const subjectKey = resolveSubjectKey(subject);
  assertRequired(type, fields);

  /** @type {FinalizationEvent} */
  const event = { type, subjectKey, at: fields.at };
  for (const key of [...REQUIRED_FIELDS[type], ...OPTIONAL_FIELDS[type]]) {
    const value = fields[key];
    if (value !== undefined && value !== null) event[key] = value;
  }
  return event;
}

// Thin per-type constructors — the ergonomic call sites. Each forwards to
// `makeFinalizationEvent`, so the vocabulary and validation live in one place.
export const revisionAdvanced = (subject, fields) => makeFinalizationEvent('revision_advanced', subject, fields);
export const verdictRecorded = (subject, fields) => makeFinalizationEvent('verdict_recorded', subject, fields);
export const checksSettled = (subject, fields) => makeFinalizationEvent('checks_settled', subject, fields);
export const attestationRecorded = (subject, fields) => makeFinalizationEvent('attestation_recorded', subject, fields);
export const remediationDispatched = (subject, fields) => makeFinalizationEvent('remediation_dispatched', subject, fields);
export const remediationConcluded = (subject, fields) => makeFinalizationEvent('remediation_concluded', subject, fields);
export const budgetExhausted = (subject, fields) => makeFinalizationEvent('budget_exhausted', subject, fields);
export const operatorOverride = (subject, fields) => makeFinalizationEvent('operator_override', subject, fields);
export const finalized = (subject, fields) => makeFinalizationEvent('finalized', subject, fields);
export const closed = (subject, fields) => makeFinalizationEvent('closed', subject, fields);
export const escalated = (subject, fields) => makeFinalizationEvent('escalated', subject, fields);
export const halted = (subject, fields) => makeFinalizationEvent('halted', subject, fields);

/**
 * Structural validation of an event read back from the store (or crossing a
 * process boundary) before the fold ingests it.
 *
 * @param {unknown} value
 * @returns {value is FinalizationEvent}
 */
export function isFinalizationEvent(value) {
  if (!value || typeof value !== 'object') return false;
  const event = /** @type {FinalizationEvent} */ (value);
  if (!EVENT_TYPE_SET.has(event.type)) return false;
  if (!isNonEmptyString(event.at)) return false;
  try {
    resolveSubjectKey(event.subjectKey);
    assertRequired(event.type, event);
  } catch {
    return false;
  }
  return true;
}

/** Whether an event type is pinned to a revision (fold indexes it per-rev). */
export function isRevisionScopedEvent(type) {
  return REVISION_SCOPED_SET.has(type);
}
