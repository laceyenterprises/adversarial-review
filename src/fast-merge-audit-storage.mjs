import { join } from 'node:path';

const FAST_MERGE_AUDIT_DIR = ['data', 'fast-merge-audits'];

function fastMergeAuditDir(rootDir) {
  return join(rootDir, ...FAST_MERGE_AUDIT_DIR);
}

export {
  FAST_MERGE_AUDIT_DIR,
  fastMergeAuditDir,
};
