import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateSchema } from '../src/config-loader.mjs';

test('public hygiene accepts empty and populated policy without host defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    assert.deepEqual(loadConfig({ topPath, env: {} }).get('worker_pool.public_hygiene'), { repos: [], identities: {} });
    const denylistPath = join(dir, 'private-rules');
    writeFileSync(denylistPath, 'literal:invented-fixture\n');
    const policy = { repos: ['fixture-org/public-repo'], identities: { codex: { name: 'Fixture Bot', email: 'fixture@example.invalid' } }, denylist_path: denylistPath };
    writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: policy } }));
    assert.deepEqual(loadConfig({ topPath, env: {} }).get('worker_pool.public_hygiene'), policy);
    for (const invalid of [
      { ...policy, extra: true },
      { ...policy, denylist_path: null },
      { ...policy, denylist_path: 'relative' },
      { ...policy, denylist_path: join(dir, 'absent') },
      { ...policy, identities: { codex: { name: 'bad|fixture', email: 'fixture@example.invalid' } } },
      { ...policy, identities: { codex: { name: 'Fixture' } } },
      { ...policy, identities: { codex: { name: 'Fixture', email: 'fixture@example.invalid', extra: true } } },
    ]) {
      assert.throws(() => validateSchema({ version: 1, worker_pool: { public_hygiene: invalid } }));
      writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: invalid } }));
      assert.throws(() => loadConfig({ topPath, env: {} }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cached policy refuses after private denylist removal', async () => {
  const { loadConfigCached, resetConfigCache } = await import('../src/config-loader.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-cache-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const denylistPath = join(dir, 'private-rules');
    writeFileSync(denylistPath, 'literal:invented-fixture\n');
    writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: { repos: ['fixture-org/public-repo'], denylist_path: denylistPath } } }));
    loadConfigCached({ topPath, env: {} });
    rmSync(denylistPath);
    assert.throws(() => loadConfigCached({ topPath, env: {} }));
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
