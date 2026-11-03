import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSchema, loadConfig } from '../src/config-loader.mjs';

const architectureInputs = [
  {
    thresholds: { scars: 30 }, detectors: [{ id: 'example', kind: 'nxa', path: 'data/example.jsonl', paths: ['modules/example'], consumers: [] }],
  },
  { future_key: true },
  // Python owns threshold validation; this unread namespace cannot gate Node.
  { thresholds: { scars: -1 } },
];

test('ARCH sibling settings are ignored by the Node schema validator', () => {
  for (const architecture_review of architectureInputs) {
    const validated = validateSchema({ version: 1, architecture_review });
    assert.equal(Object.hasOwn(validated, 'architecture_review'), false);
  }
});

test('ARCH sibling settings cannot stop checked-in or local config loads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-config-'));
  try {
    const topPath = join(dir, 'config.yaml');
    for (const layer of ['checked-in', 'local']) {
      for (const architecture_review of architectureInputs) {
        writeFileSync(topPath, JSON.stringify({
          version: 1,
          ...(layer === 'checked-in' ? { architecture_review } : {}),
        }));
        writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify(
          layer === 'local' ? { architecture_review } : {},
        ));
        const cfg = loadConfig({ topPath, env: {} });
        assert.equal(cfg.get('architecture_review'), null);
        assert.equal(cfg.get('architecture_review.thresholds.scars'), null);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
