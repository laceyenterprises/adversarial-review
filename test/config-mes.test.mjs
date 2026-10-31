import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/mes-config.v1.json', import.meta.url)));
for (const vector of vectors.cases) {
  test(`MES-01 Node reader: ${vector.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mes-config-'));
    try {
      const topPath = join(dir, 'config.yaml');
      writeFileSync(topPath, JSON.stringify({ version: 1, mes: vector.config }));
      // Shared vectors describe the full owner schema; unread fields are
      // outside this reader's validation surface (CFGREADERSCOPE-01).
      if (vector.valid || vector.name === 'unknown-key') {
        const cfg = loadConfig({ topPath, env: {} });
        if (vector.name === 'unknown-key') assert.equal(cfg.get('mes.typo'), null);
        const expected = { ...vectors.defaults };
        if (vector.key) expected[vector.key] = vector.expected;
        for (const [key, value] of Object.entries(expected)) {
          assert.deepEqual(cfg.get(`mes.${key}`), value, key);
        }
      } else {
        assert.throws(() => loadConfig({ topPath, env: {} }));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('MES-01 host overlay replaces the fragment reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mes-overlay-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1 }));
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ mes: { tier_policy: 'fixture/policy.json' } }));
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('mes.tier_policy'), 'fixture/policy.json');
    assert.equal(cfg.get('mes.mode'), 'shadow');
    assert.equal(cfg.get('mes.enforce.build'), false);
    assert.equal(cfg.get('mes.kill_switch'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
