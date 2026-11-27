import { completedCommentOnlyHandoff, scanPrFollowUpJobs } from './comment-only-final-round.mjs';
import { readCompletedRemediationEvidence } from './ama/hammer-head-validation.mjs';
import { currencyGit, replaysDirectMainIntegration } from './ama/review-currency.mjs';
import { amaReviewerFamilyForLogin } from './ama/reviewer-authority.mjs';
import { legacyFollowUpReviewerRole } from './follow-up-reviewer-identity.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { meteredExecFile } from './metered-gh.mjs';
import { resolveRepoCheckoutDir } from './reviewer-repo-checkout.mjs';

const SHA = /^[a-f0-9]{40}$/u;

function publishedHandoff(job, reviewedHead) {
  if (job.revisionRef !== reviewedHead || job.baseBranch !== 'main' || !job.branch) return false;
  const round = completedCommentOnlyHandoff(job);
  return Boolean(round?.publishedHeadSha && round.publishedHeadSha === job.completion?.workerPushedHeadSha
    && round.reReview?.requested !== true);
}

function sourceStillLatest(reviews, job) {
  if (!Array.isArray(reviews) || reviews.length >= 100) return false;
  const submitted = reviews.filter(review => review?.state !== 'PENDING');
  if (submitted.some(review => !Number.isFinite(Date.parse(review?.submitted_at)))) return false;
  const latest = submitted.sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))[0];
  const family = amaReviewerFamilyForLogin(latest?.user?.login);
  const role = job.reviewerRole ?? legacyFollowUpReviewerRole(job.reviewerModel);
  // The protected final fix-all producer carries the source body and head
  // from AMA, but can omit reviewer identity. Verify the bot on GitHub here.
  const roleOmittedByFixAll = job.closureHandoff?.reason === 'final-fix-all'
    && job.reviewerRole == null && job.reviewerModel == null;
  if (!latest || Date.parse(latest.submitted_at) === Date.parse(submitted[1]?.submitted_at)
    || latest.state !== 'COMMENTED' || latest.user?.type !== 'Bot'
    || latest.commit_id !== job.revisionRef || latest.body !== job.reviewBody
    || !family || (role !== `${family}-reviewer` && !roleOmittedByFixAll)
    || !(Date.parse(latest.submitted_at) <= Date.parse(job.createdAt))) return false;
  const { blocking, nonBlocking } = parseReviewFindings(latest.body);
  return blocking.state === 'known' && blocking.count === 0 && nonBlocking.state === 'known';
}

// This proof assigns the posted-review lane only. It neither rewrites the
// completed job's exact head nor serves as merge or disposition evidence.
export async function readFinalRemediationIntegration({
  rootDir, repo, prNumber, headSha, reviewedHead, execFileImpl, signal: parentSignal,
  get = async (endpoint, signal) => {
    const { stdout } = await meteredExecFile(execFileImpl, 'gh', ['api', endpoint], { signal, maxBuffer: 5 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
  log = console, git: suppliedGit,
}) {
  if (!SHA.test(headSha || '') || !SHA.test(reviewedHead || '') || reviewedHead === headSha) return null;
  const timeout = AbortSignal.timeout(loadAwareTimeoutMs(12000));
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  try {
    const hasCandidate = scanPrFollowUpJobs(rootDir, 'completed', repo, prNumber, log)
      .some(job => publishedHandoff(job, reviewedHead));
    if (!hasCandidate) return null;
    const cwd = suppliedGit ? null : await resolveRepoCheckoutDir({ repo, rootDir });
    if (!cwd && !suppliedGit) return null;
    const git = suppliedGit || ((args, input, options) => currencyGit(args, input, { cwd, ...options, signal }));
    const [merge, first, main, ...other] = (await git(['rev-list', '--parents', '-n1', headSha])).trim().split(/\s+/u);
    if (merge !== headSha || !SHA.test(first || '') || !SHA.test(main || '') || other.length) return null;
    // The bounded, no-follow reader refuses ambiguous and damaged records.
    const { sourceJobs } = await readCompletedRemediationEvidence(rootDir, repo, prNumber, { sourceParent: first });
    if (sourceJobs?.length !== 1) return null;
    const [job] = sourceJobs;
    if (!publishedHandoff(job, reviewedHead) || job.completion.workerPushedHeadSha !== first) return null;
    // The posted lane must still be able to admit the original findings under
    // its ordinary ancestry rules. A replayed but rerooted source needs its
    // own currency proof and is outside this scheduling path.
    if ((await git(['merge-base', '--all', reviewedHead, first])).trim() !== reviewedHead) return null;
    const prPath = `repos/${repo}/pulls/${prNumber}`;
    const matchesDestination = live => live?.number === prNumber && live.state === 'open'
      && live.head?.sha === headSha && live.head.ref === job.branch && live.base?.ref === job.baseBranch
      && live.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()
      && live.base.repo?.full_name?.toLowerCase() === repo.toLowerCase() && SHA.test(live.base.sha || '');
    const live = await get(prPath, signal);
    if (!matchesDestination(live)
      || !await replaysDirectMainIntegration({ publishedHead: first, currentHead: headSha, base: live.base.sha, git })
      || !sourceStillLatest(await get(`${prPath}/reviews?per_page=100`, signal), job)) return null;
    const refreshed = await get(prPath, signal);
    if (signal.aborted || !matchesDestination(refreshed) || refreshed.base.sha !== live.base.sha) return null;
    return Object.freeze({ revisionRef: reviewedHead, head: headSha });
  } catch (error) {
    log.warn?.(`[watcher] Final remediation integration proof unavailable for ${repo}#${prNumber}@${headSha}: ${error.message}`);
    return null;
  }
}
