import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const guard = new URL('./helpers/child-leak-guard.mjs', import.meta.url).pathname;
const fixture = new URL('./fixtures/leaked-child.test.mjs', import.meta.url).pathname;
const closedFixture = new URL('./fixtures/closed-detached-child.test.mjs', import.meta.url).pathname;
const closedProbeFixture = new URL('./fixtures/closed-group-probe.test.mjs', import.meta.url).pathname;

test('suite guard reports and kills a deliberately leaked process group', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', guard, '--test', fixture], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.signal, null, output);
  assert.notEqual(result.status, 0, output);
  assert.match(output, /Leaked test children:/);
  assert.match(output, /Stop shared children in t\.after\/finally, not a file-level after hook/);
  assert.match(output, /deliberately leaked detached child/);
  assert.match(output, /leaked-child\.test\.mjs/);
  const pid = Number(output.match(/LEAKED_FIXTURE_PID=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(pid), output);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('suite guard forgets a closed detached group before a pgid can be recycled', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', guard, '--test', closedFixture], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('suite guard never probes or signals a closed detached leader', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', guard, '--test', closedProbeFixture], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
