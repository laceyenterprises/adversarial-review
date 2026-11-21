import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSchema, loadConfig } from '../src/config-loader.mjs';

// ONS-07: architecture_review validates against the generated CFG schema.
// Expected verdicts were recorded from the Python loader (one-schema@6ab5e7ac02db).
const accepted = {
  thresholds: { scars: 30 },
  detectors: [{ id: 'example', kind: 'nxa', path: 'data/example.jsonl', paths: ['modules/example'], consumers: [] }],
};
const refused = [
  [{ future_key: true }, /architecture_review\.future_key: unknown key \(strict schema\)/],
  [{ thresholds: { scars: -1 } }, /architecture_review\.thresholds\.scars: expected >= 0, got -1/],
];

test('ARCH settings validate like the Python loader', () => {
  assert.deepEqual(validateSchema({ version: 1, architecture_review: accepted }).architecture_review, accepted);
  for (const [architecture_review, error] of refused) {
    assert.throws(() => validateSchema({ version: 1, architecture_review }), error);
  }
});

test('ARCH settings load from checked-in and local layers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-config-'));
  try {
    const topPath = join(dir, 'config.yaml');
    for (const layer of ['checked-in', 'local']) {
      writeFileSync(topPath, JSON.stringify({ version: 1, ...(layer === 'checked-in' ? { architecture_review: accepted } : {}) }));
      writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify(layer === 'local' ? { architecture_review: accepted } : {}));
      assert.equal(loadConfig({ topPath, env: {} }).get('architecture_review.thresholds.scars'), 30);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
