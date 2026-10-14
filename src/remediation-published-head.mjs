// REMLINK-01: recovery requires worker/service evidence, never just a moved head.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readRemediationReplyArtifact } from './follow-up-jobs.mjs';
import { resolveRemediationReplyTarget, resolveReplyStorageKey } from './remediation-reply-paths.mjs';

export function findWorkerPublishedHead({ rootDir, job, headSha, execFileSyncImpl = execFileSync }) {
  const plan = job?.remediationPlan;
  // Pending retries decrement currentRound; their retained attempt is nextRound.
  const roundNumber = job?.status === 'pending' ? Number(plan?.currentRound || 0) + 1 : plan?.currentRound;
  const round = plan?.rounds?.find(entry => entry.round === roundNumber);
  const worker = job?.remediationWorker || round?.worker || {};
  const startHead = round?.startHeadSha || job?.revisionRef;
  if (!round || !headSha || !startHead || headSha === startHead
    || (!round.spawnedAt && !worker.spawnedAt && !round.publishedHeadSha)) return null;

  let reply = null;
  let replyPath = null;
  try {
    const target = resolveRemediationReplyTarget(process.env, { requireExists: false });
    replyPath = worker.replyPath || job?.remediationReply?.path
      || target.resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
    replyPath = resolve(rootDir, replyPath);
    if (existsSync(replyPath)) reply = readRemediationReplyArtifact(replyPath, { expectedJob: job });
  } catch {
    // A missing/invalid reply cannot supply publish evidence.
  }
  const result = source => ({ round, worker, headSha, startHead, source, reply, replyPath });
  if (round.publishedHeadSha === headSha) return result('round.publishedHeadSha');
  // The reply contract names a push in its summary/validation, not a local commit.
  if (reply && [reply.summary, ...(reply.validation || [])].some(text =>
    [...String(text).matchAll(/\bpushed (?:commit |PR head (?:is )?)?([a-f0-9]{7,40})\b/gi)]
      .some(match => match[1].toLowerCase() === headSha.toLowerCase()))) return result('worker-reply');

  const storedWorkspace = job.workspaceDir || worker.workspaceDir;
  const workspaceDir = storedWorkspace ? resolve(rootDir, storedWorkspace)
    : join(rootDir, 'data', 'follow-up-jobs', 'workspaces', job.jobId);
  if (!existsSync(join(workspaceDir, '.git'))) return null;
  try {
    const branch = String(execFileSyncImpl('git', ['-C', workspaceDir, 'symbolic-ref', '--quiet', 'HEAD'],
      { encoding: 'utf8', timeout: 5000 })).trim();
    if (!branch.startsWith('refs/heads/')) return null;
    const tip = String(execFileSyncImpl('git', ['-C', workspaceDir, 'rev-parse', '--verify', `${branch}^{commit}`],
      { encoding: 'utf8', timeout: 5000 })).trim();
    return tip === headSha ? result('workspace-branch-tip') : null;
  } catch {
    return null;
  }
}
