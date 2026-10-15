import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRateLimitThrottle, withGitHubBudgetScope, extractRateLimitObservation } from '../src/rate-limit-throttle.mjs';
import * as budgetApi from '../src/rate-limit-throttle.mjs';
import { meteredExecFile, meteredExecFileSync } from '../src/metered-gh.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'credential-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('GHSCOPE-01: only the matching credential and resource defer, with a real reset', async t => {
  const root = fixture(t);
  let now = Date.now();
  const throttle = createRateLimitThrottle({ sharedStatePath: join(root, 'budget.json'), nowMs: () => now });
  await withGitHubBudgetScope({}, async () => {
    await throttle.recordRateLimitedCall('graphql', 'credential-a');
    assert.equal(await throttle.awaitThrottleIfNeeded('core', 'credential-a'), false);
    assert.equal(await throttle.awaitThrottleIfNeeded('graphql', 'credential-b'), false);
    await assert.rejects(throttle.awaitThrottleIfNeeded('graphql', 'credential-a'), error => {
      assert.ok(Date.parse(error.observation.resetAt) > now);
      assert.doesNotMatch(error.message, /until null/);
      return error.budgetDeferred;
    });
    now += 61_000;
    assert.equal(await throttle.awaitThrottleIfNeeded('graphql', 'credential-a'), false);
  });
});

for (const sync of [false, true]) test(`GHSCOPE-01: ${sync ? 'sync' : 'async'} gh isolates credentials and records reset headers`, async t => {
  const root = fixture(t);
  const statePath = join(root, 'budget.json');
  const old = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = statePath;
  t.after(() => { if (old === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH; else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = old; });
  const envA = { GH_TOKEN: 'synthetic-token-a', GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath };
  const envB = { ...envA, GH_TOKEN: 'synthetic-token-b' };
  const reset = Math.ceil(Date.now() / 1000) + 120;
  let calls = 0;
  function execute(_command, args) {
    calls++;
    if (calls === 1) throw Object.assign(new Error('GraphQL: API rate limit exceeded'), {
      stderr: `* Request at fixture\n< HTTP/2.0 429\n< X-Ratelimit-Resource: graphql\n< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: ${reset}\n* Request took 1ms\n`,
    });
    return sync ? '{}' : { stdout: '{}', stderr: '' };
  }
  const invoke = (resource, env) => sync
    ? meteredExecFileSync(execute, 'gh', ['api', resource], { env })
    : meteredExecFile(execute, 'gh', ['api', resource], { env });
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(async () => invoke('graphql', envA), /rate limit/);
    await invoke('repos/example/alpha', envA);
    await invoke('graphql', envB);
    await assert.rejects(async () => invoke('graphql', envA), error => error.observation.resetAt === new Date(reset * 1000).toISOString());
  });
  assert.equal(calls, 3);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const bucket = Object.values(state.buckets).find(item => item.resource === 'graphql');
  assert.equal(bucket.credential, budgetApi.githubCredential({ env: envA }));
  assert.doesNotMatch(JSON.stringify(state), /synthetic-token/);
});

test('GHSCOPE-01: retry-after supplies a reset even without primary-budget headers', () => {
  const observation = extractRateLimitObservation({ 'retry-after': '90' }, {
    observedAt: '2026-01-01T00:00:00Z', resource: 'graphql', rateLimited: true,
  });
  assert.equal(observation.resetAt, '2026-01-01T00:01:30.000Z');
  assert.equal(observation.resource, 'graphql');
});
