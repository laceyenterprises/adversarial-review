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

// REST review lists are oldest first. Include dismissed blocking bodies:
// withdrawing a finding requires a newer authoritative verdict.
export async function latestAuthoritativeReviewInAncestry(reviews, headSha, compare) {
  for (const entry of [...reviews].reverse()) {
    if (!['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(entry.state)
      || !amaAllAuthoritativeReviewerLogins().includes(String(entry.user?.login || '').replace(/\[bot\]$/, ''))) continue;
    if (!/^[a-f0-9]{40}$/i.test(entry.commit_id || '')) throw new Error('authoritative review has no valid head');
    if (entry.commit_id !== headSha) {
      const ancestry = await compare(entry.commit_id, headSha);
      if (['behind', 'diverged'].includes(ancestry.status)) continue;
      if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('cannot verify review ancestry');
    }
    return entry;
  }
}
