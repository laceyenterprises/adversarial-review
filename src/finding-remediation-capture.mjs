import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { linkFindingRemediation } from './review-finding-records.mjs';

// Completion has already persisted the job before this observational write.
// A failed capture leaves that durable job available for an offline replay.
export function captureFindingRemediationSafe({ rootDir, job, log = console }) {
  const path = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(path)) return;
  let db;
  try {
    db = new Database(path, { fileMustExist: true, timeout: 100 });
    const round = job.remediationPlan?.rounds?.find(r => r.round === job.remediationPlan.currentRound);
    const workspace = round?.worker?.workspaceDir || job.workspaceDir || job.remediationWorker?.workspaceDir;
    return linkFindingRemediation(db, { job, workspaceDir: workspace ? resolve(rootDir, workspace) : null });
  } catch {
    log.warn?.('[review-findings] remediation projection failed; replay the stored job');
  } finally { db?.close(); }
}
