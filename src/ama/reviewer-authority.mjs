import {
  REVIEWER_ROUTE_BY_MODEL,
  ROUTE_BY_BUILDER_CLASS,
} from '../adapters/subject/github-pr/routing.mjs';

const AMA_AUTHORITATIVE_REVIEWER_LOGINS_BY_MODEL = Object.freeze({
  claude: ['lacey-claude-reviewer', 'claude-reviewer-lacey'],
  codex: ['lacey-codex-reviewer', 'codex-reviewer-lacey'],
  gemini: ['lacey-gemini-reviewer', 'gemini-reviewer-lacey'],
});

// The reviewer bot's GitHub account; accept BOTH observed naming forms so the
// AMA live-review anti-spoof filter is robust to the known discrepancy between
// the live account (`lacey-<model>-reviewer`) and the legacy config form
// (`<model>-reviewer-lacey`). Keyed on the `reviewed_prs.reviewer` model/family,
// with builder tags resolved through the canonical GitHub-PR reviewer route.
export function amaAuthoritativeReviewerLoginsForModel(reviewerModel) {
  const m = String(reviewerModel ?? '').trim().toLowerCase();
  if (!m) return [];
  const route = REVIEWER_ROUTE_BY_MODEL[m] || ROUTE_BY_BUILDER_CLASS[m];
  return AMA_AUTHORITATIVE_REVIEWER_LOGINS_BY_MODEL[route?.reviewerModel] || [];
}

export function amaReviewerFamilyForLogin(login) {
  const normalized = String(login ?? '').replace(/\[bot\]$/, '');
  return Object.entries(AMA_AUTHORITATIVE_REVIEWER_LOGINS_BY_MODEL)
    .find(([, logins]) => logins.includes(normalized))?.[0] || null;
}

export function amaAllAuthoritativeReviewerLogins() {
  return [...new Set(Object.values(AMA_AUTHORITATIVE_REVIEWER_LOGINS_BY_MODEL).flat())];
}

async function currentReviewHead(reviewedHead, headSha, compare, currency) {
  if (currency) return (await currency(reviewedHead, headSha)).current === true;
  if (reviewedHead === headSha) return true;
  const ancestry = await compare(reviewedHead, headSha);
  if (['behind', 'diverged'].includes(ancestry.status)) return false;
  if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('cannot verify review ancestry');
  return true;
}

// REST review lists are oldest first. Include dismissed blocking bodies:
// withdrawing a finding requires a newer authoritative verdict.
export async function latestAuthoritativeReviewInAncestry(reviews, headSha, compare, currency = null) {
  for (const entry of [...reviews].reverse()) {
    if (!['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(entry.state)
      || !amaAllAuthoritativeReviewerLogins().includes(String(entry.user?.login || '').replace(/\[bot\]$/, ''))) continue;
    if (!/^[a-f0-9]{40}$/i.test(entry.commit_id || '')) throw new Error('authoritative review has no valid head');
    if (!await currentReviewHead(entry.commit_id, headSha, compare, currency)) continue;
    return entry;
  }
}

// Families may stack findings on one head, but no citation survives a newer
// authoritative head in the parent ancestry, even from another family.
export async function isCurrentAuthoritativeFamilyReview(review, reviews, headSha, compare, currency = null) {
  const family = amaReviewerFamilyForLogin(review?.user?.login);
  if (!family) return false;
  const latest = await latestAuthoritativeReviewInAncestry(reviews.filter((entry) =>
    amaReviewerFamilyForLogin(entry.user?.login) === family), headSha, compare, currency);
  if (latest !== review) return false;
  for (const entry of reviews) {
    if (!amaReviewerFamilyForLogin(entry.user?.login)
      || !['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(entry.state)
      || entry.commit_id === review.commit_id) continue;
    if (!/^[a-f0-9]{40}$/i.test(entry.commit_id || '')) throw new Error('authoritative review has no valid head');
    if (!await currentReviewHead(entry.commit_id, headSha, compare, currency)) continue;
    const newer = await compare(review.commit_id, entry.commit_id);
    if (newer.status === 'ahead' || (currency && newer.status === 'diverged'
      && reviews.indexOf(entry) > reviews.indexOf(review))) return false;
    if (!['behind', 'diverged', 'identical'].includes(newer.status)) throw new Error('cannot verify review supersession');
  }
  return true;
}

// HAMLATEAUDIT-01: an exact SHA proves content validation, not that a later
// review's findings were considered. Compare each authoritative family's
// applicable body at validation with its current body. IDs/timestamps alone
// must not invalidate an identical repeat; different families cannot erase
// one another. Reuse the same ancestry/currency rules as finding admission.
export async function terminalReviewProofMatches({
  reviews, headSha, validatedAt, compare, currency = null,
}) {
  const cutoff = Date.parse(validatedAt);
  if (!Array.isArray(reviews) || !Number.isFinite(cutoff)) {
    return { ok: false, reason: 'terminal-review-evidence-unavailable' };
  }
  // Currency can independently prove a rewritten head, but a failed proof
  // alone cannot establish that a review belongs to a discarded branch.
  const checkedCurrency = currency && (async (from, to) => {
    const result = await currency(from, to);
    if (result.current === true) return result;
    const ancestry = await compare(from, to);
    if (!['behind', 'diverged'].includes(ancestry?.status)) throw new Error('cannot verify terminal review applicability');
    return result;
  });
  const normalized = reviews.map(review => ({
    ...review,
    user: review.user || review.author,
    commit_id: review.commit_id || review.commit?.oid || review.commitId,
    submitted_at: review.submitted_at || review.submittedAt,
    state: String(review.state || '').toUpperCase(),
  })).sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
  const families = new Set(normalized.map(review => amaReviewerFamilyForLogin(review.user?.login)).filter(Boolean));
  for (const family of families) {
    const entries = normalized.filter(review => amaReviewerFamilyForLogin(review.user?.login) === family);
    const undated = entries.filter(review => !Number.isFinite(Date.parse(review.submitted_at)));
    if (await latestAuthoritativeReviewInAncestry(undated, headSha, compare, checkedCurrency)) {
      return { ok: false, reason: 'terminal-review-evidence-unavailable' };
    }
    const latest = await latestAuthoritativeReviewInAncestry(entries, headSha, compare, checkedCurrency);
    if (!latest) continue;
    const prior = await latestAuthoritativeReviewInAncestry(
      // GitHub timestamps have second precision. An equal-second review
      // cannot prove it preceded the audit; retain the earlier body instead.
      entries.filter(review => Date.parse(review.submitted_at) < cutoff), headSha, compare, checkedCurrency,
    );
    if (latest.commit_id !== prior?.commit_id || latest.body !== prior?.body) {
      return { ok: false, reason: 'review-changed-since-validation',
        reviewId: latest.node_id || latest.id || null, family };
    }
  }
  return { ok: true };
}
