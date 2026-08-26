// The bot/dependency-author predicate, as a pure leaf module.
//
// This started life inside `pollonce-phases.mjs` (MAL-01), where it decides
// whether a prefix-less PR title is an actionable `malformed` row or an
// unroutable bot PR. ASR-02's security-surface classifier needs the SAME
// predicate, and `pollonce-phases.mjs` cannot supply it: importing that module
// opens `reviews.db` at module scope (via `review-state-db.mjs`), and the
// classifier is required to be pure — no I/O, no DB.
//
// So the predicate lives here, defined exactly once. `pollonce-phases.mjs`
// re-exports it, which keeps its existing import site and public surface
// unchanged. Copying the login set into the classifier instead would have let
// the two drift, and the drift would be silent: a bot added to one list and not
// the other is a PR that routes nowhere.
const UNROUTABLE_BOT_AUTHORS = new Set([
  'dependabot[bot]',
  'dependabot-preview[bot]',
  'renovate[bot]',
  'github-actions[bot]',
]);

/**
 * Is this author a dependency/CI bot that cannot produce a worker-class title
 * prefix?
 *
 * @param {unknown} authorRef  A login, in either rendering GitHub uses.
 * @returns {boolean}
 */
export function isUnroutableBotAuthor(authorRef) {
  const login = String(authorRef || '').trim().toLowerCase();
  if (!login) return false;
  if (UNROUTABLE_BOT_AUTHORS.has(login)) return true;
  // `app/<name>` is how some surfaces (e.g. `gh pr view --json author`) render a
  // GitHub App author for the same account the REST API returns as `<name>[bot]`.
  // The `[bot]` suffix is synthesised ONLY for that prefixed form: a bare
  // `dependabot` is a perfectly ordinary account name and must NOT be silently
  // classified as the app.
  if (!login.startsWith('app/')) return false;
  return UNROUTABLE_BOT_AUTHORS.has(`${login.slice('app/'.length)}[bot]`);
}
