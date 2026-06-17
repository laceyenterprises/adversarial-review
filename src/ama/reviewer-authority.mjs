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
