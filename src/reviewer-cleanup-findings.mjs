import { existsSync, opendirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { probeReviewerSession } from './reviewer-reattach.mjs';

const CLEANUP_FINDING_DIR = ['data', 'reviewer-cleanup-findings'];
const DEFAULT_RECHECK_MAX_ROWS = 20;
const DEFAULT_RECHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupFindingDir(rootDir) {
  return join(rootDir, ...CLEANUP_FINDING_DIR);
}

function cleanupFindingPath(rootDir, sessionUuid) {
  const normalized = String(sessionUuid || '').trim();
  if (!normalized) {
    throw new TypeError('reviewerSessionUuid is required for cleanup findings');
  }
  if (normalized.includes('/') || normalized.includes('\\')) {
    throw new TypeError(`Invalid reviewerSessionUuid for file path: ${sessionUuid}`);
  }
  return join(cleanupFindingDir(rootDir), `${normalized}.json`);
}

function normalizeCleanupFinding(finding = {}, now = new Date()) {
  const observedAt = now.toISOString();
  return {
    id: String(finding.id || 'reviewer:posted_process_group_leak'),
    severity: String(finding.severity || 'warning'),
    repo: String(finding.repo || ''),
    prNumber: Number(finding.prNumber || finding.pr_number || 0),
    reviewerSessionUuid: String(finding.reviewerSessionUuid || finding.reviewer_session_uuid || ''),
    reviewerPgid: Number(finding.reviewerPgid || finding.reviewer_pgid || 0),
    matched: finding.matched === true || finding.matched === false ? finding.matched : null,
    postedAt: finding.postedAt ? String(finding.postedAt) : null,
    firstObservedAt: finding.firstObservedAt ? String(finding.firstObservedAt) : observedAt,
    lastObservedAt: observedAt,
    checks: Number.isInteger(finding.checks) && finding.checks >= 0 ? finding.checks : 1,
  };
}

function writeReviewerCleanupFinding(rootDir, finding, { now = new Date(), log = console } = {}) {
  const normalized = normalizeCleanupFinding(finding, now);
  if (!normalized.reviewerSessionUuid || !Number.isInteger(normalized.reviewerPgid) || normalized.reviewerPgid <= 0) {
    throw new TypeError('cleanup finding requires reviewerSessionUuid and positive reviewerPgid');
  }
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(cleanupFindingPath(rootDir, normalized.reviewerSessionUuid), 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      log.warn?.(
        `[watcher] reviewer_cleanup_finding_read_failed session=${normalized.reviewerSessionUuid} ` +
        `error=${err?.message || err}`
      );
    }
  }
  const merged = normalizeCleanupFinding({
    ...existing,
    ...normalized,
    firstObservedAt: existing?.firstObservedAt || normalized.firstObservedAt,
    checks: (Number(existing?.checks) || 0) + 1,
  }, now);
  writeFileAtomic(
    cleanupFindingPath(rootDir, merged.reviewerSessionUuid),
    `${JSON.stringify(merged, null, 2)}\n`,
  );
  return merged;
}

function readReviewerCleanupFindings(rootDir, { maxRows = Number.POSITIVE_INFINITY } = {}) {
  const dir = cleanupFindingDir(rootDir);
  if (!existsSync(dir)) return [];
  const findings = [];
  const limit = Number.isInteger(Number(maxRows)) && Number(maxRows) >= 0
    ? Number(maxRows)
    : Number.POSITIVE_INFINITY;
  const handle = opendirSync(dir);
  try {
    let entry;
    while (findings.length < limit && (entry = handle.readSync())) {
      const name = entry.name;
      if (!name.endsWith('.json')) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try {
        findings.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      } catch {
        // Corrupt durable findings should not block rechecking every other leak.
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {}
  }
  return findings;
}

function removeReviewerCleanupFinding(rootDir, sessionUuid) {
  rmSync(cleanupFindingPath(rootDir, sessionUuid), { force: true });
}

function recheckReviewerCleanupFindings({
  rootDir,
  probeSessionImpl = probeReviewerSession,
  now = new Date(),
  log = console,
  maxRows = DEFAULT_RECHECK_MAX_ROWS,
  maxAgeMs = DEFAULT_RECHECK_MAX_AGE_MS,
} = {}) {
  let findings = [];
  let cleared = 0;
  let stillAlive = 0;
  let unknown = 0;
  try {
    findings = readReviewerCleanupFindings(rootDir, { maxRows });
  } catch (err) {
    log.warn?.(
      `[watcher] reviewer_cleanup_findings_read_failed error=${err?.message || err}`
    );
    return { scanned: 0, stillAlive, cleared, unknown: 1 };
  }
  for (const finding of findings) {
    try {
      const firstObservedAt = Date.parse(finding.firstObservedAt || '');
      if (Number.isFinite(firstObservedAt) && Number.isFinite(Number(maxAgeMs)) &&
        Number(maxAgeMs) >= 0 && now.getTime() - firstObservedAt > Number(maxAgeMs)) {
        removeReviewerCleanupFinding(rootDir, finding.reviewerSessionUuid);
        cleared += 1;
        continue;
      }
      const probe = probeSessionImpl({
        pgid: finding.reviewerPgid,
        sessionUuid: finding.reviewerSessionUuid,
      });
      const alive = typeof probe === 'boolean' ? probe : probe?.alive === true && probe?.matched !== false;
      if (!alive) {
        removeReviewerCleanupFinding(rootDir, finding.reviewerSessionUuid);
        cleared += 1;
        continue;
      }
      stillAlive += 1;
      writeReviewerCleanupFinding(rootDir, {
        ...finding,
        matched: typeof probe === 'boolean' ? finding.matched : probe?.matched ?? null,
      }, { now, log });
    } catch (err) {
      unknown += 1;
      log.warn?.(
        `[watcher] reviewer_cleanup_finding_recheck_failed session=${finding.reviewerSessionUuid || 'unknown'} ` +
        `pgid=${finding.reviewerPgid || 'unknown'} error=${err?.message || err}`
      );
    }
  }
  if (stillAlive > 0 || unknown > 0 || cleared > 0) {
    log.warn?.(
      `[watcher] reviewer_cleanup_findings_rechecked still_alive=${stillAlive} cleared=${cleared} unknown=${unknown}`
    );
  }
  return { scanned: findings.length, stillAlive, cleared, unknown };
}

function recheckReviewerCleanupFindingsForWatcher(rootDir, log = console, options = {}) {
  try {
    return recheckReviewerCleanupFindings({ rootDir, log, ...options });
  } catch (err) {
    log.warn?.(`[watcher] reviewer_cleanup_findings_recheck_tick_failed error=${err?.message || err}`);
    return { scanned: 0, stillAlive: 0, cleared: 0, unknown: 1 };
  }
}

function writeReviewerCleanupFindingForWatcher(rootDir, finding, log = console) {
  return writeReviewerCleanupFinding(rootDir, finding, { log });
}

export {
  cleanupFindingPath,
  DEFAULT_RECHECK_MAX_AGE_MS,
  DEFAULT_RECHECK_MAX_ROWS,
  readReviewerCleanupFindings,
  recheckReviewerCleanupFindings,
  recheckReviewerCleanupFindingsForWatcher,
  removeReviewerCleanupFinding,
  writeReviewerCleanupFinding,
  writeReviewerCleanupFindingForWatcher,
};
