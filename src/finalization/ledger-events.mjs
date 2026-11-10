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

import { WORKFLOW_EVENT_FIELDS } from './workflow-state.mjs';

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
  'launch_custody_observed',
  ...Object.keys(WORKFLOW_EVENT_FIELDS),
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
  'launch_custody_observed',
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
  launch_custody_observed: ['revisionRef', 'sourceRef', 'idempotencyKey', 'custody'],
  ...Object.fromEntries(Object.entries(WORKFLOW_EVENT_FIELDS)
    .map(([type, fields]) => [type, ['sourceRef', 'idempotencyKey', ...fields]])),
});

// The optional fields each event type may carry (copied through when present).
const OPTIONAL_FIELDS = Object.freeze({
  revision_advanced: ['sourceRef'],
  verdict_recorded: [],
  checks_settled: [],
  attestation_recorded: [],
  remediation_dispatched: ['stageId', 'final', 'sourceRef', 'admittedAt', 'operationId'],
  remediation_concluded: ['stageId', 'sourceRef', 'coverageValidated', 'workId', 'operationId'],
  budget_exhausted: ['sourceRef'],
  operator_override: ['revisionRef', 'roundCap', 'sourceRef'],
  finalized: ['sourceRef'],
  closed: ['sourceRef'],
  escalated: ['sourceRef', 'episode'],
  halted: ['sourceRef', 'policyVersion', 'codeVersion'],
  launch_custody_observed: [],
  ...Object.fromEntries(Object.keys(WORKFLOW_EVENT_FIELDS).map(type => [type, ['revisionRef']])),
});

function assertRequired(type, fields) {
  for (const key of ['workId', 'operationId']) {
    if (fields[key] !== undefined && (!isNonEmptyString(fields[key]) || Object.hasOwn(Object.prototype, fields[key]))) {
      throw new TypeError(`invalid workflow ${key}`);
    }
  }
  if (type === 'remediation_concluded' && fields.coverageValidated !== undefined
    && typeof fields.coverageValidated !== 'boolean') throw new TypeError('invalid coverage validation');
  for (const key of REQUIRED_FIELDS[type]) {
    const value = fields[key];
    if (value === undefined || value === null || value === '') {
      throw new TypeError(`finalization ${type} event requires a non-empty ${key}`);
    }
  }
  if (Object.hasOwn(WORKFLOW_EVENT_FIELDS, type)) {
    if (!Number.isFinite(Date.parse(fields.at)) || !isNonEmptyString(fields.sourceRef)
      || !isNonEmptyString(fields.idempotencyKey)) throw new TypeError('invalid workflow provenance');
    for (const key of ['episode', 'workId', 'operationId', 'custodySourceRef', 'mergeSourceRef']) {
      if (fields[key] !== undefined && (typeof fields[key] !== 'string' || !fields[key] || Object.hasOwn(Object.prototype, fields[key]))) {
        throw new TypeError(`invalid workflow ${key}`);
      }
    }
    if (type === 'operation_observed' && !['absent', 'admitted', 'completed', 'failed', 'merged'].includes(fields.outcome)) {
      throw new TypeError('invalid operation observation');
    }
    if (type === 'work_consumed' && !['completed', 'findings'].includes(fields.outcome)) throw new TypeError('useful work conclusion required');
    if (type === 'decision_anchored'
      && (!Number.isFinite(Date.parse(fields.anchorAt))
        || ![fields.nominalMs, fields.effectiveMs, fields.ceilingMs].every(n => Number.isFinite(n) && n > 0)
        || fields.effectiveMs > fields.ceilingMs)) throw new TypeError('invalid decision deadline');
    if (type === 'custody_recovered'
      && (fields.teardown !== 'completed' || !isNonEmptyString(fields.patchRef)
        || !isNonEmptyString(fields.successor))) throw new TypeError('custody release requires salvage and successor');
    if (type === 'provenance_observed'
      && (!['preserved', 'unknown', 'missing'].includes(fields.primaryChange)
        || typeof fields.hammerCommits !== 'boolean' || typeof fields.mergeMain !== 'boolean')) {
      throw new TypeError('invalid primary provenance');
    }
    if (type === 'merge_observed' && typeof fields.planRequired !== 'boolean') throw new TypeError('merge requires plan disposition');
    if (type === 'delivery_observed' && !['pending', 'failed', 'verified', 'not-required'].includes(fields.activation)) {
      throw new TypeError('invalid delivery activation');
    }
  }
  if (type === 'remediation_dispatched' && fields.admittedAt !== undefined && !Number.isFinite(Date.parse(fields.admittedAt))) {
    throw new TypeError('invalid admission timestamp');
  }
  if (type === 'launch_custody_observed') {
    const c = fields.custody;
    if (!c || typeof c !== 'object' || Array.isArray(c)
      || typeof c.launchRequestId !== 'string' || !c.launchRequestId
      || !isNonEmptyString(fields.revisionRef) || !isNonEmptyString(fields.sourceRef)
      || !isNonEmptyString(fields.idempotencyKey)
      || typeof c.repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(c.repository)
      || !Number.isSafeInteger(c.prNumber) || c.prNumber < 1
      || !['requested', 'admitted', 'leased', 'starting', 'running', 'deferred', 'refused',
        'terminal', 'workspace', 'waiting_approval', 'waiting_input', 'suspended'].includes(c.state)
      || !Number.isFinite(Date.parse(fields.at)) || c.at !== fields.at
      || !Number.isFinite(c.freshnessSeconds) || c.freshnessSeconds <= 0 || c.freshnessSeconds > 180
      || (c.state === 'workspace' && (!['live', 'terminal', 'unknown'].includes(c.launchLiveness)
        || ![true, false, null].includes(c.dirty)))) {
      throw new TypeError('invalid launch custody observation');
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
  if (type === 'launch_custody_observed'
    && (subjectKey.domainId !== 'code-pr'
      || subjectKey.subjectExternalId !== `${fields.custody.repository}#${fields.custody.prNumber}`)) {
    throw new TypeError('custody subject mismatch');
  }

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
    makeFinalizationEvent(event.type, event.subjectKey, event);
  } catch {
    return false;
  }
  return true;
}

/** Whether an event type is pinned to a revision (fold indexes it per-rev). */
export function isRevisionScopedEvent(type) {
  return REVISION_SCOPED_SET.has(type);
}

// Lane vocabulary is separate from subject eligibility: a queue acknowledgement
// is never review evidence or authority to merge.
export const QUEUE_PHASES = Object.freeze([
  'acknowledged', 'ready', 'rebasing', 'publishing', 'waiting-checks',
  'finalizing', 'merged', 'parked-hold', 'parked-permission',
  'parked-infrastructure', 'returned-to-closer', 'closed-observed',
]);
export const QUEUE_ACTIONABLE_PHASES = Object.freeze(QUEUE_PHASES.slice(0, 6));
export const QUEUE_EVENT_TYPES = Object.freeze([
  'acknowledged', 'progress', 'operation-intent', 'operation-result',
  'owner-claimed', 'owner-renewed', 'owner-released', 'owner-parked',
]);

export function resolveLaneKey({ repository, base } = {}) {
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new TypeError('lane requires repository full name');
  }
  // Repository names are case insensitive; Git refs are not. Accept only short
  // branch refs to avoid aliasing main and refs/heads/main into separate lanes.
  if (typeof base !== 'string' || !base || base.startsWith('refs/')
    || base.startsWith('/') || base.endsWith('/') || base.endsWith('.')
    || base.includes('..') || base.includes('@{') || base === '@'
    || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(base)
    || base.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))) {
    throw new TypeError('lane requires a short, valid base branch ref');
  }
  return { repository: repository.toLowerCase(), base };
}

export function makeQueueEvent(type, lane, fields) {
  if (!QUEUE_EVENT_TYPES.includes(type)) throw new TypeError('unknown queue event');
  if (!Number.isFinite(Date.parse(fields?.at))) throw new TypeError('queue event requires at');
  return { ...fields, type, lane: resolveLaneKey(lane) };
}
