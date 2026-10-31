import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigRuntime } from '../src/config-loader.mjs';

test('custody compression config mirrors Python and tolerates shared local overlays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-compression-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    for (const loader of [loadConfig, loadConfigRuntime]) {
      const cfg = loader({ topPath, env: {} });
      assert.equal(cfg.get('retention.ephemeral.token_transcripts_compression_enabled'), true);
      assert.equal(cfg.get('retention.ephemeral.token_transcripts_compress_after_days'), 7);
    }
    writeFileSync(join(dir, 'config.local.yaml'), 'retention:\n  ephemeral:\n    token_transcripts_compression_enabled: false\n    token_transcripts_compress_after_days: 21\n    future_overlay_key: true\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('retention.ephemeral.token_transcripts_compression_enabled'), false);
    assert.equal(cfg.get('retention.ephemeral.token_transcripts_compress_after_days'), 21);
    rmSync(join(dir, 'config.local.yaml'));
    writeFileSync(topPath, 'version: 1\nretention:\n  ephemeral:\n    token_transcripts_compress_after_days: 0\n');
    assert.throws(() => loadConfig({ topPath, env: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
