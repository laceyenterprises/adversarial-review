import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDotenv } from '../src/secret-source/dotenv.mjs';
import { OAUTH_ENV_STRIP_LIST, injectEnvSecrets, scrubOAuthFallbackEnv } from '../src/secret-source/env.mjs';

test('secret-source scrub list removes provider fallback env while preserving Anthropic OAuth bearer', () => {
  const { env, stripped } = scrubOAuthFallbackEnv({
    ANTHROPIC_API_KEY: 'sk-ant',
    ANTHROPIC_AUTH_TOKEN: 'oauth-token',
    OPENAI_API_KEY: 'sk-openai',
    GEMINI_API_KEY: 'gemini',
    SAFE_VALUE: 'kept',
  });

  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'oauth-token');
  assert.equal(env.SAFE_VALUE, 'kept');
  assert.deepEqual(stripped.sort(), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'].sort());
  assert.ok(OAUTH_ENV_STRIP_LIST.includes('AWS_BEARER_TOKEN_BEDROCK'));
});

test('injectEnvSecrets applies values after OAuth fallback scrub', () => {
  const { env, source } = injectEnvSecrets({
    env: {
      OPENAI_API_KEY: 'sk-openai',
      EXISTING: 'one',
    },
    values: {
      GITHUB_TOKEN: 'gh-token',
    },
  });

  assert.equal(source, 'env');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.EXISTING, 'one');
  assert.equal(env.GITHUB_TOKEN, 'gh-token');
});

test('parseDotenv reads simple quoted and unquoted assignments', () => {
  assert.deepEqual(parseDotenv(`
# comment
GITHUB_TOKEN=gh-token
ALERT_TO="123456"
EMPTY=
`), {
    GITHUB_TOKEN: 'gh-token',
    ALERT_TO: '123456',
    EMPTY: '',
  });
});
