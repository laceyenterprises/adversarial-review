import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const FAST_MERGE_AUDIT_DIR = ['data', 'fast-merge-audits'];

function fastMergeAuditDir(rootDir) {
  return join(rootDir, ...FAST_MERGE_AUDIT_DIR);
}

function sanitizeFastMergeAuditSegment(value, replacement = '_') {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, replacement);
}

function fastMergeAuditPath(rootDir, { repo, prNumber, action, at, uuid = randomUUID() } = {}) {
  const safeRepo = sanitizeFastMergeAuditSegment(repo, '_');
  const safeAt = sanitizeFastMergeAuditSegment(at || new Date().toISOString(), '-');
  return join(
    fastMergeAuditDir(rootDir),
    `fast-merge-${action || 'unknown'}-${safeRepo}-${prNumber}-${safeAt}-${uuid}.json`
  );
}

export {
  FAST_MERGE_AUDIT_DIR,
  fastMergeAuditDir,
  fastMergeAuditPath,
};
