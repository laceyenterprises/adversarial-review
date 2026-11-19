import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { followUpJobFileFilter } from './follow-up-job-names.mjs';
import { repositoryNames } from './repository-names.mjs';

const SHA = /^[0-9a-f]{40}$/i;
const sameHead = (left, right) => typeof left === 'string' && SHA.test(left)
  && left.toLowerCase() === right.toLowerCase();

function launcherAlive(pid) {
  try { return process.kill(pid, 0); }
  catch { return false; }
}

function ownsClaim(job, { repo, prNumber, headSha, ticket, launcherPid }) {
  const plan = job.remediationPlan;
  const rounds = Array.isArray(plan?.rounds)
    ? plan.rounds.filter(round => round?.round === plan.currentRound) : [];
  const [round] = rounds;
  return job.kind === 'adversarial-review-follow-up' && job.status === 'in_progress'
    && job.jobId === ticket && job.repo.toLowerCase() === repo.toLowerCase()
    && job.prNumber === prNumber && sameHead(job.revisionRef, headSha)
    && typeof job.claimedAt === 'string' && Number.isFinite(Date.parse(job.claimedAt))
    && job.claimedBy?.launcherPid === launcherPid
    && typeof job.claimedBy.workerType === 'string' && job.claimedBy.workerType.length > 0
    && job.remediationWorker == null && plan?.dispatchPath === 'hq' && !plan.stop
    && Number.isSafeInteger(plan.currentRound) && plan.currentRound > 0
    && Number.isSafeInteger(plan.maxRounds) && plan.currentRound <= plan.maxRounds
    && plan.nextAction?.type === 'worker-spawn' && plan.nextAction.round === plan.currentRound
    && rounds.length === 1 && round.state === 'claimed' && !round.spawnedAt && !round.publishedHeadSha
    && round.claimedAt === job.claimedAt && round.claimedBy?.launcherPid === launcherPid
    && round.claimedBy.workerType === job.claimedBy.workerType && sameHead(round.startHeadSha, headSha)
    && launcherAlive(launcherPid);
}

export function readRepairFollowUpClaim(rootDir, { repo, prNumber, headSha, ticket, launcherPid }) {
  const target = { rootDir, repo, prNumber, caseInsensitiveRepo: true };
  const matchesName = followUpJobFileFilter(target);
  const ownFile = `${ticket}.json`;
  const buckets = ['pending', 'inProgress'];
  const refused = jobId => ({ ok: false, reason: 'remediation-owned', jobId });
  if (typeof ticket !== 'string' || !/^[\w.-]+$/.test(ticket) || !matchesName(ownFile)) {
    for (const bucket of buckets) {
      const [entry] = listFollowUpJobsInDir(rootDir, bucket, target);
      if (entry) return refused(entry.job?.jobId);
    }
    return { ok: true };
  }

  // The native dispatch boundary supplies the explicit ticket and its actual
  // parent PID. Read raw records so normalization cannot fill in missing proof.
  // Scan both buckets by payload as well as filename to catch misfiled owners.
  let claimedAt;
  try {
    const repos = new Set(repositoryNames(rootDir, repo).map(name => name.toLowerCase()));
    for (const bucket of buckets) {
      const dir = getFollowUpJobDir(rootDir, bucket);
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.name.endsWith('.json')) continue;
        if (!entry.isFile()) return { ok: false, reason: 'remediation-ownership-unknown' };
        const job = JSON.parse(readFileSync(join(dir, entry.name), 'utf8'));
        if (typeof job?.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(job.repo)) {
          return { ok: false, reason: 'remediation-ownership-unknown' };
        }
        const namedForPr = matchesName(entry.name);
        if (!namedForPr && !repos.has(job.repo.toLowerCase())) continue;
        if (!Number.isSafeInteger(job.prNumber) || job.prNumber <= 0) {
          return { ok: false, reason: 'remediation-ownership-unknown' };
        }
        if (!namedForPr && job.prNumber !== prNumber) continue;
        if (bucket !== 'inProgress' || entry.name !== ownFile || claimedAt
          || !Number.isSafeInteger(launcherPid) || launcherPid <= 1
          || !ownsClaim(job, { repo, prNumber, headSha, ticket, launcherPid })) return refused(job.jobId);
        claimedAt = job.claimedAt;
      }
    }
  } catch {
    return { ok: false, reason: 'remediation-ownership-unknown' };
  }
  return claimedAt ? { ok: true, claimedAt } : refused(ticket);
}
