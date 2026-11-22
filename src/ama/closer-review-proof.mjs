import { fetchHammerPr } from '../hammer-pr-read.mjs';
import { withCloserGitHubBudget } from '../rate-limit-throttle.mjs';
import { normalizeActorLogin } from '../untrusted-pr-gate.mjs';
import { createHistoryReader } from './history-reader.mjs';
import { createReviewCurrencyReader } from './review-currency.mjs';
import { amaReviewerFamilyForLogin, terminalReviewProofMatches } from './reviewer-authority.mjs';
import { historyReadStopReason } from './history-read-policy.mjs';

const sha = /^[a-f0-9]{40}$/i;
const reviewStates = new Set(['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED', 'COMMENTED', 'PENDING']);
const unavailable = () => ({ ok: false, reason: 'terminal-review-evidence-unavailable' });
const issuerUnverifiable = () => ({ ok: false, reason: 'terminal-review-issuer-unverifiable', needsOperator: true });

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
      if (exactHead || (state === 'CHANGES_REQUESTED' && !sha.test(head))) return issuerUnverifiable();
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
        let result;
        try {
          result = await get(`repos/${repo}/collaborators/${encodeURIComponent(review.login)}/permission`);
        } catch (error) {
          // A wrapped history read retains its cause; a 404 cannot resolve by
          // repeatedly reading the same deleted/non-collaborating issuer.
          for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
            if (historyReadStopReason(cause) === 'history-read-failed:permanent:http-404') return issuerUnverifiable();
          }
          throw error;
        }
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
    if (!sha.test(liveHead) || String(snapshot?.state).toUpperCase() !== 'OPEN') return unavailable();
    if (liveHead.toLowerCase() !== headSha.toLowerCase()) return { ok: false, reason: 'live-head-moved-before-merge' };
    const operator = await withCloserGitHubBudget(() =>
      standingOperatorReviewProof({ reviews: snapshot.reviews, headSha, operatorLogins, repo, get }));
    if (!operator.ok) return operator;
    return await terminalReviewProofMatches({
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
      withReviews: live => String(live?.state).toUpperCase() === 'OPEN'
        && String(live?.headSha || live?.headRefOid || '').toLowerCase() === String(headSha).toLowerCase() });
    return await closerReviewProof({ snapshot, repo, prNumber, headSha, validatedAt, operatorLogins, get });
  } catch {
    return unavailable();
  }
}
