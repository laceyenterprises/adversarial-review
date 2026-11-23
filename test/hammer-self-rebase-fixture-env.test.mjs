import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/hammer-self-rebase-gh.sh', import.meta.url));

for (const missing of [['SCENARIO'], ['FIXTURE_DIR'], ['SCENARIO', 'FIXTURE_DIR']]) {
  test(`Hammer fixture delegates when ${missing.join(' and ')} is absent`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'hammer-fixture-env-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const helper = join(dir, 'fallback.cjs');
    writeFileSync(helper, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const env = { ...process.env, REAL_NODE: process.execPath, FIXTURE_HELPER: helper,
      SCENARIO: 'ordinary', FIXTURE_DIR: dir };
    for (const key of missing) delete env[key];
    const args = ['pr', 'view', '--json', 'body'];
    const output = execFileSync('/bin/bash', [fixture, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.deepEqual(JSON.parse(output), ['gh', ...args]);
  });
}
