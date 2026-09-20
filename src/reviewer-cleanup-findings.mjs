import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { probeReviewerSession } from './reviewer-reattach.mjs';

const CLEANUP_FINDING_DIR = ['data', 'reviewer-cleanup-findings'];

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

function readReviewerCleanupFindings(rootDir) {
  const dir = cleanupFindingDir(rootDir);
  if (!existsSync(dir)) return [];
  const findings = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      findings.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch {
      // Corrupt durable findings should not block rechecking every other leak.
    }
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
} = {}) {
  const findings = readReviewerCleanupFindings(rootDir);
  let cleared = 0;
  let stillAlive = 0;
  let unknown = 0;
  for (const finding of findings) {
    try {
      const probe = probeSessionImpl({
        pgid: finding.reviewerPgid,
        sessionUuid: finding.reviewerSessionUuid,
      });
      const alive = typeof probe === 'boolean' ? probe : probe?.alive === true;
      if (!alive) {
        removeReviewerCleanupFinding(rootDir, finding.reviewerSessionUuid);
        cleared += 1;
        continue;
      }
      stillAlive += 1;
      writeReviewerCleanupFinding(rootDir, finding, { now, log });
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

function recheckReviewerCleanupFindingsForWatcher(rootDir, log = console) {
  return recheckReviewerCleanupFindings({ rootDir, log });
}

function writeReviewerCleanupFindingForWatcher(rootDir, finding, log = console) {
  return writeReviewerCleanupFinding(rootDir, finding, { log });
}

export {
  cleanupFindingPath,
  readReviewerCleanupFindings,
  recheckReviewerCleanupFindings,
  recheckReviewerCleanupFindingsForWatcher,
  removeReviewerCleanupFinding,
  writeReviewerCleanupFinding,
  writeReviewerCleanupFindingForWatcher,
};
