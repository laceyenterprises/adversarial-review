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
  function execute(_command, _args) {
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

test('GHSCOPE-01: unknown reset uses the bounded default even after a healthy observation', async t => {
  const root = fixture(t);
  let now = Date.now();
  const throttle = createRateLimitThrottle({ sharedStatePath: join(root, 'budget.json'), nowMs: () => now });
  await throttle.recordResponseRateLimit({ resource: 'graphql', credential: 'credential-a', remaining: 4900, resetAt: now + 3600_000 });
  await withGitHubBudgetScope({}, async () => {
    const failure = await throttle.recordRateLimitedCall('graphql', 'credential-a');
    assert.equal(Date.parse(failure.resetAt), now + 60_000);
    await assert.rejects(throttle.awaitThrottleIfNeeded('graphql', 'credential-a'), error => Date.parse(error.observation.resetAt) === now + 60_000);
  });
  const reader = createRateLimitThrottle({ sharedStatePath: join(root, 'budget.json'), nowMs: () => now });
  await withGitHubBudgetScope({ urgent: true }, async () => {
    await assert.rejects(reader.awaitThrottleIfNeeded('graphql', 'credential-a'), error =>
      error.observation.remaining === 0 && Date.parse(error.observation.resetAt) === now + 60_000);
  });
  const resetAt = now + 60_000;
  now += 10_000;
  const repeated = await throttle.recordRateLimitedCall('graphql', 'credential-a');
  assert.equal(Date.parse(repeated.resetAt), resetAt, 'an already exhausted window is reused by the scope');
  const state = await reader.readSharedState();
  assert.equal(Date.parse(state['credential-a/graphql'].resetAt), resetAt);
  assert.equal(state['credential-a/graphql'].rateLimitedCalls, 2);
});

for (const viaResponse of [false, true]) test(`secondary limits override healthy quota across readers, response=${viaResponse}`, async t => {
  const root = fixture(t);
  const sharedStatePath = join(root, 'budget.json');
  let now = Date.parse('2026-10-15T10:00:00Z');
  const sleeps = [];
  const writer = createRateLimitThrottle({ sharedStatePath, nowMs: () => now });
  const reader = createRateLimitThrottle({ sharedStatePath, nowMs: () => now, sleepImpl: async ms => { sleeps.push(ms); } });
  const healthy = { resource: 'graphql', credential: 'credential-a', remaining: 4900, resetAt: now + 3600_000 };
  await writer.recordResponseRateLimit(healthy);
  await reader.readSharedState(); // A long-lived reader has cached the healthy quota.
  const observation = { ...healthy, resetAt: now + 120_000 };
  if (viaResponse) await writer.recordResponseRateLimit({ ...observation, rateLimited: true });
  else await writer.recordRateLimitedCall('graphql', 'credential-a', observation);
  await writer.recordResponseRateLimit(healthy); // A late healthy response cannot clear the hold.
  const state = JSON.parse(readFileSync(sharedStatePath, 'utf8'));
  const bucket = state.buckets['credential-a/graphql'];
  assert.equal(bucket.remaining, 0);
  assert.equal(Date.parse(bucket.resetAt), now + 120_000);
  assert.equal(bucket.rateLimitedCalls, 1);
  await withGitHubBudgetScope({ urgent: true }, async () => {
    await assert.rejects(reader.awaitThrottleIfNeeded('graphql', 'credential-a'), { budgetDeferred: true });
    assert.equal(await reader.awaitThrottleIfNeeded('core', 'credential-a'), false);
    assert.equal(await reader.awaitThrottleIfNeeded('graphql', 'credential-b'), false);
  });
  const fresh = createRateLimitThrottle({ sharedStatePath, nowMs: () => now, sleepImpl: async ms => { sleeps.push(ms); }, recordApiCallImpl: () => {} });
  assert.equal(await fresh.awaitThrottleIfNeeded('graphql', 'credential-a'), true);
  assert.deepEqual(sleeps, [120_000]);
  now += 120_000;
  await withGitHubBudgetScope({}, async () => {
    assert.equal(await reader.awaitThrottleIfNeeded('graphql', 'credential-a'), false);
  });
});

test('secondary-limit extraction overrides positive primary headers and uses Retry-After', () => {
  const observation = extractRateLimitObservation({
    'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': '1792062000', 'retry-after': '120',
  }, { observedAt: '2026-10-15T10:00:00Z', rateLimited: true });
  assert.equal(observation.remaining, 0);
  assert.equal(observation.resetAt, '2026-10-15T10:02:00.000Z');
});

test('a guessed (headerless) window yields to a newer healthy observation; a reported reset does not', async t => {
  const root = fixture(t);
  const sharedStatePath = join(root, 'budget.json');
  const now = Date.now();
  const writer = createRateLimitThrottle({ sharedStatePath, nowMs: () => now });
  const healthy = resource => ({ resource, credential: 'credential-a', remaining: 4900, resetAt: now + 3600_000 });
  const buckets = () => JSON.parse(readFileSync(sharedStatePath, 'utf8')).buckets;
  await writer.recordResponseRateLimit(healthy('graphql'));
  await writer.recordRateLimitedCall('graphql', 'credential-a'); // no headers: the reset is a guess
  await writer.recordRateLimitedCall('core', 'credential-a', { resetAt: now + 120_000 }); // reported reset
  assert.equal(buckets()['credential-a/graphql'].remaining, 0, 'an older healthy reading cannot clear a newer guess');
  assert.equal(buckets()['credential-a/graphql'].resetUnknown, true);
  assert.equal(buckets()['credential-a/core'].resetUnknown, undefined);
  await writer.recordResponseRateLimit(healthy('graphql'));
  await writer.recordResponseRateLimit(healthy('core'));
  assert.equal(buckets()['credential-a/graphql'].remaining, 4900);
  assert.equal(buckets()['credential-a/graphql'].resetUnknown, undefined);
  assert.equal(buckets()['credential-a/core'].remaining, 0);
  const reader = createRateLimitThrottle({ sharedStatePath, nowMs: () => now });
  await withGitHubBudgetScope({ urgent: true }, async () => {
    assert.equal(await reader.awaitThrottleIfNeeded('graphql', 'credential-a'), false);
    await assert.rejects(reader.awaitThrottleIfNeeded('core', 'credential-a'), { budgetDeferred: true });
  });
  // A headerless failure inside a reported window keeps the reported reset.
  await writer.recordRateLimitedCall('core', 'credential-a');
  assert.equal(Date.parse(buckets()['credential-a/core'].resetAt), now + 120_000);
  assert.equal(buckets()['credential-a/core'].resetUnknown, undefined);
});

test('runtime status resolves active credential aliases and retains other observed budgets', async t => {
  const root = fixture(t);
  const sharedStatePath = join(root, 'budget.json');
  const now = Date.now();
  const env = { GH_TOKEN: 'synthetic-active-token', GITHUB_TOKEN: 'synthetic-other-token', GHO_RATE_LIMIT_SHARED_STATE_PATH: sharedStatePath };
  const credential = budgetApi.githubCredential({ env });
  const throttle = createRateLimitThrottle({ sharedStatePath, nowMs: () => now });
  await throttle.recordResponseRateLimit({ resource: 'core', remaining: 123, resetAt: now + 60_000 });
  await throttle.recordResponseRateLimit({ resource: 'core', credential, credentialSelector: 'watcher', remaining: 4900, resetAt: now + 60_000 });
  await throttle.recordRateLimitedCall('graphql', credential);
  await throttle.recordResponseRateLimit({ resource: 'graphql', credential: 'credential-b', remaining: 4000, resetAt: now + 60_000 });
  const status = budgetApi.readGitHubBudgetStatus({ env, nowMs: now });
  assert.equal(status.core.remaining, 4900);
  assert.equal(status.core.credential, credential);
  assert.equal(status.core.credentialSelector, 'watcher');
  assert.deepEqual(status.core, status[`${credential}/core`]);
  assert.equal(status.graphql.remaining, 0);
  assert.equal(status.graphql.rateLimitedCalls, 1);
  assert.equal(Date.parse(status.graphql.resetAt), now + 60_000);
  assert.equal(status['credential-b/graphql'].remaining, 4000);
  const anonymous = budgetApi.readGitHubBudgetStatus({ env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: sharedStatePath }, nowMs: now });
  assert.equal(anonymous.core.remaining, 123);
  assert.equal(anonymous.graphql.remaining, null);
  const expired = budgetApi.readGitHubBudgetStatus({ env, nowMs: now + 60_000 });
  assert.equal(expired.core.remaining, null);
  assert.equal(expired.graphql.remaining, null);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-/);
});

test('GHSCOPE-01: measured budgets remain separate across new scopes and persisted readers', async t => {
  const root = fixture(t);
  const sharedStatePath = join(root, 'budget.json');
  const now = Date.now();
  const throttle = createRateLimitThrottle({ sharedStatePath, nowMs: () => now });
  await throttle.recordResponseRateLimit({ resource: 'graphql', credential: 'credential-a', remaining: 0, resetAt: now + 60_000 });
  await throttle.recordResponseRateLimit({ resource: 'graphql', credential: 'credential-b', remaining: 4900, resetAt: now + 60_000 });
  const reader = createRateLimitThrottle({ sharedStatePath, nowMs: () => now });
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(reader.awaitThrottleIfNeeded('graphql', 'credential-a'), { budgetDeferred: true });
    assert.equal(await reader.awaitThrottleIfNeeded('graphql', 'credential-b'), false);
    assert.equal(await reader.awaitThrottleIfNeeded('core', 'credential-a'), false);
  });
});

test('GHSCOPE-01: adapter subprocess failures carry their selector into the enclosing scope', async () => {
  const { writeAdapterPullRequestLabel } = await import('../src/github-adapter-client.mjs');
  const env = { GHA_ADAPTER_BIN: '/synthetic/github-adapter', WATCHER_GH_AUTH_VIA_BROKER: 'true',
    WATCHER_GH_BROKER_ROLE: 'merge-agent', GITHUB_TOKEN: 'synthetic-adapter-token' };
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(writeAdapterPullRequestLabel('example/alpha', 7, { action: 'remove', labelName: 'fixture-marker' }, {
      env, execFileImpl: async () => { throw Object.assign(new Error('adapter rejected request'), {
        code: 1, stdout: JSON.stringify({ ok: false, failureClass: 'rate_limit', message: 'API rate limit exceeded' }),
      }); },
    }), error => error.rateLimited && Date.parse(error.observation.resetAt) > Date.now());
    let calls = 0;
    const execute = async () => { calls++; return { stdout: '{}', stderr: '' }; };
    await meteredExecFile(execute, 'gh', ['api', 'repos/example/alpha'], { env });
    await meteredExecFile(execute, 'gh', ['api', 'graphql'], { env: { GITHUB_TOKEN: 'synthetic-other-token' } });
    await assert.rejects(meteredExecFile(execute, 'gh', ['api', 'graphql'], { env }), { budgetDeferred: true });
    assert.equal(calls, 2);
    const state = await budgetApi.readGitHubBudgetState();
    const credential = budgetApi.githubCredential({ env });
    assert.equal(state[budgetApi.githubBudgetKey('graphql', credential)].credentialSelector, 'merge-agent');
  });
});

test('GHSCOPE-01: a CLI-only exhausted credential cannot trigger the anonymous watcher shortcut', async t => {
  const { runLowBudgetWatcherPoll } = await import('../src/watcher-github-budget.mjs');
  const root = fixture(t);
  const keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GHO_RATE_LIMIT_SHARED_STATE_PATH'];
  const old = keys.map(key => process.env[key]);
  process.env.GH_TOKEN = 'synthetic-cli-shortcut-token';
  delete process.env.GITHUB_TOKEN;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(root, 'budget.json');
  t.after(() => keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i]; }));
  const credential = budgetApi.githubCredential();
  for (const resource of ['core', 'graphql']) await budgetApi.recordResponseRateLimit({ credential, resource, remaining: 0, resetAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(await runLowBudgetWatcherPoll({ db: { prepare: () => assert.fail('anonymous watcher must keep polling') } }), false);
});

for (const retryAfter of [null, '120']) test(`GHSCOPE-01: a mixed command keeps the failing last response separate, Retry-After=${retryAfter}`, async () => {
  const env = { GH_TOKEN: `synthetic-mixed-${retryAfter || 'unknown'}-token` };
  let calls = 0;
  const now = Date.now();
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(meteredExecFile(async () => {
      throw Object.assign(new Error('GraphQL: API rate limit exceeded'), {
        stderr: `* Request at fixture\n< HTTP/2.0 200 OK\n< X-Ratelimit-Resource: core\n< X-Ratelimit-Remaining: 4900\n< X-Ratelimit-Reset: 4102444800\n* Request took 1ms\n* Request at fixture\n< HTTP/2.0 200 OK\n${retryAfter ? `< Retry-After: ${retryAfter}\n` : ''}* Request took 1ms\n`,
      });
    }, 'gh', ['pr', 'view', '7'], { env }), /rate limit/);
    await meteredExecFile(async () => { calls++; return { stdout: '{}', stderr: '' }; }, 'gh', ['api', 'repos/example/alpha'], { env });
    await assert.rejects(meteredExecFile(async () => assert.fail('limited GraphQL must defer'), 'gh', ['api', 'graphql'], { env }), error => {
      const resetMs = Date.parse(error.observation.resetAt);
      assert.ok(resetMs >= now + Number(retryAfter || 60) * 1000);
      assert.ok(resetMs < now + Number(retryAfter || 60) * 1000 + 5000);
      return error.budgetDeferred;
    });
  });
  assert.equal(calls, 1);
});

test('GHSCOPE-01: a headerless mixed-command REST limit uses the request URL resource', async () => {
  const env = { GH_TOKEN: 'synthetic-rest-trace-token' };
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(meteredExecFile(async () => {
      throw Object.assign(new Error('API rate limit exceeded'), {
        stderr: '* Request at fixture\n* Request to https://api.github.com/repos/example/alpha\n< HTTP/2.0 429\n* Request took 1ms\n',
      });
    }, 'gh', ['pr', 'view', '7'], { env }), /rate limit/);
    await meteredExecFile(async () => ({ stdout: '{}', stderr: '' }), 'gh', ['api', 'graphql'], { env });
    await assert.rejects(meteredExecFile(async () => assert.fail('core must defer'), 'gh', ['api', 'repos/example/alpha'], { env }), { budgetDeferred: true });
  });
});
