import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOSConfigError, loadConfig } from '../src/config-loader.mjs';
import { PoolConfigConflictError, legacyPoolOverrideConflicts, validateLegacyPoolOverrides } from '../src/config-token-pool-migration.mjs';
import { resolveIdentityTokenPools, validateStartupRoleConfig } from '../src/role-config.mjs';
import { poolConflictFixture } from './helpers/pool-conflict-fixture.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const accounts = {
  corp: { family: 'codex', broker_provider: 'codex-corp', allowed_models: ['gpt-6'], concurrency: 1 },
  personal: { family: 'codex', broker_provider: 'codex', allowed_models: ['gpt-6'], concurrency: 1 },
};

test('ITPPOOLCONFLICT-01 startup reports runtime conflicts as nonfatal redacted warnings', t => {
  const fixture = poolConflictFixture(t, { identities: ['codex', 'hammer'] });
  const messages = [];
  t.mock.method(console, 'warn', message => messages.push(message));
  const keys = ['roles.build_pack_default_worker_class', 'roles.codex_worker_account_order'];
  assert.deepEqual(legacyPoolOverrideConflicts(loadConfig(fixture.options)), keys);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = validateStartupRoleConfig(fixture.options);
    assert.deepEqual(result.warnings, keys.map(key => ({ reason: 'pool-config-conflict', key })));
    assert.throws(() => resolveIdentityTokenPools(fixture.options), error => {
      assert.ok(error instanceof PoolConfigConflictError);
      assert.equal(error.key, keys[0]);
      assert.deepEqual(error.keys, keys);
      return true;
    });
  }
  assert.deepEqual(messages, keys.map(key => `pool-config-conflict: ${key}`));
  assert.equal(JSON.stringify(messages).includes('personal-first'), false);
  assert.equal(JSON.stringify(messages).includes(fixture.options.topPath), false);
});

test('ITPPOOLCONFLICT-01 identity projection leaves global declaration validation strict', t => {
  const fixture = poolConflictFixture(t, { invalidAccounts: true });
  assert.equal(resolveIdentityTokenPools({ ...fixture.options, identity: 'hammer' }), null);
  for (const read of [loadConfig, resolveIdentityTokenPools, validateStartupRoleConfig]) {
    assert.throws(() => read(fixture.options), /concurrency/);
  }
  assert.throws(() => resolveIdentityTokenPools({ ...fixture.options, identity: 'codex' }), /concurrency/);
});

test('ITP-17 strict loader default is corporate-first before any role selector', () => {
  assert.equal(loadConfig({ topPath: '/nonexistent/itp17/config.yaml', modulePaths: [], env: {} }).get('roles.codex_worker_account_order'), 'corporate-first');
});

for (const pools of [undefined, null, {}]) {
  test(`ITP-17 migration helper ignores absent pools: ${JSON.stringify(pools)}`, () => {
    validateLegacyPoolOverrides({ get: key => {
      assert.equal(key, 'oauth.identity_token_pools');
      return pools;
    } });
  });
}

for (const declaration of ['', ' null']) {
  test(`ITP-17 resolver reports a config error for null YAML pools: ${JSON.stringify(declaration)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'itp17-null-'));
    try {
      const topPath = join(dir, 'config.yaml');
      writeFileSync(topPath, `version: 1\noauth:\n  identity_token_pools:${declaration}\n`);
      assert.throws(() => resolveIdentityTokenPools({ topPath, modulePaths: [], env: {} }), error => {
        assert.ok(error instanceof AgentOSConfigError);
        assert.match(error.message, /oauth.identity_token_pools: expected mapping/);
        assert.equal(error.source, topPath);
        return true;
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const [pin, role] of [
  ['codex', 'remediator-codex'],
  ['codex-corp', 'remediator-codex'],
  ['claude', 'remediator-claude'],
  ['claude-code', 'remediator-claude'],
  ['claude-code-corp', 'remediator-claude'],
  ['remediator-codex-corp', 'remediator-codex'],
  ['remediator-claude-corp', 'remediator-claude'],
]) {
  test(`ITP-17 migration helper checks remediator pin ${pin} against ${role}`, () => {
    // Exercise the helper seam even for spellings the strict schema rejects.
    const config = (pool, source) => ({
      get: key => ({ 'oauth.identity_token_pools': { [pool]: ['account'] }, 'roles.remediator': pin })[key],
      resolutionTrace: () => [{ source }],
    });
    assert.throws(() => validateLegacyPoolOverrides(config(role, 'local:config.local.yaml')),
      /roles.remediator: conflicting legacy\/new account policy \(local:config.local.yaml\)/);
    assert.doesNotThrow(() => validateLegacyPoolOverrides(config(role, 'code-default')));
    assert.doesNotThrow(() => validateLegacyPoolOverrides(config('hammer', 'local:config.local.yaml')));
  });
}

for (const [key, value] of [
  ['roles.codex_worker_account_order', 'personal-first'],
  ['roles.remediator', 'codex'],
  ['roles.adversarial.merge_authority.worker_class', 'hammer'],
]) test(`ITP-17 conflicting legacy override refuses with exact path: ${key}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp17-conflict-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1, oauth: {
      token_accounts: accounts, identity_token_pools: {
        hammer: ['corp', 'personal'], 'remediator-codex': ['corp', 'personal'],
      },
    } }));
    const local = {};
    const parts = key.split('.');
    let node = local;
    for (const part of parts.slice(0, -1)) node = node[part] = {};
    node[parts.at(-1)] = value;
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify(local));
    assert.throws(() => resolveIdentityTokenPools({ topPath, modulePaths: [], env: {} }), error =>
      error.message.includes(key) && error.message.includes('local:'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
