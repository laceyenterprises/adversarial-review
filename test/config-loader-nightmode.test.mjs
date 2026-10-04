import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';

test('NIGHTMODE-01 strict loader accepts schedule and CPU admission configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightmode-cfg-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  dispatch:\n    night_mode: normal\n    schedule_windows:\n      "22-7": hot\n    resource_admission:\n      min_cpu_idle_percent: 20.0\n      safety_load_per_core: 32.0\n');
    const cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('worker_pool.dispatch.night_mode'), 'normal');
    assert.deepEqual(cfg.get('worker_pool.dispatch.schedule_windows'), { '22-7': 'hot' });
    assert.equal(cfg.get('worker_pool.dispatch.resource_admission.min_cpu_idle_percent'), 20.0);
    assert.equal(cfg.get('worker_pool.dispatch.resource_admission.safety_load_per_core'), 32.0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
