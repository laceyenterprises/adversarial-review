const OAUTH_ENV_STRIP_LIST = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
]);

function scrubOAuthFallbackEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  const stripped = [];
  for (const key of OAUTH_ENV_STRIP_LIST) {
    if (env[key] !== undefined) {
      delete env[key];
      stripped.push(key);
    }
  }
  return { env, stripped };
}

function injectEnvSecrets({
  env = process.env,
  values = {},
  scrubOAuthFallbacks = true,
} = {}) {
  const base = scrubOAuthFallbacks ? scrubOAuthFallbackEnv(env) : { env: { ...env }, stripped: [] };
  return {
    env: {
      ...base.env,
      ...Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined && value !== null)
      ),
    },
    stripped: base.stripped,
    source: 'env',
  };
}

function readEnvSecret(name, { env = process.env } = {}) {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export {
  OAUTH_ENV_STRIP_LIST,
  injectEnvSecrets,
  readEnvSecret,
  scrubOAuthFallbackEnv,
};
