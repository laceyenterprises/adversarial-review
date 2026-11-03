// WATCHERANONBUCKET-01: an anonymous 60/h observation must not defer watcher
// intake or reviewer reads that send an authenticated credential, and a
// throttle floor never exceeds the observed bucket limit. All tokens are
// disposable fakes; budget state lives in an isolated temp file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const stateDir = mkdtempSync(path.join(tmpdir(), 'watcheranonbucket-'));
const statePath = path.join(stateDir, 'rate-limit-state.json');
const ENV_KEYS = ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR', 'GH_TOKEN', 'GITHUB_TOKEN',
  'WATCHER_GH_AUTH_VIA_BROKER', 'WATCHER_GH_BROKER_ROLE', 'GHA_ADAPTER_BIN', 'AGENT_OS_GITHUB_ADAPTER_BIN',
  'AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY', 'HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND', 'HAM_ROOT_DIR'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = statePath;
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

const resetEpoch = Math.floor(Date.now() / 1000) + 1800;
const resetAt = new Date(resetEpoch * 1000).toISOString();
const WATCHER_TOKEN = 'fake-watcheranonbucket-watcher';

const throttle = await import('../src/rate-limit-throttle.mjs');
const { createRateLimitThrottle, githubBudgetFloor, githubCredential, githubBudgetKey, withGitHubBudgetScope,
  extractRateLimitObservation, GitHubBudgetDeferredError } = throttle;
const { createWatcherOctokit } = await import('../src/conditional-request.mjs');
const { createGitHubPRSubjectAdapter } = await import('../src/adapters/subject/github-pr/index.mjs');
const { fetchLivePRLifecycle } = await import('../src/review-state.mjs');
const { meteredExecFile, meteredExecFileSync } = await import('../src/metered-gh.mjs');
const { runLowBudgetClosingTick } = await import('../src/watcher-github-budget.mjs');

const scoped = fn => withGitHubBudgetScope({}, fn);
const bucketOf = (state, token, resource = 'core') =>
  state[githubBudgetKey(resource, token ? githubCredential({ token }) : 'default')];
const readBuckets = () => JSON.parse(readFileSync(statePath, 'utf8')).buckets;
const observed = (extra) => ({ observedAt: new Date().toISOString(), resetAt, ...extra });

// The witnessed production shape: an anonymous `core` entry with no
// credential, far below the 200 floor, beside healthy authenticated buckets.
function seedWitnessedState({ anonymousLimit = 60 } = {}) {
  const credential = githubCredential({ token: WATCHER_TOKEN });
  writeFileSync(statePath, `${JSON.stringify({ version: 2, buckets: {
    core: observed({ resource: 'core', remaining: 58, ...(anonymousLimit ? { limit: anonymousLimit } : {}) }),
    [`${credential}/core`]: observed({ resource: 'core', credential, remaining: 5340, limit: 5000 }),
    [`${credential}/graphql`]: observed({ resource: 'graphql', credential, remaining: 5265, limit: 5000 }),
  } })}\n`);
}

function productionWatcherEnv() {
  // The start script resolves one broker installation token into both names
  // and sets the broker signal the adapter read seam keys on.
  process.env.GITHUB_TOKEN = WATCHER_TOKEN;
  process.env.GH_TOKEN = WATCHER_TOKEN;
  process.env.WATCHER_GH_AUTH_VIA_BROKER = 'true';
  process.env.GHA_ADAPTER_BIN = path.join(stateDir, 'github-adapter');
}

function clearWatcherEnv() {
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'WATCHER_GH_AUTH_VIA_BROKER', 'GHA_ADAPTER_BIN']) delete process.env[key];
}

function fixturePr(number) {
  const sha = String(number).repeat(40).slice(0, 40);
  return {
    number, title: `[codex] FIXTURE-${number}: synthetic change`, state: 'open',
    head: { sha, ref: `fixture-${number}`, repo: { full_name: 'fixture/repo', id: 1 } },
    base: { sha: 'c'.repeat(40), ref: 'main', repo: { full_name: 'fixture/repo', id: 1 } },
    user: { login: 'fixture-author' }, author_association: 'MEMBER', labels: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

test('deployed composition replay: intake and reviewer reads proceed past an anonymous 58/60 observation', async () => {
  seedWitnessedState();
  productionWatcherEnv();
  try {
    // Real @octokit/rest (its auth and hook chain), with only fetch replaced.
    const { Octokit } = createRequire(import.meta.url)('@octokit/rest');
    const sent = [];
    const fetch = async (url, init) => {
      sent.push({ url: String(url), authorization: init?.headers?.authorization || null });
      return new Response(JSON.stringify([fixturePr(7)]), { status: 200, headers: {
        'content-type': 'application/json', 'x-ratelimit-remaining': '5339', 'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': String(resetEpoch), 'x-ratelimit-resource': 'core' } });
    };
    const octokit = createWatcherOctokit({ auth: process.env.GITHUB_TOKEN, authProvider: () => process.env.GITHUB_TOKEN,
      octokitFactory: options => new Octokit({ ...options, request: { fetch } }) });
    const adapterCalls = [];
    // The adapter env is process.env, as the watcher composition root builds it.
    const subjectAdapter = createGitHubPRSubjectAdapter({ octokit, repos: ['fixture/repo'], rootDir: stateDir,
      execFileImpl: async (command, args) => {
        adapterCalls.push(args);
        return { stdout: JSON.stringify({ ok: true, complete: true, pullRequests: [] }) };
      } });
    const refs = await scoped(() => subjectAdapter.discoverSubjects());
    assert.deepEqual(refs.map(ref => ref.subjectExternalId), ['fixture/repo#7']);
    assert.deepEqual(sent.map(item => item.authorization), [`token ${WATCHER_TOKEN}`]);
    assert.ok(adapterCalls[0].includes('--pat-env'), 'adapter reads bind the watcher token');

    // Reviewer-side lookups that run during dispatch use the gh child env.
    const live = await scoped(() => fetchLivePRLifecycle({ repo: 'fixture/repo', prNumber: 7, execFileImpl: async () => ({
      stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, closedAt: null, labels: [], headRefOid: '7'.repeat(40) }),
      stderr: '' }) }));
    assert.equal(live?.prState, 'open');
    const gh = await scoped(() => meteredExecFile(async () => ({ stdout: '{}', stderr: '' }),
      'gh', ['api', 'repos/fixture/repo/pulls/7']));
    assert.equal(gh.stdout, '{}');

    const state = readBuckets();
    assert.equal(bucketOf(state, WATCHER_TOKEN).remaining, 5339);
    assert.equal(bucketOf(state, WATCHER_TOKEN).limit, 5000, 'the observed limit is recorded');
    assert.equal(bucketOf(state, null).remaining, 58, 'authenticated reads never charge the anonymous bucket');
  } finally {
    clearWatcherEnv();
  }
});

test('an authenticated bucket genuinely at zero defers and names that credential', async () => {
  seedWitnessedState();
  const token = 'fake-watcheranonbucket-exhausted';
  const credential = githubCredential({ token });
  await throttle.recordResponseRateLimit({ credential, resource: 'core', remaining: 0, limit: 5000, resetAt });
  let calls = 0;
  await assert.rejects(scoped(() => meteredExecFile(async () => { calls += 1; return { stdout: '{}', stderr: '' }; },
    'gh', ['api', 'repos/fixture/repo/pulls'], { env: { GH_TOKEN: token } })), err => {
    assert.ok(err instanceof GitHubBudgetDeferredError);
    assert.equal(err.credential, credential);
    assert.match(err.message, new RegExp(`core budget deferred until .*credential=${credential}; remaining=0/5000; floor=200`));
    assert.doesNotMatch(err.message, new RegExp(token), 'the raw token never appears');
    return true;
  });
  assert.equal(calls, 0, 'a deferred read must not reach GitHub');
  assert.throws(() => scoped(() => meteredExecFileSync(() => assert.fail('sync read must defer'),
    'gh', ['api', 'repos/fixture/repo/pulls'], { env: { GH_TOKEN: token, GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath } })),
  err => err.budgetDeferred === true && err.credential === credential);
});

test('an anonymous-only call with limit 60 and remaining 58 is not deferred by a 200 floor', async () => {
  seedWitnessedState();
  assert.equal(githubBudgetFloor({ remaining: 58, limit: 60 }, 200), 6);
  assert.equal(githubBudgetFloor({ remaining: 4000, limit: 5000 }, 200), 200, 'a normal bucket keeps the configured floor');
  assert.equal(githubBudgetFloor({ remaining: 58 }, 200), 200, 'an unrecorded limit keeps the configured floor');
  let calls = 0;
  const anonymous = { PATH: process.env.PATH, HOME: stateDir };
  await scoped(() => meteredExecFile(async () => { calls += 1; return { stdout: '[]', stderr: '' }; },
    'gh', ['api', 'repos/fixture/repo/pulls'], { env: anonymous }));
  meteredExecFileSync(() => { calls += 1; return { status: 0, stdout: '[]', stderr: '' }; },
    'gh', ['api', 'repos/fixture/repo/pulls'], { env: { ...anonymous, GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath } });
  assert.equal(calls, 2);

  // Un-scoped callers must not sleep until reset either.
  let slept = 0;
  const local = createRateLimitThrottle({ env: { GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath }, sleepImpl: async ms => { slept += ms; },
    recordApiCallImpl: null });
  assert.equal(await local.awaitThrottleIfNeeded('core', 'default'), false);
  assert.equal(slept, 0);

  // The low-budget closing shortcut does not treat 58/60 as low.
  const lines = [];
  assert.equal(await runLowBudgetClosingTick({ budgets: { core: bucketOf(readBuckets(), null) }, rows: [],
    isReady: () => true, serve: async () => {}, logger: { log: line => lines.push(line) }, floor: 200 }), false);
  assert.deepEqual(lines, []);

  // A genuinely drained anonymous bucket still defers, naming `default`.
  await throttle.recordResponseRateLimit({ resource: 'core', remaining: 3, limit: 60, resetAt });
  await assert.rejects(scoped(() => meteredExecFile(async () => assert.fail('drained anonymous must defer'),
    'gh', ['api', 'repos/fixture/repo/pulls'], { env: anonymous })), err => err.budgetDeferred === true
    && err.credential === 'default' && /credential=default; remaining=3\/60; floor=6/.test(err.message));
});

test('header observations carry x-ratelimit-limit and keep it across merges', () => {
  const observation = extractRateLimitObservation({ 'x-ratelimit-remaining': '58', 'x-ratelimit-limit': '60',
    'x-ratelimit-reset': String(resetEpoch) });
  assert.equal(observation.limit, 60);
  const merged = throttle.mergeObservationMaps({ core: { ...observation } }, { core: { ...observation, remaining: 57, limit: undefined } });
  assert.equal(merged.core.remaining, 57);
  assert.equal(merged.core.limit, 60);
  assert.equal(throttle.normalizeObservation({ remaining: 5, resetAt, limit: 'not-a-number' }).limit, undefined);
});
