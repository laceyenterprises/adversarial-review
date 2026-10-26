import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOSConfigError, loadConfig, loadConfigRuntime, validateSchema } from '../src/config-loader.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/search-config-cases.json', import.meta.url)));

test('SPE search capability vocabulary overrides and modes cover each provider independently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-capabilities-'));
  const topPath = join(dir, 'config.yaml');
  try {
    writeFileSync(topPath, 'version: 1\n');
    const defaults = loadConfig({ topPath, env: {} });
    for (const provider of Object.keys(fixture.configured.providers)) {
      const server = `search-${provider}`;
      const capability = `search.${provider}`;
      assert.equal(defaults.get(`services.hcp.capability_enforcement.${server}`), 'off');
      assert.ok(defaults.get('services.hcp.capability_vocabulary').includes(capability));
      writeFileSync(topPath, JSON.stringify({ version: 1, services: { hcp: { capability_vocabulary: [capability], capability_enforcement: { [server]: 'enforce' } } } }));
      const cfg = loadConfig({ topPath, env: {} });
      assert.deepEqual(cfg.get('services.hcp.capability_vocabulary'), [capability]);
      assert.equal(cfg.get(`services.hcp.capability_enforcement.${server}`), 'enforce');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
      writeFileSync(topPath, 'version: 1\n');
      writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ services: doc.services }));
      for (const load of [() => loadConfig({ topPath, env: {} }), () => loadConfigRuntime({ topPath, env: {} })]) {
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

for (const versioned of [false, true]) {
  for (const load of [loadConfig, loadConfigRuntime]) {
    test(`SPE limits replace inherited declarations (${load.name}, versioned local: ${versioned})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'search-replacement-'));
      const topPath = join(dir, 'config.yaml');
      const localPath = join(dir, 'config.local.yaml');
      const limitsPath = 'services.hcp.search.providers.brave.operation_limits';
      const baseLimits = fixture.configured.providers.brave.operation_limits;
      const replacements = [
        { allowed_operations: ['web_search'], operation_limits: { web_search: baseLimits.web_search } },
        { enabled: false, allowed_operations: [], operation_limits: {} },
        {
          allowed_operations: ['brave.image_search'],
          operation_limits: {
            'brave.image_search': { max_duration_seconds: 60, max_charge_usd: '0.50', currency: 'USD', pricing_provenance: 'replacement fixture' },
          },
        },
      ];
      try {
        writeFileSync(topPath, JSON.stringify({ version: 1, services: { hcp: { search: fixture.configured } } }));
        for (const replacement of replacements) {
          writeFileSync(localPath, JSON.stringify({ ...(versioned ? { version: 1 } : {}), services: { hcp: { search: { providers: { brave: replacement } } } } }));
          const cfg = load({ topPath, env: {} });
          assert.deepEqual(cfg.get(limitsPath), replacement.operation_limits);
          assert.deepEqual(cfg.get('services.hcp.search.providers.brave.allowed_operations'), replacement.allowed_operations);
          assert.deepEqual(cfg.resolutionTrace(limitsPath), [
            { source: 'code-default', value: {}, path: null },
            { source: 'top', value: baseLimits, path: topPath },
            { source: `local:${localPath}`, value: replacement.operation_limits, path: localPath },
          ]);
          assert.equal(cfg.sources[limitsPath], `local:${localPath}`);
          assert.ok(!Object.keys(cfg.sources).some(key => key.startsWith(`${limitsPath}.`)));
          assert.deepEqual(cfg.get('services.hcp.search.providers.exa.operation_limits'), fixture.configured.providers.exa.operation_limits);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

for (const item of fixture.cases.filter(item => item.name.startsWith('metadata-prefix-unknown'))) {
  test(`SPE versionless local rejects ${item.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-local-metadata-'));
    const topPath = join(dir, 'config.yaml');
    try {
      writeFileSync(topPath, 'version: 1\n');
      writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ services: { hcp: { search: expand(item) } } }));
      for (const load of [loadConfig, loadConfigRuntime]) {
        assert.throws(() => load({ topPath, env: {} }), AgentOSConfigError);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('SPE excludes Exa KB PAT spellings from every search credential field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-credential-exclusion-'));
  const topPath = join(dir, 'config.yaml');
  try {
    for (const provider of Object.keys(fixture.configured.providers)) {
      for (const field of provider === 'brave' ? ['credential_ref', 'answers_credential_ref'] : ['credential_ref']) {
        for (const item of ['Exa KB PAT', 'exa kb pat', 'EXA   KB\tPAT']) {
          const doc = { version: 1, services: { hcp: { search: { providers: { [provider]: { [field]: `op://test-vault/${item}/credential` } } } } } };
          writeFileSync(topPath, JSON.stringify(doc));
          for (const load of [() => validateSchema(doc), () => loadConfig({ topPath, env: {} }), () => loadConfigRuntime({ topPath, env: {} })]) {
            assert.throws(load, AgentOSConfigError, `${provider}.${field}: ${item}`);
          }
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
