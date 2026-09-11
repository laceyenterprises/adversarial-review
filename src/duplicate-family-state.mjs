import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readBuildCompletionSignalForPr } from './session-ledger-read-adapter.mjs';

export const DUPLICATE_FAMILY_STATUS_ADVISORY = 'advisory';
export const DUPLICATE_FAMILY_STATUS_INACTIVE = 'inactive';
export const DUPLICATE_FAMILY_SUPPRESSION_LABEL = 'not-a-duplicate-stack';

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,12}-\d{1,6})\b/i;
const STACK_LABEL_RE = /^(?:stack|stacked|depends-on|follow-up|followup|remediation)(?::|$)/i;
const EXPLICIT_IDENTITY_LABEL_RE = /^work-identity:(.+)$/i;

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
      PRIMARY KEY (family_id, repo, pr_number),
      FOREIGN KEY (family_id) REFERENCES duplicate_families(family_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_duplicate_family_candidates_pr
      ON duplicate_family_candidates(repo, pr_number, head_sha);
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
  let result = reader({ ...common, headSha: headSha || null });
  let resolvedBy = 'current-head';
  if (!result?.ok) {
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
    const identity = extractDuplicateWorkIdentity(entry, {
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
    });
  }
  return families;
}

function readExistingFamilyByKey(db, familyKey) {
  return db.prepare('SELECT * FROM duplicate_families WHERE family_key = ?').get(familyKey) || null;
}

function updateOperatorOverrideForHeadMove(existing, candidates) {
  const override = parseMaybeJson(existing?.operator_override_json, null);
  if (!override || typeof override !== 'object' || Array.isArray(override)) return existing?.operator_override_json || null;
  const prNumber = Number(override.candidatePrNumber ?? override.prNumber);
  const headSha = normalizeText(override.candidateHeadSha ?? override.headSha);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !headSha) return existing?.operator_override_json || null;
  const candidate = candidates.find((item) => item.prNumber === prNumber);
  if (!candidate || !candidate.headSha || candidate.headSha === headSha) return existing?.operator_override_json || null;
  return JSON.stringify({
    ...override,
    stale: true,
    staleReason: 'candidate-head-moved',
    staleAt: new Date().toISOString(),
    staleObservedHeadSha: candidate.headSha,
  });
}

function appendTransitionLog(existingJson, transition) {
  const existing = parseMaybeJson(existingJson, []);
  const transitions = Array.isArray(existing) ? existing : [];
  const alreadyPresent = transitions.some((entry) => (
    entry?.transition === transition.transition
    && entry?.status === transition.status
    && entry?.reason === transition.reason
  ));
  return JSON.stringify(alreadyPresent ? transitions : [...transitions, transition]);
}

export function upsertDuplicateFamilies(db, families, {
  now = new Date().toISOString(),
  repoPath = null,
  deactivateMissing = false,
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
         WHEN duplicate_families.status = 'inactive' THEN excluded.status
         ELSE duplicate_families.status
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
    `SELECT family_id, family_key, transition_log_json
       FROM duplicate_families
      WHERE target_repo = ?
        AND status = ?`
  );
  const markInactive = db.prepare(
    `UPDATE duplicate_families
        SET status = ?,
            candidate_count = 0,
            transition_log_json = ?,
            updated_at = ?,
            last_seen_at = ?
      WHERE family_id = ?
        AND status = ?`
  );
  const upsertCandidate = db.prepare(
    `INSERT INTO duplicate_family_candidates (
       family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
       head_sha, base_sha, role, work_identity_json, signals_json,
       suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(family_id, repo, pr_number) DO UPDATE SET
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
      const transitionLog = existing?.transition_log_json || JSON.stringify([{
        at: now,
        transition: 'detected-advisory',
        status: DUPLICATE_FAMILY_STATUS_ADVISORY,
      }]);
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
      const nextOverride = updateOperatorOverrideForHeadMove(row, family.candidates);
      if (nextOverride !== (row.operator_override_json || null)) {
        updateOverride.run(nextOverride, now, family.familyKey);
      }
      for (const candidate of family.candidates) {
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
      for (const row of selectActiveRepoFamilies.all(repoPath, DUPLICATE_FAMILY_STATUS_ADVISORY)) {
        if (activeKeys.has(row.family_key)) continue;
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
          DUPLICATE_FAMILY_STATUS_ADVISORY,
        );
      }
    }
    return changed;
  });
  return tx();
}

export function reconcileDuplicateFamiliesForRepo(db, subjectEntries, options = {}) {
  const families = detectDuplicateFamiliesForRepo(subjectEntries, options);
  const familyIds = upsertDuplicateFamilies(db, families, {
    ...options,
    repoPath: options.repoPath,
    deactivateMissing: true,
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
    }
    return result;
  };
  const spawnSyncImpl = (command, args, options = {}) => nodeSpawnSync(command, args, {
    ...options,
    timeout: Math.min(Math.max(1, Number(options.timeout) || 1500), 1500),
  });
  try {
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
  return new Set([
    'missing-ledger-target',
    'malformed-ledger-target',
    'postgres-configured-but-sqlite-resolved',
    'psql-not-installed',
    'ledger-read-failed',
  ]).has(String(reason || ''));
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
