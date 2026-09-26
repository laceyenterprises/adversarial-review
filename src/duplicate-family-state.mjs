import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readBuildCompletionSignalForPr } from './session-ledger-read-adapter.mjs';
import {
  DUPLICATE_FAMILY_HOLD_LABEL,
  DUPLICATE_FAMILY_LABEL,
  evaluateDuplicateFamilyCandidate,
} from './duplicate-family-gate.mjs';

export const DUPLICATE_FAMILY_STATUS_ADVISORY = 'advisory';
export const DUPLICATE_FAMILY_STATUS_INACTIVE = 'inactive';
export const DUPLICATE_FAMILY_STATUS_SURVIVOR_SELECTED = 'survivor-selected';
export const DUPLICATE_FAMILY_STATUS_SURVIVOR_MERGED = 'survivor-merged';
export const DUPLICATE_FAMILY_STATUS_RESOLVED = 'resolved';
export const DUPLICATE_FAMILY_STATUS_ABANDONED = 'abandoned';
export const DUPLICATE_FAMILY_SUPPRESSION_LABEL = 'not-a-duplicate-stack';
export const DUPLICATE_FAMILY_SURVIVOR_LABEL = 'duplicate-family-survivor';
export const DUPLICATE_FAMILY_LOSER_LABEL = 'duplicate-family-loser';

const REACTIVATABLE_STATUSES = new Set([
  DUPLICATE_FAMILY_STATUS_INACTIVE,
  DUPLICATE_FAMILY_STATUS_RESOLVED,
]);
const DEACTIVATABLE_STATUSES = [
  DUPLICATE_FAMILY_STATUS_ADVISORY,
  DUPLICATE_FAMILY_STATUS_SURVIVOR_SELECTED,
  DUPLICATE_FAMILY_STATUS_ABANDONED,
];
const PERSISTED_MERGE_STATUSES = [
  DUPLICATE_FAMILY_STATUS_ADVISORY,
  DUPLICATE_FAMILY_STATUS_SURVIVOR_SELECTED,
  DUPLICATE_FAMILY_STATUS_SURVIVOR_MERGED,
  DUPLICATE_FAMILY_STATUS_ABANDONED,
];

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,12}-\d{1,6})\b/i;
const STACK_LABEL_RE = /^(?:stack|stacked|depends-on|follow-up|followup|remediation)(?::|$)/i;
const EXPLICIT_IDENTITY_LABEL_RE = /^work-identity:(.+)$/i;
const TRANSIENT_PROVENANCE_FAILURES = new Set([
  'missing-ledger-target',
  'malformed-ledger-target',
  'postgres-configured-but-sqlite-resolved',
  'psql-not-installed',
  'ledger-read-failed',
]);

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeKeyPart(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '') || null;
}

function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => (typeof label === 'string' ? label : label?.name || ''))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

function lowerLabelSet(labels) {
  return new Set(labelNames(labels).map((name) => name.toLowerCase()));
}

function labelsFromLowerSet(labels) {
  return [...labels].sort();
}

function isNotFoundError(err) {
  return Number(err?.status || err?.response?.status) === 404;
}

function extractTicket(value) {
  const match = String(value || '').match(TICKET_RE);
  return match ? match[1].toUpperCase() : null;
}

function parseMaybeJson(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function stableFamilyId({ targetRepo, baseBranch, normalizedWorkIdentity, detectedAt }) {
  const repoName = String(targetRepo || '').split('/').filter(Boolean).at(-1) || 'repo';
  const day = String(detectedAt || new Date().toISOString()).slice(0, 10);
  const prefix = [
    normalizeKeyPart(repoName),
    normalizeKeyPart(baseBranch) || 'base',
    normalizeKeyPart(normalizedWorkIdentity) || 'work',
    day,
  ].filter(Boolean).join('-').slice(0, 96);
  const digest = createHash('sha1')
    .update(`${targetRepo}\0${baseBranch}\0${normalizedWorkIdentity}`)
    .digest('hex')
    .slice(0, 10);
  return `${prefix}-${digest}`;
}

export function ensureDuplicateFamilySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS duplicate_families (
      family_id                 TEXT PRIMARY KEY,
      family_key                TEXT NOT NULL UNIQUE,
      target_repo               TEXT NOT NULL,
      base_branch               TEXT NOT NULL,
      normalized_work_identity  TEXT NOT NULL,
      status                    TEXT NOT NULL DEFAULT 'advisory',
      strongest_signal          TEXT,
      selected_survivor_pr_number INTEGER,
      report_path               TEXT,
      operator_override_json    TEXT,
      transition_log_json       TEXT NOT NULL DEFAULT '[]',
      candidate_count           INTEGER NOT NULL DEFAULT 0,
      first_detected_at         TEXT NOT NULL,
      last_seen_at              TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS duplicate_family_candidates (
      family_id                 TEXT NOT NULL,
      repo                      TEXT NOT NULL,
      pr_number                 INTEGER NOT NULL,
      title                     TEXT,
      pr_state                  TEXT,
      base_branch               TEXT,
      head_branch               TEXT,
      head_sha                  TEXT,
      base_sha                  TEXT,
      role                      TEXT NOT NULL DEFAULT 'candidate',
      work_identity_json        TEXT NOT NULL,
      signals_json              TEXT NOT NULL,
      suppressions_json         TEXT NOT NULL DEFAULT '[]',
      labels_json               TEXT NOT NULL DEFAULT '[]',
      first_seen_at             TEXT NOT NULL,
      last_seen_at              TEXT NOT NULL,
      updated_at                TEXT NOT NULL,
      PRIMARY KEY (repo, pr_number),
      FOREIGN KEY (family_id) REFERENCES duplicate_families(family_id) ON DELETE CASCADE
    );

  `);
  migrateDuplicateFamilyCandidatesPrimaryKey(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_duplicate_family_candidates_pr
      ON duplicate_family_candidates(repo, pr_number, head_sha);
    CREATE INDEX IF NOT EXISTS idx_duplicate_family_candidates_family_id
      ON duplicate_family_candidates(family_id);
    CREATE INDEX IF NOT EXISTS idx_duplicate_families_status
      ON duplicate_families(status, target_repo, base_branch);
  `);
}

export function duplicateFamilySchemaTableNames() {
  return ['duplicate_families', 'duplicate_family_candidates'];
}

function readDispatchProvenance({
  repoPath,
  prNumber,
  headSha,
  rootDir,
  hqRoot,
  env,
  ledgerTarget,
  spawnSyncImpl,
  readBuildCompletionSignalForPrImpl,
}) {
  const reader = readBuildCompletionSignalForPrImpl || readBuildCompletionSignalForPr;
  const common = {
    repo: repoPath,
    prNumber,
    signalKind: 'pr_opened',
    rootDir,
    hqRoot,
    env,
    ledgerTarget,
    spawnSyncImpl,
  };
  const normalizedHeadSha = normalizeText(headSha);
  let result = reader({ ...common, headSha: normalizedHeadSha || null });
  let resolvedBy = normalizedHeadSha ? 'current-head' : 'pr-opened-head-independent';
  if (!result?.ok && normalizedHeadSha) {
    result = reader({ ...common, headSha: null });
    resolvedBy = result?.ok ? 'pr-opened-head-independent' : null;
  }
  if (!result?.ok) {
    return { ok: false, reason: result?.reason || 'missing-dispatch-provenance' };
  }
  return { ok: true, row: result.row || {}, resolvedBy };
}

export function extractDuplicateWorkIdentity(entry, {
  repoPath,
  rootDir = process.cwd(),
  hqRoot = null,
  env = process.env,
  ledgerTarget = null,
  spawnSyncImpl,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
} = {}) {
  const subject = entry?.subject || entry || {};
  const prNumber = Number(entry?.prNumber ?? subject.number ?? subject.prNumber);
  const labels = labelNames(subject.labels);
  const title = normalizeText(subject.title) || '';
  const headBranch = normalizeText(subject.headRefName || subject.headBranch || subject.branch);
  const baseBranch = normalizeText(subject.baseRefName || subject.baseBranch) || 'main';
  const headSha = normalizeText(subject.headSha || subject.headRefOid || subject.ref?.revisionRef);
  const titleTicket = extractTicket(title);
  const branchTicket = extractTicket(headBranch);
  const explicitIdentity = labels
    .map((label) => label.match(EXPLICIT_IDENTITY_LABEL_RE)?.[1])
    .find(Boolean);

  const signals = [];
  const addSignal = (kind, value, strength = 'strong', source = kind) => {
    const normalized = normalizeText(value);
    if (!normalized) return;
    signals.push({ kind, value: normalized, strength, source });
  };

  addSignal('title-ticket', titleTicket, 'strong', 'title');
  addSignal('branch-ticket', branchTicket, 'strong', 'branch');
  addSignal('explicit-label', explicitIdentity, 'strong', 'label');

  const provenance = readDispatchProvenance({
    repoPath,
    prNumber,
    headSha,
    rootDir,
    hqRoot,
    env,
    ledgerTarget,
    spawnSyncImpl,
    readBuildCompletionSignalForPrImpl,
  });
  if (provenance.ok) {
    const row = provenance.row || {};
    addSignal('dispatch-ticket', row.ticket_id || row.dagrun_step_ticket_id, 'strong', provenance.resolvedBy);
    addSignal('dispatch-spec', row.spec_ref, 'strong', provenance.resolvedBy);
    addSignal('dispatch-branch', row.branch, 'strong', provenance.resolvedBy);
  }

  const normalizedWorkIdentity =
    normalizeKeyPart(provenance.ok && (provenance.row?.ticket_id || provenance.row?.dagrun_step_ticket_id))
    || normalizeKeyPart(explicitIdentity)
    || normalizeKeyPart(titleTicket || branchTicket);

  return {
    found: Boolean(normalizedWorkIdentity),
    normalizedWorkIdentity,
    baseBranch,
    headBranch,
    headSha,
    baseSha: normalizeText(subject.baseSha || subject.baseRefOid || subject.mergeBaseSha),
    signals,
    provenance: provenance.ok ? { ok: true, resolvedBy: provenance.resolvedBy } : provenance,
  };
}

function signalMap(signals) {
  const map = new Map();
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (signal?.strength !== 'strong') continue;
    const kind = normalizeText(signal.kind);
    const value = normalizeKeyPart(signal.value);
    if (!kind || !value) continue;
    map.set(kind, value);
  }
  return map;
}

function commonStrongSignalKinds(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) return [];
  let common = signalMap(candidates[0].signals);
  for (const candidate of candidates.slice(1)) {
    const next = signalMap(candidate.signals);
    common = new Map([...common].filter(([kind, value]) => next.get(kind) === value));
  }
  return [...common.keys()].sort();
}

function suppressionsForCandidate(candidate, candidates) {
  const labels = labelNames(candidate.subject?.labels);
  const suppressions = [];
  if (labels.includes(DUPLICATE_FAMILY_SUPPRESSION_LABEL)) {
    suppressions.push({ kind: 'current-head-exclusion-label', headSha: candidate.headSha || null });
  }
  if (labels.some((label) => STACK_LABEL_RE.test(label))) {
    suppressions.push({ kind: 'stack-or-follow-up-label', headSha: candidate.headSha || null });
  }
  if (candidate.headBranch) {
    const sameBranch = candidates.filter((other) => (
      other !== candidate
      && other.headBranch
      && other.headBranch === candidate.headBranch
    ));
    if (sameBranch.length > 0) {
      suppressions.push({ kind: 'same-branch-remediation', headSha: candidate.headSha || null });
    }
  }
  if (candidate.baseSha && candidates.some((other) => other !== candidate && other.headSha === candidate.baseSha)) {
    suppressions.push({ kind: 'stack-base-is-sibling-head', headSha: candidate.headSha || null });
  }
  return suppressions;
}

function subjectPrState(subject, current) {
  const state = normalizeText(subject?.state || current?.pr_state);
  if (!state) return 'open';
  return state.toLowerCase() === 'open' ? 'open' : state.toLowerCase();
}

export function detectDuplicateFamiliesForRepo(subjectEntries, {
  repoPath,
  now = new Date().toISOString(),
  rootDir = process.cwd(),
  hqRoot = null,
  env = process.env,
  ledgerTarget = null,
  spawnSyncImpl,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
} = {}) {
  const candidates = [];
  for (const entry of Array.isArray(subjectEntries) ? subjectEntries : []) {
    const subject = entry?.subject || {};
    const prNumber = Number(entry?.prNumber ?? subject.number ?? subject.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const identity = shouldUseSuppliedDuplicateWorkIdentity(entry)
      ? duplicateWorkIdentityFromEntry(entry)
      : extractDuplicateWorkIdentity(entry, {
      repoPath,
      rootDir,
      hqRoot,
      env,
      ledgerTarget,
      spawnSyncImpl,
      readBuildCompletionSignalForPrImpl,
    });
    if (!identity.found) continue;
    const prState = subjectPrState(subject, entry?.current);
    candidates.push({
      repoPath,
      prNumber,
      subject,
      prState,
      title: normalizeText(subject.title),
      normalizedWorkIdentity: identity.normalizedWorkIdentity,
      baseBranch: identity.baseBranch,
      headBranch: identity.headBranch,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      signals: identity.signals,
      workIdentity: identity,
    });
  }

  for (const candidate of candidates) {
    candidate.suppressions = suppressionsForCandidate(candidate, candidates);
  }

  const groups = new Map();
  for (const candidate of candidates) {
    const familyKey = [
      normalizeKeyPart(candidate.repoPath),
      normalizeKeyPart(candidate.baseBranch),
      candidate.normalizedWorkIdentity,
    ].join('|');
    if (!groups.has(familyKey)) groups.set(familyKey, []);
    groups.get(familyKey).push(candidate);
  }

  const families = [];
  for (const [familyKey, group] of groups) {
    const openUnsuppressed = group.filter((candidate) => (
      candidate.prState === 'open'
      && (!Array.isArray(candidate.suppressions) || candidate.suppressions.length === 0)
    ));
    const commonSignals = commonStrongSignalKinds(openUnsuppressed);
    if (openUnsuppressed.length < 2 || commonSignals.length < 2) continue;
    const exemplar = openUnsuppressed[0];
    families.push({
      familyKey,
      familyId: stableFamilyId({
        targetRepo: repoPath,
        baseBranch: exemplar.baseBranch,
        normalizedWorkIdentity: exemplar.normalizedWorkIdentity,
        detectedAt: now,
      }),
      targetRepo: repoPath,
      baseBranch: exemplar.baseBranch,
      normalizedWorkIdentity: exemplar.normalizedWorkIdentity,
      status: DUPLICATE_FAMILY_STATUS_ADVISORY,
      strongestSignal: commonSignals[0] || null,
      commonSignals,
      candidates: openUnsuppressed,
      allCandidates: group,
    });
  }
  return families;
}

function readExistingFamilyByKey(db, familyKey) {
  return db.prepare('SELECT * FROM duplicate_families WHERE family_key = ?').get(familyKey) || null;
}

function duplicateFamilyCandidatesPrimaryKeyColumns(db) {
  return db.prepare('PRAGMA table_info(duplicate_family_candidates)')
    .all()
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);
}

function migrateDuplicateFamilyCandidatesPrimaryKey(db) {
  const primaryKeyColumns = duplicateFamilyCandidatesPrimaryKeyColumns(db);
  if (primaryKeyColumns.join('|') === 'repo|pr_number') return;
  const legacyTable = `duplicate_family_candidates_legacy_${Date.now()}`;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE duplicate_family_candidates RENAME TO ${legacyTable};
      CREATE TABLE duplicate_family_candidates (
        family_id                 TEXT NOT NULL,
        repo                      TEXT NOT NULL,
        pr_number                 INTEGER NOT NULL,
        title                     TEXT,
        pr_state                  TEXT,
        base_branch               TEXT,
        head_branch               TEXT,
        head_sha                  TEXT,
        base_sha                  TEXT,
        role                      TEXT NOT NULL DEFAULT 'candidate',
        work_identity_json        TEXT NOT NULL,
        signals_json              TEXT NOT NULL,
        suppressions_json         TEXT NOT NULL DEFAULT '[]',
        labels_json               TEXT NOT NULL DEFAULT '[]',
        first_seen_at             TEXT NOT NULL,
        last_seen_at              TEXT NOT NULL,
        updated_at                TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number),
        FOREIGN KEY (family_id) REFERENCES duplicate_families(family_id) ON DELETE CASCADE
      );
      INSERT OR REPLACE INTO duplicate_family_candidates (
        family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
        head_sha, base_sha, role, work_identity_json, signals_json,
        suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
      )
      SELECT family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
             head_sha, base_sha, role, work_identity_json, signals_json,
             suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
        FROM ${legacyTable}
       ORDER BY updated_at ASC, last_seen_at ASC, family_id ASC;
      DROP TABLE ${legacyTable};
    `);
  })();
}

function updateOperatorOverrideForHeadMove(existing, candidates) {
  const override = parseMaybeJson(existing?.operator_override_json, null);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return existing?.operator_override_json || null;
  let changed = false;
  const staleIfMoved = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const prNumber = Number(entry.candidatePrNumber ?? entry.prNumber);
    const headSha = normalizeText(entry.candidateHeadSha ?? entry.headSha);
    if (!Number.isInteger(prNumber) || prNumber <= 0 || !headSha) return entry;
    const candidate = candidates.find((item) => item.prNumber === prNumber);
    if (!candidate || !candidate.headSha || candidate.headSha === headSha) return entry;
    if (entry.stale && entry.staleObservedHeadSha === candidate.headSha) return entry;
    changed = true;
    return {
      ...entry,
      stale: true,
      staleReason: 'candidate-head-moved',
      staleAt: new Date().toISOString(),
      staleObservedHeadSha: candidate.headSha,
    };
  };
  const next = {
    ...override,
    ...(override.selection ? { selection: staleIfMoved(override.selection) } : {}),
    ...(Array.isArray(override.ignoredCandidates)
      ? { ignoredCandidates: override.ignoredCandidates.map(staleIfMoved) }
      : {}),
  };
  if (!override.selection && !Array.isArray(override.ignoredCandidates)) {
    Object.assign(next, staleIfMoved(override));
  }
  return changed ? JSON.stringify(next) : existing?.operator_override_json || null;
}

function appendTransitionLog(existingJson, transition) {
  const existing = parseMaybeJson(existingJson, []);
  const transitions = Array.isArray(existing) ? existing : [];
  const previous = transitions.at(-1);
  const comparable = (entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const { at: _at, ...rest } = entry;
    return JSON.stringify(rest);
  };
  const alreadyPresent = comparable(previous) === comparable(transition);
  return JSON.stringify(alreadyPresent ? transitions : [...transitions, transition]);
}

function subjectEntryKey(entry, fallbackRepo = null) {
  const subject = entry?.subject || {};
  const repo = normalizeText(entry?.repoPath || entry?.repo || subject.repositoryWithOwner || subject.repo || fallbackRepo);
  const prNumber = Number(entry?.prNumber ?? subject.number ?? subject.prNumber);
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) return null;
  return `${repo}\0${prNumber}`;
}

function observedSubjectCandidateKeys(subjectEntries, repoPath) {
  const keys = new Set();
  for (const entry of Array.isArray(subjectEntries) ? subjectEntries : []) {
    const subject = entry?.subject || {};
    const prNumber = Number(entry?.prNumber ?? subject.number ?? subject.prNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
    const repo = normalizeText(entry?.repoPath || entry?.repo || subject.repositoryWithOwner || subject.repo || repoPath);
    if (!repo) continue;
    keys.add(`${repo}\0${prNumber}`);
  }
  return keys;
}

function refreshObservedDuplicateCandidateRows(db, subjectEntries, repoPath, now = new Date().toISOString()) {
  if (!repoPath) return;
  const updateObservedCandidate = db.prepare(
    `UPDATE duplicate_family_candidates
        SET title = ?,
            pr_state = ?,
            base_branch = ?,
            head_branch = ?,
            head_sha = ?,
            base_sha = ?,
            labels_json = ?,
            last_seen_at = ?,
            updated_at = ?
      WHERE repo = ?
        AND pr_number = ?`
  );
  const tx = db.transaction(() => {
    for (const entry of Array.isArray(subjectEntries) ? subjectEntries : []) {
      const subject = entry?.subject || {};
      const prNumber = Number(entry?.prNumber ?? subject.number ?? subject.prNumber);
      if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
      const repo = normalizeText(entry?.repoPath || entry?.repo || subject.repositoryWithOwner || subject.repo || repoPath);
      if (!repo) continue;
      updateObservedCandidate.run(
        normalizeText(subject.title),
        subjectPrState(subject, entry?.current),
        normalizeText(subject.baseRefName || subject.baseBranch || 'main'),
        normalizeText(subject.headRefName || subject.headBranch),
        normalizeText(subject.headSha || subject.headRefOid),
        normalizeText(subject.baseSha || subject.baseRefOid || subject.mergeBaseSha),
        JSON.stringify(labelNames(subject.labels)),
        now,
        now,
        repo,
        prNumber,
      );
    }
  });
  tx();
}

function familyHasObservedCandidate(db, familyId, observedCandidateKeys) {
  if (!(observedCandidateKeys instanceof Set) || observedCandidateKeys.size === 0) return false;
  const rows = db.prepare(
    `SELECT repo, pr_number
       FROM duplicate_family_candidates
      WHERE family_id = ?`
  ).all(familyId);
  return rows.some((row) => observedCandidateKeys.has(`${row.repo}\0${row.pr_number}`));
}

function mergePersistedDuplicateCandidates(db, subjectEntries, repoPath) {
  if (!repoPath) return Array.isArray(subjectEntries) ? subjectEntries : [];
  const merged = Array.isArray(subjectEntries) ? [...subjectEntries] : [];
  const seen = new Set(merged.map((entry) => subjectEntryKey(entry, repoPath)).filter(Boolean));
  const hasReviewedPrs = Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviewed_prs'`
  ).get());
  const authoritativeStateSelect = hasReviewedPrs
    ? ', reviewed_prs.pr_state AS authoritative_pr_state'
    : ', NULL AS authoritative_pr_state';
  const authoritativeStateJoin = hasReviewedPrs
    ? `LEFT JOIN reviewed_prs
         ON reviewed_prs.repo = duplicate_family_candidates.repo
        AND reviewed_prs.pr_number = duplicate_family_candidates.pr_number`
    : '';
  const rows = db.prepare(
    `SELECT duplicate_family_candidates.*${authoritativeStateSelect}
       FROM duplicate_family_candidates
       JOIN duplicate_families
         ON duplicate_families.family_id = duplicate_family_candidates.family_id
      ${authoritativeStateJoin}
      WHERE duplicate_families.target_repo = ?
        AND duplicate_families.status IN (${PERSISTED_MERGE_STATUSES.map(() => '?').join(', ')})`
  ).all(repoPath, ...PERSISTED_MERGE_STATUSES);
  for (const row of rows) {
    const key = `${row.repo}\0${row.pr_number}`;
    if (seen.has(key)) continue;
    const workIdentity = parseMaybeJson(row.work_identity_json, {});
    const signals = parseMaybeJson(row.signals_json, []);
    const labels = parseMaybeJson(row.labels_json, []);
    merged.push({
      repoPath: row.repo,
      prNumber: row.pr_number,
      subject: {
        number: row.pr_number,
        title: row.title,
        state: ['merged', 'closed'].includes(String(row.authoritative_pr_state || '').toLowerCase())
          ? String(row.authoritative_pr_state).toLowerCase()
          : row.pr_state,
        baseRefName: row.base_branch,
        headRefName: row.head_branch,
        headSha: row.head_sha,
        baseSha: row.base_sha,
        labels,
      },
      current: { pr_state: row.pr_state },
      duplicateWorkIdentity: {
        ...workIdentity,
        found: Boolean(workIdentity?.normalizedWorkIdentity),
        signals,
      },
    });
    seen.add(key);
  }
  return merged;
}

function shouldUseSuppliedDuplicateWorkIdentity(entry) {
  return Boolean(entry?.duplicateWorkIdentity?.found && entry.duplicateWorkIdentity?.normalizedWorkIdentity);
}

function duplicateWorkIdentityFromEntry(entry) {
  const identity = entry.duplicateWorkIdentity || {};
  return {
    found: true,
    normalizedWorkIdentity: identity.normalizedWorkIdentity,
    baseBranch: identity.baseBranch || entry?.subject?.baseRefName || 'main',
    headBranch: identity.headBranch || entry?.subject?.headRefName || null,
    headSha: identity.headSha || entry?.subject?.headSha || null,
    baseSha: identity.baseSha || entry?.subject?.baseSha || null,
    signals: Array.isArray(identity.signals) ? identity.signals : [],
    provenance: identity.provenance || { ok: true, resolvedBy: 'persisted-duplicate-candidate' },
  };
}

export function upsertDuplicateFamilies(db, families, {
  now = new Date().toISOString(),
  repoPath = null,
  deactivateMissing = false,
  observedCandidateKeys = null,
} = {}) {
  ensureDuplicateFamilySchema(db);
  const upsertFamily = db.prepare(
    `INSERT INTO duplicate_families (
       family_id, family_key, target_repo, base_branch, normalized_work_identity,
       status, strongest_signal, transition_log_json, candidate_count,
       first_detected_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(family_key) DO UPDATE SET
      status = CASE
         WHEN duplicate_families.status IN ('inactive', 'resolved') THEN excluded.status
         ELSE duplicate_families.status
       END,
       selected_survivor_pr_number = CASE
         WHEN duplicate_families.status IN ('inactive', 'resolved') THEN NULL
         ELSE duplicate_families.selected_survivor_pr_number
       END,
       report_path = CASE
         WHEN duplicate_families.status IN ('inactive', 'resolved') THEN NULL
         ELSE duplicate_families.report_path
       END,
       operator_override_json = CASE
         WHEN duplicate_families.status IN ('inactive', 'resolved') THEN NULL
         ELSE duplicate_families.operator_override_json
       END,
       transition_log_json = CASE
         WHEN duplicate_families.status IN ('inactive', 'resolved') THEN excluded.transition_log_json
         ELSE duplicate_families.transition_log_json
       END,
       strongest_signal = excluded.strongest_signal,
       candidate_count = excluded.candidate_count,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`
  );
  const updateOverride = db.prepare(
    `UPDATE duplicate_families
        SET operator_override_json = ?, updated_at = ?
      WHERE family_key = ?`
  );
  const selectActiveRepoFamilies = db.prepare(
    `SELECT family_id, family_key, status, transition_log_json
       FROM duplicate_families
      WHERE target_repo = ?
        AND status IN (${DEACTIVATABLE_STATUSES.map(() => '?').join(', ')})`
  );
  const markInactive = db.prepare(
    `UPDATE duplicate_families
        SET status = ?,
            candidate_count = 0,
            transition_log_json = ?,
            updated_at = ?,
            last_seen_at = ?
      WHERE family_id = ?
        AND status IN (${DEACTIVATABLE_STATUSES.map(() => '?').join(', ')})`
  );
  const upsertCandidate = db.prepare(
    `INSERT INTO duplicate_family_candidates (
       family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
       head_sha, base_sha, role, work_identity_json, signals_json,
       suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       family_id = excluded.family_id,
       title = excluded.title,
       pr_state = excluded.pr_state,
       base_branch = excluded.base_branch,
       head_branch = excluded.head_branch,
       head_sha = excluded.head_sha,
       base_sha = excluded.base_sha,
       work_identity_json = excluded.work_identity_json,
       signals_json = excluded.signals_json,
       suppressions_json = excluded.suppressions_json,
       labels_json = excluded.labels_json,
       last_seen_at = excluded.last_seen_at,
       updated_at = excluded.updated_at`
  );

  const tx = db.transaction(() => {
    const changed = [];
    for (const family of Array.isArray(families) ? families : []) {
      const existing = readExistingFamilyByKey(db, family.familyKey);
      let transitionLog = existing?.transition_log_json || JSON.stringify([{
        at: now,
        transition: 'detected-advisory',
        status: DUPLICATE_FAMILY_STATUS_ADVISORY,
      }]);
      if (REACTIVATABLE_STATUSES.has(String(existing?.status || '').toLowerCase())) {
        transitionLog = appendTransitionLog(transitionLog, {
          at: now,
          transition: 'reactivated-advisory',
          status: DUPLICATE_FAMILY_STATUS_ADVISORY,
          reason: 'duplicate-census-detected-again',
        });
      }
      upsertFamily.run(
        existing?.family_id || family.familyId,
        family.familyKey,
        family.targetRepo,
        family.baseBranch,
        family.normalizedWorkIdentity,
        DUPLICATE_FAMILY_STATUS_ADVISORY,
        family.strongestSignal,
        transitionLog,
        family.candidates.length,
        existing?.first_detected_at || now,
        now,
        now,
      );
      const row = readExistingFamilyByKey(db, family.familyKey);
      const persistedCandidates = Array.isArray(family.allCandidates) ? family.allCandidates : family.candidates;
      const nextOverride = updateOperatorOverrideForHeadMove(row, persistedCandidates);
      if (nextOverride !== (row.operator_override_json || null)) {
        updateOverride.run(nextOverride, now, family.familyKey);
      }
      for (const candidate of persistedCandidates) {
        upsertCandidate.run(
          row.family_id,
          candidate.repoPath,
          candidate.prNumber,
          candidate.title,
          candidate.prState,
          candidate.baseBranch,
          candidate.headBranch,
          candidate.headSha,
          candidate.baseSha,
          JSON.stringify(candidate.workIdentity || {}),
          JSON.stringify(candidate.signals || []),
          JSON.stringify(candidate.suppressions || []),
          JSON.stringify(labelNames(candidate.subject?.labels)),
          now,
          now,
          now,
        );
      }
      changed.push(row.family_id);
    }
    if (deactivateMissing && repoPath) {
      const activeKeys = new Set((Array.isArray(families) ? families : []).map((family) => family.familyKey));
      for (const row of selectActiveRepoFamilies.all(repoPath, ...DEACTIVATABLE_STATUSES)) {
        if (activeKeys.has(row.family_key)) continue;
        if (!familyHasObservedCandidate(db, row.family_id, observedCandidateKeys)) continue;
        markInactive.run(
          DUPLICATE_FAMILY_STATUS_INACTIVE,
          appendTransitionLog(row.transition_log_json, {
            at: now,
            transition: 'census-no-longer-duplicate',
            status: DUPLICATE_FAMILY_STATUS_INACTIVE,
            reason: 'fewer-than-two-live-unsuppressed-candidates',
          }),
          now,
          now,
          row.family_id,
          ...DEACTIVATABLE_STATUSES,
        );
      }
    }
    return changed;
  });
  return tx();
}

export function reconcileDuplicateFamiliesForRepo(db, subjectEntries, options = {}) {
  ensureDuplicateFamilySchema(db);
  const repoPath = options.repoPath;
  refreshObservedDuplicateCandidateRows(db, subjectEntries, repoPath, options.now);
  const observedCandidateKeys = observedSubjectCandidateKeys(subjectEntries, repoPath);
  const censusEntries = mergePersistedDuplicateCandidates(db, subjectEntries, repoPath);
  const families = detectDuplicateFamiliesForRepo(censusEntries, options);
  const familyIds = upsertDuplicateFamilies(db, families, {
    ...options,
    repoPath,
    deactivateMissing: true,
    observedCandidateKeys,
  });
  return { families, familyIds };
}

export async function runDuplicateFamilyCensusForWatcher({
  db,
  subjectEntries,
  repoPath,
  rootDir,
  env = process.env,
  log = console,
} = {}) {
  let provenanceDisabledReason = null;
  const readBuildCompletionSignalForPrImpl = (args) => {
    if (provenanceDisabledReason) {
      return { ok: false, reason: provenanceDisabledReason };
    }
    const result = readBuildCompletionSignalForPr(args);
    if (!result?.ok && shouldDisableProvenanceForTick(result.reason)) {
      provenanceDisabledReason = result.reason || 'duplicate-family-provenance-unavailable';
      throw new Error(`Transient provenance failure: ${provenanceDisabledReason}`);
    }
    return result;
  };
  const spawnSyncImpl = (command, args, options = {}) => nodeSpawnSync(command, args, {
    ...options,
    timeout: Math.min(Math.max(1, Number(options.timeout) || 1500), 1500),
  });
  try {
    for (const explicitLedgerPath of [
      env.AGENT_OS_SESSION_LEDGER_DB_PATH,
      env.SESSION_LEDGER_DB_PATH,
    ]) {
      if (explicitLedgerPath && !existsSync(explicitLedgerPath)) {
        throw new Error('Transient provenance failure: missing-ledger-target');
      }
    }
    const probeSubject = (Array.isArray(subjectEntries) ? subjectEntries : [])
      .map((entry) => entry?.subject || entry || {})
      .find((subject) => Number.isInteger(Number(subject.number ?? subject.prNumber)));
    if (probeSubject) {
      readBuildCompletionSignalForPrImpl({
        repo: repoPath,
        prNumber: Number(probeSubject.number ?? probeSubject.prNumber),
        headSha: normalizeText(probeSubject.headSha || probeSubject.headRefOid || probeSubject.ref?.revisionRef),
        signalKind: 'pr_opened',
        rootDir,
        hqRoot: env.HQ_ROOT || null,
        env,
        spawnSyncImpl,
      });
    }
    const duplicateCensus = reconcileDuplicateFamiliesForRepo(db, subjectEntries, {
      repoPath,
      rootDir,
      hqRoot: env.HQ_ROOT || null,
      env,
      spawnSyncImpl,
      readBuildCompletionSignalForPrImpl,
    });
    if (duplicateCensus.familyIds.length > 0) {
      log.log(
        `[watcher] duplicate-family advisory census for ${repoPath}: ` +
        `${duplicateCensus.familyIds.length} active duplicate famil` +
        `${duplicateCensus.familyIds.length === 1 ? 'y' : 'ies'}`
      );
    }
    return duplicateCensus;
  } catch (err) {
    log.error(
      `[watcher] duplicate-family advisory census failed for ${repoPath}:`,
      err?.message || err
    );
    return { families: [], familyIds: [], error: err };
  }
}

function shouldDisableProvenanceForTick(reason) {
  return TRANSIENT_PROVENANCE_FAILURES.has(String(reason || ''));
}

export function listDuplicateFamilies(db, { repo = null, status = null } = {}) {
  ensureDuplicateFamilySchema(db);
  const clauses = [];
  const params = {};
  if (repo) {
    clauses.push('target_repo = @repo');
    params.repo = repo;
  }
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `SELECT *
       FROM duplicate_families
       ${where}
      ORDER BY first_detected_at ASC, family_id ASC`
  ).all(params);
}

export function readDuplicateFamilyForPr(db, { repo, prNumber, headSha = null } = {}) {
  ensureDuplicateFamilySchema(db);
  const row = db.prepare(
    `SELECT duplicate_families.*, duplicate_family_candidates.head_sha AS candidate_head_sha,
            duplicate_family_candidates.role AS candidate_role
       FROM duplicate_family_candidates
       JOIN duplicate_families
         ON duplicate_families.family_id = duplicate_family_candidates.family_id
      WHERE duplicate_family_candidates.repo = ?
        AND duplicate_family_candidates.pr_number = ?
      ORDER BY duplicate_families.updated_at DESC
      LIMIT 1`
  ).get(repo, Number(prNumber)) || null;
  if (!row) return null;
  if (headSha && row.candidate_head_sha && row.candidate_head_sha !== headSha) {
    return { ...row, currentHeadMatches: false };
  }
  return { ...row, currentHeadMatches: true };
}

export function duplicateFamilyCandidateRows(db, familyId) {
  ensureDuplicateFamilySchema(db);
  return db.prepare(
    `SELECT *
       FROM duplicate_family_candidates
      WHERE family_id = ?
      ORDER BY pr_number ASC`
  ).all(familyId);
}

function requireDuplicateFamily(db, familyId) {
  ensureDuplicateFamilySchema(db);
  const family = db.prepare('SELECT * FROM duplicate_families WHERE family_id = ?').get(familyId);
  if (!family) throw new Error(`duplicate family not found: ${familyId}`);
  return family;
}

function duplicateFamilyOverride(family) {
  const value = parseMaybeJson(family?.operator_override_json, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isActiveIgnoredCandidate(override, candidate) {
  const ignored = Array.isArray(override?.ignoredCandidates) ? override.ignoredCandidates : [];
  return ignored.some((entry) => (
    Number(entry?.candidatePrNumber) === Number(candidate?.pr_number)
    && String(entry?.candidateHeadSha || '') === String(candidate?.head_sha || '')
    && entry?.stale !== true
  ));
}

function validateOperatorAudit({ actor, reason, salvage = true, validation = true } = {}) {
  if (!normalizeText(actor)) throw new Error('operator actor is required');
  if (!normalizeText(reason)) throw new Error('auditable reason is required');
  if (!normalizeText(salvage)) throw new Error('salvage audit text is required');
  if (!normalizeText(validation)) throw new Error('validation audit text is required');
}

export function selectDuplicateFamilySurvivor(db, {
  familyId,
  survivorPrNumber,
  reportPath,
  reportVerifiedHeadSha,
  actor,
  reason,
  salvage,
  validation,
  now = new Date().toISOString(),
} = {}) {
  validateOperatorAudit({ actor, reason, salvage, validation });
  const normalizedReportPath = normalizeText(reportPath);
  if (!normalizedReportPath || normalizedReportPath.startsWith('/') || normalizedReportPath.includes('..')) {
    throw new Error('report path must be a repository-relative committed path');
  }
  if (!/^docs\/research\/duplicate-pr-divergence\/reports\/.+\.md$/i.test(normalizedReportPath)) {
    throw new Error('report path must name a duplicate-divergence corpus report');
  }
  const family = requireDuplicateFamily(db, familyId);
  if ([DUPLICATE_FAMILY_STATUS_ABANDONED, DUPLICATE_FAMILY_STATUS_RESOLVED, DUPLICATE_FAMILY_STATUS_SURVIVOR_MERGED].includes(String(family.status).toLowerCase())) {
    throw new Error(`cannot select a survivor from ${family.status} family ${familyId}`);
  }
  const candidates = duplicateFamilyCandidateRows(db, familyId);
  const survivor = candidates.find((row) => Number(row.pr_number) === Number(survivorPrNumber));
  if (!survivor) throw new Error(`survivor PR #${survivorPrNumber} is not a member of ${familyId}`);
  if (!survivor.head_sha || survivor.head_sha !== reportVerifiedHeadSha) {
    throw new Error('report verification must be bound to the selected survivor current head');
  }
  const selection = {
    transition: 'survivor-selected',
    candidatePrNumber: Number(survivorPrNumber),
    candidateHeadSha: survivor.head_sha,
    reportPath: normalizedReportPath,
    reportVerifiedHeadSha,
    actor: normalizeText(actor),
    reason: normalizeText(reason),
    salvage: normalizeText(salvage),
    validation: normalizeText(validation),
    observedAt: now,
  };
  const override = duplicateFamilyOverride(family);
  const transition = {
    at: now,
    transition: 'survivor-selected',
    status: 'survivor-selected',
    actor: selection.actor,
    reason: selection.reason,
    survivorPrNumber: selection.candidatePrNumber,
    survivorHeadSha: selection.candidateHeadSha,
    reportPath: normalizedReportPath,
  };
  db.transaction(() => {
    db.prepare(
      `UPDATE duplicate_families
          SET status = 'survivor-selected', selected_survivor_pr_number = ?, report_path = ?,
              operator_override_json = ?, transition_log_json = ?, updated_at = ?
        WHERE family_id = ?`
    ).run(
      selection.candidatePrNumber,
      normalizedReportPath,
      JSON.stringify({ ...override, selection }),
      appendTransitionLog(family.transition_log_json, transition),
      now,
      familyId,
    );
    const updateRole = db.prepare(
      `UPDATE duplicate_family_candidates
          SET role = ?, updated_at = ?
        WHERE family_id = ? AND pr_number = ?`
    );
    for (const candidate of candidates) {
      const suppressed = parseMaybeJson(candidate.suppressions_json, []).length > 0;
      const role = Number(candidate.pr_number) === selection.candidatePrNumber
        ? 'survivor'
        : (suppressed || isActiveIgnoredCandidate(override, candidate)) ? 'candidate' : 'loser';
      updateRole.run(role, now, familyId, candidate.pr_number);
    }
  })();
  return selection;
}

export function ignoreDuplicateFamilyCandidate(db, {
  familyId, prNumber, candidateHeadSha, actor, reason, now = new Date().toISOString(),
} = {}) {
  validateOperatorAudit({ actor, reason, salvage: true, validation: true });
  const family = requireDuplicateFamily(db, familyId);
  const candidate = duplicateFamilyCandidateRows(db, familyId)
    .find((row) => Number(row.pr_number) === Number(prNumber));
  if (!candidate) throw new Error(`PR #${prNumber} is not a member of ${familyId}`);
  if (!candidate.head_sha || candidate.head_sha !== candidateHeadSha) {
    throw new Error('ignored-not-duplicate override must name the candidate current head');
  }
  const override = duplicateFamilyOverride(family);
  const ignoredCandidates = (Array.isArray(override.ignoredCandidates) ? override.ignoredCandidates : [])
    .filter((entry) => Number(entry?.candidatePrNumber) !== Number(prNumber));
  ignoredCandidates.push({
    transition: 'ignored-not-duplicate',
    candidatePrNumber: Number(prNumber),
    candidateHeadSha,
    actor: normalizeText(actor),
    reason: normalizeText(reason),
    observedAt: now,
  });
  db.prepare(
    `UPDATE duplicate_families
        SET operator_override_json = ?, transition_log_json = ?, updated_at = ?
      WHERE family_id = ?`
  ).run(
    JSON.stringify({ ...override, ignoredCandidates }),
    appendTransitionLog(family.transition_log_json, {
      at: now, transition: 'ignored-not-duplicate', status: family.status,
      actor: normalizeText(actor), reason: normalizeText(reason),
      candidatePrNumber: Number(prNumber), candidateHeadSha,
    }),
    now,
    familyId,
  );
  return ignoredCandidates.at(-1);
}

export function abandonDuplicateFamily(db, {
  familyId, actor, reason, now = new Date().toISOString(),
} = {}) {
  validateOperatorAudit({ actor, reason, salvage: true, validation: true });
  const family = requireDuplicateFamily(db, familyId);
  const override = duplicateFamilyOverride(family);
  const abandoned = { transition: 'abandoned', actor: normalizeText(actor), reason: normalizeText(reason), observedAt: now };
  db.prepare(
    `UPDATE duplicate_families
        SET status = 'abandoned', operator_override_json = ?, transition_log_json = ?, updated_at = ?
      WHERE family_id = ?`
  ).run(
    JSON.stringify({ ...override, abandoned }),
    appendTransitionLog(family.transition_log_json, {
      at: now, transition: 'abandoned', status: 'abandoned', actor: abandoned.actor, reason: abandoned.reason,
    }),
    now,
    familyId,
  );
  return abandoned;
}

function reportUrlForSelection(repoPath, selection) {
  const encodedPath = String(selection.reportPath || '').split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repoPath}/blob/${selection.candidateHeadSha}/${encodedPath}`;
}

function pullHeadSha(pull) {
  return String(pull?.head?.sha || pull?.headRefOid || pull?.headSha || '').trim();
}

function pullMerged(pull) {
  return pull?.merged === true || Boolean(pull?.merged_at || pull?.mergedAt);
}

export async function reconcileDuplicateFamilyCloseouts({
  db,
  octokit,
  repoPath,
  logger = console,
  cfg = null,
  census = null,
} = {}) {
  if (!db || !octokit || !repoPath) return { inspected: 0, closed: 0 };
  const projectionVerified = !census || (!census.error && Array.isArray(census.familyIds));
  if (!projectionVerified) {
    logger?.log?.(`[watcher] duplicate-family closeout skipped for ${repoPath}: census state unverified this tick`);
    return { inspected: 0, closed: 0, skipped: 'census-unverified' };
  }
  if (cfg?.enabled !== true || cfg?.autonomousMergeExecutionEnabled === false) {
    logger?.log?.(
      `[watcher] duplicate-family closeout skipped for ${repoPath}: merge authority disabled`,
    );
    return { inspected: 0, closed: 0, skipped: 'merge-authority-disabled' };
  }
  const [owner, repo] = String(repoPath).split('/');
  if (!owner || !repo) return { inspected: 0, closed: 0 };
  const families = db.prepare(
    `SELECT * FROM duplicate_families
      WHERE target_repo = ? AND status IN ('survivor-selected', 'survivor-merged')`
  ).all(repoPath);
  let closed = 0;
  for (const initial of families) {
    let family = initial;
    const candidates = duplicateFamilyCandidateRows(db, family.family_id);
    const survivor = candidates.find((row) => Number(row.pr_number) === Number(family.selected_survivor_pr_number));
    const override = duplicateFamilyOverride(family);
    const selection = override.selection;
    if (!survivor) continue;
    if (!selection || selection.stale || selection.candidateHeadSha !== survivor.head_sha) continue;
    let survivorPull;
    try {
      const response = await octokit.rest.pulls.get({ owner, repo, pull_number: survivor.pr_number });
      survivorPull = response?.data || response;
    } catch (err) {
      logger?.error?.(
        `[watcher] duplicate-family survivor refresh failed for ${repoPath}#${survivor.pr_number}: ${err?.message || err}`,
      );
      continue;
    }
    if (pullHeadSha(survivorPull) && pullHeadSha(survivorPull) !== survivor.head_sha) continue;
    if (!pullMerged(survivorPull)) continue;
    if (String(survivor.pr_state || '').toLowerCase() !== 'merged') {
      db.prepare(
        `UPDATE duplicate_family_candidates SET pr_state = 'merged', updated_at = ?
          WHERE repo = ? AND pr_number = ? AND head_sha = ?`
      ).run(new Date().toISOString(), repoPath, survivor.pr_number, survivor.head_sha);
    }
    const now = new Date().toISOString();
    if (family.status === 'survivor-selected') {
      const nextLog = appendTransitionLog(family.transition_log_json, {
        at: now, transition: 'survivor-merged', status: 'survivor-merged',
        survivorPrNumber: survivor.pr_number, survivorHeadSha: survivor.head_sha,
      });
      db.prepare(
        `UPDATE duplicate_families SET status = 'survivor-merged', transition_log_json = ?, updated_at = ?
          WHERE family_id = ? AND status = 'survivor-selected'`
      ).run(nextLog, now, family.family_id);
      family = { ...family, status: 'survivor-merged', transition_log_json: nextLog };
    }
    const ignored = Array.isArray(override.ignoredCandidates) ? override.ignoredCandidates : [];
    const losers = candidates.filter((row) => (
      row.role === 'loser'
      && String(row.pr_state || '').toLowerCase() === 'open'
      && parseMaybeJson(row.suppressions_json, []).length === 0
      && !ignored.some((entry) => Number(entry?.candidatePrNumber) === Number(row.pr_number))
    ));
    const staleIgnored = ignored.filter((entry) => entry?.stale === true);
    let needsReadjudication = false;
    for (const entry of staleIgnored) {
      if (candidates.some((row) => Number(row.pr_number) === Number(entry?.candidatePrNumber))) {
        needsReadjudication = true;
        logger?.log?.(
          `[watcher] duplicate-family closeout skipped ignored stale candidate ${repoPath}#${entry.candidatePrNumber}: re-adjudication required`,
        );
      }
    }
    let failed = false;
    for (const loser of losers) {
      let loserPull;
      try {
        const response = await octokit.rest.pulls.get({ owner, repo, pull_number: loser.pr_number });
        loserPull = response?.data || response;
      } catch (err) {
        failed = true;
        logger?.error?.(
          `[watcher] duplicate-family loser refresh failed for ${repoPath}#${loser.pr_number}: ${err?.message || err}`,
        );
        break;
      }
      if (String(loserPull?.state || '').toLowerCase() !== 'open') continue;
      if (pullHeadSha(loserPull) && pullHeadSha(loserPull) !== loser.head_sha) continue;
      const survivorUrl = `https://github.com/${repoPath}/pull/${survivor.pr_number}`;
      const reportUrl = reportUrlForSelection(repoPath, selection);
      const body = [
        '<!-- adversarial-review:duplicate-family-loser-closeout -->',
        `Closed as a duplicate-family loser after survivor ${survivorUrl} merged.`,
        '',
        `Adjudication report: ${reportUrl}`,
        `Survivor choice: ${selection.reason}`,
        `Salvage: ${selection.salvage}`,
        `Validation: ${selection.validation}`,
      ].join('\n');
      try {
        let alreadyCommented = false;
        if (typeof octokit.rest.issues.listComments === 'function') {
          const { data } = await octokit.rest.issues.listComments({
            owner, repo, issue_number: loser.pr_number, per_page: 100,
            sort: 'created', direction: 'desc',
          });
          alreadyCommented = (Array.isArray(data) ? data : []).some((comment) => (
            String(comment?.body || '').includes('<!-- adversarial-review:duplicate-family-loser-closeout -->')
          ));
        }
        if (!alreadyCommented) {
          await octokit.rest.issues.createComment({ owner, repo, issue_number: loser.pr_number, body });
        }
        await octokit.rest.pulls.update({ owner, repo, pull_number: loser.pr_number, state: 'closed' });
        db.prepare(
          `UPDATE duplicate_family_candidates SET pr_state = 'closed', updated_at = ?
            WHERE repo = ? AND pr_number = ? AND head_sha = ?`
        ).run(new Date().toISOString(), repoPath, loser.pr_number, loser.head_sha);
        closed += 1;
      } catch (err) {
        failed = true;
        logger?.error?.(
          `[watcher] duplicate-family loser closeout failed for ${repoPath}#${loser.pr_number}: ${err?.message || err}`,
        );
        break;
      }
    }
    if (!failed && !needsReadjudication) {
      const resolvedAt = new Date().toISOString();
      db.prepare(
        `UPDATE duplicate_families SET status = 'resolved', transition_log_json = ?, updated_at = ?
          WHERE family_id = ? AND status = 'survivor-merged'`
      ).run(
        appendTransitionLog(family.transition_log_json, {
          at: resolvedAt, transition: 'resolved', status: 'resolved',
          reason: 'survivor-merged-and-losers-closed',
        }),
        resolvedAt,
        family.family_id,
      );
    }
  }
  return { inspected: families.length, closed };
}

export async function reconcileDuplicateFamilyLabels({ db, octokit, repoPath, logger = console, census = null, cfg = null } = {}) {
  if (!db || !repoPath) return { inspected: 0, changed: 0, skipped: 'missing-store-or-repo' };
  if (!octokit) {
    logger?.log?.(`[watcher] duplicate-family label projection skipped for ${repoPath}: octokit unavailable`);
    return { inspected: 0, changed: 0, skipped: 'octokit-unavailable' };
  }
  const projectionVerified = !census || (!census.error && Array.isArray(census.familyIds));
  if (!projectionVerified) {
    logger?.log?.(`[watcher] duplicate-family hold projection skipped for ${repoPath}: census state unverified this tick`);
  }
  ensureDuplicateFamilySchema(db);
  const [owner, repo] = String(repoPath).split('/');
  if (!owner || !repo) return { inspected: 0, changed: 0 };
  const rows = db.prepare(
    `SELECT duplicate_families.*, duplicate_family_candidates.pr_number,
            duplicate_family_candidates.head_sha AS candidate_head_sha,
            duplicate_family_candidates.role AS candidate_role,
            duplicate_family_candidates.labels_json,
            duplicate_family_candidates.suppressions_json
       FROM duplicate_family_candidates
       JOIN duplicate_families
         ON duplicate_families.family_id = duplicate_family_candidates.family_id
      WHERE duplicate_family_candidates.repo = ?
        AND lower(duplicate_family_candidates.pr_state) = 'open'`
  ).all(repoPath);
  const updateCandidateLabels = db.prepare(
    `UPDATE duplicate_family_candidates
        SET labels_json = ?,
            updated_at = ?
      WHERE repo = ?
        AND pr_number = ?`
  );
  let changed = 0;
  for (const row of rows) {
    const gate = evaluateDuplicateFamilyCandidate(row, {
      prNumber: row.pr_number,
      headSha: row.candidate_head_sha,
    });
    const suppressed = parseMaybeJson(row.suppressions_json, []).length > 0;
    const held = gate.held && !suppressed;
    const current = lowerLabelSet(parseMaybeJson(row.labels_json, []));
    const next = new Set(current);
    const familyActive = !['inactive', 'resolved'].includes(String(row.status || '').toLowerCase());
    const roleLabel = row.candidate_role === 'survivor'
      ? DUPLICATE_FAMILY_SURVIVOR_LABEL
      : row.candidate_role === 'loser' && !suppressed ? DUPLICATE_FAMILY_LOSER_LABEL : null;
    const wanted = familyActive
      ? [DUPLICATE_FAMILY_LABEL, ...(held ? [DUPLICATE_FAMILY_HOLD_LABEL] : []), ...(roleLabel ? [roleLabel] : [])]
      : [];
    const additions = projectionVerified ? wanted.filter((name) => !current.has(name)) : [];
    const removeHold = !held && current.has(DUPLICATE_FAMILY_HOLD_LABEL);
    const removeFamily = !familyActive && current.has(DUPLICATE_FAMILY_LABEL);
    const obsoleteRoleLabels = [DUPLICATE_FAMILY_SURVIVOR_LABEL, DUPLICATE_FAMILY_LOSER_LABEL]
      .filter((name) => current.has(name) && (!familyActive || name !== roleLabel));
    let persist = false;
    try {
      if (removeHold) {
        await octokit.rest.issues.removeLabel({
          owner, repo, issue_number: row.pr_number, name: DUPLICATE_FAMILY_HOLD_LABEL,
        });
        changed += 1;
        next.delete(DUPLICATE_FAMILY_HOLD_LABEL);
        persist = true;
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        next.delete(DUPLICATE_FAMILY_HOLD_LABEL);
        persist = true;
      } else {
        logger?.error?.(
          `[watcher] duplicate-family hold removal failed for ${repoPath}#${row.pr_number}: ${err?.message || err}`,
        );
      }
    }
    try {
      if (removeFamily) {
        await octokit.rest.issues.removeLabel({
          owner, repo, issue_number: row.pr_number, name: DUPLICATE_FAMILY_LABEL,
        });
        changed += 1;
        next.delete(DUPLICATE_FAMILY_LABEL);
        persist = true;
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        next.delete(DUPLICATE_FAMILY_LABEL);
        persist = true;
      } else {
        logger?.error?.(
          `[watcher] duplicate-family label removal failed for ${repoPath}#${row.pr_number}: ${err?.message || err}`,
        );
      }
    }
    for (const name of obsoleteRoleLabels) {
      try {
        await octokit.rest.issues.removeLabel({ owner, repo, issue_number: row.pr_number, name });
        changed += 1;
        next.delete(name);
        persist = true;
      } catch (err) {
        if (isNotFoundError(err)) {
          next.delete(name);
          persist = true;
        } else {
          logger?.error?.(
            `[watcher] duplicate-family role label removal failed for ${repoPath}#${row.pr_number}: ${err?.message || err}`,
          );
        }
      }
    }
    try {
      if (additions.length > 0) {
        await octokit.rest.issues.addLabels({ owner, repo, issue_number: row.pr_number, labels: additions });
        changed += additions.length;
        for (const label of additions) next.add(label);
        persist = true;
      }
    } catch (err) {
      logger?.error?.(
        `[watcher] duplicate-family label add failed for ${repoPath}#${row.pr_number}: ${err?.message || err}`,
      );
    }
    if (persist) {
      updateCandidateLabels.run(JSON.stringify(labelsFromLowerSet(next)), new Date().toISOString(), repoPath, row.pr_number);
    }
  }
  const closeout = await reconcileDuplicateFamilyCloseouts({ db, octokit, repoPath, logger, census, cfg });
  return { inspected: rows.length, changed, closeout };
}
