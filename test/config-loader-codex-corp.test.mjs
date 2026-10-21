import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { AgentOSConfigError, loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

const dispatchClasses = ['codex', 'codex-corp', 'claude-code', 'merge-agent', 'reviewer'];
// Only leaves already mirrored by this reader: failure-recovery roles and
// worker_pool.merge_agent sub-roles remain owned by the host's loaders.
const leaves = [
  ['roles.build_pack_default_worker_class', ['plan', 'codex', 'codex-corp', 'claude-code'], 'codex'],
  ['worker_pool.post_merge_actions.rca_worker_class', dispatchClasses, 'codex'],
  ...[
    'coding', 'research', 'drafting', 'analysis', 'other', 'merge',
    'merge_conflict_resolution', 'merge_comment_only_followups', 'merge_agent_failure_recovery',
  ].map(kind => [
    `dispatch.default_worker_class_by_task_kind.${kind}`,
    dispatchClasses,
    ['merge', 'merge_conflict_resolution', 'merge_comment_only_followups'].includes(kind) ? 'merge-agent' : 'codex',
  ]),
];

function yamlFor(key, value) {
  return dump({ version: 1, ...key.split('.').reduceRight((child, part) => ({ [part]: child }), value) });
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'config-codex-corp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = join(dir, 'config.yaml');
  writeFileSync(topPath, 'version: 1\n');
  return { topPath, localPath: join(dir, 'config.local.yaml') };
}

for (const [key, allowed, defaultClass] of leaves) {
  const envName = `AGENT_OS_${key.replaceAll('.', '_').toUpperCase()}`;

  test(`${key} retains its default and matches the shared allowed classes`, t => {
    const { topPath } = fixture(t);
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get(key), defaultClass);
    const leaf = key.split('.').reduce((schema, part) => schema.__keys[part], cfg.schema);
    assert.deepEqual(leaf.__enum, allowed);
  });

  test(`${key} accepts allowed classes from strict YAML`, t => {
    const { topPath } = fixture(t);
    for (const workerClass of allowed) {
      writeFileSync(topPath, yamlFor(key, workerClass));
      assert.equal(loadConfig({ topPath, env: {}, tolerateUnknown: false }).get(key), workerClass);
    }
  });

  test(`${key} accepts corporate Codex from local YAML at watcher startup`, t => {
    const { topPath, localPath } = fixture(t);
    writeFileSync(localPath, yamlFor(key, 'codex-corp'));
    assert.equal(loadConfigRuntime({ topPath, env: {} }).get(key), 'codex-corp');
  });

  test(`${key} accepts allowed classes from env over YAML`, t => {
    const { topPath } = fixture(t);
    writeFileSync(topPath, yamlFor(key, 'claude-code'));
    for (const workerClass of allowed) {
      const cfg = loadConfig({ topPath, env: { [envName]: workerClass } });
      assert.equal(cfg.get(key), workerClass);
      assert.equal(cfg.resolutionTrace(key).at(-1).source, `env:${envName}`);
    }
  });

  for (const source of ['YAML', 'env']) {
    test(`${key} rejects unknown classes from ${source} in strict and runtime loaders`, t => {
      const { topPath } = fixture(t);
      const unknown = 'unknown-worker';
      const env = source === 'env' ? { [envName]: unknown } : {};
      if (source === 'YAML') writeFileSync(topPath, yamlFor(key, unknown));
      for (const load of [loadConfig, loadConfigRuntime]) {
        assert.throws(() => load({ topPath, env }), error => {
          assert.ok(error instanceof AgentOSConfigError);
          assert.equal(error.key, key);
          assert.equal(error.got, unknown);
          return true;
        });
      }
    });
  }
}
