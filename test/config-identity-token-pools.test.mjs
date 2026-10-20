import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadConfigRuntime, validateSchema, AgentOSConfigError } from '../src/config-loader.mjs';
import { modelSubsetAllowed } from '../src/config-token-pools.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/identity-token-pools.v1.json', import.meta.url)));
const vocabulary = JSON.parse(readFileSync(new URL('../src/identity-token-pools.v1.json', import.meta.url)));

test('ITP-01 published vocabulary and shared vectors use version 1', () => {
  assert.equal(vocabulary.version, 1);
  assert.equal(vectors.version, vocabulary.version);
});

for (const vector of vectors.declarations) {
  test(`ITP-01 public per-file validation: ${vector.name}`, () => {
    const doc = { version: 1, oauth: vector.oauth };
    if (vector.valid) {
      assert.deepEqual(validateSchema(doc).oauth, vector.oauth);
    } else {
      assert.throws(() => validateSchema(doc, { source: 'single.yaml' }), error => {
        assert.ok(error instanceof AgentOSConfigError);
        assert.ok(error.message.includes(vector.error), error.message);
        assert.equal(error.source, 'single.yaml');
        return true;
      });
    }
  });
}

for (const [name, mutate] of [
  ['version', value => { value.version = 2; }],
  ['max_concurrency', value => { delete value.max_concurrency; }],
  ['max_models', value => { value.max_models = '128'; }],
  ['max_pool_accounts', value => { value.max_pool_accounts = 0; }],
  ['families', value => { value.families = ['future']; }],
  ['account_fields', value => { value.account_fields = {}; }],
  ['required_fields', value => { value.required_fields = ['family']; }],
  ['id_pattern', value => { value.id_pattern = '['; }],
  ['model_pattern', value => { delete value.model_pattern; }],
  ['broker_families', value => { value.broker_families = { codex: 'gemini' }; }],
  ['role_families', value => { value.role_families = { codex: 'future' }; }],
]) {
  test(`ITP-01 malformed published ${name} fails at module import`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'itp-vocabulary-'));
    try {
      const broken = structuredClone(vocabulary);
      mutate(broken);
      copyFileSync(new URL('../src/config-token-pools.mjs', import.meta.url), join(dir, 'config-token-pools.mjs'));
      writeFileSync(join(dir, 'identity-token-pools.v1.json'), JSON.stringify(broken));
      await assert.rejects(import(pathToFileURL(join(dir, 'config-token-pools.mjs')).href),
        error => error.message.includes('invalid ITP-01 vocabulary:') && error.message.includes(name));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('ITP-01 public validation rejects scalar maps', () => {
  assert.throws(() => validateSchema({ version: 1, oauth: { token_accounts: 'garbage' } }),
    /oauth.token_accounts: expected mapping/);
});

test('ITP-01 existing Python litellm OAuth children remain loadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp-litellm-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const oauth = Object.fromEntries(['codex', 'claude', 'gemini', 'opencode', 'hermes', 'pi', 'oss_local', 'patch']
      .map(role => [`litellm_vk_${role}`, { op_ref: `op://Synthetic/litellm-${role}/credential` }]));
    writeFileSync(topPath, JSON.stringify({ version: 1, oauth }));
    const cfg = loadConfig({ topPath, env: {} });
    for (const [key, value] of Object.entries(oauth)) assert.deepEqual(cfg.get(`oauth.${key}`), value);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const versioned of [false, true]) {
  test(`ITP-01 final validation preserves cross-layer references and winning sources (versioned local: ${versioned})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'itp-sources-'));
    try {
      const topPath = join(dir, 'config.yaml');
      const module = join(dir, 'module.yaml');
      const local = join(dir, 'config.local.yaml');
      const { token_accounts: accounts, identity_token_pools: pools } = vectors.declarations[0].oauth;
      writeFileSync(module, JSON.stringify({ oauth: { identity_token_pools: pools } }));
      writeFileSync(topPath, JSON.stringify({ version: 1, oauth: { token_accounts: 'superseded' } }));
      writeFileSync(local, JSON.stringify({ ...(versioned ? { version: 1 } : {}), oauth: { token_accounts: accounts } }));
      // A lower-layer pool can refer to higher-layer accounts, and invalid
      // lower-layer maps can be superseded before declaration validation.
      assert.deepEqual(loadConfig({ topPath, modulePaths: [module], env: {} }).get('oauth.identity_token_pools'), pools);
      writeFileSync(local, JSON.stringify({ ...(versioned ? { version: 1 } : {}), oauth: { token_accounts: {} } }));
      assert.throws(() => loadConfig({ topPath, modulePaths: [module], env: {} }), error => {
        assert.ok(error instanceof AgentOSConfigError);
        assert.match(error.message, /unknown account reference/);
        assert.equal(error.source, module);
        assert.deepEqual(error.declarationSources, {
          'oauth.token_accounts': { source: `local:${local}`, path: local },
          'oauth.identity_token_pools': { source: `module:${module}`, path: module },
        });
        assert.ok(error.message.includes(local));
        assert.ok(error.message.includes(module));
        return true;
      });
      writeFileSync(local, JSON.stringify({ ...(versioned ? { version: 1 } : {}), oauth: { token_accounts: null } }));
      assert.throws(() => loadConfig({ topPath, modulePaths: [module], env: {} }), error => {
        assert.equal(error.source, local);
        assert.match(error.message, /oauth.token_accounts: expected mapping/);
        return true;
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const mode of ['top', 'module', 'local']) {
  for (const oauth of [
    { identity_token_pools: { future_role: ['synthetic-redaction-sentinel'] } },
    { token_accounts: { ...vectors.declarations[0].oauth.token_accounts,
      future_account: { future_field: 'synthetic-redaction-sentinel' } } },
  ]) {
    test(`ITP-01 runtime deliberately refuses future declaration vocabulary in ${mode} (${Object.keys(oauth)[0]})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'itp-runtime-'));
      try {
        const topPath = join(dir, 'config.yaml');
        const layer = join(dir, mode === 'local' ? 'config.local.yaml' : 'module.yaml');
        writeFileSync(topPath, JSON.stringify({ version: 1, ...(mode === 'top' ? { oauth } : {}) }));
        if (mode !== 'top') writeFileSync(layer, JSON.stringify({ oauth }));
        assert.throws(() => loadConfigRuntime({ topPath, modulePaths: mode === 'module' ? [layer] : [], env: {} }), error => {
          assert.ok(error instanceof AgentOSConfigError);
          assert.match(error.message, /unknown (canonical role|descriptor field)/);
          assert.ok(!error.message.includes('synthetic-redaction-sentinel'));
          assert.ok(!JSON.stringify(error).includes('synthetic-redaction-sentinel'));
          return true;
        });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

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
