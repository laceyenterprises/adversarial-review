import test from 'node:test';
import assert from 'node:assert/strict';

import {
  providerSlugToBotLogin,
  resolveGitHubAppBotLogin,
  resolveProviderForBotTokenEnv,
} from '../src/github-app-identity.mjs';

test('provider slug derives deterministic GitHub App bot login', () => {
  assert.equal(providerSlugToBotLogin('github-app-the-hammer-lacey'), 'the-hammer-lacey[bot]');
  assert.equal(providerSlugToBotLogin('github-app-merge-agent-lacey'), 'merge-agent-lacey[bot]');
  assert.equal(providerSlugToBotLogin('pat-provider'), null);
});

test('app identity resolver prefers configured gh_bot_login aliases', () => {
  const cfg = {
    get(key, fallback = null) {
      assert.equal(key, 'entitlements.merge-agent-lacey.gh_bot_login');
      return 'the-hammer-lacey[bot],hammer-lacey';
    },
  };

  assert.equal(
    resolveGitHubAppBotLogin({
      identity: 'merge-agent-lacey',
      botTokenEnv: 'MERGE_AGENT_GH_TOKEN',
      loaderImpl: () => cfg,
      env: {},
    }),
    'the-hammer-lacey[bot]',
  );
});

test('app identity resolver falls back to configured provider slug', () => {
  assert.equal(
    resolveGitHubAppBotLogin({
      identity: 'codex-reviewer-lacey',
      botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      env: {
        OAUTH_BROKER_CODEX_REVIEWER_PROVIDER: 'github-app-lacey-codex-reviewer',
      },
      loaderImpl: () => ({ get: () => '' }),
    }),
    'lacey-codex-reviewer[bot]',
  );
});

test('reviewer broker source enables default github-app role provider', () => {
  assert.equal(
    resolveProviderForBotTokenEnv('GH_CLAUDE_REVIEWER_TOKEN', {
      GH_CLAUDE_REVIEWER_TOKEN_SOURCE: 'oauth-broker',
    }),
    'github-app-claude-reviewer',
  );
});

test('PAT-like token env without app signal returns null so /user fallback remains available', () => {
  assert.equal(
    resolveGitHubAppBotLogin({
      identity: 'codex-reviewer-lacey',
      botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      env: {},
      loaderImpl: () => ({ get: () => '' }),
    }),
    null,
  );
});
