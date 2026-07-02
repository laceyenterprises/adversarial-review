import { loadRoleConfig } from './role-config.mjs';

const REVIEWER_ROLE_BY_BOT_TOKEN_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer',
  GH_GEMINI_REVIEWER_TOKEN: 'gemini-reviewer',
});

function roleUpper(role) {
  return String(role || '').replace(/-/g, '_').toUpperCase();
}

function firstConfiguredLogin(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)[0] || null;
}

function providerSlugToBotLogin(provider) {
  const raw = String(provider || '').trim();
  const match = raw.match(/^github-app-(.+)$/);
  if (!match) return null;
  const slug = match[1].trim();
  return slug ? `${slug}[bot]` : null;
}

function resolveProviderForBotTokenEnv(botTokenEnv, env = process.env) {
  const tokenEnv = String(botTokenEnv || '').trim();
  if (!tokenEnv) return null;

  const tokenScopedProvider = String(env[`${tokenEnv}_BROKER_PROVIDER`] || '').trim();
  if (tokenScopedProvider) return tokenScopedProvider;

  const role = REVIEWER_ROLE_BY_BOT_TOKEN_ENV[tokenEnv] || null;
  if (!role) return null;
  const upper = roleUpper(role);
  const roleScopedProvider = String(env[`OAUTH_BROKER_${upper}_PROVIDER`] || '').trim();
  if (roleScopedProvider) return roleScopedProvider;

  const tokenSource = String(env[`${tokenEnv}_SOURCE`] || '').trim().toLowerCase();
  const brokerFlag = String(env[`${upper}_AUTH_VIA_BROKER`] || '').trim().toLowerCase();
  if (tokenSource === 'oauth-broker' || ['1', 'true', 'yes', 'on'].includes(brokerFlag)) {
    return `github-app-${role}`;
  }

  return null;
}

function resolveConfiguredEntitlementBotLogin({
  identity,
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
} = {}) {
  const normalizedIdentity = String(identity || '').trim();
  if (!normalizedIdentity) return null;
  const cfg = loadRoleConfig({
    env,
    topPath,
    modulePaths,
    loaderImpl,
    contextKey: `entitlements.${normalizedIdentity}.gh_bot_login`,
  });
  return firstConfiguredLogin(cfg.get(`entitlements.${normalizedIdentity}.gh_bot_login`, ''));
}

function resolveGitHubAppBotLogin({
  identity = null,
  botTokenEnv = null,
  provider = null,
  env = process.env,
  topPath,
  modulePaths,
  loaderImpl,
  log = console,
} = {}) {
  try {
    const configured = resolveConfiguredEntitlementBotLogin({
      identity,
      env,
      topPath,
      modulePaths,
      loaderImpl,
    });
    if (configured) return configured;
  } catch (err) {
    log.warn?.(
      `[github-app-identity] failed to resolve gh_bot_login for ${identity || '<unknown>'}: ${err?.message || err}`
    );
  }

  const providerLogin = providerSlugToBotLogin(provider || resolveProviderForBotTokenEnv(botTokenEnv, env));
  if (providerLogin) return providerLogin;

  return null;
}

export {
  providerSlugToBotLogin,
  resolveGitHubAppBotLogin,
  resolveProviderForBotTokenEnv,
};
