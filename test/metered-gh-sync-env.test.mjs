import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { meteredExecFileSync } from '../src/metered-gh.mjs';
import { GitHubBudgetDeferredError, withGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'metered-sync-env-'));
  const keys = ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR'];
  const previous = keys.map(key => process.env[key]);
  const ambient = join(dir, 'ambient.json');
  const explicit = join(dir, 'explicit.json');
  process.env[keys[0]] = ambient;
  process.env[keys[1]] = '200';
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: explicit, GHO_RATE_LIMIT_THROTTLE_FLOOR: '50' };
  return { dir, ambient, explicit, env };
}

function writeBudget(path, remaining, resetAt = Date.now() + 60_000) {
  writeFileSync(path, JSON.stringify({ version: 1, buckets: { core: {
    resource: 'core', remaining, observedAt: new Date().toISOString(), resetAt: new Date(resetAt).toISOString(),
  } } }));
}

for (const scenario of ['success', 'headers-error', 'headerless-error', 'injected-result']) {
  test(`synchronous ${scenario} records only in the caller's budget store`, t => {
    const { dir, ambient, explicit, env } = fixture(t);
    const limited = scenario.endsWith('error');
    const stderr = scenario === 'headerless-error' ? 'gh: rate limit exceeded\n' :
      `* Request at fixture\n< HTTP/2.0 ${limited ? '429 Too Many Requests' : '200 OK'}\n< X-Ratelimit-Resource: core\n< X-Ratelimit-Remaining: 4900\n< X-Ratelimit-Reset: 4102444800\n* Request took 1ms\n`;
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
process.stdout.write('{}');
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${limited ? 1 : 0});
`, { mode: 0o755 });
    const executor = scenario === 'injected-result' ? () => ({ stdout: '{}', stderr, status: 0 }) : execFileSync;
    const run = () => meteredExecFileSync(executor, 'gh', ['api', 'repos/fixture/repo'], { env, encoding: 'utf8', timeout: 2000 });
    if (limited) assert.throws(run, error => error.rateLimited === true);
    else assert.equal(scenario === 'injected-result' ? run().stdout : run(), '{}');
    const bucket = JSON.parse(readFileSync(explicit, 'utf8')).buckets.core;
    assert.equal(bucket.remaining, limited ? 0 : 4900);
    assert.equal(bucket.rateLimitedCalls || 0, limited ? 1 : 0);
    assert.equal(existsSync(ambient), false, 'record and limited bridges must not write ambient state');
  });
}

test('synchronous admission uses the caller budget path and throttle floor', async t => {
  const { ambient, explicit, env } = fixture(t);
  let calls = 0;
  const run = () => meteredExecFileSync(() => { calls++; return '{}'; }, 'gh', ['api', 'repos/fixture/repo'], { env });
  writeBudget(ambient, 0);
  writeBudget(explicit, 100);
  await withGitHubBudgetScope({}, async scope => {
    assert.equal(run(), '{}', 'explicit floor 50 admits 100 despite ambient floor 200 and exhausted ambient budget');
    assert.equal(scope.deferred, false);
  });
  writeBudget(ambient, 4900);
  writeBudget(explicit, 0);
  await withGitHubBudgetScope({}, async scope => {
    assert.throws(run, GitHubBudgetDeferredError);
    assert.equal(scope.deferred, true);
  });
  assert.equal(calls, 1);
});

test('synchronous wait bridge waits for the caller budget reset', t => {
  const { ambient, explicit, env } = fixture(t);
  const resetAt = Date.now() + 50;
  writeBudget(ambient, 4900);
  writeBudget(explicit, 0, resetAt);
  assert.equal(meteredExecFileSync(() => {
    assert.ok(Date.now() >= resetAt, 'wait must finish before executing gh');
    return '{}';
  }, 'gh', ['api', 'repos/fixture/repo'], { env }), '{}');
  assert.equal(JSON.parse(readFileSync(ambient, 'utf8')).buckets.core.remaining, 4900);
});
