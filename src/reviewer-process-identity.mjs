import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { PGID_IDENTITY_TOLERANCE_MS } from './process-group-identity.mjs';

const execFileAsync = promisify(execFile);

export function directReviewerIdentity(record) {
  const { repo, prNumber, reviewerHeadSha, reviewerSessionUuid } = record?.subjectContext || {};
  if (record?.runtime !== 'cli-direct' || !repo || !Number.isSafeInteger(prNumber)
    || !reviewerHeadSha || !reviewerSessionUuid) return null;
  return { repo, prNumber, reviewerHeadSha, reviewerSessionUuid };
}

export async function verifyDirectReviewerIdentity(record, { execFileImpl = execFileAsync } = {}) {
  const expected = directReviewerIdentity(record);
  if (!expected || expected.reviewerSessionUuid !== record.sessionUuid
    || !Number.isSafeInteger(record.pgid) || record.pgid <= 0) {
    return { match: false, reason: 'incomplete reviewer process identity' };
  }
  try {
    const { stdout } = await execFileImpl('ps', [
      '-ww', '-p', String(record.pgid), '-o', 'pgid=,lstart=,command=',
    ], { timeout: loadAwareTimeoutMs(5_000) });
    const processRow = String(stdout).trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    const argv = processRow?.[3].match(/^\S*node(?:\s+)\S*[/]reviewer\.mjs\s+(\{.*\})$/)?.[1];
    if (Number(processRow?.[1]) !== record.pgid || !argv) {
      return { match: false, reason: 'reviewer group leader or command did not match' };
    }
    const actual = JSON.parse(argv);
    const drift = Math.abs(Date.parse(processRow[2]) - Date.parse(record.spawnedAt));
    if (!(drift <= PGID_IDENTITY_TOLERANCE_MS)
      || !Object.entries(expected).every(([key, value]) => actual[key] === value)) {
      return { match: false, reason: 'reviewer start time or launch arguments did not match' };
    }
    return { match: true };
  } catch {
    return { match: false, reason: 'reviewer process identity probe failed' };
  }
}
