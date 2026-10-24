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
        assert.equal(cfg.get('osg.sample_rate'), vector.config.sample_rate ?? 0.5);
        assert.equal(cfg.get('osg.policy.enabled'), vector.config.policy?.enabled ?? false);
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
    assert.equal(cfg.get('osg.sample_rate'), 0.5);
    assert.deepEqual(cfg.get('osg.arms'), []);
    assert.equal(cfg.get('osg.policy.enabled'), false);
    assert.deepEqual(cfg.get('osg.double_blind'), {
      enabled: false, window_start: '', window_end: '', sample_rate: 0.05, weekly_cap: 10,
    });
    assert.deepEqual(cfg.get('osg.budget'), {
      monthly_usd: 300, open_model_usd: 200, judge_usd: 70, jev_usd: 30,
      trial_share_pct: 15, double_blind_share_pct: 5,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const layer of ['module', 'local']) {
  for (const subtree of ['osg', 'osg.policy', 'osg.double_blind', 'osg.router']) {
  test(`OSG null ${subtree} subtree rejected in ${layer} layer`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'osg-layer-'));
    try {
      const topPath = join(dir, 'config.yaml');
      const overlay = join(dir, layer === 'module' ? 'module.yaml' : 'config.local.yaml');
      writeFileSync(topPath, JSON.stringify({ version: 1 }));
      writeFileSync(overlay, JSON.stringify({ osg: subtree === 'osg' ? null : { [subtree.split('.')[1]]: null } }));
      assert.throws(() => loadConfig({ topPath, modulePaths: layer === 'module' ? [overlay] : [], env: {} }), error => error.message.includes(`${subtree}: expected mapping`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  }
}
