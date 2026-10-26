import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentOSConfigError, loadConfig, loadConfigCached, loadGeminiReviewerConfigCached, resetConfigCache,
} from '../src/config-loader.mjs';
import { resolveGeminiReviewerTokenPools } from '../src/role-config.mjs';

function fixture(t, doc) {
  const root = mkdtempSync(join(tmpdir(), 'gemini-reviewer-config-'));
  t.after(() => { resetConfigCache(); rmSync(root, { recursive: true, force: true }); });
  const topPath = join(root, 'config.yaml');
  writeFileSync(topPath, JSON.stringify({ version: 1, ...doc }));
  return { topPath, modulePaths: [], env: {} };
}

test('null OAuth root normalizes to default declarations without a runtime error', t => {
  const options = fixture(t, { oauth: null });
  for (const read of [loadConfig, loadConfigCached, loadGeminiReviewerConfigCached]) {
    assert.deepEqual(read(options).get('oauth.identity_token_pools'), {});
  }
  assert.deepEqual(resolveGeminiReviewerTokenPools(options).identity_token_pools, {});
});

test('omitted pool map preserves reviewer fallback while ordinary account validation stays strict', t => {
  const options = fixture(t, { oauth: { token_accounts: { invalid: {} } } });
  const strictRead = () => assert.throws(() => loadConfigCached(options), AgentOSConfigError);
  strictRead();
  assert.deepEqual(loadGeminiReviewerConfigCached(options).get('oauth.identity_token_pools'), {});
  assert.deepEqual(resolveGeminiReviewerTokenPools(options).identity_token_pools, {});
  strictRead();
});

const oauth = {
  token_accounts: { agy: { family: 'gemini', holder_user: 'fixture-holder',
    concurrency: 1, allowed_models: ['gemini-test'] } },
  identity_token_pools: { 'gemini-reviewer': ['agy'] },
};

for (const legacy of ['fixture-holder', 42, {}]) {
  test(`scalar/object legacy identities fail as structured config errors: ${JSON.stringify(legacy)}`, t => {
    const options = fixture(t, { oauth, reviewer: { gemini: { identities: legacy } } });
    const check = error => {
      assert.ok(error instanceof AgentOSConfigError);
      assert.equal(error.key, 'reviewer.gemini.identities');
      return true;
    };
    assert.throws(() => resolveGeminiReviewerTokenPools(options), check);
    // A raw injected loader must retain the same error category as schema-backed reads.
    const values = { 'oauth.token_accounts': oauth.token_accounts,
      'oauth.identity_token_pools': oauth.identity_token_pools, 'reviewer.gemini.identities': legacy };
    const loaderImpl = () => ({ get: (key, fallback) => Object.hasOwn(values, key) ? values[key] : fallback });
    assert.throws(() => resolveGeminiReviewerTokenPools({ loaderImpl, env: {} }), check);
  });
}

for (const legacy of [null, ['fixture-holder']]) {
  test(`declared reviewer accepts nullable/array legacy identities: ${JSON.stringify(legacy)}`, t => {
    const options = fixture(t, { oauth, reviewer: { gemini: { identities: legacy } } });
    assert.deepEqual(resolveGeminiReviewerTokenPools(options), oauth);
  });
}
