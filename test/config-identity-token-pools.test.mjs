import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';
import { modelSubsetAllowed } from '../src/config-token-pools.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/identity-token-pools.v1.json', import.meta.url)));
for (const mode of ['top', 'module', 'local']) {
for (const vector of vectors.declarations) {
  test(`ITP-01 strict config ${mode}: ${vector.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'itp-config-'));
    try {
      const topPath = join(dir, 'config.yaml');
      writeFileSync(topPath, JSON.stringify({ version: 1, ...(mode === 'top' ? { oauth: vector.oauth } : {}) }));
      const modulePaths = mode === 'module' ? [join(dir, 'module.yaml')] : [];
      if (mode !== 'top') {
        writeFileSync(join(dir, mode === 'module' ? 'module.yaml' : 'config.local.yaml'), JSON.stringify({ oauth: vector.oauth }));
      }
      if (vector.valid) {
        const cfg = loadConfig({ topPath, modulePaths, env: {} });
        assert.deepEqual(cfg.get('oauth.token_accounts'), vector.oauth.token_accounts ?? {});
        assert.deepEqual(cfg.get('oauth.identity_token_pools'), vector.oauth.identity_token_pools ?? {});
      } else {
        assert.throws(() => loadConfig({ topPath, modulePaths, env: {} }), error => {
          assert.ok(error instanceof AgentOSConfigError);
          assert.ok(error.message.includes(vector.error), error.message);
          return true;
        });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

}

test('ITP-01 atomic local maps can clear declarations without changing roles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp-override-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1, oauth: vectors.declarations[0].oauth }));
    const roles = loadConfig({ topPath, env: {} }).get('roles');
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ oauth: {
      token_accounts: {}, identity_token_pools: {},
    } }));
    const cfg = loadConfig({ topPath, env: {} });
    assert.deepEqual(cfg.get('oauth.token_accounts'), {});
    assert.deepEqual(cfg.get('oauth.identity_token_pools'), {});
    assert.deepEqual(cfg.get('roles'), roles);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('ITP-01 shared model subset vectors preserve identity authorization', () => {
  const accounts = vectors.declarations[0].oauth.token_accounts;
  for (const vector of vectors.model_subsets) {
    assert.equal(modelSubsetAllowed(accounts[vector.account], vector.identity_models, vector.requested_models), vector.allowed);
  }
});


test('ITP-01 module aliases preserve atomic declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp-alias-'));
  try {
    const oauth = vectors.declarations[0].oauth;
    const module = join(dir, 'module.yaml');
    writeFileSync(module, JSON.stringify({
      __aliases: { accounts: 'oauth.token_accounts', pools: 'oauth.identity_token_pools' },
      accounts: oauth.token_accounts, pools: oauth.identity_token_pools,
    }));
    const cfg = loadConfig({ topPath: join(dir, 'config.yaml'), modulePaths: [module], env: {} });
    assert.deepEqual(cfg.get('oauth.token_accounts'), oauth.token_accounts);
    assert.deepEqual(cfg.get('oauth.identity_token_pools'), oauth.identity_token_pools);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('ITP-01 alias conflicts never echo unvalidated account values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp-redaction-'));
  try {
    const module = join(dir, 'module.yaml');
    const sentinel = 'synthetic-redaction-sentinel';
    writeFileSync(module, JSON.stringify({
      __aliases: { accounts: 'oauth.token_accounts' },
      accounts: { sample: sentinel }, oauth: { token_accounts: {} },
    }));
    assert.throws(() => loadConfig({ topPath: join(dir, 'config.yaml'), modulePaths: [module], env: {} }), error => {
      assert.ok(error instanceof AgentOSConfigError);
      assert.match(error.message, /conflicting declarations/);
      assert.ok(!JSON.stringify(error).includes(sentinel));
      assert.ok(!error.message.includes(sentinel));
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
