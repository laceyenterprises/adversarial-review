import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';

test('credential flags default safely and accept sibling overlay keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-flags-'));
  try {
    const path = join(dir, 'config.yaml');
    writeFileSync(path, 'version: 1\n');
    let cfg = loadConfig({ topPath: path, env: {} });
    assert.equal(cfg.get('credentials.enforcement'), 'observe');
    assert.equal(cfg.get('credentials.model_broker.enforcement'), 'observe');
    assert.equal(cfg.get('credentials.cloud.enabled'), false);
    writeFileSync(join(dir, 'config.local.yaml'), 'credentials:\n  future: true\n  enforcement: enforce\n  cloud:\n    future: true\n');
    cfg = loadConfig({ topPath: path, env: {} });
    assert.equal(cfg.get('credentials.enforcement'), 'enforce');
    assert.equal(cfg.get('credentials.cloud.enabled'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
