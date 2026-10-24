import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

function config(value, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'incident-config-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, `version: 1\ndeploy:\n  post_merge_activation:\n    ${value}\n`);
    fn(topPath);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('incident dispatch defaults off and accepts a strict boolean overlay', () => {
  config('{}', topPath => {
    assert.equal(loadConfig({ topPath, env: {} }).get('deploy.post_merge_activation.incident_dispatch'), false);
  });
  for (const value of ['true', 'false']) {
    config(`incident_dispatch: ${value}`, topPath => {
      assert.equal(loadConfig({ topPath, env: {} }).get('deploy.post_merge_activation.incident_dispatch'), value === 'true');
    });
  }
});
for (const value of ['null', '1', '\"true\"', '[]']) {
  test(`incident dispatch rejects ${value}`, () => {
    config(`incident_dispatch: ${value}`, topPath => {
      assert.throws(() => loadConfig({ topPath, env: {} }), AgentOSConfigError);
    });
  });
}
