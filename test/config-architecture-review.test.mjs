import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSchema, loadConfig } from '../src/config-loader.mjs';
import { extendModuleSchema } from '../src/config-module-schema.mjs';

const mirror = JSON.parse(readFileSync(new URL('../src/python-module-schema.v1.json', import.meta.url), 'utf8'));

test('ARCH mirror carries the Python threshold and registry shapes', () => {
  const schema = extendModuleSchema(undefined, mirror.architecture_review);
  assert.equal(schema.__keys.thresholds.__keys.scars.__default, 30);
  assert.equal(schema.__keys.thresholds.__keys.detector_days.__min, 1);
  assert.deepEqual(schema.__keys.detectors.__item.__keys.kind.__enum, ['nxa', 'sentinel-state']);
  assert.equal(schema.__keys.dark_components.__item.__keys.tables.__type, 'list');
});

test('ARCH remains parse-only and unread fields cannot stop the Node reader', () => {
  const doc = { version: 1, architecture_review: {
    thresholds: { scars: 30 }, detectors: [{ id: 'example', kind: 'nxa', path: 'data/example.jsonl', paths: ['modules/example'], consumers: [] }],
  } };
  assert.doesNotThrow(() => validateSchema(doc));
  assert.doesNotThrow(() => validateSchema({ version: 1, architecture_review: { future_key: true } }));
  assert.throws(() => validateSchema({ version: 1, architecture_review: { thresholds: { scars: -1 } } }), { name: 'AgentOSConfigError' });
  const dir = mkdtempSync(join(tmpdir(), 'arch-config-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify(doc));
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ architecture_review: { future_key: true } }));
    assert.doesNotThrow(() => loadConfig({ topPath, env: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
