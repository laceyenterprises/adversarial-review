import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../bin/metered-gh.mjs', import.meta.url));

function fixture(t, script) {
  const dir = mkdtempSync(join(tmpdir(), 'metered-gh-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (script !== null) writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  return {
    ...process.env,
    PATH: dir,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json'),
  };
}

for (const code of [0, 7]) {
  test(`exec helper preserves ordinary exit code ${code} and output`, t => {
    const env = fixture(t, `process.stdout.write('fixture output'); process.stderr.write('fixture diagnostic'); process.exit(${code});`);
    const result = spawnSync(process.execPath, [helper, 'exec', 'api', 'fixture'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code);
    assert.equal(result.stdout, 'fixture output');
    assert.equal(result.stderr, 'fixture diagnostic');
  });
}

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGALRM', 142], ['SIGKILL', 137]]) {
  test(`exec helper maps child ${signal} to exit code ${code}`, t => {
    const env = fixture(t, `process.kill(process.pid, '${signal}');`);
    const result = spawnSync(process.execPath, [helper, 'exec', 'api', 'fixture'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code);
    assert.equal(result.signal, null);
  });
}

test('exec helper falls back to 1 for a missing gh executable', t => {
  const env = fixture(t, null);
  const result = spawnSync(process.execPath, [helper, 'exec', 'api', 'fixture'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`exec helper preserves incoming ${signal} while killing its child`, t => {
    const env = fixture(t, `
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.stdout.write(process.pid + '\\n');
process.stderr.write('fixture diagnostic');
setTimeout(() => process.kill(process.ppid, '${signal}'), 50);
setTimeout(() => process.exit(99), 4000);
`);
    const result = spawnSync(process.execPath, [helper, 'exec', 'api', 'fixture'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, 'fixture diagnostic');
    const pid = Number(result.stdout.trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}
