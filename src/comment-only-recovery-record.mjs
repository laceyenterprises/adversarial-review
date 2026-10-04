import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECOVERY_LIMIT = 3;
export const RECOVERY_SOURCE_PATH = Symbol('comment-only-recovery-source-path');
export const recoveryDigest = (job) => createHash('sha256').update(JSON.stringify(job)).digest('hex');
export function recoveryRecordPath(rootDir, jobId, attempt) {
  if (!/^[a-zA-Z0-9_.-]{1,240}$/u.test(jobId)) throw new Error('invalid-recovery-job-id');
  return join(rootDir, 'data', 'follow-up-jobs', 'final-round-recoveries', `${jobId}.${attempt}.json`);
}

// A derived read model only. Never rewrite the stopped job or its historical
// completion fields; consumers still see its original terminal status/round.
export function withCommentOnlyRecovery(rootDir, job) {
  if (!job?.jobId || job.finalRound !== 'comment-only' || job.status !== 'stopped') return job;
  for (let attempt = 1; attempt <= RECOVERY_LIMIT; attempt += 1) {
    let record;
    try {
      const raw = readFileSync(recoveryRecordPath(rootDir, job.jobId, attempt), 'utf8');
      if (raw.length > 65536) continue;
      record = JSON.parse(raw);
    } catch { continue; }
    if (job[RECOVERY_SOURCE_PATH]) {
      try {
        if (recoveryDigest(JSON.parse(readFileSync(job[RECOVERY_SOURCE_PATH], 'utf8'))) !== record.sourceDigest) continue;
      } catch { continue; }
    }
    if (record.schemaVersion !== 1 || record.sourceDigest !== recoveryDigest(job) ||
        record.jobId !== job.jobId || record.repo !== job.repo || record.prNumber !== job.prNumber ||
        record.reviewedHead !== job.revisionRef || record.completed !== true ||
        record.head !== job.completion?.withheldPushHeadSha ||
        record.completion?.workerPushedHeadSha !== record.head ||
        record.completion?.workerPushProof?.method !== 'git-cherry-replay' ||
        record.completion?.workerPushProof?.generatedIndexPolicy !== 'agent-os-main-index-v1' ||
        record.completion?.finalRoundOutcome?.completed !== true) continue;
    return { ...job, finalRoundRecovery: record,
      completion: { ...job.completion, workerPushedHeadSha: record.head,
        workerPushProof: record.completion.workerPushProof } };
  }
  return job;
}
