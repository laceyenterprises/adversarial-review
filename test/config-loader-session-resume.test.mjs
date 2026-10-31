// WSRCANARYSCOPE-01: strict schema compatibility for durable resume policy.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';

test('session resume automatic policy defaults off and accepts explicit cells', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-policy-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    let cfg = loadConfig({ topPath, env: {} });
    assert.equal(cfg.get('worker_pool.session_resume.automatic.enabled'), false);
    assert.deepEqual(cfg.get('worker_pool.session_resume.automatic.cells'), []);
    const policy = 'worker_pool:\n  session_resume:\n    automatic:\n      enabled: true\n      cells: [codex:exec:host_shutdown, codex:exec:supervisor_loss]\n';
    for (const local of [false, true]) {
      writeFileSync(topPath, 'version: 1\n' + (local ? '' : policy));
      if (local) writeFileSync(join(dir, 'config.local.yaml'), policy);
      cfg = loadConfig({ topPath, env: {} });
      assert.equal(cfg.get('worker_pool.session_resume.automatic.enabled'), true);
      assert.deepEqual(cfg.get('worker_pool.session_resume.automatic.cells'), ['codex:exec:host_shutdown', 'codex:exec:supervisor_loss']);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('session resume checked-in schema rejects malformed supported leaves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-policy-invalid-'));
  try {
    const topPath = join(dir, 'config.yaml');
    for (const leaf of ['enabled: invalid', 'cells: true', 'cells: [1]']) {
      writeFileSync(topPath, 'version: 1\nworker_pool:\n  session_resume:\n    automatic:\n      ' + leaf + '\n');
      assert.throws(() => loadConfig({ topPath, env: {} }), { name: 'AgentOSConfigError' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('session resume ignores unread policy leaves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-policy-unread-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\nworker_pool:\n  session_resume:\n    automatic:\n      future_example: true\n');
    assert.equal(loadConfig({ topPath, env: {} }).get('worker_pool.session_resume.automatic.future_example'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
