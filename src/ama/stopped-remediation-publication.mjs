import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { followUpJobFilePrefix } from '../follow-up-job-names.mjs';
import { resolveGitHubAppBotLogin } from '../github-app-identity.mjs';
import { isLivePackCrossEditFindingTitle, parseBlockingFindingsSection } from '../kernel/review-findings.mjs';
import { validateRemediationReply } from '../kernel/remediation-reply.mjs';
import { resolveRemediationReplyTarget, resolveReplyStorageKey } from '../remediation-reply-paths.mjs';
import { REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS, remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import { parseCommitTrailerValues } from './ham-provenance.mjs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const ACTIVITY_PAGE_SIZE = 100;

async function readArtifact(path, { from = -Infinity, through = Infinity } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES || stat.mtimeMs < from || stat.mtimeMs > through) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes);
    return bytesRead === stat.size ? bytes.toString('utf8', 0, bytesRead) : null;
  } finally {
    await file.close();
  }
}

async function readStoppedJob(rootDir, jobId) {
  const dir = join(rootDir, 'data', 'follow-up-jobs');
  // A retrying or already reconciled copy takes precedence over this fallback.
  const conflicting = await Promise.all(['pending', 'in-progress', 'completed', 'failed'].map(async partition => {
    try {
      await lstat(join(dir, partition, `${jobId}.json`));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }));
  if (conflicting.some(Boolean)) return null;
  const records = await Promise.all(['stopped', 'stopped-archived'].map(async partition => {
    try {
      const text = await readArtifact(join(dir, partition, `${jobId}.json`));
      return JSON.parse(text ?? '');
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }));
  const present = records.filter(record => record !== undefined);
  return present.length === 1 ? present[0] : null;
}

function appPushed(event, workerClass) {
  if (event.actor?.type !== 'Bot' || !event.actor.login
    || !Object.hasOwn(REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS, workerClass)) return false;
  const provider = REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS[workerClass];
  const identity = provider.replace(/^github-app-/, '');
  const configured = resolveGitHubAppBotLogin({ identity, provider, log: { warn() {} } });
  const login = value => String(value ?? '').toLowerCase().replace(/\[bot\]$/, '');
  // cfg-allowlist(github-account): compatibility identities for existing fleet installations.
  return login(event.actor.login) === login(configured) || login(event.actor.login) === `lacey-${identity}`;
}

function ciCapStop(stop) {
  return stop?.code === 'max-rounds-reached' && stop.ciRegression === true && stop.sourceStatus === 'failed'
    && stop.stoppedBy?.type === 'system' && stop.stoppedBy.requestedBy === 'watcher-ci-admission';
}

function attemptWindow(worker) {
  const from = Date.parse(worker?.spawnedAt);
  const through = Date.parse(worker?.reconciledAt);
  return Number.isFinite(from) && through >= from ? { from, through } : null;
}

async function accountedReply(job, round, worker, window) {
  const replyPath = resolveRemediationReplyTarget().resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
  if (worker.replyPath !== replyPath || job.remediationWorker?.replyPath !== replyPath
    || job.failure?.remediationReplyPath !== replyPath || round.failure?.remediationReplyPath !== replyPath
    || !worker.outputPath || worker.outputPath !== job.remediationWorker?.outputPath
    || !job.workspaceDir || job.workspaceDir !== worker.workspaceDir
    || dirname(worker.outputPath) !== join(job.workspaceDir, '.adversarial-follow-up')) return false;
  // Any publication refusal sidecar, including an unreadable one, defeats this proof.
  try {
    await lstat(`${replyPath}.publication-failure.json`);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const [replyText, output] = await Promise.all([readArtifact(replyPath, window), readArtifact(worker.outputPath, window)]);
  if (!replyText || !output?.trim()) return false;
  const reply = validateRemediationReply(JSON.parse(replyText), { expectedJob: job });
  const findings = parseBlockingFindingsSection(job.reviewBody);
  const expected = findings?.filter(finding => !isLivePackCrossEditFindingTitle(finding.title)).length;
  const countError = `review has ${expected} blocking issue(s), reply records ${findings?.length} `;
  return expected > 0 && job.failure.message?.includes(countError) && round.failure.message === job.failure.message
    && reply.repo === job.repo && Number(reply.prNumber) === Number(job.prNumber)
    && reply.outcome === 'partial' && reply.reReview.requested === false
    && reply.addressed?.length === expected && !reply.pushback?.length
    && reply.blockers.length === findings.length - expected && reply.blockers.length > 0
    && reply.blockers.every(entry => isLivePackCrossEditFindingTitle(entry?.title))
    && reply.operationalBlockers?.length > 0
    && reply.operationalBlockers.every(entry => entry.title === 'ci-pending' && entry.kind === 'pending-ci');
}

// Recover finding lineage from the specific historical accounting refusal.
// GitHub records the publication separately from the worker's reply and exit.
export async function proveStoppedRemediationPublication({ rootDir, repo, prNumber, reviewedHead, currentHead, live, get, readCommit }) {
  if (!rootDir || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(Number(prNumber))
    || Number(prNumber) < 1 || live?.state !== 'open' || live.head?.sha !== currentHead
    || live.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || !live.head.ref) return false;

  const ref = `refs/heads/${live.head.ref}`;
  const activity = await get(`repos/${repo}/activity?ref=${encodeURIComponent(ref)}&per_page=${ACTIVITY_PAGE_SIZE}&direction=desc`);
  if (!Array.isArray(activity) || activity.length === 0 || activity.length >= ACTIVITY_PAGE_SIZE) return false;
  const [latest, previous] = activity;
  if (latest?.ref !== ref || latest.after !== currentHead) return false;
  const successor = latest.before === reviewedHead ? null : latest;
  const publication = successor ? previous : latest;
  if (publication?.ref !== ref || publication.activity_type !== 'force_push' || publication.before !== reviewedHead
    || !SHA.test(publication.after || '') || publication.after === reviewedHead
    || (successor && (successor.activity_type !== 'push' || successor.before !== publication.after))) return false;

  const commit = await readCommit(publication.after);
  const trailers = parseCommitTrailerValues(commit?.commit?.message);
  const [jobId] = trailers['worker-job-id'] || [];
  const prefix = followUpJobFilePrefix(repo, prNumber);
  if (!/^[\w.-]{1,128}$/.test(jobId || '') || !jobId.toLowerCase().startsWith(prefix.toLowerCase())
    || trailers['worker-job-id'].length !== 1 || trailers['worker-class']?.length !== 1) return false;
  const job = await readStoppedJob(rootDir, jobId);
  const plan = job?.remediationPlan;
  if (job?.kind !== 'adversarial-review-follow-up' || job.status !== 'stopped' || job.jobId !== jobId
    || job.repo?.toLowerCase() !== repo.toLowerCase() || Number(job.prNumber) !== Number(prNumber)
    || job.branch !== live.head.ref || job.revisionRef !== reviewedHead || job.domainId !== 'code-pr'
    || job.closureHandoff || job.unpublishedWork || job.completion || job.reReview
    || job.failure?.code !== 'invalid-remediation-reply' || !ciCapStop(plan?.stop)
    || plan.dispatchPath !== 'bare' || !Number.isSafeInteger(plan.currentRound)
    || plan.currentRound < 1 || plan.currentRound !== plan.maxRounds || !Array.isArray(plan.rounds)) return false;
  const rounds = plan.rounds.filter(round => round?.round === plan.currentRound);
  const [round] = rounds;
  const worker = round?.worker;
  const jobWorker = job.remediationWorker;
  const window = attemptWindow(worker);
  const pushedAt = Date.parse(publication.timestamp);
  if (rounds.length !== 1 || round.kind !== 'remediation' || round.state !== 'stopped'
    || round.startHeadSha !== reviewedHead || round.revisionRef !== reviewedHead || round.publishedHeadSha !== publication.after
    || round.completion || round.reReview || round.resultingHeadSha || round.failure?.code !== job.failure.code
    || !ciCapStop(round.stop) || !window || !(pushedAt >= window.from && pushedAt <= window.through)
    || !(Date.parse(round.finishedAt) >= window.through) || round.finishedAt !== job.stoppedAt
    || round.spawnedAt !== worker.spawnedAt || ![worker, jobWorker].every(entry => entry?.state === 'failed'
      && !entry.dispatchId && !entry.requiresProducedAttestation && [undefined, 'local'].includes(entry.dispatchMode)
      && entry.launchRequestId === resolveReplyStorageKey(job) && entry.workerClass === worker.workerClass
      && entry.recordedOutcome?.exitCode === 0 && entry.recordedOutcome?.signal === null
      && entry.spawnedAt === worker.spawnedAt && entry.reconciledAt === worker.reconciledAt)
    || trailers['worker-class'][0] !== remediationWorkerTrailerClass(worker.workerClass)
    || !appPushed(publication, worker.workerClass)
    || (successor && (!(Date.parse(successor.timestamp) >= pushedAt) || !appPushed(successor, worker.workerClass)))) return false;

  if (!await accountedReply(job, round, worker, { from: pushedAt, through: window.through })) return false;
  if (!successor) return true;
  const comparePath = `repos/${repo}/compare/${publication.after}...${currentHead}`;
  const comparison = await (get.metadata ? get.metadata(comparePath) : get(comparePath));
  return comparison?.status === 'ahead' && comparison.merge_base_commit?.sha === publication.after
    && comparison.total_commits === 1;
}
