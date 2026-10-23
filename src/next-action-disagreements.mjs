// NXA-02 rollout evidence: a bounded, read-only classification report over the
// shadow disagreement log (src/pr-next-action-shadow.mjs). The authorized
// rollout owner keeps dispositions in their own private file, keyed by case;
// this module never writes. Its sufficiency line is human rollout acceptance
// guidance, not a CI, runtime or pre-push gate, and grants no switch authority.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { caseKeyOf } from './pr-next-action-shadow.mjs';

export const NEXT_ACTION_ROLLOUT_DISTINCT_CASES = 20;
export const NEXT_ACTION_REPORT_MAX_BYTES = 64 * 1024 * 1024;
export const NEXT_ACTION_REPORT_DEFAULT_BYTES = 8 * 1024 * 1024;
const KNOWN_DISPOSITIONS = new Set(['candidate-mistake', 'expected-correction', 'needs-investigation']);

// Read at most `maxBytes` from the end of the log. A partial first line is dropped.
export function readShadowLogTail(file, { maxBytes = NEXT_ACTION_REPORT_DEFAULT_BYTES, fsImpl = { openSync, fstatSync, readSync, closeSync } } = {}) {
  const limit = Math.max(1, Math.min(Number(maxBytes) || NEXT_ACTION_REPORT_DEFAULT_BYTES, NEXT_ACTION_REPORT_MAX_BYTES));
  let fd;
  try { fd = fsImpl.openSync(file, 'r'); } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], bytes: 0, truncated: false, missing: true };
    throw error;
  }
  try {
    const size = fsImpl.fstatSync(fd).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    fsImpl.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    return { lines: lines.filter(Boolean), bytes: length, truncated: size > length, missing: false };
  } finally { fsImpl.closeSync(fd); }
}

export function readDispositions(file, { readFileImpl = readFileSync } = {}) {
  if (!file) return {};
  const parsed = JSON.parse(String(readFileImpl(file, 'utf8')));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('dispositions must be a JSON object keyed by caseKey');
  return parsed;
}

const transitionOf = record => `${record.legacy?.action}/${record.legacy?.actor} -> ${record.next?.action}/${record.next?.actor}`;
const increment = (map, key) => { map[key] = (map[key] || 0) + 1; };

/**
 * Group shadow records into distinct cases (repeats of one case count once) and
 * summarize dispositions. `aggregate` omits every subject key, head and case
 * key, leaving only anonymous counts suitable for publication.
 */
export function classifyDisagreements(lines, { dispositions = {}, aggregate = false, limit = 200, source = null } = {}) {
  const cases = new Map();
  const overdue = { count: 0, byAction: {} };
  let malformed = 0;
  let records = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { malformed++; continue; }
    if (!record || typeof record !== 'object' || !record.next) { malformed++; continue; }
    if (source && record.source !== source) continue;
    records++;
    if (record.kind === 'overdue') {
      overdue.count++;
      increment(overdue.byAction, `${record.next.action}/${record.next.actor}`);
      continue;
    }
    if (record.kind !== 'disagreement' || !record.legacy) { malformed++; continue; }
    const caseKey = typeof record.caseKey === 'string' ? record.caseKey : caseKeyOf(record);
    let entry = cases.get(caseKey);
    if (!entry) {
      entry = { caseKey, subjectKey: record.subjectKey ?? null, head: record.head ?? null, sources: new Set(),
        occurrences: 0, firstSeen: record.observedAt ?? null, lastSeen: record.observedAt ?? null,
        legacy: record.legacy, next: { action: record.next.action, actor: record.next.actor, reason: record.next.reason,
          row: record.next.row ?? null }, fields: record.fields ?? [] };
      cases.set(caseKey, entry);
    }
    entry.occurrences++;
    entry.sources.add(record.source ?? 'unknown');
    if (record.observedAt && (!entry.lastSeen || record.observedAt > entry.lastSeen)) entry.lastSeen = record.observedAt;
    if (record.observedAt && (!entry.firstSeen || record.observedAt < entry.firstSeen)) entry.firstSeen = record.observedAt;
  }
  const bySource = {};
  const byTransition = {};
  const byRow = {};
  const byDisposition = {};
  for (const entry of cases.values()) {
    for (const name of entry.sources) increment(bySource, name);
    increment(byTransition, transitionOf(entry));
    increment(byRow, entry.next.row || 'unknown');
    const raw = dispositions[entry.caseKey];
    entry.disposition = typeof raw === 'string' && raw ? raw : null;
    increment(byDisposition, entry.disposition ? (KNOWN_DISPOSITIONS.has(entry.disposition) ? entry.disposition : 'other') : 'unclassified');
  }
  const classified = [...cases.values()].filter(entry => entry.disposition).length;
  const report = {
    schema: 'nxa-disagreements/v1',
    scanned: { records, malformed },
    distinctCases: cases.size,
    bySource, byTransition, byRow, byDisposition, overdue,
    rollout: {
      requiredDistinctLiveCases: NEXT_ACTION_ROLLOUT_DISTINCT_CASES,
      classifiedDistinctCases: classified,
      includesCandidateMistake: (byDisposition['candidate-mistake'] || 0) > 0,
      includesExpectedCorrection: (byDisposition['expected-correction'] || 0) > 0,
      evidenceSufficient: classified >= NEXT_ACTION_ROLLOUT_DISTINCT_CASES
        && (byDisposition['candidate-mistake'] || 0) > 0 && (byDisposition['expected-correction'] || 0) > 0,
      note: 'Human rollout acceptance only. Legacy decideClosureOwner keeps authority until an authorized switch.',
    },
  };
  if (!aggregate) {
    report.cases = [...cases.values()]
      .sort((left, right) => String(right.lastSeen).localeCompare(String(left.lastSeen)))
      .slice(0, Math.max(0, Number(limit) || 0))
      .map(entry => ({ ...entry, sources: [...entry.sources].sort() }));
  }
  return report;
}
