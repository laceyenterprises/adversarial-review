import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { followUpJobFilePrefix } from '../follow-up-job-names.mjs';
import { resolveGitHubAppBotLogin } from '../github-app-identity.mjs';
import { isLivePackCrossEditFindingTitle, parseBlockingFindingsSection, parseReviewFindings } from '../kernel/review-findings.mjs';
import { validateRemediationReply } from '../kernel/remediation-reply.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { resolveRemediationReplyTarget, resolveReplyStorageKey } from '../remediation-reply-paths.mjs';
import { REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS, remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import { parseCommitTrailerValues } from './ham-provenance.mjs';
import { amaReviewerFamilyForLogin } from './reviewer-authority.mjs';
import { stoppedJobPaths } from './stopped-job-index.mjs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const ACTIVITY_PAGE_SIZE = 100;
const login = value => String(value ?? '').toLowerCase().replace(/\[bot\]$/, '');

async function readArtifact(path, { from = -Infinity, through = Infinity } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES || stat.mtimeMs < from || stat.mtimeMs > through) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes);
    return bytesRead === stat.size ? { text: bytes.toString('utf8', 0, bytesRead), mtimeMs: stat.mtimeMs,
      size: bytesRead, digest: createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex') } : null;
  } finally {
    await file.close();
  }
}

function matchesReview(job, review) {
  const reviewer = amaReviewerFamilyForLogin(review?.user?.login);
  const submittedAt = Date.parse(review?.submitted_at);
  return reviewer && job.reviewerModel === reviewer && job.reviewBody === review.body && job.revisionRef === review.commit_id
    && Number.isFinite(submittedAt) && Date.parse(job.createdAt) >= submittedAt;
}

async function findStoppedJob({ rootDir, repo, prNumber, reviewedHead, branch, review, matches }) {
  const dir = join(rootDir, 'data', 'follow-up-jobs');
  const prefix = followUpJobFilePrefix(repo, prNumber).toLowerCase();
  let candidate;
  const index = await stoppedJobPaths(dir, prefix);
  const { paths, partitions } = index;
  for (const { path, partition, jobId } of paths) {
      const artifact = await readArtifact(path).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw new Error(`stopped-publication artifact unreadable: ${path}`, { cause: error });
      });
      if (!artifact) continue;
      let job;
      try { job = JSON.parse(artifact.text); }
      catch (error) { throw new Error(`stopped-publication artifact has invalid JSON: ${path}`, { cause: error }); }
      if (job?.jobId !== jobId || job.kind !== 'adversarial-review-follow-up' || job.status !== 'stopped'
        || job.repo?.toLowerCase() !== repo.toLowerCase() || Number(job.prNumber) !== Number(prNumber)
        || job.branch !== branch || job.revisionRef !== reviewedHead || job.domainId !== 'code-pr'
        || (review && !matchesReview(job, review)) || !matches(job)) continue;
      if (candidate) return null;
      candidate = { job, partition };
  }
  if (!candidate) return null;
  if (!await index.unchanged()) throw new Error(`stopped-publication partitions changed while reading artifacts: ${dir}`);

  // A retrying or already reconciled copy takes precedence over this fallback.
  const otherPartitions = [...partitions.filter(partition => partition !== candidate.partition),
    ...['pending', 'in-progress', 'completed', 'failed'].map(partition => join(dir, partition))];
  for (const partition of otherPartitions) {
    try {
      await lstat(join(partition, `${candidate.job.jobId}.json`));
      return null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return candidate;
}

function appPushed(event, workerClass) {
  if (event.actor?.type !== 'Bot' || !event.actor.login
    || !Object.hasOwn(REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS, workerClass)) return false;
  const provider = REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS[workerClass];
  const identity = provider.replace(/^github-app-/, '');
  const configured = resolveGitHubAppBotLogin({ identity, provider, log: { warn() {} } });
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

async function hasPublicationFailure(replyPath) {
  try {
    await lstat(`${replyPath}.publication-failure.json`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function matchesWorkerCommit(commit, job, worker) {
  const trailers = parseCommitTrailerValues(commit?.commit?.message);
  return trailers['worker-job-id']?.length === 1 && trailers['worker-job-id'][0] === job.jobId
    && trailers['worker-class']?.length === 1
    && trailers['worker-class'][0] === remediationWorkerTrailerClass(worker.workerClass);
}

async function accountedReplyTime({ job, expected, count }, round, worker, window) {
  const replyPath = resolveRemediationReplyTarget().resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
  if (worker.replyPath !== replyPath || job.remediationWorker?.replyPath !== replyPath
    || job.failure?.remediationReplyPath !== replyPath || round.failure?.remediationReplyPath !== replyPath
    || !worker.outputPath || worker.outputPath !== job.remediationWorker?.outputPath
    || !job.workspaceDir || job.workspaceDir !== worker.workspaceDir
    || dirname(worker.outputPath) !== join(job.workspaceDir, '.adversarial-follow-up')) return null;
  // Any publication refusal sidecar, including an unreadable one, defeats this proof.
  if (await hasPublicationFailure(replyPath)) return null;
  const [artifact, output] = await Promise.all([readArtifact(replyPath, window), readArtifact(worker.outputPath, window)]);
  if (!artifact?.text || !output?.text.trim()) return null;
  const reply = validateRemediationReply(JSON.parse(artifact.text), { expectedJob: job });
  const accounted = reply.repo === job.repo && Number(reply.prNumber) === Number(job.prNumber)
    && reply.outcome === 'partial' && reply.reReview.requested === false
    && reply.addressed?.length === expected && !reply.pushback?.length
    && reply.blockers.length === count - expected
    && reply.blockers.every(entry => isLivePackCrossEditFindingTitle(entry?.title))
    && reply.operationalBlockers?.length > 0
    && reply.operationalBlockers.every(entry => entry.title === 'ci-pending' && entry.kind === 'pending-ci');
  return accounted ? Math.min(artifact.mtimeMs, output.mtimeMs) : null;
}

// Recover finding lineage from the specific historical accounting refusal.
// GitHub records the publication separately from the worker's reply and exit.
export async function proveStoppedRemediationPublication({ rootDir, repo, prNumber, reviewedHead, currentHead, review, live, get, readCommit }) {
  if (!rootDir || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(Number(prNumber))
    || Number(prNumber) < 1 || live?.state !== 'open' || live.head?.sha !== currentHead
    || live.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || !live.head.ref) return false;

  const findings = parseBlockingFindingsSection(review?.body);
  const legacy = parseBlockingFindingsSection(review?.body, { countCompactLivePackFindings: false });
  if (!legacy?.length || findings.length <= legacy.length
    || findings.filter(finding => !isLivePackCrossEditFindingTitle(finding.title)).length !== legacy.length) return false;
  const candidate = await findStoppedJob({
    rootDir, repo, prNumber, reviewedHead, branch: live.head.ref, review,
    matches: job => job.failure?.code === 'invalid-remediation-reply'
      && job.failure.message?.includes(`review has ${legacy.length} blocking issue(s), reply records ${findings.length} `)
      && ciCapStop(job.remediationPlan?.stop),
  });
  if (!candidate) return false;
  const { job } = candidate;
  const plan = job.remediationPlan;
  if (job.closureHandoff || job.unpublishedWork || job.completion || job.reReview
    || plan.dispatchPath !== 'bare' || !Number.isSafeInteger(plan.currentRound)
    || plan.currentRound < 1 || plan.currentRound !== plan.maxRounds || !Array.isArray(plan.rounds)) return false;
  const rounds = plan.rounds.filter(round => round?.round === plan.currentRound);
  const [round] = rounds;
  const worker = round?.worker;
  const jobWorker = job.remediationWorker;
  const window = attemptWindow(worker);
  if (rounds.length !== 1 || round.kind !== 'remediation' || round.state !== 'stopped'
    || round.startHeadSha !== reviewedHead || round.revisionRef !== reviewedHead
    || !SHA.test(round.publishedHeadSha || '') || round.publishedHeadSha === reviewedHead
    || round.completion || round.reReview || round.resultingHeadSha || round.failure?.code !== job.failure.code
    || round.failure.message !== job.failure.message || !ciCapStop(round.stop) || !window
    || !(Date.parse(round.finishedAt) >= window.through) || round.finishedAt !== job.stoppedAt
    || round.spawnedAt !== worker.spawnedAt || ![worker, jobWorker].every(entry => entry?.state === 'failed'
      && !entry.dispatchId && !entry.requiresProducedAttestation && [undefined, 'local'].includes(entry.dispatchMode)
      && entry.launchRequestId === resolveReplyStorageKey(job) && entry.workerClass === worker.workerClass
      && entry.recordedOutcome?.exitCode === 0 && entry.recordedOutcome?.signal === null
      && entry.spawnedAt === worker.spawnedAt && entry.reconciledAt === worker.reconciledAt)) return false;

  const artifactsAt = await accountedReplyTime({ job, expected: legacy.length, count: findings.length }, round, worker, window);
  if (artifactsAt === null) return false;

  const ref = `refs/heads/${live.head.ref}`;
  const activity = await get(`repos/${repo}/activity?ref=${encodeURIComponent(ref)}&per_page=${ACTIVITY_PAGE_SIZE}&direction=desc`);
  if (!Array.isArray(activity) || activity.length === 0 || activity.length >= ACTIVITY_PAGE_SIZE) return false;
  const [latest, previous] = activity;
  if (latest?.ref !== ref || latest.after !== currentHead) return false;
  const successor = latest.before === reviewedHead ? null : latest;
  const publication = successor ? previous : latest;
  const pushedAt = Date.parse(publication?.timestamp);
  if (publication?.ref !== ref || publication.activity_type !== 'force_push' || publication.before !== reviewedHead
    || publication.after !== round.publishedHeadSha || !(pushedAt >= window.from && pushedAt <= artifactsAt)
    || !appPushed(publication, worker.workerClass)
    || (successor && (successor.activity_type !== 'push' || successor.before !== publication.after
      || !(Date.parse(successor.timestamp) >= pushedAt) || !appPushed(successor, worker.workerClass)))) return false;

  const matchesWorker = async sha => matchesWorkerCommit(await readCommit(sha), job, worker);
  if (!await matchesWorker(publication.after)) return false;

  if (!successor) return true;
  const comparePath = `repos/${repo}/compare/${publication.after}...${currentHead}`;
  const comparison = await (get.metadata ? get.metadata(comparePath) : get(comparePath));
  return comparison?.status === 'ahead' && comparison.merge_base_commit?.sha === publication.after
    && comparison.total_commits === 1 && await matchesWorker(currentHead);
}

function suppressedFinalReview(record) {
  return record?.requested === false && record.status === 'suppressed' && record.suppressed === 'comment-only-final-round';
}

function nativeStop(stop) {
  return stop?.code === 'no-progress' && stop.sourceStatus === 'completed' && stop.stoppedBy === null;
}

// Require exact accountability for a final advisory pass. The reply identifies
// the outstanding SPEC obligation. GitHub and Git supply publication evidence.
function finalAdvisorySpec(reply, body) {
  const { blocking, nonBlocking } = parseReviewFindings(body);
  if (normalizeEffectiveReviewVerdict(body) !== 'comment-only' || blocking.state !== 'known' || blocking.count !== 0
    || nonBlocking.state !== 'known' || reply.outcome !== 'partial' || reply.reReview.requested !== false
    || reply.addressed?.length || reply.pushback?.length || reply.blockers.length !== 1
    || !reply.operationalBlockers?.length || !reply.operationalBlockers.every(blocker => blocker.kind === 'pending-ci')) return null;
  const [hold] = reply.blockers;
  const path = /^Operator-Live-Edit-Required: live-pack-plan (projects\/[\w-]+\/SPEC\.md)$/.exec(hold.needsHumanInput || '')?.[1];
  const finding = nonBlocking.findings.find(entry => entry.title === hold.title);
  if (hold.kind !== 'live-pack-operator-edit' || !path || !finding?.problem?.includes(path)) return null;
  const recorded = new Set([hold.title, ...(reply.nonBlocking || []).map(entry => entry.title)]);
  return recorded.size === (reply.nonBlocking?.length || 0) + 1
    && recorded.size === nonBlocking.count && nonBlocking.findings.every(entry => recorded.has(entry.title)) ? path : null;
}

async function nativeFinalArtifacts(job, round, window) {
  const { worker, completion } = round;
  const replyPath = resolveRemediationReplyTarget().resolvePath({ launchRequestId: resolveReplyStorageKey(job) }).replyPath;
  const receipt = round.remediationReply;
  if (!job.workspaceDir || worker.workspaceDir !== job.workspaceDir || !worker.outputPath
    || dirname(worker.outputPath) !== join(job.workspaceDir, '.adversarial-follow-up')
    || worker.outputPath !== completion.finalMessagePath || worker.replyPath !== replyPath
    || receipt?.state !== 'worker-wrote-reply' || receipt.path !== replyPath
    || !isDeepStrictEqual(receipt, job.remediationReply) || await hasPublicationFailure(replyPath)) return null;
  const [artifact, output] = await Promise.all([readArtifact(replyPath, window), readArtifact(worker.outputPath, window)]);
  if (!artifact?.text || !output?.text.trim() || output.size !== completion.finalMessageBytes
    || output.digest !== completion.finalMessageDigest) return null;
  const reply = validateRemediationReply(JSON.parse(artifact.text), { expectedJob: job });
  if (!isDeepStrictEqual(reply, receipt.payload) || reply.repo !== job.repo || Number(reply.prNumber) !== Number(job.prNumber)) return null;
  const spec = finalAdvisorySpec(reply, job.reviewBody);
  return spec ? { spec, artifactsAt: Math.min(artifact.mtimeMs, output.mtimeMs) } : null;
}

export async function proveNativeStoppedFindingLineage({
  rootDir, repo, prNumber, reviewedHead, currentHead, review, live, get, readCommit, provenance, verifySource,
}) {
  if (!rootDir || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d*$/.test(String(prNumber))
    || live?.state !== 'open' || live.head?.sha !== currentHead || live.base?.ref !== 'main'
    || live.base.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || !live.head.ref
    || live.head.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) return false;
  const candidate = await findStoppedJob({
    rootDir, repo, prNumber, reviewedHead, branch: live.head.ref, review,
    matches: job => job.nonBlockingOnly === true && job.finalRound === 'comment-only' && nativeStop(job.remediationPlan?.stop),
  });
  if (!candidate) return false;
  const { job } = candidate;
  const { remediationPlan: plan } = job;
  if (!Array.isArray(plan.rounds) || plan.rounds.length !== 1) return false;
  const [round] = plan.rounds;
  const worker = round?.worker;
  const completion = round?.completion;
  const window = attemptWindow(worker);
  const published = round?.publishedHeadSha;
  if (job.closureHandoff || job.unpublishedWork || job.failure || plan.dispatchPath !== 'bare'
    || plan.currentRound !== 1 || !Number.isSafeInteger(plan.maxRounds) || plan.maxRounds < 1
    || round?.round !== 1 || round.kind !== 'remediation' || round.state !== 'stopped'
    || round.startHeadSha !== reviewedHead || round.revisionRef !== reviewedHead || round.resultingHeadSha || round.failure
    || !nativeStop(round.stop) || !window || round.spawnedAt !== worker.spawnedAt || round.finishedAt !== job.stoppedAt
    || Date.parse(round.finishedAt) !== window.through || !isDeepStrictEqual(worker, job.remediationWorker)
    || worker.state !== 'completed' || worker.dispatchId || worker.requiresProducedAttestation
    || ![undefined, 'local'].includes(worker.dispatchMode) || worker.launchRequestId !== job.jobId
    || worker.launchRequestId !== resolveReplyStorageKey(job)
    || !suppressedFinalReview(round.reReview) || !isDeepStrictEqual(round.reReview, job.reReview)
    || !SHA.test(published || '') || published === reviewedHead || completion?.workerPushedHeadSha !== published
    || completion.finalRemediationPush !== true || completion.pendingCiOnly || completion.workerModel !== worker.workerClass
    || completion.workerPushProof?.method !== 'git-cherry-replay' || completion.workerPushProof.workerCommits !== 1
    || completion.finalRoundOutcome?.completed !== false || completion.finalRoundOutcome.reason !== 'review-blockers'
    || completion.finalRoundOutcome.push !== 'replayed-onto-base' || !isDeepStrictEqual(completion, job.completion)) return false;

  const artifacts = await nativeFinalArtifacts(job, round, window);
  if (!artifacts) return false;
  const reviews = await get(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
  if (!Array.isArray(reviews) || reviews.length >= 100) return false;
  const sources = reviews.filter(entry => entry.state === 'COMMENTED' && entry.user?.type === 'Bot' && matchesReview(job, entry));
  const [source] = sources;
  if (sources.length !== 1 || !Number.isSafeInteger(source.id)
    || (review && (![String(source.id), source.node_id].filter(Boolean).includes(String(review.id))
      || source.submitted_at !== review.submitted_at || login(source.user.login) !== login(review.user?.login)
      || source.state !== review.state))) return false;

  const ref = `refs/heads/${live.head.ref}`;
  const activity = await get(`repos/${repo}/activity?ref=${encodeURIComponent(ref)}&per_page=${ACTIVITY_PAGE_SIZE}&direction=desc`);
  if (!Array.isArray(activity) || activity.length >= ACTIVITY_PAGE_SIZE) return false;
  const index = activity.findIndex(event => event.before === reviewedHead && event.after === published);
  // One closer publication, optionally one uninterrupted integration push.
  if (index !== 1 && index !== 2) return false;
  const publication = activity[index];
  const closure = activity[index - 1];
  const timestamp = Date.parse(publication.timestamp);
  const closedAt = Date.parse(closure.timestamp);
  if (!SHA.test(closure.after || '') || activity[0].after !== currentHead || activity.slice(0, index).some((event, i) =>
    event.ref !== ref || event.activity_type !== 'push' || event.before !== activity[i + 1].after
    || !(Date.parse(event.timestamp) >= Date.parse(activity[i + 1].timestamp)))
    || publication.ref !== ref || publication.activity_type !== 'force_push'
    || !(timestamp >= window.from && timestamp <= artifacts.artifactsAt) || closedAt < window.through
    || !appPushed(publication, worker.workerClass) || closure.actor?.type !== 'Bot'
    || !provenance.some(edge => edge.base === published && edge.head === closure.after
      && login(edge.login) === login(closure.actor.login))
    || !matchesWorkerCommit(await readCommit(published), job, worker)) return false;
  return verifySource({ published, closer: closure.after, spec: artifacts.spec,
    reviewedCommits: completion.workerPushProof.reviewedCommitsReplayed });
}
