import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRateLimitThrottle, isGitHubRateLimitError, rateLimitErrorObservation,
  withGitHubBudgetScope, githubCredential, extractRateLimitObservation, rateLimitConfirmation } from '../src/rate-limit-throttle.mjs';
import { meteredExecFile, parseGhDebug } from '../src/metered-gh.mjs';
import { createWatcherOctokit, fetchConditionalRestPage } from '../src/conditional-request.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'falsezero-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const telemetry = [], sleeps = [];
  const throttle = createRateLimitThrottle({ env: {}, sharedStatePath: join(dir, 'state.json'),
    nowMs: () => now, sleepImpl: async ms => { sleeps.push(ms); now += ms; },
    recordApiCallImpl: row => telemetry.push(row), ...options });
  return { throttle, telemetry, sleeps, dir, now: () => now, advance: ms => { now += ms; } };
}

for (const status of [401, 404, 500]) {
  test(`${status} with rate-limit prose in every output field never becomes a limit`, async t => {
    const f = fixture(t);
    const error = Object.assign(new Error('Command failed: gh pr diff: rate limit'), {
      status, stderr: 'gh: Not Found (HTTP 404) rate limit', stdout: '+ rate limit\n',
      response: { status, headers: { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.ceil(f.now() / 1000) + 3600) },
        data: { message: 'rate limit', body: 'rate limit', documentation_url: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit' } },
    });
    assert.equal(isGitHubRateLimitError(error), false);
    assert.equal(rateLimitErrorObservation(error), null);
    const previous = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(f.dir, 'cli.json');
    t.after(() => { if (previous === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH; else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previous; });
    await assert.rejects(meteredExecFile(async () => { throw error; }, 'gh', ['pr', 'diff', '1'], { env: {} }), e => e === error);
    assert.equal(error.rateLimited, undefined);
    assert.deepEqual(await f.throttle.readSharedState(), {});
  });
}

test('status and parsed API error evidence classify; arbitrary diagnostics do not', () => {
  assert.equal(isGitHubRateLimitError({ rateLimited: true, message: 'HTTP 429 rate limit' }), false);
  assert.equal(isGitHubRateLimitError({ status: 403, response: { data: { message: 'rate limit' } } }), false);
  assert.equal(isGitHubRateLimitError({ status: 403, response: { data: { message: 'You have exceeded a secondary rate limit.' } } }), true);
  assert.equal(isGitHubRateLimitError({ status: 429 }), true);
  assert.equal(isGitHubRateLimitError({ status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } }), true);
});

test('gh stderr error records classify without trusting content or debug bodies', () => {
  for (const stderr of [
    'gh: HTTP 403: API rate limit exceeded (https://api.github.com/repos/example/widget)',
    'HTTP 429: Too Many Requests (https://api.github.com/graphql)',
    'gh: You have exceeded a secondary rate limit. (HTTP 403)',
    'GraphQL: API rate limit exceeded for fixture. (rateLimit)',
    'GraphQL: API rate limit exceeded for user ID 123. (rateLimit)',
    'github-rate-limit: deferred',
  ]) {
    assert.equal(isGitHubRateLimitError({ stderr }), true, stderr);
    assert.equal(rateLimitErrorObservation({ stderr }).remaining, null);
    assert.equal(isGitHubRateLimitError({ stdout: stderr, message: stderr }), false);
    assert.equal(isGitHubRateLimitError({ stderr: `diff: ${stderr}` }), false);
    assert.equal(isGitHubRateLimitError({ stderr: `* Request at fixture\n< HTTP/2 200\n\n${stderr}\n* Request took 1ms` }), false);
  }
});

test('execFile maxBuffer rejection with huge content never establishes quota evidence', async t => {
  const f = fixture(t);
  const previous = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(f.dir, 'overflow.json');
  t.after(() => {
    if (previous === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previous;
  });
  const error = Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    stdout: '+ API rate limit exceeded\n'.repeat(100_000),
    stderr: '* Request at fixture\n< HTTP/2 429\n< retry-after: 60\n\n* Request took 1ms\nAPI rate limit exceeded',
  });
  assert.equal(isGitHubRateLimitError(error), false);
  assert.equal(rateLimitErrorObservation(error), null);
  await assert.rejects(meteredExecFile(async () => { throw error; }, 'gh', ['pr', 'diff', '1'], { env: {} }), e => e === error);
  assert.equal(error.rateLimited, undefined);
  assert.deepEqual(await f.throttle.readSharedState(), {});
});

test('secondary 403 keeps 4000 primary requests and holds only for retry-after', async t => {
  const f = fixture(t);
  const observation = rateLimitErrorObservation({ status: 403, response: { headers: {
    'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5400', 'x-ratelimit-used': '1400',
    'x-ratelimit-reset': String(Math.ceil(f.now() / 1000) + 3600), 'x-ratelimit-resource': 'core', 'retry-after': '60',
  } } }, { observedAt: f.now(), requestCategory: 'pr_diff', consumer: 'reviewer' });
  await f.throttle.recordRateLimitedCall('core', 'reviewer', observation);
  const state = (await f.throttle.readSharedState())['reviewer/core'];
  assert.equal(state.remaining, 4000);
  assert.equal(Date.parse(state.secondaryUntil) - f.now(), 60_000);
  await withGitHubBudgetScope({}, async () => {
    await assert.rejects(f.throttle.awaitThrottleIfNeeded('core', 'reviewer'), e => e.budgetDeferred && Date.parse(e.observation.resetAt) - f.now() === 60_000);
    assert.equal(await f.throttle.awaitThrottleIfNeeded('core', 'watcher'), false);
  });
  assert.equal(f.telemetry[0].extra.headers['x-ratelimit-used'], '1400');
  assert.equal(f.telemetry[0].extra.consumer, 'reviewer');
  f.advance(60_000);
  assert.equal(await f.throttle.awaitThrottleIfNeeded('core', 'reviewer'), false);
});

test('secondary limits without retry-after use minute-scale exponential backoff without zeroing', async t => {
  const f = fixture(t);
  const observation = extractRateLimitObservation({}, { rateLimited: true, observedAt: f.now() });
  for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    await f.throttle.recordRateLimitedCall('core', 'reviewer', observation);
    const bucket = (await f.throttle.readSharedState())['reviewer/core'];
    assert.equal(bucket.remaining, null);
    assert.equal(Date.parse(bucket.secondaryUntil) - f.now(), delay);
    f.advance(delay);
    assert.equal(await f.throttle.awaitThrottleIfNeeded('core', 'reviewer'), false);
  }
  await f.throttle.recordResponseRateLimit({ resource: 'core', credential: 'reviewer',
    remaining: 5000, resetAt: f.now() + 3600_000, observedAt: f.now() });
  const resumed = await f.throttle.recordRateLimitedCall('core', 'reviewer', observation);
  assert.equal(resumed.secondaryAttempts, 1, 'a settled primary response ends the consecutive failure series');
  assert.equal(Date.parse(resumed.secondaryUntil) - f.now(), 60_000);
});

test('nested wrappers record one secondary response only once', async t => {
  const f = fixture(t);
  const observation = extractRateLimitObservation({
    'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.ceil(f.now() / 1000) + 3600),
  }, { observedAt: f.now(), status: 403, kind: 'secondary', rateLimited: true });
  const first = await f.throttle.recordRateLimitedCall('core', 'reviewer', observation);
  const outer = await f.throttle.recordRateLimitedCall('core', 'reviewer',
    rateLimitErrorObservation({ githubRateLimitKind: 'secondary', observation: first }));
  assert.equal(outer.resetAt, first.resetAt);
  const bucket = (await f.throttle.readSharedState())['reviewer/core'];
  assert.equal(bucket.secondaryAttempts, 1);
  assert.equal(bucket.rateLimitedCalls, 1);
  assert.equal(bucket.remaining, 4000);
  assert.equal(f.telemetry.filter(row => row.category === 'github_rate_limit').length, 1);
});

for (const scope of [false, true]) {
  for (const remaining of [0, 100]) {
    test(`long false balance ${remaining} is corrected from live /rate_limit before ${scope ? 'deferring' : 'sleeping'}`, async t => {
      let probes = 0;
      const f = fixture(t, { confirmBudgetImpl: async ({ resource, credential }) => {
        probes++;
        assert.equal(credential, 'reviewer');
        return { resource, remaining: 5032, limit: 5400, resetAt: f.now() + 3600_000, observedAt: f.now() };
      } });
      await f.throttle.recordResponseRateLimit({ resource: 'core', credential: 'reviewer', remaining,
        resetAt: f.now() + 3600_000, observedAt: f.now() });
      const admit = () => f.throttle.awaitThrottleIfNeeded('core', 'reviewer');
      assert.equal(await (scope ? withGitHubBudgetScope({}, admit) : admit()), false);
      assert.equal(probes, 1);
      assert.deepEqual(f.sleeps, []);
      assert.equal((await f.throttle.readSharedState())['reviewer/core'].remaining, 5032);
      const evidence = f.telemetry.find(row => row.category === 'github_budget_confirmation').extra;
      assert.equal(evidence.recorded.remaining, remaining);
      assert.equal(evidence.live.remaining, 5032);
    });
  }
}

test('primary 403 with zero waits to its confirmed reset', async t => {
  const f = fixture(t, { confirmBudgetImpl: async () => ({ remaining: 0, resetAt: f.now() + 3600_000, observedAt: f.now() }) });
  await f.throttle.recordRateLimitedCall('core', 'reviewer', rateLimitErrorObservation({ status: 403, response: { headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(f.now() / 1000) + 3600),
  } } }, { observedAt: f.now() }));
  await withGitHubBudgetScope({}, () => assert.rejects(f.throttle.awaitThrottleIfNeeded('core', 'reviewer'), e => e.budgetDeferred && Date.parse(e.observation.resetAt) - f.now() >= 3599_000));
});

test('unavailable confirmation bounds a self-imposed hold to two minutes', async t => {
  const f = fixture(t, { confirmBudgetImpl: async () => { throw new Error('offline'); } });
  await f.throttle.recordResponseRateLimit({ remaining: 0, resetAt: f.now() + 3600_000 });
  await withGitHubBudgetScope({}, () => assert.rejects(f.throttle.awaitThrottleIfNeeded(), e => Date.parse(e.observation.resetAt) - f.now() === 120_000));
});

for (const resource of ['core', 'graphql']) test(`a structured secondary refusal of /rate_limit honors Retry-After while confirming ${resource}`, async t => {
  const env = { GH_TOKEN: 'fixture-confirmation-identity' };
  const f = fixture(t, { env });
  const credential = githubCredential({ env });
  let probes = 0;
  t.mock.method(rateLimitConfirmation, 'read', async probeEnv => {
    assert.equal(probeEnv.GH_TOKEN, env.GH_TOKEN);
    assert.equal(probeEnv.GH_ENTERPRISE_TOKEN, env.GH_TOKEN);
    probes++;
    throw { status: 403, response: { status: 403, headers: {
      'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.ceil(f.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core', 'retry-after': '300',
    }, data: { message: 'You have exceeded a secondary rate limit.' } } };
  });
  await f.throttle.recordResponseRateLimit({ resource, credential,
    remaining: 0, resetAt: f.now() + 3600_000, observedAt: f.now() });
  await withGitHubBudgetScope({}, () => assert.rejects(f.throttle.awaitThrottleIfNeeded(resource, credential),
    err => err.budgetDeferred && Date.parse(err.observation.resetAt) - f.now() === 300_000));
  assert.equal(probes, 1);
  const state = await f.throttle.readSharedState();
  assert.equal(state[`${credential}/core`].remaining, 4000);
  if (resource === 'graphql') assert.equal(state[`${credential}/graphql`].remaining, 0,
    'core response headers cannot supply GraphQL primary capacity');
  const limited = f.telemetry.find(row => row.category === 'github_rate_limit').extra;
  assert.equal(limited.status, 403);
  assert.equal(limited.requestCategory, 'rate_limit_probe');
  assert.equal(limited.headers['retry-after'], '300');
  assert.equal(f.telemetry.find(row => row.category === 'github_budget_confirmation').extra.recorded.remaining, 0);
});

test('HTTP debug bodies discussing rate limits cannot classify a 404, 500 or permission 403', () => {
  for (const status of [404, 500, 403]) {
    const parsed = parseGhDebug(`* Request at fixture\n< HTTP/2.0 ${status}\n< X-Ratelimit-Remaining: 4000\n< X-Ratelimit-Reset: 4102444800\n\n{"message":"rate limit","body":"too many requests"}\n* Request took 1ms\n`);
    assert.equal(parsed.observations[0].rateLimited, false);
    assert.equal(parsed.observations[0].remaining, 4000);
  }
});

test('conditional request and watcher hook leave a failed content-bearing response unclassified', async t => {
  const f = fixture(t);
  const error = Object.assign(new Error('rate limit'), { status: 404, stdout: 'rate limit', response: { data: { message: 'rate limit' } } });
  await assert.rejects(fetchConditionalRestPage({ rootDir: f.dir, repo: 'fixture/repo', prNumber: 1,
    category: 'pr_diff', endpoint: 'pulls', request: async () => { throw error; }, recordApiCallImpl() {} }), e => e === error);
  let wrap;
  createWatcherOctokit({ auth: 'fixture-watcher', octokitFactory: () => ({ hook: { wrap: (_name, fn) => { wrap = fn; } } }) });
  await assert.rejects(wrap(async () => { throw error; }, { url: '/repos/fixture/repo/pulls/1' }), e => e === error);
  assert.equal(error.observation, undefined);
  assert.equal(isGitHubRateLimitError(error), false);
  assert.notEqual(githubCredential({ token: 'fixture-reviewer' }), githubCredential({ token: 'fixture-watcher' }));
});

test('reviewer gh pr diff failure with a content-bearing stdout never enters a throttle or files fallback', async t => {
  const { fetchPRDiff } = await import('../src/reviewer-diff-fetch.mjs');
  const f = fixture(t);
  const calls = [];
  const error = Object.assign(new Error('Command failed: gh pr diff'), {
    code: 1, stdout: Buffer.from('diff --git a/example b/example\n+ rate limit\n'),
    stderr: 'gh: Not Found (HTTP 404)',
  });
  await assert.rejects(fetchPRDiff('fixture/repo', 1, 'synthetic-head', {
    execFileImpl: async (command, args) => { calls.push([command, ...args]); throw error; },
    getCachedDiffImpl: () => null, recordApiCallImpl: row => f.telemetry.push(row),
    ghRetrySleepImpl: async () => assert.fail('content must not trigger a retry'),
    awaitThrottleIfNeededImpl: async () => false,
  }), err => err === error);
  assert.deepEqual(calls, [['gh', 'pr', 'diff', '1', '--repo', 'fixture/repo']]);
  assert.equal(error.rateLimited, undefined);
  assert.deepEqual(await f.throttle.readSharedState(), {});
});

test('fast merge, duplicate workflow and live-review retry ignore rate-limit prose', async () => {
  const { isRetryableGhTransportError } = await import('../src/fast-merge-github-io.mjs');
  const { isTransientSubprocessError } = await import('../src/duplicate-family-workflow-cli.mjs');
  const { fetchLatestHeadReviewBodiesWithRetry } = await import('../src/daemon-clean-merge.mjs');
  const error = Object.assign(new Error('rate limit / abuse detection / HTTP 429'), {
    status: 404, stdout: 'secondary rate limit', stderr: 'rate-limit',
  });
  for (const classify of [isRetryableGhTransportError, isTransientSubprocessError]) {
    assert.equal(classify(error), false);
    assert.equal(classify({ status: 429 }), true);
    assert.equal(classify({ status: 403, response: { headers: { 'retry-after': '60' } } }), true);
  }
  let attempts = 0;
  await assert.rejects(fetchLatestHeadReviewBodiesWithRetry({
    fetchLatestHeadReviewBodiesImpl: async () => { attempts++; throw error; },
    retryDelaysMs: [0, 0],
  }), e => e === error);
  assert.equal(attempts, 1);
  const secondary = { status: 403, response: { headers: { 'retry-after': '60' } } };
  attempts = 0;
  await assert.rejects(fetchLatestHeadReviewBodiesWithRetry({
    fetchLatestHeadReviewBodiesImpl: async () => { attempts++; throw secondary; },
    retryDelaysMs: [0, 0],
  }), e => e === secondary);
  assert.equal(attempts, 1);
});
