import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('simple hammer GitHub fixture reads do not initialize native policy stores', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'state.json'), '{}');
  const preload = join(dir, 'reject-native.cjs');
  writeFileSync(preload, 'process.dlopen = () => { throw new Error("unexpected native store initialization"); };\n');
  const result = spawnSync(process.execPath, [
    '--require', preload,
    join(import.meta.dirname, 'fixtures/hammer-self-rebase.mjs'),
    'gh', 'pr', 'view', '--json', 'title',
  ], {
    env: { ...process.env, FIXTURE_DIR: dir, SCENARIO: 'no-op' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), 'Repair synthetic surface');
});
