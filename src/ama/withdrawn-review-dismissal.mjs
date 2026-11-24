import { carryHammerWithdrawals, createReviewCurrencyReader } from './review-currency.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { classifyBlockingFindings } from '../follow-up-merge-agent.mjs';
import { amaAllAuthoritativeReviewerLogins, isCurrentAuthoritativeFamilyReview } from './reviewer-authority.mjs';
import { hamAuditCommentAuthorMatches } from './ham-provenance.mjs';
import {
  blockingFindingIdentitiesFromBody, hammerWithdrawalsFromComments, readHammerWithdrawals,
  resolveHammerAdjudication,
} from './hammer-adjudication.mjs';

const sha = /^[a-f0-9]{40}$/i;

function hasQueuedRereviewDismissal(events, review) {
  if (!Array.isArray(events)) throw new Error('missing review dismissal timeline');
  const matches = events.filter(event => event?.event === 'review_dismissed'
    && event.dismissed_review?.review_id === review.id);
  if (matches.length !== 1) return false;
  const [event] = matches;
  const actor = event.actor;
  if (!Number.isSafeInteger(event.id) || event.id < 1 || actor?.type !== 'Bot'
    || typeof actor.login !== 'string' || !actor.login.endsWith('[bot]') || !hamAuditCommentAuthorMatches(actor.login)
    || typeof event.dismissed_review.state !== 'string'
    || event.dismissed_review.state.toLowerCase() !== 'changes_requested') return false;
  // The request can name an intermediate head. Review currency and terminal
  // validation are checked against today's exact head by the caller.
  const message = /^Request changes judged commit ([a-f0-9]{40}); current head is ([a-f0-9]{40})\. Re-review requested at (\S+) is queued or running for the current head; dismissing the superseded review\.$/
    .exec(event.dismissed_review.dismissal_message);
  return Boolean(message && message[1] === review.commit_id && message[2] !== review.commit_id
    && Number.isFinite(Date.parse(message[3])));
}

// HAMFINAL-01: remove only a veto whose complete blocker list has durable,
// comment-verified withdrawals. A verified queued re-review dismissal on a
// terminally remediated head is a separate, read-only case.
export async function dismissWithdrawnReviews({
  rootDir, repo, prNumber, headSha, expectedWithdrawnIdentities = [], terminalReviewedHead = null,
}, {
  get, dismiss, readWithdrawals = readHammerWithdrawals, git,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')
    || !Number.isInteger(prNumber) || prNumber < 1 || !sha.test(headSha || '')) {
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
  const currency = createReviewCurrencyReader({ repo, prNumber, rootDir, get, comments, git });
  const withdrawals = await carryHammerWithdrawals(hammerWithdrawalsFromComments(comments, recorded), headSha, currency);
  if (!expectedWithdrawnIdentities.every(identity => withdrawals.some(entry =>
    entry.identity === identity && entry.reviewCurrency.current && entry.evidenceCurrency.current))) {
    throw new Error('admitted withdrawal authority is missing or invalid');
  }
  const dismissed = [];
  let timeline;
  for (const review of reviews) {
    if (!Number.isSafeInteger(review.id) || review.id < 1 || !['CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)
      || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))
      || normalizeEffectiveReviewVerdict(review.body) !== 'request-changes') continue;
    if (review.commit_id !== headSha && !await isCurrentAuthoritativeFamilyReview(review, reviews, headSha,
      (from, to) => get(`repos/${repo}/compare/${from}...${to}`), currency)) continue;
    const blockers = classifyBlockingFindings(review.body, { lastVerdict: 'request-changes' });
    const adjudication = resolveHammerAdjudication({
      blockingFindingState: blockers.state, blockingFindingCount: blockers.count,
      blockingFindingIdentities: blockingFindingIdentitiesFromBody(review.body),
      reviewedHead: review.commit_id, currentHead: headSha,
    }, withdrawals);
    if (!adjudication.allBlockingWithdrawn) {
      if (review.state === 'CHANGES_REQUESTED') continue;
      const terminalRepair = adjudication.applicable && review.commit_id === terminalReviewedHead
        && terminalReviewedHead !== headSha;
      if (!terminalRepair || !hasQueuedRereviewDismissal(
        timeline ??= await get(`repos/${repo}/issues/${prNumber}/timeline?per_page=100`), review,
      )) {
        throw new Error('dismissed review withdrawal authority is missing or invalid');
      }
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
      + 'durable dispute evidence verified. Other reviews and merge gates remain enforced.');
    dismissed.push(review.id);
  }
  return { dismissed };
}
