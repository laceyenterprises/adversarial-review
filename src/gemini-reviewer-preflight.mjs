// gemini-reviewer-preflight — fail-closed guards for the gemini-reviewer
// posting identity (GMW-06).
//
// The watcher/reviewer runtime consumes the gemini reviewer's GitHub App
// installation token from ONE env var only: GH_GEMINI_REVIEWER_TOKEN (the
// destination `botTokenEnv` registered in reviewer-broker-refresh.mjs's
// BROKER_REVIEWER_ROLES). The backing 1Password item is named
// GEMINI_REVIEWER_GH_TOKEN and is mapped into GH_GEMINI_REVIEWER_TOKEN by
// config/watcher-op.env (op://Cliovault/GEMINI_REVIEWER_GH_TOKEN/token).
//
// Two failure modes this module makes loud instead of silent:
//
//  1. Token unresolved. If a gemini reviewer is selected but
//     GH_GEMINI_REVIEWER_TOKEN is empty, posting MUST NOT fall through to
//     whatever other reviewer token happens to be in env (e.g.
//     GH_CODEX_REVIEWER_TOKEN) — that would mis-post the gemini review under
//     codex-reviewer-lacey's identity. We throw a single-line, operator-legible
//     error that names the op.env mapping and the runbook.
//
//  2. Legacy env-var conflict. The 1Password ITEM name (GEMINI_REVIEWER_GH_TOKEN)
//     must never be exported into the runtime process as an env var — only the
//     resolved value under the canonical GH_GEMINI_REVIEWER_TOKEN name may be.
//     A stray GEMINI_REVIEWER_GH_TOKEN in env signals a mis-wired op.env mapping
//     that could shadow / diverge from the canonical var, so we fail closed
//     before any post.

export const GEMINI_REVIEWER_TOKEN_ENV = 'GH_GEMINI_REVIEWER_TOKEN';
export const GEMINI_REVIEWER_LEGACY_TOKEN_ENV = 'GEMINI_REVIEWER_GH_TOKEN';
export const GEMINI_REVIEWER_RUNBOOK = 'docs/RUNBOOK-gemini-reviewer-app.md';

// The exact single-line error contract from SPEC §GMW-06. Kept verbatim so the
// bash launcher guard (scripts/adversarial-watcher-start.sh) and this node
// preflight emit identical operator-facing text.
export const GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE =
  'gemini reviewer selected but GH_GEMINI_REVIEWER_TOKEN unresolved — '
  + 'check the op.env mapping for GEMINI_REVIEWER_GH_TOKEN '
  + '(see docs/RUNBOOK-gemini-reviewer-app.md)';

export const GEMINI_REVIEWER_LEGACY_CONFLICT_MESSAGE =
  'legacy GEMINI_REVIEWER_GH_TOKEN env var is present — adversarial-review '
  + 'consumes GH_GEMINI_REVIEWER_TOKEN only; unset GEMINI_REVIEWER_GH_TOKEN and '
  + 'map op://Cliovault/GEMINI_REVIEWER_GH_TOKEN/token → GH_GEMINI_REVIEWER_TOKEN '
  + '(see docs/RUNBOOK-gemini-reviewer-app.md)';

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// True when this reviewer post is going out under the gemini-reviewer identity,
// detected from either the routed botTokenEnv or an explicit reviewer identity.
export function isGeminiReviewerSelected({ botTokenEnv, reviewerIdentity } = {}) {
  if (String(botTokenEnv || '').trim() === GEMINI_REVIEWER_TOKEN_ENV) {
    return true;
  }
  const identity = String(reviewerIdentity || '').trim().toLowerCase();
  return identity === 'gemini-reviewer' || identity === 'gemini-reviewer-lacey';
}

// Fail closed when the 1Password item name leaked into the runtime as an env
// var. This runs regardless of which reviewer is selected: the legacy var must
// never be present, and surfacing it loudly before any post is strictly safer
// than letting a mis-wired mapping silently take effect.
export function assertNoLegacyGeminiReviewerTokenEnv(env = process.env) {
  if (!isBlank(env[GEMINI_REVIEWER_LEGACY_TOKEN_ENV])) {
    throw new Error(GEMINI_REVIEWER_LEGACY_CONFLICT_MESSAGE);
  }
}

// Preflight invoked before a reviewer posts. Throws the legible single-line
// error when a gemini reviewer is selected but its token is unresolved, and
// fails closed on the legacy-conflict env var. No-op for non-gemini reviewers
// with a clean env, so it is safe to call on every post path.
export function preflightGeminiReviewerToken({
  env = process.env,
  botTokenEnv,
  reviewerIdentity,
} = {}) {
  assertNoLegacyGeminiReviewerTokenEnv(env);
  if (!isGeminiReviewerSelected({ botTokenEnv, reviewerIdentity })) {
    return;
  }
  if (isBlank(env[GEMINI_REVIEWER_TOKEN_ENV])) {
    throw new Error(GEMINI_REVIEWER_TOKEN_UNRESOLVED_MESSAGE);
  }
}
