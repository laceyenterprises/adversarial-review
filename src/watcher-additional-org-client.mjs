import { createWatcherOctokit } from './conditional-request.mjs';
import { githubOwnerTokens } from './github-owner-token.mjs';
import { resolveWatcherGhBrokerRole } from './reviewer-broker-refresh.mjs';

// Owner-scoped client for an additional watched org: every request, including
// pagination, authenticates with that org's installation token, never the home
// client's. Returns null when no owner-scoped credential path exists for the org
// (for example the home org itself), so discovery can skip it.
export function ownerScopedOrgClient(org, { tokens = githubOwnerTokens, create = createWatcherOctokit, env = process.env } = {}) {
  if (!tokens.routedOwner({ owner: org })) return null;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token || !env.OAUTH_BROKER_SHARED_SECRET_FILE) return null;
  return create({ authProvider: () => tokens.select({
    token, env, role: resolveWatcherGhBrokerRole(env), target: { owner: org },
  }) });
}
