import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const guard = new URL('./helpers/child-leak-guard.mjs', import.meta.url).pathname;
const fixture = new URL('./fixtures/leaked-child.test.mjs', import.meta.url).pathname;

test('suite guard reports and kills a deliberately leaked process group', () => {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  const result = spawnSync(process.execPath, ['--import', guard, '--test', fixture], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.signal, null, output);
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Leaked test children:/);
  assert.match(output, /deliberately leaked detached child/);
  assert.match(output, /leaked-child\.test\.mjs/);
  const pid = Number(output.match(/LEAKED_FIXTURE_PID=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(pid), output);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
