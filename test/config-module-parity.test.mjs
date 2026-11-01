import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateSchema } from '../src/config-loader.mjs';
import { extendModuleSchema } from '../src/config-module-schema.mjs';

const mirror = JSON.parse(readFileSync(new URL('../src/python-module-schema.v1.json', import.meta.url), 'utf8'));

function withTop(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'config-module-parity-'));
  const topPath = join(dir, 'config.yaml');
  writeFileSync(topPath, 'version: 1\n');
  try { callback(topPath); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function nested(path, value) {
  return path.reduceRight((body, key) => ({ [key]: body }), value);
}

function* strictObjects(schema, path = []) {
  if (schema.__strict === true) yield path;
  for (const [key, child] of Object.entries(schema.__keys ?? {})) {
    yield* strictObjects(child, [...path, key]);
  }
}

test('recovery role preserves the owning reader defaults, types and allowlists', () => {
  withTop((topPath) => {
    const defaults = loadConfig({ topPath, env: {} });
    assert.equal(defaults.get('roles.merge_agent_failure_recovery.worker_class'), 'codex');
    assert.equal(defaults.get('roles.merge_agent_failure_recovery.fallback_path'), 'none');
    for (const worker of ['codex', 'codex-corp', 'claude-code']) {
      for (const fallback of ['none', 'litellm-vk', 'litellm-vk-then-deferral']) {
        const modulePath = join(topPath, '..', 'module.yaml');
        writeFileSync(modulePath, JSON.stringify({ roles: {
          merge_agent_failure_recovery: { worker_class: worker, fallback_path: fallback },
        } }));
        const cfg = loadConfig({ topPath, modulePaths: [modulePath], env: {} });
        assert.equal(cfg.get('roles.merge_agent_failure_recovery.worker_class'), worker);
        assert.equal(cfg.get('roles.merge_agent_failure_recovery.fallback_path'), fallback);
      }
    }
    for (const [key, invalid] of [
      ['worker_class', 'unknown-worker'], ['worker_class', 1],
      ['fallback_path', 'unknown-fallback'], ['fallback_path', true],
    ]) {
      assert.throws(() => validateSchema({ version: 1, roles: {
        merge_agent_failure_recovery: { [key]: invalid },
      } }), { name: 'AgentOSConfigError', key: `roles.merge_agent_failure_recovery.${key}` });
    }
    const cfg = loadConfig({ topPath, env: {
      MERGE_AGENT_FAILURE_RECOVERY_WORKER_CLASS: 'codex-corp',
      LITELLM_VK_FALLBACK_FOR_MERGE_AGENT_FAILURE_RECOVERY: 'litellm-vk',
    } });
    assert.equal(cfg.get('roles.merge_agent_failure_recovery.worker_class'), 'codex-corp');
    assert.equal(cfg.get('roles.merge_agent_failure_recovery.fallback_path'), 'litellm-vk');
  });
});

test('packaged compatibility mirror ignores unread fields and preserves leaf constraints', () => {
  for (const path of strictObjects({ __keys: mirror })) {
    const validated = validateSchema({ version: 1, ...nested([...path, 'unknown_field'], true) });
    const parent = path.reduce((doc, key) => doc?.[key], validated);
    assert.equal(parent?.unknown_field, undefined);
  }
  for (const [path, invalid] of [
    [['roles', 'oss-local', 'litellm_base_url'], 1],
    [['worker_pool', 'network_profile', 'default'], 'bogus'],
    [['worker_pool', 'dispatch', 'first_sign_of_life_timeout_seconds'], -1],
  ]) {
    assert.throws(() => validateSchema({ version: 1, ...nested(path, invalid) }),
      { name: 'AgentOSConfigError', key: path.join('.') });
  }
  // Identity defaults remain owned by Python. This parse-only declaration uses
  // an explicitly supplied synthetic value and never embeds a host identity.
  const accepted = validateSchema({ version: 1, session_ledger: {
    node_identity: { canonical_node_id: 'example-node', canonical_hostnames: ['example-host'] },
  } });
  assert.equal(accepted.session_ledger.node_identity.canonical_node_id, 'example-node');
});

const zeroDisableFields = [
  ['worker_pool', 'claude_code', 'bash_timeout_seconds'],
  ['worker_pool', 'dispatch', 'first_sign_of_life_timeout_seconds'],
];

test('zero-disable fields accept zero and their bounds, rejecting the gap below minimum', () => {
  for (const path of zeroDisableFields) {
    const leaf = path.reduce((schema, key) => schema.__keys[key], { __keys: mirror });
    for (const value of [0, leaf.__min, leaf.__max]) {
      const validated = validateSchema({ version: 1, ...nested(path, value) });
      assert.equal(path.reduce((doc, key) => doc[key], validated), value);
    }
    for (const value of [-1, 1, leaf.__min - 1, leaf.__max + 1]) {
      assert.throws(() => validateSchema({ version: 1, ...nested(path, value) }),
        { name: 'AgentOSConfigError', key: path.join('.') });
    }
  }
});

test('mirror maximums follow Python enforcement while minimums are always enforced', () => {
  const path = ['worker_pool', 'policy', 'dedup', 'uncommitted_line_threshold'];
  const accepted = validateSchema({ version: 1, ...nested(path, 2000) });
  assert.equal(accepted.worker_pool.policy.dedup.uncommitted_line_threshold, 2000);
  assert.throws(() => validateSchema({ version: 1, ...nested(path, -1) }),
    { name: 'AgentOSConfigError', key: path.join('.') });
  // Find an explicitly annotated minimum rather than accidentally testing an
  // unknown key, as the former network_profile.mode case did.
  function* annotatedMinimums(schema, path = []) {
    if (schema.__enforce_min && schema.__min !== undefined) yield [path, schema.__min];
    for (const [key, child] of Object.entries(schema.__keys ?? {})) {
      yield* annotatedMinimums(child, [...path, key]);
    }
  }
  const minimums = [...annotatedMinimums({ __keys: mirror })];
  assert.ok(minimums.length > 0);
  for (const [path, minimum] of minimums) {
    assert.doesNotThrow(() => validateSchema({ version: 1, ...nested(path, minimum) }));
    assert.throws(() => validateSchema({ version: 1, ...nested(path, minimum - 1) }),
      { name: 'AgentOSConfigError', key: path.join('.') });
  }
});

test('local override mirror keys retain zero-disable and enum validation', () => {
  withTop((topPath) => {
    const localPath = join(topPath, '..', 'config.local.yaml');
    for (const version of [{}, { version: 1 }]) {
      writeFileSync(localPath, JSON.stringify({ ...version, worker_pool: {
        claude_code: { bash_timeout_seconds: 0 },
        dispatch: { first_sign_of_life_timeout_seconds: 0 },
        network_profile: { default: 'restricted' },
      } }));
      const cfg = loadConfig({ topPath, env: {} });
      for (const path of zeroDisableFields) assert.equal(cfg.get(path.join('.')), 0);
      for (const path of zeroDisableFields) {
        writeFileSync(localPath, JSON.stringify({ ...version, ...nested(path, 1) }));
        assert.throws(() => loadConfig({ topPath, env: {} }),
          { name: 'AgentOSConfigError', key: path.join('.') });
      }
      writeFileSync(localPath, JSON.stringify({ ...version,
        worker_pool: { network_profile: { default: 'bogus' } },
      }));
      assert.throws(() => loadConfig({ topPath, env: {} }),
        { name: 'AgentOSConfigError', key: 'worker_pool.network_profile.default' });
    }
  });
});

test('schema alias layers, getters, traces and CLI writes share the canonical owner', () => {
  withTop((topPath) => {
    const alias = 'worker_pool.merge_agent.failure_recovery_worker_class';
    const canonical = 'roles.merge_agent_failure_recovery.worker_class';
    const modulePath = join(topPath, '..', 'module.yaml');
    const localPath = join(topPath, '..', 'config.local.yaml');
    const aliasDoc = nested(alias.split('.'), 'claude-code');
    const canonicalDoc = nested(canonical.split('.'), 'codex-corp');
    const cases = [
      [topPath, { version: 1, ...aliasDoc }, 'top'],
      [modulePath, aliasDoc, `module:${modulePath}`],
      [localPath, aliasDoc, `local:${localPath}`],
      [localPath, { version: 1, ...aliasDoc }, `local:${localPath}`],
    ];
    for (const [file, doc, source] of cases) {
      writeFileSync(topPath, 'version: 1\n');
      rmSync(modulePath, { force: true });
      rmSync(localPath, { force: true });
      writeFileSync(file, JSON.stringify(doc));
      const options = { topPath, modulePaths: [modulePath], env: {} };
      const cfg = loadConfig(options);
      assert.equal(cfg.get(canonical), 'claude-code');
      assert.equal(cfg.get(alias), 'claude-code');
      assert.deepEqual(cfg.resolutionTrace(alias), cfg.resolutionTrace(canonical));
      assert.equal(cfg.resolutionTrace(alias).at(-1).source, source);
      assert.equal(Object.hasOwn(cfg.values.worker_pool.merge_agent, 'failure_recovery_worker_class'), false);
      const cli = loadConfig({ ...options, cliOverrides: { [alias]: 'codex-corp' } });
      assert.equal(cli.get(canonical), 'codex-corp');
      const env = loadConfig({ ...options, env: { MERGE_AGENT_FAILURE_RECOVERY_WORKER_CLASS: 'codex' } });
      assert.equal(env.get(alias), 'codex');
      writeFileSync(file, JSON.stringify({ ...doc, ...canonicalDoc }));
      assert.throws(() => loadConfig(options),
        { name: 'AgentOSConfigError', key: canonical });
      writeFileSync(file, JSON.stringify({ ...doc,
        ...nested(canonical.split('.'), 'claude-code'),
      }));
      assert.equal(loadConfig(options).get(canonical), 'claude-code');
    }
    writeFileSync(topPath, JSON.stringify({ version: 1, ...canonicalDoc }));
    writeFileSync(localPath, JSON.stringify(aliasDoc));
    assert.equal(loadConfig({ topPath, env: {} }).get(canonical), 'claude-code');
  });
});

test('mirror composition refuses leaf collisions, absent typeless parents and unsupported annotations', () => {
  const dict = (__keys = {}) => ({ __type: 'dict', __strict: true, __keys });
  const nullable = { __type: 'string', __nullable: true, __default: null };
  const extended = extendModuleSchema(dict(), { __keys: { new_leaf: nullable } });
  assert.equal(extended.__keys.new_leaf.__default, null);
  assert.throws(() => extendModuleSchema(dict({ leaf: nullable }), { __keys: { leaf: nullable } }),
    /leaf.*overwrite an existing leaf/);
  assert.throws(() => extendModuleSchema(dict(), { __keys: { missing: { __keys: {} } } }),
    /missing.*missing mirror parent type/);
  assert.throws(() => extendModuleSchema(dict(), { __keys: { missing: dict({ child: { __keys: {} } }) } }),
    /child.*missing mirror parent type/);
  assert.throws(() => extendModuleSchema(dict(), { __keys: { leaf: null } }),
    /leaf.*plain object/);
  assert.throws(() => extendModuleSchema(dict(), { __keys: {
    leaf: { __type: 'int', __future_constraint: true },
  } }), /unsupported mirror annotation __future_constraint/);
  assert.throws(() => extendModuleSchema(dict(), { __keys: {
    leaf: { __type: 'list', __item: { __type: 'string', __future_constraint: true } },
  } }), /unsupported mirror annotation __future_constraint/);
  assert.throws(() => extendModuleSchema(dict(), { __keys: {
    leaf: { __type: 'dict', __extra_keys_schema: { __type: 'int', __future_constraint: true } },
  } }), /unsupported mirror annotation __future_constraint/);
});

test('compiled schema is reused and frozen, with independent mutable defaults per load', () => {
  withTop((topPath) => {
    const first = loadConfig({ topPath, env: {} });
    const second = loadConfig({ topPath, env: {} });
    assert.equal(first.schema, second.schema);
    assert.ok(Object.isFrozen(first.schema));
    const mirrorLeaf = first.schema.__keys.worker_pool.__keys.network_profile.__keys.default;
    assert.ok(Object.isFrozen(mirrorLeaf.__enum));
    assert.throws(() => { mirrorLeaf.__enum.push('bogus'); }, TypeError);
    const defaults = first.get('roles.adversarial.merge_authority.worker_class_fallback');
    defaults.push('test-only');
    assert.equal(second.get('roles.adversarial.merge_authority.worker_class_fallback').includes('test-only'), false);
    const third = loadConfig({ topPath, env: {} });
    assert.equal(third.get('roles.adversarial.merge_authority.worker_class_fallback').includes('test-only'), false);
  });
});
