// LAC-2075: GitHub budget admission and header observations belong to the
// credential that actually makes the request. A low anonymous (`default`)
// bucket must not defer an authenticated token, one token must not borrow or
// poison another, and a low/zero budget for the effective token still defers.
// All tokens below are disposable fakes; state lives in an isolated temp file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const stateDir = mkdtempSync(path.join(tmpdir(), 'lac2075-budget-'));
const statePath = path.join(stateDir, 'rate-limit-state.json');
const savedEnv = {};
for (const key of ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR', 'GH_TOKEN', 'GITHUB_TOKEN',
  'WATCHER_GH_AUTH_VIA_BROKER', 'GHA_ADAPTER_BIN', 'AGENT_OS_GITHUB_ADAPTER_BIN', 'AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY']) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = statePath;
process.env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY = 'false';
test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
const resetAt = new Date(resetEpoch * 1000).toISOString();
// The witnessed shape: an anonymous-quota window (limit 60) far below the
// 200 floor, keyed by the bare `default` resource.
writeFileSync(statePath, `${JSON.stringify({ version: 2, buckets: {
  core: { resource: 'core', remaining: 58, resetAt, observedAt: new Date().toISOString() },
} })}\n`);

const throttle = await import('../src/rate-limit-throttle.mjs');
const { withGitHubBudgetScope, githubCredential, githubBudgetKey, recordResponseRateLimit } = throttle;
const githubApi = await import('../src/github-api.mjs');
const { execGhJson, runAdapterReadWithTelemetry } = githubApi.__test__;
const { createGitHubPRSubjectAdapter } = await import('../src/adapters/subject/github-pr/index.mjs');
const { postRemediationOutcomeComment } = await import('../src/adapters/comms/github-pr-comments/pr-comments.mjs');
const { fetchLivePRLifecycle } = await import('../src/review-state.mjs');

const scoped = (fn) => withGitHubBudgetScope({}, fn);
const bucket = (token, resource = 'core') => readState()[githubBudgetKey(resource, token ? githubCredential({ token }) : 'default')];
function readState() { return JSON.parse(readFileSync(statePath, 'utf8')).buckets; }
function seed(token, remaining) {
  return recordResponseRateLimit({ credential: githubCredential({ token }), resource: 'core', remaining, resetAt });
}
function envelope(status, remaining, body) {
  return `HTTP/2.0 ${status}\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: ${resetEpoch}\r\n\r\n${body}`;
}
function assertAnonymousUntouched() {
  assert.equal(bucket(null).remaining, 58, 'authenticated observations must not be written to the anonymous bucket');
  assert.equal(bucket(null).credential, undefined);
}

test('gh read: a low anonymous bucket does not defer an authenticated token; its headers stay on that token', async () => {
  process.env.GH_TOKEN = 'fake-lac2075-healthy-a';
  let calls = 0;
  const gh = async () => { calls += 1; return { stdout: envelope('200 OK', 4999, '{"ok":true}'), stderr: '' }; };
  assert.deepEqual(await scoped(() => execGhJson(gh, ['api', 'repos/fixture/repo/pulls'])), { ok: true });
  assert.deepEqual(await scoped(() => execGhJson(gh, ['api', 'repos/fixture/repo/pulls'])), { ok: true });
  assert.equal(calls, 2);
  assert.equal(bucket('fake-lac2075-healthy-a').remaining, 4999);
  assertAnonymousUntouched();
});

test('gh read: one token neither borrows nor poisons another; the effective low token still defers', async () => {
  process.env.GH_TOKEN = 'fake-lac2075-low-b';
  let calls = 0;
  const lowGh = async () => { calls += 1; return { stdout: envelope('200 OK', 3, '[]'), stderr: '' }; };
  assert.deepEqual(await scoped(() => execGhJson(lowGh, ['api', 'repos/fixture/repo/pulls'])), []);
  assert.equal(bucket('fake-lac2075-low-b').remaining, 3);

  process.env.GH_TOKEN = 'fake-lac2075-healthy-c';
  const healthyGh = async () => { calls += 1; return { stdout: envelope('200 OK', 4000, '[]'), stderr: '' }; };
  assert.deepEqual(await scoped(() => execGhJson(healthyGh, ['api', 'repos/fixture/repo/pulls'])), []);
  assert.equal(calls, 2);

  process.env.GH_TOKEN = 'fake-lac2075-low-b';
  await assert.rejects(scoped(() => execGhJson(lowGh, ['api', 'repos/fixture/repo/pulls'])),
    err => err.budgetDeferred === true && err.observation.credential === githubCredential({ token: 'fake-lac2075-low-b' }));
  assert.equal(calls, 2, 'a deferred read must not reach GitHub');
  assertAnonymousUntouched();
});

test('gh error response: a zero-balance observation is charged to the requesting token only', async () => {
  process.env.GH_TOKEN = 'fake-lac2075-zero-d';
  const limitedGh = async () => {
    throw Object.assign(new Error('gh: HTTP 403'), {
      stdout: envelope('403 Forbidden', 0, '{"message":"forbidden"}'), stderr: '', code: 1,
    });
  };
  await assert.rejects(scoped(() => execGhJson(limitedGh, ['api', 'repos/fixture/repo/pulls'])), /HTTP 403/);
  assert.equal(bucket('fake-lac2075-zero-d').remaining, 0);
  assertAnonymousUntouched();
  await assert.rejects(scoped(() => execGhJson(limitedGh, ['api', 'repos/fixture/repo/pulls'])), err => err.budgetDeferred === true);

  process.env.GH_TOKEN = 'fake-lac2075-healthy-c';
  assert.deepEqual(await scoped(() => execGhJson(async () => ({ stdout: envelope('200 OK', 3999, '{}'), stderr: '' }),
    ['api', 'repos/fixture/repo/pulls'])), {});
});

test('adapter read: preflight uses the bound broker token, or the adapter selector when the parent binds none', async () => {
  const brokerEnv = { WATCHER_GH_AUTH_VIA_BROKER: 'true', GITHUB_TOKEN: 'fake-lac2075-broker-e', GH_TOKEN: 'fake-lac2075-broker-e' };
  const read = env => scoped(() => runAdapterReadWithTelemetry('pr_head_state', {
    repo: 'fixture/repo', prNumber: 1, env, adapterAvailable: true, recordApiCallImpl: () => {},
  }, async () => ({ ok: true })));
  assert.deepEqual(await read(brokerEnv), { ok: true });
  assert.deepEqual(await read({}), { ok: true });
  await seed('fake-lac2075-broker-e', 10);
  await assert.rejects(read(brokerEnv), err => err.budgetDeferred === true
    && err.observation.credential === githubCredential({ token: 'fake-lac2075-broker-e' }));
  assertAnonymousUntouched();
});

test('watcher intake: Octokit discovery is admitted and observed under the watcher token', async () => {
  let remaining = 4321;
  const adapter = createGitHubPRSubjectAdapter({
    octokit: { rest: { pulls: { list: async () => ({ data: [], headers: {
      'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(resetEpoch) } }) } } },
    repos: ['fixture/repo'],
    rootDir: stateDir,
    env: { GITHUB_TOKEN: 'fake-lac2075-watcher-f', AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: 'false' },
  });
  assert.deepEqual(await scoped(() => adapter.discoverSubjects()), []);
  assert.equal(bucket('fake-lac2075-watcher-f').remaining, 4321);
  assertAnonymousUntouched();
  remaining = 5;
  await scoped(() => adapter.discoverSubjects());
  await assert.rejects(scoped(() => adapter.discoverSubjects()), /core budget deferred/);
});

test('comment write: the reviewer-bot token is admitted even when the anonymous and operator buckets are low', async () => {
  await seed('fake-lac2075-operator-h', 0);
  const post = (token) => {
    const calls = [];
    return scoped(() => postRemediationOutcomeComment({
      repo: 'fixture/repo', prNumber: 7, workerClass: 'claude-code', body: 'x', rootDir: stateDir,
      env: { GH_CLAUDE_REVIEWER_TOKEN: token, GITHUB_TOKEN: 'fake-lac2075-operator-h', PATH: '/usr/bin', HOME: stateDir,
        AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0' },
      execFileImpl: async (command, args, options) => { calls.push({ command, args, options }); return { stdout: '', stderr: '' }; },
      findExistingImpl: async () => ({ found: false }),
      log: { error() {}, warn() {}, log() {} },
    })).then(result => ({ result, calls }));
  };
  const healthy = await post('fake-lac2075-reviewer-g');
  assert.equal(healthy.result.posted, true);
  assert.equal(healthy.calls.length, 1);
  await seed('fake-lac2075-reviewer-z', 0);
  const exhausted = await post('fake-lac2075-reviewer-z');
  assert.equal(exhausted.result.posted, false);
  assert.equal(exhausted.calls.length, 0, 'the effective exhausted token must still defer the write');
});

test('live lifecycle lookup: preflight follows the gh subprocess token, not the anonymous bucket', async () => {
  process.env.GH_TOKEN = 'fake-lac2075-healthy-c';
  const gh = async () => ({ stdout: JSON.stringify({ state: 'OPEN', mergedAt: null, closedAt: null, labels: [], headRefOid: 'a'.repeat(40) }), stderr: '' });
  const live = await scoped(() => fetchLivePRLifecycle({ repo: 'fixture/repo', prNumber: 7, execFileImpl: gh }));
  assert.equal(live?.prState, 'open');
  process.env.GH_TOKEN = 'fake-lac2075-low-b';
  assert.equal(await scoped(() => fetchLivePRLifecycle({ repo: 'fixture/repo', prNumber: 7, execFileImpl: gh })), null);
});

test('recovery replay: the deployed watcher composition resumes intake while the anonymous bucket is below the floor', async () => {
  const { createWatcherOctokit } = await import('../src/conditional-request.mjs');
  // Minimal Octokit double: `wrap` encloses the before hooks and the request,
  // as in @octokit/core, so the real watcher hook does its own admission.
  const sent = [];
  let remaining = 4100;
  const octokitFactory = () => {
    const befores = [];
    let wrapper = null;
    const request = async (options) => {
      for (const before of befores) before(options);
      sent.push(options.headers?.authorization || null);
      return { status: 200, data: [], headers: { 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(resetEpoch) } };
    };
    return {
      hook: { before: (_name, fn) => befores.push(fn), wrap: (_name, fn) => { wrapper = fn; } },
      rest: { pulls: { list: (params) => {
        const options = { method: 'GET', url: '/repos/{owner}/{repo}/pulls', headers: {}, ...params };
        return wrapper ? wrapper(request, options) : request(options);
      } } },
    };
  };
  process.env.GITHUB_TOKEN = 'fake-lac2075-watcher-live';
  process.env.GH_TOKEN = 'fake-lac2075-watcher-live';
  try {
    const octokit = createWatcherOctokit({ auth: process.env.GITHUB_TOKEN, authProvider: () => process.env.GITHUB_TOKEN, octokitFactory });
    const adapter = createGitHubPRSubjectAdapter({ octokit, repos: ['fixture/repo'], rootDir: stateDir });
    assert.ok(bucket(null).remaining < 200, 'the witnessed anonymous bucket is below the floor');
    assert.deepEqual(await scoped(() => adapter.discoverSubjects()), []);
    assert.deepEqual(sent, ['token fake-lac2075-watcher-live']);
    assert.equal(bucket('fake-lac2075-watcher-live').remaining, 4100);
    assertAnonymousUntouched();
    remaining = 7;
    await scoped(() => adapter.discoverSubjects());
    await assert.rejects(scoped(() => adapter.discoverSubjects()), /core budget deferred/);
    assert.equal(sent.length, 2, 'a genuinely low watcher token still defers before any request');
  } finally {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  }
});
