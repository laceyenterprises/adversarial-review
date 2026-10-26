import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOSConfigError, loadConfig, loadConfigRuntime, validateSchema } from '../src/config-loader.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/search-config-cases.json', import.meta.url)));
function expand(item) {
  const search = structuredClone(item.base ? fixture[item.base] : item.search);
  for (const patch of item.patches ?? []) {
    const parent = patch.path.slice(0, -1).reduce((o, k) => o[k], search);
    if (patch.delete) delete parent[patch.path.at(-1)];
    else parent[patch.path.at(-1)] = patch.value;
  }
  return search;
}

for (const item of fixture.cases) {
  test(`SPE search policy: ${item.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-schema-'));
    const topPath = join(dir, 'config.yaml');
    try {
      const doc = { version: 1, services: { hcp: { search: expand(item) } } };
      writeFileSync(topPath, JSON.stringify(doc));
      for (const load of [() => validateSchema(doc), () => loadConfig({ topPath, env: {} }), () => loadConfigRuntime({ topPath, env: {} })]) {
        if (item.valid) load();
        else assert.throws(load, AgentOSConfigError);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('SPE defaults and overlay retain dotted operation IDs as atomic declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-overlay-'));
  const topPath = join(dir, 'config.yaml');
  try {
    writeFileSync(topPath, 'version: 1\n');
    const defaults = loadConfig({ topPath, env: {} }).get('services.hcp.search');
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.run_budget_usd, '0.00');
    assert.equal(Object.keys(defaults.providers).length, 6);
    for (const entry of Object.values(defaults.providers)) {
      assert.deepEqual(entry, { enabled: false, presentation: 'abstracted', budget_usd: '0.00', budget_window_seconds: 86400, allowed_operations: [], operation_limits: {} });
    }
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ services: { hcp: { search: fixture.configured } } }));
    assert.deepEqual(loadConfig({ topPath, env: {} }).get('services.hcp.search'), fixture.configured);
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ services: { hcp: { search: { upstream_url: 'https://example.invalid/' } } } }));
    assert.throws(() => loadConfigRuntime({ topPath, env: {} }), AgentOSConfigError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
