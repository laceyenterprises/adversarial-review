import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateSchema } from '../src/config-loader.mjs';

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
      ['fallback_path', 'unknown-fallback'], ['fallback_path', true], ['unknown', false],
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

test('packaged Python module mirror preserves strict objects and leaf constraints', () => {
  for (const path of strictObjects({ __keys: mirror })) {
    assert.throws(() => validateSchema({ version: 1, ...nested([...path, 'unknown_field'], true) }),
      { name: 'AgentOSConfigError', key: [...path, 'unknown_field'].join('.') });
  }
  for (const [path, invalid] of [
    [['roles', 'oss-local', 'litellm_base_url'], 1],
    [['worker_pool', 'network_profile', 'mode'], 'unknown-mode'],
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
