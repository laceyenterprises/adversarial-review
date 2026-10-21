import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/osg-config.v1.json', import.meta.url)));
for (const vector of vectors.cases) {
  test(`OSG-01 strict loader: ${vector.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'osg-config-'));
    try {
      const topPath = join(dir, 'config.yaml');
      writeFileSync(topPath, JSON.stringify({ version: 1, osg: vector.config }));
      if (vector.valid) {
        const cfg = loadConfig({ topPath, env: {} });
        assert.equal(cfg.get('osg.mode'), vector.config.mode ?? 'off');
      } else {
        assert.throws(() => loadConfig({ topPath, env: {} }));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test('OSG-01 defaults are inert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osg-default-'));
  try {
    const cfg = loadConfig({ topPath: join(dir, 'config.yaml'), env: {} });
    assert.equal(cfg.get('osg.mode'), 'off');
    assert.deepEqual(cfg.get('osg.arms'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const layer of ['module', 'local']) {
  test(`OSG-01 null subtree rejected in ${layer} layer`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'osg-layer-'));
    try {
      const topPath = join(dir, 'config.yaml');
      const overlay = join(dir, layer === 'module' ? 'module.yaml' : 'config.local.yaml');
      writeFileSync(topPath, JSON.stringify({ version: 1 }));
      writeFileSync(overlay, JSON.stringify({ osg: null }));
      assert.throws(() => loadConfig({ topPath, modulePaths: layer === 'module' ? [overlay] : [], env: {} }), /osg: expected mapping/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
