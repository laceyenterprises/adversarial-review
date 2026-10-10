import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { classifyBlockingFindings } from '../follow-up-merge-agent.mjs';
import { amaAllAuthoritativeReviewerLogins } from './reviewer-authority.mjs';
import {
  blockingFindingIdentitiesFromBody, hammerWithdrawalsFromComments, readHammerWithdrawals,
  resolveHammerAdjudication,
} from './hammer-adjudication.mjs';

// HAMFINAL-01: remove only the GitHub veto whose complete blocker list has
// durable, comment-verified withdrawals at the live head. This grants no merge
// authority and does not use the older-head terminal-remediation dismissal.
export async function dismissWithdrawnReviews({ rootDir, repo, prNumber, headSha, expectedWithdrawnIdentities = [] }, {
  get, dismiss, readWithdrawals = readHammerWithdrawals,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')
    || !Number.isInteger(prNumber) || prNumber < 1 || !/^[a-f0-9]{40}$/i.test(headSha || '')) {
    throw new Error('withdrawn review dismissal requires PR identity and exact head');
  }
  const recorded = readWithdrawals({ rootDir, repo, prNumber, strict: true });
  const prPath = `repos/${repo}/pulls/${prNumber}`;
  const assertLiveHead = async () => {
    const pr = await get(prPath);
    if (pr.state !== 'open' || pr.draft || pr.head?.sha !== headSha) {
      throw new Error('withdrawn review dismissal head is not live/open');
    }
  };
  await assertLiveHead();
  // The CLI supplies complete paginated lists; an unreadable list fails closed.
  const reviews = await get(`${prPath}/reviews?per_page=100`);
  const comments = await get(`repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  if (!Array.isArray(reviews) || !Array.isArray(comments)) throw new Error('missing reviews or withdrawal comments');
  const withdrawals = hammerWithdrawalsFromComments(comments, recorded);
  if (!expectedWithdrawnIdentities.every(identity => withdrawals.some(entry =>
    entry.identity === identity && entry.headSha === headSha))) {
    throw new Error('admitted withdrawal authority is missing or invalid');
  }
  const dismissed = [];
  for (const review of reviews) {
    if (!Number.isSafeInteger(review.id) || review.id < 1 || !['CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
      || review.commit_id !== headSha
      || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))
      || normalizeEffectiveReviewVerdict(review.body) !== 'request-changes') continue;
    const blockers = classifyBlockingFindings(review.body, { lastVerdict: 'request-changes' });
    const adjudication = resolveHammerAdjudication({
      blockingFindingState: blockers.state, blockingFindingCount: blockers.count,
      blockingFindingIdentities: blockingFindingIdentitiesFromBody(review.body),
      reviewedHead: review.commit_id, currentHead: headSha,
    }, withdrawals);
    if (!adjudication.allBlockingWithdrawn) {
      if (review.state === 'DISMISSED') throw new Error('dismissed review withdrawal authority is missing or invalid');
      continue;
    }
    // Recheck the selected review and live head immediately before mutation.
    const liveReview = await get(`${prPath}/reviews/${review.id}`);
    if (liveReview.state !== review.state || liveReview.body !== review.body
      || liveReview.commit_id !== review.commit_id || liveReview.user?.login !== review.user?.login
      || liveReview.id !== review.id) throw new Error('withdrawn review changed before dismissal');
    await assertLiveHead();
    if (liveReview.state === 'DISMISSED') continue;
    await dismiss(`${prPath}/reviews/${review.id}/dismissals`,
      `HAMFINAL-01: all ${blockers.count} blocking findings withdrawn-by-hammer at exact head ${headSha}; `
      + 'durable admission and HAM comment evidence verified. Other reviews and merge gates remain enforced.');
    dismissed.push(review.id);
  }
  return { dismissed };
}
