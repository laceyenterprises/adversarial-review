import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const args of [[], ['--unknown'], ['--json', '--unknown'], ['--json', '--json']]) {
  test(`recovery status CLI rejects ${JSON.stringify(args)} before reading runtime state`, () => {
    const result = spawnSync(process.execPath,
      [new URL('../bin/recovery-status.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8', timeout: 5_000 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: node bin/recovery-status.mjs --json\n');
  });
}
