import { fetchHammerPr } from '../hammer-pr-read.mjs';
import { withCloserGitHubBudget } from '../rate-limit-throttle.mjs';
import { normalizeActorLogin } from '../untrusted-pr-gate.mjs';
import { createHistoryReader } from './history-reader.mjs';
import { createReviewCurrencyReader } from './review-currency.mjs';
import { amaReviewerFamilyForLogin, terminalReviewProofMatches } from './reviewer-authority.mjs';

const sha = /^[a-f0-9]{40}$/i;
const reviewStates = new Set(['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED', 'COMMENTED', 'PENDING']);
const unavailable = () => ({ ok: false, reason: 'terminal-review-evidence-unavailable' });

// A formal operator veto stands until GitHub dismisses that review or the
// same issuer later approves. Rebasing, publishing an audit or leaving a comment
// cannot clear it. This proof has no bearing on coding instructions.
async function standingOperatorReviewProof({ reviews, headSha, operatorLogins, repo, get }) {
  if (!Array.isArray(reviews) || !sha.test(headSha)) return unavailable();
  const decisive = [];
  for (const review of reviews) {
    const state = review?.state;
    if (!reviewStates.has(state)) return unavailable();
    if (state !== 'CHANGES_REQUESTED' && state !== 'APPROVED') continue;
    const head = review.commit_id || review.commitId || review.commit?.oid;
    const exactHead = typeof head === 'string' && head.toLowerCase() === headSha.toLowerCase();
    // Historical approvals with missing commit/author evidence cannot dispose
    // a veto. Deleted historical authors cannot be verified as live operators.
    // Keep missing identity on the merge head fail-closed.
    if (state === 'APPROVED' && !sha.test(head) && !exactHead) continue;
    const author = review.user || review.author;
    const login = normalizeActorLogin(author?.login, { typename: author?.type || author?.__typename || review.authorType });
    if (!login) {
      if (exactHead || (state === 'CHANGES_REQUESTED' && !sha.test(head))) return unavailable();
      continue;
    }
    if (login.endsWith('[bot]') || amaReviewerFamilyForLogin(login)) continue;
    // GitHub retains requests for changes across pushes, including the
    // hammer's base-retry rebase. A known issuer's veto needs no head match.
    decisive.push({
      state, login, id: review.node_id || review.id,
      at: Date.parse(review.submitted_at || review.submittedAt),
    });
  }
  const configured = new Set(operatorLogins.map(login => normalizeActorLogin(login)));
  const permissions = new Map();
  for (const review of decisive) {
    if (review.state !== 'CHANGES_REQUESTED') continue;
    if (!review.id || !Number.isFinite(review.at)) return unavailable();
    if (decisive.some(approval => approval.state === 'APPROVED' && approval.login === review.login
      && approval.id && approval.id !== review.id && approval.at > review.at)) continue;
    if (!configured.has(review.login)) {
      if (!permissions.has(review.login)) {
        const result = await get(`repos/${repo}/collaborators/${encodeURIComponent(review.login)}/permission`);
        const permission = result?.permission;
        if (!['admin', 'maintain', 'write', 'triage', 'read', 'none'].includes(permission)) return unavailable();
        permissions.set(review.login, permission);
      }
      // Private org membership can appear as CONTRIBUTOR even for an admin.
      // Require the repository permission itself, not author association.
      if (permissions.get(review.login) !== 'admin') continue;
    }
    return { ok: false, reason: 'operator-review-changes-requested', reviewId: review.id, operatorLogin: review.login };
  }
  return { ok: true };
}

export async function closerReviewProof({ snapshot, repo, prNumber, headSha, validatedAt, operatorLogins = [], get }) {
  try {
    const liveHead = snapshot?.headSha || snapshot?.headRefOid;
    if (!sha.test(liveHead) || snapshot.state !== 'OPEN') return unavailable();
    if (liveHead !== headSha) return { ok: false, reason: 'live-head-moved-before-merge' };
    const operator = await withCloserGitHubBudget(() =>
      standingOperatorReviewProof({ reviews: snapshot.reviews, headSha, operatorLogins, repo, get }));
    if (!operator.ok) return operator;
    return terminalReviewProofMatches({
      reviews: snapshot.reviews, headSha, validatedAt,
      compare: (from, to) => get(`repos/${repo}/compare/${from}...${to}`),
      currency: createReviewCurrencyReader({ repo, prNumber, get, comments: snapshot.comments }),
    });
  } catch {
    return unavailable();
  }
}

export async function readCloserReviewProof({ repo, prNumber, headSha, validatedAt, operatorLogins, signal, env },
  { fetchPr = fetchHammerPr, get = createHistoryReader({ signal, env, hammerToken: true }) } = {}) {
  try {
    const snapshot = await fetchPr(repo, prNumber, { withChecks: false, signal, env,
      withReviews: live => live.state === 'OPEN' && live.headSha === headSha });
    return await closerReviewProof({ snapshot, repo, prNumber, headSha, validatedAt, operatorLogins, get });
  } catch {
    return unavailable();
  }
}
