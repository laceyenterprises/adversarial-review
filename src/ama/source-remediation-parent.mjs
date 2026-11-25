import { isDeepStrictEqual } from 'node:util';
import { validateRemediationReply, parseBlockingFindingsSection } from '../kernel/remediation-reply.mjs';
import { resolveReplyStorageKey } from '../remediation-reply-paths.mjs';
import { REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS, remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import { exactRemediationForcePush, readCompletedRemediationEvidence } from './hammer-head-validation.mjs';
import { parseCommitTrailerValues } from './ham-provenance.mjs';
import { amaReviewerFamilyForLogin } from './reviewer-authority.mjs';

const SHA = /^[a-f0-9]{40}$/;
const MAX_REVIEWED_COMMITS = 8;
const specOrChangeNote = /^(?:docs\/SPEC(?:-[\w.-]+)?|(?:[\w-]+\/)+changes\/[\w-]+)\.md$/;

function linear(commits, base, tip) {
  return commits.length > 0 && commits.at(-1)?.sha === tip
    && new Set([base, ...commits.map(entry => entry?.sha)]).size === commits.length + 1
    && commits.every((entry, index) => SHA.test(entry?.sha || '') && entry.parents?.length === 1
      && entry.parents[0]?.sha === (index === 0 ? base : commits[index - 1].sha));
}

function publishedPaths(job, review, head) {
  const { remediationPlan: plan, completion } = job;
  const rounds = plan.rounds.filter(round => round?.round === plan.currentRound);
  const [round] = rounds;
  const worker = round?.worker;
  const reply = round?.remediationReply;
  if (job.kind !== 'adversarial-review-follow-up' || job.closureHandoff
    || job.revisionRef !== review.commit_id || job.reviewBody !== review.body
    || job.reviewerModel !== amaReviewerFamilyForLogin(review.user?.login)
    || plan.dispatchPath !== 'bare' || !Number.isSafeInteger(plan.currentRound)
    || plan.currentRound < 1 || plan.currentRound !== plan.maxRounds
    || rounds.length !== 1 || round.kind !== 'remediation' || round.state !== 'completed'
    || round.startHeadSha !== review.commit_id || round.revisionRef !== review.commit_id
    || round.resultingHeadSha !== head || round.publishedHeadSha !== head
    || completion?.workerPushedHeadSha !== head || completion.finalRemediationPush !== true
    || completion.pendingCiOnly || round.completion?.workerPushedHeadSha !== head
    || round.completion.finalRemediationPush !== true || round.completion.pendingCiOnly
    || worker?.state !== 'completed' || worker.dispatchId || worker.requiresProducedAttestation
    || ![undefined, 'local'].includes(worker.dispatchMode)
    || worker.launchRequestId !== resolveReplyStorageKey(job)
    || job.remediationWorker?.launchRequestId !== worker.launchRequestId
    || job.remediationWorker?.workerClass !== worker.workerClass
    || reply?.state !== 'worker-wrote-reply') return null;
  const parsed = validateRemediationReply(reply.payload, { expectedJob: job });
  if (parsed.repo !== job.repo || Number(parsed.prNumber) !== Number(job.prNumber)) return null;
  if (parsed.outcome !== 'completed' || parsed.blockers.length || parsed.operationalBlockers?.length) return null;
  const blockingTitles = new Set(parseBlockingFindingsSection(review.body).map(finding => finding.title));
  const paths = new Set((parsed.addressed || []).filter(entry => blockingTitles.has(entry.title))
    .flatMap(entry => (entry.files || []).map(file => file.replace(/:\d+(?:-\d+)?$/, ''))));
  return { paths, worker };
}

// Source authority only. This composes one completed bare follow-up publication
// with an exact forward replay of the reviewed series. The caller still maps
// the cited region against the original review and checks the HAM removal.
export async function proveSourceRemediationParent({
  repo, prNumber, rootDir, review, oldBase, mergeBase, reviewedCommits, history,
  commit, primaryHead, parentFiles, reviewedFiles, exactFileChanges, compareBase, loadTimelinePage,
}) {
  const parent = commit.parents[0].sha;
  if (!exactFileChanges || !loadTimelinePage || parent !== primaryHead || oldBase === mergeBase
    || commit.sha !== history.at(-1)?.sha || parent !== history.at(-2)?.sha
    || history.length !== reviewedCommits?.length + 2
    || reviewedCommits.length > MAX_REVIEWED_COMMITS
    || !linear(reviewedCommits, oldBase, review.commit_id) || !linear(history, mergeBase, commit.sha)) return null;
  const publication = history.at(-2);
  const { sourceJobs } = await readCompletedRemediationEvidence(rootDir, repo, prNumber, { sourceParent: parent });
  if (sourceJobs?.length !== 1) return null;
  const [job] = sourceJobs;
  const receipt = publishedPaths(job, review, parent);
  const trailers = parseCommitTrailerValues(publication.commit?.message);
  const classes = trailers['worker-class'];
  const jobIds = trailers['worker-job-id'];
  if (!receipt || jobIds?.length !== 1 || jobIds[0] !== job.jobId
    || classes?.length !== 1 || classes[0] !== remediationWorkerTrailerClass(receipt.worker.workerClass)) return null;
  const workerClass = receipt.worker.workerClass;
  if (!Object.hasOwn(REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS, workerClass)) return null;
  const appIdentity = REMEDIATION_WORKER_PUSH_PROVIDER_DEFAULTS[workerClass].replace(/^github-app-/, '');
  if (!await exactRemediationForcePush(loadTimelinePage, review, parent, appIdentity)) return null;

  const ancestry = await compareBase(oldBase, mergeBase);
  if (ancestry.status !== 'ahead' || ancestry.merge_base_commit?.sha !== oldBase) return null;
  const originalPaths = new Set(reviewedFiles.flatMap(file => [file.filename, file.previous_filename]));
  const delta = await exactFileChanges(repo, publication.parents[0].sha, parent);
  if (!delta?.length || !delta.every(({ path, a, b }) => specOrChangeNote.test(path)
    && receipt.paths.has(path) && !originalPaths.has(path)
    && (!a || a.mode === '100644' && a.type === 'blob') && b?.mode === '100644' && b.type === 'blob'
    && parentFiles.some(file => file.filename === path && !file.previous_filename
      && file.status === (a ? 'modified' : 'added') && file.sha === b.sha))) return null;

  // Compare both sides of every changed entry. Order, modes, paths and blob
  // bytes must agree at each step, including changes later reverted.
  const identity = files => files.map(({ path, a, b }) => [path,
    a && [a.mode, a.type, a.sha], b && [b.mode, b.type, b.sha]]);
  for (const [index, original] of reviewedCommits.entries()) {
    const replayed = history[index];
    const before = await exactFileChanges(repo, original.parents[0].sha, original.sha);
    const after = await exactFileChanges(repo, replayed.parents[0].sha, replayed.sha);
    if (!before?.length || !after?.length || !isDeepStrictEqual(identity(before), identity(after))) return null;
  }
  return delta.map(file => file.path);
}
