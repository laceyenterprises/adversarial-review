import { createWatcherOctokit } from './conditional-request.mjs';
import { githubOwnerTokens } from './github-owner-token.mjs';

// Owner-scoped client for an additional watched org: every request, including
// pagination, authenticates with that org's installation token, never the home
// client's. Returns null when no owner-scoped credential path exists for the org
// (for example the home org itself), so discovery can skip it.
export function ownerScopedOrgClient(org, { tokens = githubOwnerTokens, create = createWatcherOctokit, env = process.env } = {}) {
  if (!tokens.routedOwner({ owner: org })) return null;
  return create({ authProvider: () => tokens.select({ token: env.GITHUB_TOKEN, target: { owner: org } }) });
}
