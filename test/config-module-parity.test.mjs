import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateSchema } from '../src/config-loader.mjs';
// ONS-07 retired the packaged Python-module mirror; these keys now come from
// the generated CFG schema like every other one.

function withTop(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'config-module-parity-'));
  const topPath = join(dir, 'config.yaml');
  writeFileSync(topPath, 'version: 1\n');
  try { callback(topPath); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function nested(path, value) {
  return path.reduceRight((body, key) => ({ [key]: body }), value);
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

test('CNS bounded dispatch policy parses with shadow defaults and rejects authority widening', () => {
  withTop((topPath) => {
    const config = loadConfig({ topPath, env: {} });
    assert.equal(config.get('sentinel.cns.auto_dispatch.mode'), 'shadow');
    assert.deepEqual(config.get('sentinel.cns.auto_dispatch.allow_families'), ['closers.*', 'host.leak.*', 'capacity.*']);
    assert.deepEqual(config.get('sentinel.cns.auto_dispatch.deny_families'), []);
    assert.equal(config.get('sentinel.cns.auto_dispatch.minimum_severity'), 'sev2');
    assert.equal(config.get('sentinel.cns.auto_dispatch.worker_class'), 'claude-code');
    assert.equal(config.get('sentinel.cns.auto_dispatch.priority'), 'normal');
    assert.equal(config.get('sentinel.cns.auto_dispatch.hourly_cap'), 6);
    assert.equal(config.get('sentinel.cns.auto_dispatch.daily_token_budget'), 400000);
    assert.equal(config.get('sentinel.cns.auto_dispatch.worker_token_budget'), 150000);
    assert.equal(config.get('sentinel.cns.auto_dispatch.cooldown_seconds'), 3600);
    for (const [key, value] of [['mode', 'invalid'], ['priority', 'critical'], ['worker_class', 'worker']]) {
      assert.throws(() => validateSchema(nested(['sentinel', 'cns', 'auto_dispatch', key], value)));
    }
  });
});

test('closer workspace handoff switch defaults on and accepts an explicit off switch', () => {
  withTop((topPath) => {
    assert.equal(loadConfig({ topPath, env: {} }).get('worker_pool.closer_handoff.enabled'), true);
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  closer_handoff:\n    enabled: false\n');
    assert.equal(loadConfig({ topPath, env: {} }).get('worker_pool.closer_handoff.enabled'), false);
    assert.throws(() => validateSchema({ version: 1, worker_pool: {
      closer_handoff: { enabled: 'yes' },
    } }), { name: 'AgentOSConfigError', key: 'worker_pool.closer_handoff.enabled' });
  });
});
