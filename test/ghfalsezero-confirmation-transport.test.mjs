import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUnthrottledGitHubRateLimit } from '../src/metered-gh.mjs';
import { createRateLimitThrottle, githubCredential } from '../src/rate-limit-throttle.mjs';

for (const [routing, endpoint] of [
  [{}, 'rate_limit'],
  [{ GH_HOST: 'github.com' }, 'rate_limit'],
  [{ GH_HOST: 'enterprise.example' }, 'https://enterprise.example/api/v3/rate_limit'],
  [{ GH_API_URL: 'https://legacy.example/api/v3/' }, 'https://legacy.example/api/v3/rate_limit'],
  [{ GITHUB_API_URL: 'https://standard.example/api/v3', GH_API_URL: 'https://unused.example' },
    'https://standard.example/api/v3/rate_limit'],
]) {
  for (const status of [200, 403]) test(`confirmation routes ${status} through gh at ${endpoint}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'confirmation-transport-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const reset = Math.ceil(Date.now() / 1000) + 3600;
    const headers = `HTTP/2.0 ${status}\r\nX-Ratelimit-Remaining: 4000\r\nX-Ratelimit-Reset: ${reset}\r\nRetry-After: 300\r\n\r\n`;
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}
      const assert = require('node:assert/strict');
      assert.deepEqual(process.argv.slice(2), ['api', '--method', 'GET', '--include', '-H', 'User-Agent: adversarial-review', ${JSON.stringify(endpoint)}]);
      assert.equal(process.env.HTTPS_PROXY, 'http://proxy.example:8080');
      assert.equal(process.env.GH_TOKEN, 'fixture-token');
      assert.equal(process.env.GH_DEBUG, '');
      process.stdout.write(${JSON.stringify(headers)} + JSON.stringify({ resources: { core: { remaining: 4000, reset: ${reset} } } }));
      process.stderr.write('untrusted diagnostic');
      process.exit(${status === 200 ? 0 : 1});
    `, { mode: 0o700 });
    const read = () => readUnthrottledGitHubRateLimit({ PATH: dir, GH_TOKEN: 'fixture-token',
      GH_DEBUG: 'api', HTTPS_PROXY: 'http://proxy.example:8080', ...routing });
    if (status === 200) assert.equal((await read()).core.remaining, 4000);
    else await assert.rejects(read(), err => err.response?.status === 403
      && err.response.headers['retry-after'] === '300'
      && err.response.headers['x-ratelimit-remaining'] === '4000');
  });
}

test('confirmed budget read passes its configured environment to the live probe', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'confirmation-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const reset = Math.ceil((now + 3600_000) / 1000);
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
    const assert = require('node:assert/strict');
    assert.equal(process.env.GH_TOKEN, 'fixture-budget-token');
    assert.equal(process.env.HTTPS_PROXY, 'http://proxy.example:8080');
    assert.equal(process.env.GH_HOST, 'enterprise.example');
    process.stdout.write('HTTP/2.0 200\\r\\n\\r\\n' + JSON.stringify({ resources: {
      core: { remaining: 4500, limit: 5000, reset: ${reset} }
    } }));
  `, { mode: 0o700 });
  const env = { PATH: dir, GH_TOKEN: 'fixture-budget-token',
    HTTPS_PROXY: 'http://proxy.example:8080', GH_HOST: 'enterprise.example',
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'state.json') };
  const credential = githubCredential({ env });
  const throttle = createRateLimitThrottle({ env });
  await throttle.recordResponseRateLimit({ resource: 'core', credential, remaining: 0,
    limit: 5000, resetAt: reset * 1000, observedAt: now });
  assert.equal((await throttle.readConfirmedBudget('core', credential)).remaining, 4500);
});
