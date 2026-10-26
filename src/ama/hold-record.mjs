import { writeFileAtomic } from '../atomic-write.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

// Evidence collection stays with the existing owners. This module only decides
// whether their observations satisfy a durable predicate. Evaluation performs no I/O.
const polls = new AsyncLocalStorage();
const deliveredEscalations = new Set();
export const MAX_HOLD_ESCALATIONS = 10_000;
const dimensions = { head: 'headSha', base: 'baseSha', mergeability: 'mergeability', checks: 'checks', review: 'review' };
const kinds = new Set([...Object.keys(dimensions).map(name => `${name}-change`),
  'event', 'retry-at', 'companion-merged', 'gitlink-contains-commit']);
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

export function assertHoldRecord(record) {
  if (!record || typeof record.owner !== 'string' || !record.owner.trim()) throw new TypeError('hold requires owner');
  if (!iso(record.deadline)) throw new TypeError('hold requires ISO deadline');
  if (typeof record.reason !== 'string' || !record.reason.trim()) throw new TypeError('hold requires reason');
  if (typeof record.onDeadline !== 'string' || !record.onDeadline.trim()) throw new TypeError('hold requires onDeadline');
  if (!Array.isArray(record.awaits) || !record.awaits.length) throw new TypeError('hold requires awaits');
  for (const predicate of record.awaits) {
    if (!kinds.has(predicate?.kind)) throw new TypeError('unknown hold predicate');
    if (predicate.kind === 'event' && (typeof predicate.name !== 'string' || !predicate.name.trim())) throw new TypeError('hold event requires name');
    if (predicate.kind === 'retry-at' && !iso(predicate.at)) throw new TypeError('hold retry requires ISO time');
  }
  return record;
}

export function writeHoldRecord(path, record) {
  assertHoldRecord(record);
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function createHoldRecord(record) {
  return assertHoldRecord({ ...record, holdVersion: 1 });
}

// Defaults are supplied by the legacy owner, using its existing page horizon.
// Already-versioned records are validated, never silently repaired at write time.
export function normalizeHoldRecord(record, defaults) {
  if (record?.holdVersion === 1) return assertHoldRecord(record);
  return createHoldRecord({ ...defaults, ...record,
    owner: record?.owner || defaults.owner,
    deadline: record?.deadline || defaults.deadline,
    onDeadline: record?.onDeadline || defaults.onDeadline,
    reason: record?.reason || defaults.reason,
    awaits: record?.awaits || defaults.awaits });
}

export function inputChangePredicates(inputs = {}) {
  return Object.entries(dimensions).map(([name, field]) => ({ kind: `${name}-change`, from: inputs[field] ?? null }));
}

export function holdRecordKey(record) {
  return JSON.stringify([record.holdType, record.repo, record.prNumber, record.headSha || null]);
}

function escalationKey(record, scope) {
  const dependency = record.mode === 'companion'
    ? [record.companionWait?.repo, record.companionWait?.prNumber, record.companionWait?.submodulePath]
    : [record.refusal?.key, record.refusalGeneration];
  return JSON.stringify([scope, holdRecordKey(record), dependency]);
}

export function markHoldEscalated(record, scope = '') {
  const key = escalationKey(record, scope);
  if (!deliveredEscalations.has(key) && deliveredEscalations.size >= MAX_HOLD_ESCALATIONS) {
    deliveredEscalations.delete(deliveredEscalations.values().next().value);
  }
  deliveredEscalations.add(key);
}

export function holdEscalatedInProcess(record, scope = '') {
  return deliveredEscalations.has(escalationKey(record, scope));
}

export function resetHoldEscalationsForTests() { deliveredEscalations.clear(); }

export async function withHoldRecordPoll(run) {
  if (polls.getStore()?.open) return run();
  const scope = { results: new Map(), open: true };
  try { return await polls.run(scope, run); }
  finally { scope.open = false; scope.results.clear(); }
}

export function holdEvaluatedThisPoll(record, namespace = '') {
  const scope = polls.getStore();
  return Boolean(scope?.open && scope.results.has(JSON.stringify([namespace, holdRecordKey(record)])));
}

function evaluatePredicates(awaits, { now, inputs = {}, events = {}, companionWait, evidenceUnreadable = false }) {
  const changed = [];
  for (const predicate of awaits) {
    const dimension = predicate.kind.replace(/-change$/, '');
    const field = dimensions[dimension];
    let fired = false;
    if (field) {
      const value = inputs[field];
      fired = ['checks', 'review'].includes(dimension)
        ? typeof value === 'string' && typeof predicate.from === 'string' && value !== predicate.from
        : Boolean(value) && (dimension !== 'mergeability' || ['MERGEABLE', 'CONFLICTING'].includes(value)) && value !== predicate.from;
    } else if (predicate.kind === 'event') fired = (!predicate.fallback || changed.length === 0) && events[predicate.name] === true;
    else if (predicate.kind === 'retry-at') fired = (!predicate.fallback || changed.length === 0) && Date.parse(now) >= Date.parse(predicate.at);
    else if (!evidenceUnreadable && companionWait) {
      const same = (!predicate.repo || predicate.repo === companionWait.repo)
        && (!predicate.prNumber || predicate.prNumber === companionWait.prNumber)
        && (!predicate.submodulePath || predicate.submodulePath === companionWait.submodulePath);
      if (same && predicate.kind === 'companion-merged') fired = companionWait.state === 'merged';
      if (same && predicate.kind === 'gitlink-contains-commit') fired = companionWait.state === 'merged'
        && companionWait.containsMerge === true && Boolean(companionWait.mergeCommit)
        && (!predicate.commit || predicate.commit === companionWait.mergeCommit);
    }
    if (fired) changed.push(predicate.changed || (field ? dimension : predicate.name || predicate.kind));
  }
  return changed;
}

export function changedHoldInputs(previous, current) {
  return previous && current ? evaluatePredicates(inputChangePredicates(previous), { inputs: current }) : [];
}

export function evaluateHoldRecord(record, { now = new Date().toISOString(), inputs = {}, events = {}, companionWait,
  evidenceUnreadable = false, namespace = '' } = {}) {
  assertHoldRecord(record);
  const scope = polls.getStore()?.open ? polls.getStore().results : null;
  const key = JSON.stringify([namespace, holdRecordKey(record)]);
  // Reuse only identical observations. Owners can collect fresh evidence or
  // persist a release/escalation receipt after an earlier evaluation this poll.
  const signature = JSON.stringify([record, now, inputs, events, companionWait, evidenceUnreadable,
    holdEscalatedInProcess(record, namespace)]);
  const cached = scope?.get(key);
  if (cached?.signature === signature) return cached.result;
  const changed = record.releasedAt || record.clearedAt ? []
    : evaluatePredicates(record.awaits, { now, inputs, events, companionWait, evidenceUnreadable });
  const released = Boolean(record.releasedAt || record.clearedAt || changed.length);
  const result = { action: released ? 'release' : 'hold', changed: record.releasedBy || changed,
    escalate: !released && !record.escalatedAt && !record.pagedAt && !record.alertedAt && !(record.holdType === 'stacked-base' && record.commentedAt)
      && !holdEscalatedInProcess(record, namespace)
      && Date.parse(now) >= Date.parse(record.deadline) };
  scope?.set(key, { signature, result });
  return result;
}
