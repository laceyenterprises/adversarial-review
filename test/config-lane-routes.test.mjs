import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';
import { resolveLaneExecutor } from '../src/config-lane-routes.mjs';
const cases = JSON.parse(readFileSync(new URL('./fixtures/lane-routing/parity.json', import.meta.url)));
for (const c of cases) test(`strict/runtime selector: ${c.name}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'lane-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const topPath = join(root, 'config.yaml');
  const ma = Object.hasOwn(c, 'routes') ? { lane_routes: c.routes } : {};
  const doc = { version: 1, roles: { adversarial: { merge_authority: ma } } };
  writeFileSync(topPath, JSON.stringify(doc));
  for (const load of [loadConfig, loadConfigRuntime]) {
    if (!c.valid) { assert.throws(() => load({ topPath, env: {} }), { name: 'AgentOSConfigError' }); continue; }
    const cfg = load({ topPath, env: {} }).getMergeAuthorityConfig();
    assert.deepEqual(cfg.laneRoutes, (c.routes ?? []).map(r => ({ ...r, repository: r.repository.toLowerCase() })));
    assert.equal(resolveLaneExecutor(cfg.laneRoutes, { repository: 'example/unrelated', base: 'main' }), 'legacy');
    assert.equal(resolveLaneExecutor(cfg.laneRoutes, { repository: 'example/review', base: 'main' }),
      c.routes?.find(r => r.repository.toLowerCase() === 'example/review' && r.base === 'main')?.executor ?? 'legacy');
  }
  if (!c.valid) {
    // Nested records stay strict even in a tolerant host-local layer.
    writeFileSync(topPath, '{"version":1}');
    writeFileSync(join(root, 'config.local.yaml'), JSON.stringify(doc));
    assert.throws(() => loadConfigRuntime({ topPath, env: {} }), { name: 'AgentOSConfigError' });
  }
});
