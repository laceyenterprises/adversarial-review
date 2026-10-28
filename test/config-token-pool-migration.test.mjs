import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOSConfigError, loadConfig } from '../src/config-loader.mjs';
import { PoolConfigConflictError, inspectLegacyPoolOverrides, legacyPoolOverrideConflicts,
  resetLegacyPoolOverrideWarnings, validateLegacyPoolOverrides, warnPoolConfigRedundancies } from '../src/config-token-pool-migration.mjs';
import { resolveIdentityTokenPools, validateStartupRoleConfig } from '../src/role-config.mjs';
import { poolConflictFixture } from './helpers/pool-conflict-fixture.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const accounts = {
  corp: { family: 'codex', broker_provider: 'codex-corp', allowed_models: ['gpt-6'], concurrency: 1 },
  personal: { family: 'codex', broker_provider: 'codex', allowed_models: ['gpt-6'], concurrency: 1 },
};

afterEach(resetLegacyPoolOverrideWarnings);

const selectorCases = JSON.parse(readFileSync(new URL('./fixtures/pool-role-selector-cases.v1.json', import.meta.url)));
for (const fixture of selectorCases.cases) {
  test(`ITPROLEPOOL-01 shared selector contract: ${fixture.name}`, t => {
    const messages = [];
    t.mock.method(console, 'warn', () => assert.fail('inspection must not warn'));
    const values = { ...fixture.values, 'oauth.identity_token_pools': fixture.pools,
      'oauth.token_accounts': selectorCases.accounts };
    const cfg = { get: (key, fallback) => values[key] ?? fallback,
      resolutionTrace: key => Object.hasOwn(fixture.values, key) ? [{ source: fixture.source }] : [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(legacyPoolOverrideConflicts(cfg), fixture.conflicts);
      const result = inspectLegacyPoolOverrides(cfg);
      assert.deepEqual(result, { conflicts: fixture.conflicts, redundant: fixture.warnings });
      warnPoolConfigRedundancies(result.redundant, message => messages.push(message));
    }
    assert.deepEqual(messages, fixture.warnings.map(key => `pool-config-redundant: ${key}; declared pools own account order`));
  });
}

test('redundancy logging is injectable in validation and startup, with an explicit reset', t => {
  t.mock.method(console, 'warn', () => assert.fail('must use the injected logger'));
  const values = { 'oauth.identity_token_pools': { codex: ['personal', 'corp'] },
    'oauth.token_accounts': accounts, 'roles.codex_worker_account_order': 'personal-first' };
  const cfg = { get: key => values[key], resolutionTrace: () => [{ source: 'fixture' }] };
  const messages = [];
  const warn = message => messages.push(message);
  for (let attempt = 0; attempt < 2; attempt++) validateLegacyPoolOverrides(cfg, warn);
  const warning = 'pool-config-redundant: roles.codex_worker_account_order; declared pools own account order';
  assert.deepEqual(messages, [warning]);
  resetLegacyPoolOverrideWarnings();
  assert.deepEqual(validateStartupRoleConfig({ loaderImpl: () => cfg, env: {}, warn }), { warnings: [] });
  assert.deepEqual(messages, [warning, warning]);
});

for (const [name, tokenAccounts, members] of [
  ['missing accounts', undefined, ['missing']],
  ['null accounts', null, ['missing']],
  ['missing entry', {}, ['missing']],
  ['null entry', { missing: null }, ['missing']],
  ['missing provider', { missing: {} }, ['missing']],
  ['unknown provider', { missing: { broker_provider: 'other' } }, ['missing']],
  ['partially resolved', accounts, ['personal', 'missing']],
  ['null membership', accounts, null],
  ['non-array membership', accounts, 'personal'],
  ['empty membership', accounts, []],
]) {
  for (const setting of ['personal-first', 'corporate-first']) {
    test(`unresolvable pool order is a structured conflict: ${name}, ${setting}`, t => {
      t.mock.method(console, 'warn', () => assert.fail('invalid declarations must not warn as redundant'));
      const key = 'roles.codex_worker_account_order';
      const values = { 'oauth.identity_token_pools': { codex: members },
        'oauth.token_accounts': tokenAccounts, [key]: setting };
      const cfg = { get: (path, fallback) => Object.hasOwn(values, path) ? values[path] : fallback,
        resolutionTrace: () => [{ source: 'fixture' }] };
      assert.deepEqual(inspectLegacyPoolOverrides(cfg), { conflicts: [key], redundant: [] });
      assert.deepEqual(legacyPoolOverrideConflicts(cfg), [key]);
      assert.throws(() => validateLegacyPoolOverrides(cfg), error =>
        error instanceof PoolConfigConflictError && error.key === key);
    });
  }
}

test('ITPROLEPOOL-01 all four Codex pools resolve with canonical selectors from every layer', () => {
  for (const source of ['top', 'local', 'env']) {
    const dir = mkdtempSync(join(tmpdir(), 'role-pools-'));
    try {
      const topPath = join(dir, 'config.yaml');
      const pools = Object.fromEntries(['codex', 'codex-reviewer', 'hammer', 'remediator-codex'].map(role => [role, ['personal', 'corp']]));
      const roles = { remediator: 'codex', build_pack_default_worker_class: 'codex',
        merge_agent_worker_class: 'hammer', adversarial: { merge_authority: { worker_class: 'hammer' } } };
      writeFileSync(topPath, JSON.stringify({ version: 1, oauth: { token_accounts: accounts, identity_token_pools: pools },
        ...(source === 'top' ? { roles } : {}) }));
      if (source === 'local') writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ roles }));
      const env = source === 'env' ? {
        AGENT_OS_ROLES_REMEDIATOR: 'codex', AGENT_OS_ROLES_BUILD_PACK_DEFAULT_WORKER_CLASS: 'codex',
        AGENT_OS_ROLES_MERGE_AGENT_WORKER_CLASS: 'hammer', AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_WORKER_CLASS: 'hammer',
      } : {};
      const options = { topPath, modulePaths: [], env };
      assert.equal(resolveIdentityTokenPools(options).identity_token_pools.hammer[0], 'personal');
      assert.deepEqual(legacyPoolOverrideConflicts(loadConfig(options)), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

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
  ['codex-corp', 'remediator-codex'],
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
  ['roles.build_pack_default_worker_class', 'codex-corp'],
  ['roles.adversarial.merge_authority.worker_class', 'hammer-corp'],
]) test(`ITP-17 conflicting legacy override refuses with exact path: ${key}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp17-conflict-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1, oauth: {
      token_accounts: accounts, identity_token_pools: {
        codex: ['corp', 'personal'], hammer: ['corp', 'personal'], 'remediator-codex': ['corp', 'personal'],
      },
    } }));
    const local = {};
    const parts = key.split('.');
    let node = local;
    for (const part of parts.slice(0, -1)) node = node[part] = {};
    node[parts.at(-1)] = value;
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify(local));
    assert.throws(() => resolveIdentityTokenPools({ topPath, modulePaths: [], env: {} }), error => {
      assert.ok(error instanceof PoolConfigConflictError);
      assert.equal(error.key, key);
      assert.ok(error.message.includes(key) && error.message.includes('local:'));
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
