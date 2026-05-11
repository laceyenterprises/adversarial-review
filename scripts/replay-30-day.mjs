#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { buildCodePrSubjectIdentity, CODE_PR_DOMAIN_ID } from '../src/identity-shapes.mjs';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../src/kernel/verdict.mjs';

const DEFAULT_WINDOW_DAYS = 30;
const REPLAY_SNAPSHOT_SCHEMA_VERSION = 1;
const TERMINAL_JOB_DIRS = ['completed', 'failed', 'stopped'];
const OPERATOR_OVERRIDE_TYPES = new Set([
  'force-rereview',
  'operator-approved',
  'halted',
  'raised-round-cap',
  'merge-agent-requested',
]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeDays(value) {
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS;
}

function normalizeRoundCap(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

function windowStart({ now = new Date(), days = DEFAULT_WINDOW_DAYS, since = null } = {}) {
  const explicit = iso(since);
  if (explicit) return explicit;
  return new Date(now.getTime() - normalizeDays(days) * 24 * 60 * 60 * 1000).toISOString();
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareStable(a, b) {
  const left = stableStringify(a);
  const right = stableStringify(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function subjectIdentityFromParts({
  domainId = null,
  domain_id = null,
  subjectExternalId = null,
  subject_external_id = null,
  revisionRef = null,
  revision_ref = null,
  repo = null,
  prNumber = null,
  pr_number = null,
} = {}) {
  const legacy = buildCodePrSubjectIdentity({
    repo,
    prNumber: prNumber ?? pr_number,
    revisionRef: revisionRef ?? revision_ref,
  });
  return {
    domainId: domainId ?? domain_id ?? legacy.domainId ?? null,
    subjectExternalId: subjectExternalId ?? subject_external_id ?? legacy.subjectExternalId ?? null,
    revisionRef: revisionRef ?? revision_ref ?? legacy.revisionRef ?? null,
    repo: repo ?? null,
    prNumber: prNumber ?? pr_number ?? null,
  };
}

function subjectKey(identity = {}) {
  const normalized = subjectIdentityFromParts(identity);
  if (normalized.domainId && normalized.subjectExternalId && normalized.revisionRef) {
    return `${normalized.domainId}:${normalized.subjectExternalId}@${normalized.revisionRef}`;
  }
  if (normalized.repo && normalized.prNumber) {
    // Include revisionRef in the legacy key so two legacy-shaped records
    // for the same PR at different SHAs don't collapse into one subject
    // and get merged across revisions. Legacy paths are dying out but
    // still present in 30-day windows during rollout.
    return `legacy:${normalized.repo}#${normalized.prNumber}@${normalized.revisionRef || 'no-revision'}`;
  }
  return 'unknown-subject';
}

function dedupeSorted(values = []) {
  return Array.from(new Set(values)).sort();
}

function recordParseError(parseErrors, error) {
  parseErrors.push({
    source: error.source,
    file: error.file || null,
    message: error.message,
  });
}

function normalizeVerdictState(record = {}) {
  const direct = record.verdictState
    ?? record.verdict_state
    ?? record.state
    ?? record.kind
    ?? record.verdict?.state
    ?? record.verdict?.kind
    ?? null;
  const normalizedDirect = normalizeReviewVerdict(direct);
  if (normalizedDirect) return normalizedDirect;

  const body = record.reviewBody
    ?? record.review_body
    ?? record.body
    ?? record.verdict?.body
    ?? record.verdictBody
    ?? null;
  if (!body) return 'unknown';

  try {
    return normalizeReviewVerdict(extractReviewVerdict(sanitizeCodexReviewPayload(String(body)))) || 'unknown';
  } catch {
    try {
      return normalizeReviewVerdict(extractReviewVerdict(String(body))) || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

function mergeVerdictStates(...states) {
  const verdictStates = Array.from(new Set(states.filter((value) => value && value !== 'unknown'))).sort();
  if (verdictStates.length === 0) return { verdictState: 'unknown', verdictStates };
  if (verdictStates.length === 1) return { verdictState: verdictStates[0], verdictStates };
  return { verdictState: 'conflict', verdictStates };
}

function entryText(entry) {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';
  const pieces = [
    entry.title,
    entry.finding,
    entry.action,
    entry.reasoning,
    entry.needsHumanInput,
    Array.isArray(entry.files) ? entry.files.join(',') : null,
  ].filter((part) => typeof part === 'string' && part.trim());
  return pieces.join(' | ').trim();
}

function normalizeReplyEntries(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(entryText)
    .filter(Boolean)
    .sort();
}

function normalizeRemediationClassification(record = {}) {
  const reply = record.remediationReply
    ?? record.remediation_reply
    ?? record.reply
    ?? record.latestRemediationReply
    ?? record;
  return {
    addressed: normalizeReplyEntries(reply?.addressed),
    pushback: normalizeReplyEntries(reply?.pushback),
    blockers: normalizeReplyEntries(reply?.blockers),
  };
}

function normalizeDeliveryKind(kind) {
  const value = String(kind ?? '').trim();
  if (value === 'review') return 'review-verdict';
  return value || 'unknown';
}

function normalizeDeliveryRecord(row = {}, subjectFallback = {}) {
  const key = row.key || row.deliveryKey || {};
  const identity = subjectIdentityFromParts({
    domainId: key.domainId ?? row.domainId ?? row.domain_id ?? subjectFallback.domainId ?? subjectFallback.domain_id,
    subjectExternalId: key.subjectExternalId
      ?? row.subjectExternalId
      ?? row.subject_external_id
      ?? subjectFallback.subjectExternalId
      ?? subjectFallback.subject_external_id,
    revisionRef: key.revisionRef
      ?? row.revisionRef
      ?? row.revision_ref
      ?? subjectFallback.revisionRef
      ?? subjectFallback.revision_ref,
    repo: row.legacy_repo ?? row.repo ?? subjectFallback.repo,
    prNumber: row.legacy_pr_number ?? row.prNumber ?? row.pr_number ?? subjectFallback.prNumber ?? subjectFallback.pr_number,
  });
  return {
    subject: `${identity.domainId || 'legacy'}:${identity.subjectExternalId || `${identity.repo}#${identity.prNumber}`}`,
    revisionRef: identity.revisionRef || null,
    round: Number(key.round ?? row.round ?? 0),
    kind: normalizeDeliveryKind(key.kind ?? key.deliveryKind ?? row.kind ?? row.deliveryKind ?? row.delivery_kind),
    noticeRef: key.noticeRef ?? row.noticeRef ?? row.notice_ref ?? null,
  };
}

function deliverySet(rows = [], subjectFallback = {}) {
  return rows
    .map((row) => normalizeDeliveryRecord(row, subjectFallback))
    .filter((row) => row.subject && Number.isInteger(row.round) && row.kind !== 'unknown')
    .sort(compareStable);
}

function deliveryIdentity(row) {
  return [
    row.subject,
    row.revisionRef || '',
    row.round,
    row.kind,
    row.noticeRef || '',
  ].join('|');
}

function findDuplicateDeliveries(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    const key = deliveryIdentity(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }))
    .sort(compareStable);
}

function normalizeOperatorOverrideEvent(event = {}, setContext = {}, subjectFallback = {}) {
  const type = String(event.type ?? event.overrideType ?? event.labelName ?? '').trim();
  if (!OPERATOR_OVERRIDE_TYPES.has(type)) return null;
  const observedRevisionRef = event.revisionRef
    ?? event.observedRevisionRef
    ?? event.observed_revision_ref
    ?? setContext.observedRevisionRef
    ?? setContext.observed_revision_ref
    ?? null;
  const currentRevisionRef = setContext.currentRevisionRef
    ?? setContext.expectedRevisionRef
    ?? setContext.expected_revision_ref
    ?? subjectFallback.revisionRef
    ?? subjectFallback.revision_ref
    ?? null;
  if (!observedRevisionRef || String(observedRevisionRef) !== String(currentRevisionRef || '')) {
    return null;
  }

  const subject = subjectIdentityFromParts({
    ...subjectFallback,
    ...(event.subjectRef || setContext.subjectRef || {}),
    revisionRef: currentRevisionRef,
  });
  return {
    type,
    subject: `${subject.domainId || CODE_PR_DOMAIN_ID}:${subject.subjectExternalId || `${subject.repo}#${subject.prNumber}`}`,
    observedRevisionRef: String(observedRevisionRef),
    expectedRevisionRef: currentRevisionRef ? String(currentRevisionRef) : null,
    eventExternalId: event.eventExternalId ?? event.eventId ?? event.id ?? null,
    roundCap: normalizeRoundCap(event.roundCap),
  };
}

function normalizeApprovalOverrides(record = {}, subjectFallback = {}) {
  const source = record.approvalOverrides
    ?? record.approval_overrides
    ?? record.operatorOverrides
    ?? record.operator_overrides
    ?? record.overrides
    ?? [];
  const sets = Array.isArray(source) ? source : [source];
  const events = [];
  for (const overrideSet of sets) {
    if (!overrideSet || typeof overrideSet !== 'object') continue;
    const candidates = Array.isArray(overrideSet.events) ? overrideSet.events : [];
    if (candidates.length) {
      for (const event of candidates) {
        const normalized = normalizeOperatorOverrideEvent(event, overrideSet, subjectFallback);
        if (normalized) events.push(normalized);
      }
      continue;
    }
    for (const type of OPERATOR_OVERRIDE_TYPES) {
      const camel = type.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (overrideSet[camel] || overrideSet[type]) {
        const normalized = normalizeOperatorOverrideEvent({ type }, overrideSet, subjectFallback);
        if (normalized) events.push(normalized);
      }
    }
  }
  return events.sort(compareStable);
}

function normalizeReplayRecord(record = {}) {
  const rawSubject = record.subjectRef || record.ref || record.subject || {};
  const identity = subjectIdentityFromParts({
    domainId: record.domainId ?? record.domain_id ?? rawSubject.domainId ?? rawSubject.domain_id,
    subjectExternalId: record.subjectExternalId
      ?? record.subject_external_id
      ?? rawSubject.subjectExternalId
      ?? rawSubject.subject_external_id,
    revisionRef: record.revisionRef ?? record.revision_ref ?? rawSubject.revisionRef ?? rawSubject.revision_ref,
    repo: record.repo ?? rawSubject.repo,
    prNumber: record.prNumber ?? record.pr_number ?? rawSubject.prNumber ?? rawSubject.pr_number,
  });
  const deliveries = deliverySet(
    record.deliveries
      ?? record.deliveryRows
      ?? record.delivery_rows
      ?? (record.commentDelivery ? [record.commentDelivery] : []),
    identity
  );
  return {
    key: subjectKey(identity),
    subject: {
      domainId: identity.domainId,
      subjectExternalId: identity.subjectExternalId,
      revisionRef: identity.revisionRef,
    },
    verdictState: normalizeVerdictState(record),
    remediation: normalizeRemediationClassification(record),
    deliveries,
    duplicateDeliveries: findDuplicateDeliveries(deliveries),
    approvalOverrides: normalizeApprovalOverrides(record, identity),
  };
}

function recordsFromSnapshot(snapshot = {}) {
  if (Array.isArray(snapshot.records)) return snapshot.records;
  if (Array.isArray(snapshot.subjects)) return snapshot.subjects;
  if (Array.isArray(snapshot.jobs)) return snapshot.jobs;
  return [];
}

function normalizeReplaySnapshot(snapshot = {}) {
  const bySubject = new Map();
  const subjectConflicts = [];
  const unkeyedRecords = [];
  const unidentifiedRecords = [];
  for (const record of recordsFromSnapshot(snapshot)) {
    const normalized = normalizeReplayRecord(record);
    const subjectHasTypedIdentity = normalized.subject.domainId && normalized.subject.subjectExternalId;
    if (subjectHasTypedIdentity && !normalized.subject.revisionRef) {
      unkeyedRecords.push({
        subject: normalized.subject,
        verdictState: normalized.verdictState,
      });
      continue;
    }
    // Fully-unidentifiable records (neither typed identity nor legacy
    // repo+prNumber) MUST NOT be merged through `bySubject`. Earlier
    // versions used `'unknown-subject'` as a synthetic merge key,
    // collapsing N malformed records into one blob and hiding input drift
    // — the exact failure mode this harness is supposed to surface.
    // Route them to their own list so the diff preserves them.
    if (normalized.key === 'unknown-subject') {
      unidentifiedRecords.push({
        subject: normalized.subject,
        verdictState: normalized.verdictState,
      });
      continue;
    }
    const existing = bySubject.get(normalized.key);
    if (!existing) {
      bySubject.set(normalized.key, normalized);
      continue;
    }
    const { verdictState, verdictStates } = mergeVerdictStates(existing.verdictState, normalized.verdictState);
    if (verdictStates.length > 1) {
      subjectConflicts.push({
        subject: normalized.subject,
        verdictStates,
      });
    }
    bySubject.set(normalized.key, {
      ...existing,
      verdictState,
      remediation: {
        addressed: dedupeSorted([...existing.remediation.addressed, ...normalized.remediation.addressed]),
        pushback: dedupeSorted([...existing.remediation.pushback, ...normalized.remediation.pushback]),
        blockers: dedupeSorted([...existing.remediation.blockers, ...normalized.remediation.blockers]),
      },
      deliveries: [...existing.deliveries, ...normalized.deliveries].sort(compareStable),
      duplicateDeliveries: findDuplicateDeliveries([...existing.deliveries, ...normalized.deliveries]),
      approvalOverrides: [...existing.approvalOverrides, ...normalized.approvalOverrides].sort(compareStable),
    });
  }
  return {
    schemaVersion: REPLAY_SNAPSHOT_SCHEMA_VERSION,
    parseErrors: Array.isArray(snapshot.parseErrors) ? snapshot.parseErrors.slice().sort(compareStable) : [],
    subjectConflicts: subjectConflicts.sort(compareStable),
    unkeyedRecords: unkeyedRecords.sort(compareStable),
    unidentifiedRecords: unidentifiedRecords.sort(compareStable),
    records: Array.from(bySubject.values()).sort((a, b) => compareStable(a.key, b.key)),
  };
}

function diffValue({ diffs, subject, field, expected, actual }) {
  if (stableStringify(expected) === stableStringify(actual)) return;
  diffs.push({ subject, field, expected, actual });
}

function diffReplaySnapshots(productionSnapshot, stagingSnapshot) {
  const expected = normalizeReplaySnapshot(productionSnapshot);
  const actual = normalizeReplaySnapshot(stagingSnapshot);
  const expectedByKey = new Map(expected.records.map((record) => [record.key, record]));
  const actualByKey = new Map(actual.records.map((record) => [record.key, record]));
  const subjects = Array.from(new Set([...expectedByKey.keys(), ...actualByKey.keys()])).sort();
  const diffs = [];

  diffValue({ diffs, subject: '__snapshot__', field: 'parseErrors', expected: expected.parseErrors, actual: actual.parseErrors });
  diffValue({
    diffs,
    subject: '__snapshot__',
    field: 'subjectConflicts',
    expected: expected.subjectConflicts,
    actual: actual.subjectConflicts,
  });
  diffValue({
    diffs,
    subject: '__snapshot__',
    field: 'unkeyedRecords',
    expected: expected.unkeyedRecords,
    actual: actual.unkeyedRecords,
  });
  diffValue({
    diffs,
    subject: '__snapshot__',
    field: 'unidentifiedRecords',
    expected: expected.unidentifiedRecords,
    actual: actual.unidentifiedRecords,
  });

  // Asymmetric-subject coverage is the most common replay mismatch.
  // Earlier versions collapsed the entire asymmetry into a single
  // `field: 'subject'` row, which carried the least info for the case
  // operators need to triage hardest. Use an empty per-field baseline
  // so verdict / remediation / delivery / override deltas all surface
  // alongside the subject diff.
  const emptySubjectRecord = {
    verdictState: 'unknown',
    remediation: { addressed: [], pushback: [], blockers: [] },
    deliveries: [],
    duplicateDeliveries: [],
    approvalOverrides: [],
    subject: null,
  };

  for (const subject of subjects) {
    const prod = expectedByKey.get(subject) || { ...emptySubjectRecord };
    const stage = actualByKey.get(subject) || { ...emptySubjectRecord };
    if (!expectedByKey.has(subject)) {
      diffs.push({ subject, field: 'subject', expected: null, actual: stage.subject });
    } else if (!actualByKey.has(subject)) {
      diffs.push({ subject, field: 'subject', expected: prod.subject, actual: null });
    }
    diffValue({ diffs, subject, field: 'verdictState', expected: prod.verdictState, actual: stage.verdictState });
    diffValue({ diffs, subject, field: 'remediation', expected: prod.remediation, actual: stage.remediation });
    diffValue({ diffs, subject, field: 'deliveryRows', expected: prod.deliveries, actual: stage.deliveries });
    diffValue({
      diffs,
      subject,
      field: 'approvalOverrides',
      expected: prod.approvalOverrides,
      actual: stage.approvalOverrides,
    });
    if (stage.duplicateDeliveries.length) {
      diffs.push({
        subject,
        field: 'duplicateDeliveryRows',
        expected: [],
        actual: stage.duplicateDeliveries,
      });
    }
  }

  return {
    ok: diffs.length === 0,
    differences: diffs.sort(compareStable),
    expected,
    actual,
  };
}

function tableExists(db, tableName) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(tableName);
  return Boolean(row);
}

function tableColumns(db, tableName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Unsafe table name: ${tableName}`);
  }
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function timestampExpression(columns, candidates) {
  const present = candidates.filter((column) => columns.has(column));
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  return `COALESCE(${present.join(', ')})`;
}

function presentOrderColumns(columns, candidates) {
  return candidates.filter((column) => columns.has(column));
}

function collectReviewRows(db, sinceIso) {
  if (!tableExists(db, 'reviewed_prs')) return [];
  const columns = tableColumns(db, 'reviewed_prs');
  const observedAt = timestampExpression(columns, [
    'posted_at',
    'last_attempted_at',
    'failed_at',
    'reviewed_at',
  ]);
  if (!observedAt) return [];
  const orderBy = [observedAt, ...presentOrderColumns(columns, ['repo', 'pr_number'])].join(', ');
  return db.prepare(
    `SELECT *
       FROM reviewed_prs
      WHERE ${observedAt} >= ?
      ORDER BY ${orderBy}`
  ).all(sinceIso);
}

function collectDeliveryRows(db, sinceIso) {
  if (!tableExists(db, 'comment_deliveries')) return [];
  const columns = tableColumns(db, 'comment_deliveries');
  const observedAt = timestampExpression(columns, ['delivered_at', 'attempted_at']);
  if (!observedAt) return [];
  const orderBy = [observedAt, ...presentOrderColumns(columns, ['id'])].join(', ');
  return db.prepare(
    `SELECT *
       FROM comment_deliveries
      WHERE ${observedAt} >= ?
      ORDER BY ${orderBy}`
  ).all(sinceIso);
}

function safeReadJson(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function collectTerminalJobs(rootDir, sinceIso) {
  const base = join(rootDir, 'data', 'follow-up-jobs');
  const sinceTime = new Date(sinceIso).getTime();
  const jobs = [];
  const parseErrors = [];
  for (const dirName of TERMINAL_JOB_DIRS) {
    const dirPath = join(base, dirName);
    if (!existsSync(dirPath)) continue;
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(dirPath, entry);
      const stat = statSync(filePath);
      let job;
      try {
        job = safeReadJson(filePath);
      } catch (error) {
        recordParseError(parseErrors, {
          source: 'terminal-job-json',
          file: filePath,
          message: error?.message || String(error),
        });
        continue;
      }
      const timestamps = [
        job.createdAt,
        job.claimedAt,
        job.completedAt,
        job.stoppedAt,
        job.failedAt,
        job.commentDelivery?.owedAt,
        job.commentDelivery?.deliveredAt,
        stat.mtime.toISOString(),
      ].map((value) => Date.parse(value)).filter((value) => Number.isFinite(value));
      // A job with no parseable timestamps cannot be window-filtered and
      // would otherwise leak past `--days` / `--since` regardless of
      // bounds — polluting production snapshots with arbitrarily old
      // records and producing spurious diffs against staging. Drop it
      // explicitly and surface as a parse error so the operator can
      // audit the upstream producer.
      if (timestamps.length === 0) {
        recordParseError(parseErrors, {
          source: 'terminal-job-no-timestamp',
          file: filePath,
          message: 'Terminal job has no parseable timestamps; cannot apply replay window filter.',
        });
        continue;
      }
      if (Math.max(...timestamps) < sinceTime) continue;
      jobs.push({
        ...job,
        deliveries: job.commentDelivery ? [job.commentDelivery] : [],
      });
    }
  }
  return {
    jobs: jobs.sort((a, b) => compareStable(String(a.jobId || ''), String(b.jobId || ''))),
    parseErrors,
  };
}

function collectReplaySnapshot(rootDir, { since = null, days = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  const sinceIso = windowStart({ since, days, now });
  const dbPath = join(rootDir, 'data', 'reviews.db');
  const records = [];
  const parseErrors = [];
  if (existsSync(dbPath)) {
    let db;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
      recordParseError(parseErrors, {
        source: 'reviews-db-open',
        file: dbPath,
        message: error?.message || String(error),
      });
    }
    if (db) {
      try {
        const reviewRows = collectReviewRows(db, sinceIso);
        const deliveryRows = collectDeliveryRows(db, sinceIso);
        const deliveriesBySubject = new Map();
        for (const row of deliveryRows) {
          const identity = subjectIdentityFromParts({
            domain_id: row.domain_id,
            subject_external_id: row.subject_external_id,
            revision_ref: row.revision_ref,
            repo: row.legacy_repo,
            pr_number: row.legacy_pr_number,
          });
          const key = subjectKey(identity);
          const list = deliveriesBySubject.get(key) || [];
          list.push(row);
          deliveriesBySubject.set(key, list);
        }
        for (const row of reviewRows) {
          const identity = subjectIdentityFromParts(row);
          records.push({
            ...row,
            subjectRef: identity,
            deliveries: deliveriesBySubject.get(subjectKey(identity)) || [],
          });
        }
        for (const [key, deliveries] of deliveriesBySubject) {
          if (records.some((record) => subjectKey(record.subjectRef) === key)) continue;
          records.push({
            subjectRef: deliveries[0],
            deliveries,
          });
        }
      } finally {
        db.close();
      }
    }
  }

  const terminalJobs = collectTerminalJobs(rootDir, sinceIso);
  records.push(...terminalJobs.jobs);
  parseErrors.push(...terminalJobs.parseErrors);
  return {
    schemaVersion: REPLAY_SNAPSHOT_SCHEMA_VERSION,
    capturedAt: now.toISOString(),
    window: { since: sinceIso, until: now.toISOString() },
    parseErrors: parseErrors.sort(compareStable),
    records,
  };
}

function parseReplayCommandArg(value) {
  if (!value) throw new Error('--replay-command requires an executable path');
  return {
    command: resolve(value),
    args: [],
  };
}

function parseArgs(argv) {
  const args = {
    days: DEFAULT_WINDOW_DAYS,
    productionRoot: null,
    stagingRoot: null,
    productionSnapshot: null,
    stagingSnapshot: null,
    output: null,
    replayCommand: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--production-root') args.productionRoot = next();
    else if (arg === '--staging-root') args.stagingRoot = next();
    else if (arg === '--production-snapshot') args.productionSnapshot = next();
    else if (arg === '--staging-snapshot') args.stagingSnapshot = next();
    else if (arg === '--out') args.output = next();
    else if (arg === '--since') args.since = next();
    else if (arg === '--days') args.days = normalizeDays(next());
    else if (arg === '--replay-command') args.replayCommand = parseReplayCommandArg(next());
    else if (arg === '--replay-command-arg') {
      if (!args.replayCommand) throw new Error('--replay-command-arg requires --replay-command first');
      args.replayCommand.args.push(next());
    }
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/replay-30-day.mjs --production-root <prod> --staging-root <staging> [--days 30]',
    '   or: node scripts/replay-30-day.mjs --production-snapshot prod.json --staging-snapshot staging.json',
    '',
    'Options:',
    '  --replay-command <path> optional staging replay executable run after production snapshot collection',
    '  --replay-command-arg <arg>  optional argument for --replay-command (repeatable)',
    '  --out <path>            write the diff report JSON',
    '  --since <iso>           explicit lower bound instead of --days',
  ].join('\n');
}

function loadSnapshot(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function runCommand(command, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Replay command exited with ${signal || code}`));
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }

  if ((!args.productionRoot && !args.productionSnapshot) || (!args.stagingRoot && !args.stagingSnapshot)) {
    throw new Error(`Production and staging roots or snapshots are required.\n${usage()}`);
  }

  const now = new Date();
  const productionSnapshot = args.productionSnapshot
    ? loadSnapshot(args.productionSnapshot)
    : collectReplaySnapshot(resolve(args.productionRoot), { since: args.since, days: args.days, now });

  if (args.replayCommand) {
    await runCommand(args.replayCommand, {
      ...process.env,
      REPLAY_WINDOW_SINCE: productionSnapshot.window?.since || windowStart({ now, days: args.days, since: args.since }),
      REPLAY_STAGING_ROOT: args.stagingRoot ? resolve(args.stagingRoot) : '',
    });
  }

  const stagingSnapshot = args.stagingSnapshot
    ? loadSnapshot(args.stagingSnapshot)
    : collectReplaySnapshot(resolve(args.stagingRoot), { since: args.since, days: args.days, now });

  const report = diffReplaySnapshots(productionSnapshot, stagingSnapshot);
  if (args.output) {
    writeFileSync(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    ok: report.ok,
    differenceCount: report.differences.length,
    differences: report.differences,
  }, null, 2));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err?.message || String(err));
    process.exitCode = 2;
  });
}

export {
  collectReplaySnapshot,
  diffReplaySnapshots,
  normalizeApprovalOverrides,
  normalizeReplaySnapshot,
  normalizeReplayRecord,
  normalizeVerdictState,
  parseArgs,
};
