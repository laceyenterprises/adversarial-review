import './helpers/rate-limit-state-isolation.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { createGithubOwnerTokenSelector, githubOwnerTokens, githubTargetOwner,
  githubTokenForTarget, githubTokenRole, githubEnvForTarget, recordGithubToken } from '../src/github-owner-token.mjs';
import { fetchReviewerTokenFromBroker, resolveReviewerAppToken, refreshWatcherGithubToken } from '../src/reviewer-broker-refresh.mjs';
import { createWatcherOctokit } from '../src/conditional-request.mjs';
import { meteredExecFile, meteredExecFileSync } from '../src/metered-gh.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { __test__ as adapter, writeAdapterPullRequestReview, githubAdapterReadCredential } from '../src/github-adapter-client.mjs';
import { clearPendingReviewsForSelf } from '../src/reviewer-pre-write.mjs';
import { mintMergeAgentWorkflowPushToken, assertWorkflowPushCapabilityForJob } from '../src/remediation-workflow-push-capability.mjs';
import { fetchPRContext, refreshReviewerTokensForSideCalls } from '../src/reviewer-context-auth.mjs';
import { __test__ as githubApi } from '../src/github-api.mjs';
import { __test__ as reviewer } from '../src/reviewer.mjs';
import { githubCredential } from '../src/rate-limit-throttle.mjs';
import { postExactHeadReview } from '../src/reviewer-exact-head-post.mjs';

const quiet = { log() {}, warn() {} };
const reviewerEnv = 'GH_CODEX_REVIEWER_TOKEN';
const outage = err => err.code === 'github-owner-token-unavailable' && err.authOutage === true && err.failureClass === 'github-auth-outage';
const brokerEnv = {
  OAUTH_BROKER_URL: 'http://broker.fixture', OAUTH_BROKER_URL_FALLBACK: 'http://broker.fixture',
  OAUTH_BROKER_SHARED_SECRET_FILE: 'fixture-secret',
  OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_APP_ID: '1001',
  OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_INSTALLATION_ID: '1001',
  OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_INSTALLATIONS: 'home-org:1001,other-org:2002',
};
const response = (overrides = {}) => ({
  access_token: 'owner-token', provider: 'github-app-codex-reviewer',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  metadata: { owner: 'other-org', app_id: '1001', installation_id: '2002', credential_source: 'github_app_installation' },
  ...overrides,
});
const ok = body => ({ ok: true, status: 200, json: async () => body });
function brokerOptions(body = response(), env = brokerEnv) {
  const urls = [];
  return { urls, options: { role: 'codex-reviewer', owner: 'other-org', env,
    readFileImpl: () => 'synthetic-secret', fetchImpl: async url => { urls.push(url); return ok(body); } } };
}
function install(options = {}) {
  const calls = [];
  const selector = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org',
    mint: async args => { calls.push(args); return { token: `${args.role}@${args.owner}-${calls.length}`, expiresAtMs: Date.now() + 3600_000 }; },
    ...options,
  });
  Object.assign(githubOwnerTokens, selector);
  return { calls, selector };
}
beforeEach(() => install());

function serviceEnv() {
  recordGithubToken('home-service', { role: 'merge-agent', owner: null });
  return { GH_TOKEN: 'home-service', GITHUB_TOKEN: 'home-service',
    GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH };
}

test('broker appends owner after force and verifies owner pins instead of home pins', async () => {
  const { options, urls } = brokerOptions();
  const result = await fetchReviewerTokenFromBroker({ ...options, force: true });
  assert.equal(result.token, 'owner-token');
  assert.equal(githubCredential({ token: result.token, env: options.env }), 'installation-1001-2002');
  assert.equal(urls[0], 'http://broker.fixture/token?provider=github-app-codex-reviewer&force=1&owner=other-org');
  const noOwnerPin = { ...brokerEnv, OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_INSTALLATIONS: '' };
  const unpinned = await fetchReviewerTokenFromBroker(brokerOptions(response({ access_token: 'unpinned-owner' }), noOwnerPin).options);
  assert.equal(unpinned.token, 'unpinned-owner');
  assert.match(githubCredential({ token: unpinned.token, env: noOwnerPin }), /^token-/);
});

test('broker rejects missing/wrong owner echo, wrong owner pin, wrong App/provider and PAT fallback', async () => {
  for (const metadata of [
    { owner: undefined }, { owner: 'home-org' }, { installation_id: '1001' },
    { app_id: '2002' }, { credential_source: 'github_pat_fallback' },
  ]) {
    const body = response({ metadata: { ...response().metadata, ...metadata } });
    await assert.rejects(fetchReviewerTokenFromBroker(brokerOptions(body).options));
  }
  await assert.rejects(fetchReviewerTokenFromBroker(brokerOptions(response({ provider: 'wrong-provider' })).options));
  for (const pin of ['other-org:', 'other-org:2002,other-org:1001']) {
    await assert.rejects(fetchReviewerTokenFromBroker(brokerOptions(response(), { ...brokerEnv, OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_INSTALLATIONS: pin }).options));
  }
});

test('broker accepts canonical owner casing while retaining installation pins', async () => {
  const body = response({ metadata: { ...response().metadata, owner: 'Other-Org' } });
  assert.equal((await fetchReviewerTokenFromBroker(brokerOptions(body).options)).token, 'owner-token');
  await assert.rejects(fetchReviewerTokenFromBroker(brokerOptions({
    ...body, metadata: { ...body.metadata, installation_id: '9999' },
  }).options), /installation_id/);
});

test('home broker URL, pins, token and resolveReviewerAppToken environment stay identical', async () => {
  const env = { ...brokerEnv };
  const body = response({ access_token: 'home-token', metadata: { app_id: '1001', installation_id: '1001' } });
  const { options, urls } = brokerOptions(body, env);
  const result = await resolveReviewerAppToken('codex-reviewer', { ...options, owner: null });
  assert.equal(result.token, 'home-token');
  assert.equal(env[reviewerEnv], 'home-token');
  assert.deepEqual(urls, ['http://broker.fixture/token?provider=github-app-codex-reviewer']);
  await assert.rejects(fetchReviewerTokenFromBroker({ ...brokerOptions(response(), env).options, owner: null }), /installation_id/);
  const before = { ...env };
  await resolveReviewerAppToken('codex-reviewer', brokerOptions(response(), env).options);
  assert.deepEqual(env, before, 'owner mint never mutates home env');
});

test('owner parsing uses repository targets, including GraphQL repo variables, never body or branch fields', () => {
  for (const target of ['Other-Org/x', '/repos/Other-Org/x/pulls', 'https://github.com/Other-Org/x/pull/1',
    { owner: 'Other-Org' }, { url: '/repos/Other-Org/x/pulls' },
    ['pr', 'view', '1', '--repo', 'Other-Org/x'], ['pr', 'view', '-ROther-Org/x'],
    ['api', 'repos/Other-Org/x/pulls/1'], ['pr', 'view', 'https://github.com/Other-Org/x/pull/1'],
    ['api', 'graphql', '-f', 'owner=Other-Org', '-f', 'repo=x']]) assert.equal(githubTargetOwner(target), 'other-org');
  for (const target of [undefined, '/graphql', '/orgs/home-org/repos', 'https://api.github.com/orgs/home-org/repos',
    'orgs/other-org/repos', 'users/octocat/repos', 'gists/public', 'graphql', 'teams/1/repos',
    'licenses/mit', 'emojis', 'meta', 'rate_limit',
    ['pr', 'view', '1', '--body', 'Other-Org/x'], ['pr', 'comment', '1', '--body', 'https://github.com/Other-Org/x'],
    ['pr', 'view', '--label', 'repos/Other-Org/x'],
    ['pr', 'comment', '1', '-b', 'https://github.com/Other-Org/x'], ['pr', 'view', '-l', 'repos/Other-Org/x'], ['api', 'graphql', '-f', 'branch=Other-Org/x'],
    { body: 'Other-Org/x', labels: ['Other-Org/x'] }]) assert.equal(githubTargetOwner(target), null);
  assert.equal(githubTargetOwner('/repos/users/x'), 'users');
  assert.equal(githubTargetOwner('https://github.com/orgs/x'), 'orgs');
});

test('relative non-repository API routes preserve the home token without minting', async () => {
  const { calls } = install();
  for (const target of ['orgs/other-org/repos', 'users/octocat/repos', 'gists/public']) {
    assert.equal(await githubTokenForTarget({ token: 'home-token', target }), 'home-token');
  }
  assert.equal(calls.length, 0);
});

test('home, unknown and no-org selections preserve token and exact environment with no mint', async () => {
  const { calls } = install();
  const env = { GH_TOKEN: 'pat', GITHUB_TOKEN: 'different-pat', EXTRA: 'untouched' };
  for (const target of ['HOME-ORG/x', '/orgs/home-org/repos', undefined]) {
    assert.equal(await githubTokenForTarget({ token: 'pat', env, target }), 'pat');
    assert.equal(await githubEnvForTarget(env, target), env);
  }
  assert.equal(calls.length, 0);
  install({ readHomeOwner: () => undefined, mint: () => { throw new Error('unexpected mint'); } });
  assert.equal(await githubEnvForTarget(env, 'other-org/x'), env);
});

test('owner cache is lazy, single-flight, expiry-aware and invalidated after auth failure', async () => {
  let current = 0, mints = 0;
  const { selector } = install({ now: () => current,
    mint: async ({ force }) => { mints++; await Promise.resolve(); return { token: `cache-${mints}-${force}`, expiresAtMs: current + 3600_000 }; } });
  const args = { token: 'reviewer-home', env: { [reviewerEnv]: 'reviewer-home' }, target: 'other-org/x' };
  assert.equal(mints, 0);
  const [a, b] = await Promise.all([selector.select(args), selector.select(args)]);
  assert.equal(a, b); assert.equal(mints, 1);
  assert.equal(await selector.select(args), a); assert.equal(selector.sync(args), a);
  current += 46 * 60_000;
  const fresh = await selector.select(args); assert.notEqual(fresh, a); assert.equal(mints, 2);
  assert.equal(selector.invalidate(fresh), true);
  assert.throws(() => selector.sync(args), outage);
  assert.match(await selector.select(args), /true$/); assert.equal(mints, 3);
});

test('roles follow minted tokens or reviewer envs, never a service startup seed or PAT', async () => {
  assert.equal(githubTokenRole('seed', { GH_TOKEN: 'seed', WATCHER_GH_BROKER_ROLE: 'merge-agent' }), undefined);
  assert.equal(githubTokenRole('reviewer', { [reviewerEnv]: 'reviewer' }), 'codex-reviewer');
  assert.equal(githubTokenRole('reviewer', { GITHUB_REVIEWER_TOKEN_ENV: reviewerEnv }), 'codex-reviewer');
  await assert.rejects(githubTokenForTarget({ token: 'pat', target: 'other-org/x', env: {} }), outage);
  const { selector } = install({ readHomeOwner: () => { throw new Error('unreadable'); } });
  await assert.rejects(selector.select({ token: 'pat', target: 'other-org/x' }), outage);
  assert.equal(await selector.select({ token: 'pat', target: '/graphql' }), 'pat');
});

test('production watcher refresh registers service roles before routed Octokit, adapter and CLI calls', async () => {
  const env = { ...brokerEnv, GH_TOKEN: 'unregistered-startup-seed', GITHUB_TOKEN: 'unregistered-startup-seed',
    GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH,
    WATCHER_GH_AUTH_VIA_BROKER: 'true', WATCHER_GH_BROKER_ROLE: 'merge-agent',
    OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID: '1001', OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID: '1001',
    GHA_ADAPTER_BIN: 'fixture-adapter' };
  assert.equal(githubTokenRole(env.GITHUB_TOKEN, env), undefined);
  const result = await refreshWatcherGithubToken({ env, force: true, log: quiet,
    readFileImpl: () => 'synthetic-secret', fetchImpl: async () => ok(response({
      provider: 'github-app-merge-agent', access_token: 'production-refreshed-service',
      metadata: { app_id: '1001', installation_id: '1001' },
    })) });
  assert.equal(result.refreshed, true);
  assert.equal(githubTokenRole(env.GITHUB_TOKEN, env), 'merge-agent');
  let requests = 0;
  const client = createWatcherOctokit({
    authProvider: options => githubTokenForTarget({ token: env.GITHUB_TOKEN, target: options, env }),
    octokitFactory: options => new Octokit({ ...options, request: { fetch: async (_url, options) => {
      assert.equal(options.headers.authorization, 'token merge-agent@other-org-1');
      requests++;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    } } }),
  });
  await client.request('GET /repos/other-org/x/pulls');
  const execFileImpl = async (_cmd, _args, options) => {
    assert.equal(options.env.GH_TOKEN, 'merge-agent@other-org-1');
    requests++;
    return { stdout: '{"ok":true}', stderr: '' };
  };
  await adapter.runGitHubAdapter('pull-request', { repo: 'other-org/x', prNumber: 1 }, { execFileImpl, env });
  await execGhWithRetry({ env, args: ['pr', 'view', '1', '-R', 'other-org/x'], execFileImpl, log: quiet });
  assert.equal(requests, 3);
});

test('Octokit pins owner token in request hook and preserves home/org requests', async () => {
  const env = serviceEnv(), seen = [];
  const client = createWatcherOctokit({ authProvider: options => githubTokenForTarget({ token: env.GITHUB_TOKEN, target: options, env }),
    octokitFactory: options => new Octokit({ ...options, request: { fetch: async (_url, options) => {
      seen.push(options.headers.authorization);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    } } }),
  });
  await client.request('GET /repos/{owner}/{repo}/pulls', { owner: 'other-org', repo: 'x' });
  await client.request('GET /repos/home-org/x/pulls');
  await client.request('GET /orgs/home-org/repos');
  assert.deepEqual(seen, ['token merge-agent@other-org-1', 'token home-service', 'token home-service']);
  install({ mint: async () => { throw new Error('broker down'); } });
  await assert.rejects(client.request('GET /repos/other-org/x/pulls'), outage);
  assert.equal(seen.length, 3, 'no request with home credential after refusal');
});

test('gh targets route child and budget credential env, home env remains unchanged', async () => {
  const env = serviceEnv();
  for (const args of [['pr', 'view', '1', '--repo', 'other-org/x'], ['api', 'repos/other-org/x/pulls/1'],
    ['pr', 'view', 'https://github.com/other-org/x/pull/1']]) {
    await meteredExecFile(async (_cmd, _args, options) => {
      assert.equal(options.env.GH_TOKEN, 'merge-agent@other-org-1');
      assert.equal(options.env.GITHUB_TOKEN, options.env.GH_TOKEN);
      assert.equal(options.credentialEnv.GH_TOKEN, options.env.GH_TOKEN);
      return { stdout: '{}', stderr: '' };
    }, 'gh', args, { env });
  }
  await meteredExecFile(async (_cmd, _args, options) => {
    assert.deepEqual(options.env, { ...env, GH_DEBUG: 'api' });
    return { stdout: '{}', stderr: '' };
  }, 'gh', ['pr', 'view', '1', '--repo', 'home-org/x'], { env });
  assert.equal(env.GH_TOKEN, 'home-service');
});

test('gh refuses unknown roles and sync cache misses; sync uses warmed cache only', async () => {
  const never = () => { throw new Error('must not execute'); };
  await assert.rejects(meteredExecFile(never, 'gh', ['pr', 'view', '-R', 'other-org/x'], { env: { GH_TOKEN: 'pat' } }), outage);
  const env = serviceEnv(), args = ['pr', 'view', '-R', 'other-org/x'];
  assert.throws(() => meteredExecFileSync(never, 'gh', args, { env }), outage);
  await githubTokenForTarget({ token: env.GH_TOKEN, env, target: args });
  meteredExecFileSync((_cmd, _args, options) => {
    assert.equal(options.env.GH_TOKEN, 'merge-agent@other-org-1');
    assert.equal(options.credentialEnv.GH_TOKEN, options.env.GH_TOKEN);
    return '{}';
  }, 'gh', args, { env });
});

test('managed hammer session keeps its entitlement without owner selection', async () => {
  const env = { GH_TOKEN: 'managed', MERGE_AGENT_GH_TOKEN: 'managed',
    MERGE_AGENT_GH_TOKEN_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString(), GHO_API_CALL_LOG_DISABLE: '1' };
  install({ mint: async () => { throw new Error('must not mint'); } });
  await meteredExecFile(async (_cmd, _args, options) => {
    assert.equal(options.env.GH_TOKEN, 'managed'); return { stdout: '{}', stderr: '' };
  }, 'gh', ['pr', 'view', '-R', 'other-org/x'], { env, hammerToken: true });
});

test('gh auth rejection invalidates and existing one-shot retry forces a fresh owner token', async () => {
  const { calls } = install(), tokens = [], env = serviceEnv();
  await execGhWithRetry({ env, args: ['pr', 'view', '1', '-R', 'other-org/x'], log: quiet,
    refreshGhAuthImpl: () => { throw new Error('home refresh must not run'); },
    execFileImpl: async (_cmd, _args, options) => {
      tokens.push(options.env.GH_TOKEN);
      if (tokens.length === 1) throw Object.assign(new Error('Bad credentials (HTTP 401)'), { stderr: 'HTTP 401' });
      return { stdout: '{}', stderr: '' };
    },
  });
  assert.deepEqual(tokens, ['merge-agent@other-org-1', 'merge-agent@other-org-2']);
  assert.equal(calls[1].force, true); assert.equal(env.GH_TOKEN, 'home-service');
});

test('gh owner remint failure retains structured authentication outage diagnostics', async () => {
  let mints = 0, executions = 0;
  install({ mint: async () => {
    if (++mints > 1) throw new Error('broker unreachable');
    return { token: 'owner-rejected', expiresAtMs: Date.now() + 3600_000 };
  } });
  await assert.rejects(execGhWithRetry({
    env: serviceEnv(), args: ['pr', 'view', '1', '-R', 'other-org/x'], log: quiet,
    execFileImpl: async () => {
      executions++;
      throw Object.assign(new Error('Bad credentials (HTTP 401)'), { stderr: 'HTTP 401' });
    },
  }), err => {
    assert.equal(err.name, 'GithubAuthOutageError');
    assert.equal(err.failureClass, 'github-auth-outage');
    assert.equal(err.remintAttempted, false);
    assert.match(err.remintDetail, /re-mint threw:.*github-owner-token-unavailable/);
    assert.match(err.cause.message, /Bad credentials/);
    return true;
  });
  assert.equal(executions, 1);
  assert.equal(mints, 2);
});

test('merge writes preserve adapter auth arguments for both home and routed repositories', () => {
  for (const repo of ['home-org/x', 'other-org/x']) {
    const args = adapter.makeAdapterWriteArgs('pull-request-merge', { repo, prNumber: 1 },
      { ...serviceEnv(), WATCHER_GH_AUTH_VIA_BROKER: 'true' });
    assert.ok(!args.includes('--auth'));
    assert.ok(!args.includes('--auth-mode'));
    assert.ok(!args.includes('--pat-env'));
  }
});

test('adapter reviewer write and service read use owner env, refuse absent tokens and preserve home', async () => {
  const env = { ...serviceEnv(), [reviewerEnv]: 'reviewer-home', GHA_ADAPTER_BIN: 'fixture-adapter' }, seen = [];
  const execFileImpl = async (_bin, args, options) => {
    seen.push({ args, env: options.env }); return { stdout: '{"ok":true}', stderr: '' };
  };
  await writeAdapterPullRequestReview('other-org/x', 1, { body: 'fixture', reviewerLogin: 'codex-reviewer' }, { execFileImpl, env });
  assert.equal(seen[0].env[reviewerEnv], 'codex-reviewer@other-org-1');
  assert.ok(seen[0].args.includes('env-token')); assert.ok(!seen[0].args.includes('broker'));
  await adapter.runGitHubAdapter('pull-request', { repo: 'other-org/x', prNumber: 1 }, { execFileImpl, env });
  assert.equal(seen[1].env.GH_TOKEN, 'merge-agent@other-org-2');
  assert.ok(seen[1].args.includes('env-token'));
  await adapter.runGitHubAdapter('pull-request', { repo: 'home-org/x', prNumber: 1 }, { execFileImpl, env });
  assert.deepEqual(seen[2].env, { GHO_API_CONSUMER: 'github-owner-token.test', GH_TOKEN: 'home-service', GITHUB_TOKEN: 'home-service',
    [reviewerEnv]: 'reviewer-home', GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: env.GHO_RATE_LIMIT_SHARED_STATE_PATH });
  assert.deepEqual(adapter.makeAdapterArgs('pull-request', { repo: 'home-org/x', prNumber: 1, reviewerLogin: 'codex-reviewer' }, env),
    ['pr-state', '--json', '--repo', 'home-org/x', '--number', '1']);
  await assert.rejects(writeAdapterPullRequestReview('other-org/x', 1, { body: 'fixture', reviewerLogin: 'codex-reviewer' },
    { execFileImpl, env: { GHA_ADAPTER_BIN: 'fixture-adapter' } }), outage);
  assert.throws(() => adapter.makeAdapterWriteArgs('pull-request-review', { repo: 'other-org/x', reviewerLogin: 'codex-reviewer' }, brokerEnv), outage);
  assert.equal(seen.length, 3);
});

test('pre-write cleanup selects owner token before raw REST and refuses failed mint', async () => {
  const seen = [], env = { [reviewerEnv]: 'reviewer-home' };
  const args = { repo: 'other-org/x', prNumber: 1, token: 'reviewer-home', tokenEnv: reviewerEnv, env, selfLogin: 'codex-reviewer', log: quiet,
    fetchImpl: async (_url, options) => { seen.push(options.headers.Authorization); return ok([{ id: 1, state: 'PENDING', user: { login: 'codex-reviewer[bot]' } }]); } };
  assert.equal((await clearPendingReviewsForSelf(args)).cleared, 1);
  assert.deepEqual(seen, ['token codex-reviewer@other-org-1', 'token codex-reviewer@other-org-1']);
  install({ mint: async () => { throw new Error('unavailable'); } });
  await assert.rejects(clearPendingReviewsForSelf(args), outage); assert.equal(seen.length, 2);
});

test('workflow-push mint verifies routed owner metadata and home mint preserves URL/token', async () => {
  const { options, urls } = brokerOptions(response({ provider: 'github-app-merge-agent' }), {
    ...brokerEnv, OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID: '1001', OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATIONS: 'other-org:2002',
  });
  assert.equal((await mintMergeAgentWorkflowPushToken({ ...options, owner: 'other-org' })).token, 'owner-token');
  assert.equal(urls[0], 'http://broker.fixture/token?provider=github-app-merge-agent&owner=other-org');
  await mintMergeAgentWorkflowPushToken({ ...options, owner: 'home-org' });
  assert.equal(urls[1], 'http://broker.fixture/token?provider=github-app-merge-agent');
  await assert.rejects(mintMergeAgentWorkflowPushToken({ ...brokerOptions(response()).options, owner: 'other-org' }), outage);
});

test('workflow-push escalation takes owner from job repo', async () => {
  const urls = [], env = { ...serviceEnv(), ...brokerEnv,
    ADVERSARIAL_REMEDIATION_WORKFLOW_PUSH_ESCALATE_TO_MERGE_AGENT: 'true' };
  const result = await assertWorkflowPushCapabilityForJob({ job: { repo: 'other-org/x', prNumber: 1, changedPaths: ['.github/workflows/fixture.yml'] }, env,
    log: quiet, retryDelaysMs: [], readFileImpl: () => 'synthetic-secret',
    fetchImpl: async url => { urls.push(url); return ok(response({ provider: 'github-app-merge-agent' })); },
    execFileImpl: async () => ({ stdout: 'X-OAuth-Scopes: repo', stderr: '' }), deliverAlertImpl: async () => {},
  });
  assert.equal(result.escalated, true);
  assert.match(urls[0], /&owner=other-org$/);
});

test('one-PR reviewer context, side calls and posting all use owner tokens after auth recovery', async t => {
  const values = { [reviewerEnv]: 'reviewer-home', GITHUB_REVIEWER_TOKEN_ENV: reviewerEnv,
    GITHUB_TOKEN: 'reviewer-home', GH_TOKEN: 'reviewer-home', CODEX_REVIEWER_AUTH_VIA_BROKER: 'true',
    GHA_ADAPTER_BIN: '', AGENT_OS_GITHUB_ADAPTER_BIN: '', AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0',
    GHO_DISABLE_GRAPHQL_ROLLUP: '0' };
  const previous = Object.fromEntries([...Object.keys(values), ...Object.keys(brokerEnv)].map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { options } = brokerOptions(response({ access_token: 'reviewer-home-refreshed', metadata: { app_id: '1001', installation_id: '1001' } }), { ...brokerEnv, ...process.env });
  Object.assign(process.env, brokerEnv);
  const seen = [], { calls } = install();
  const context = await fetchPRContext('other-org/x', 1, { botTokenEnv: reviewerEnv, log: quiet,
    fetchImpl: options.fetchImpl, readFileImpl: options.readFileImpl, recordApiCallImpl() {},
    execFileImpl: async (_cmd, _args, options) => {
      seen.push(options.env.GH_TOKEN);
      if (seen.length === 1) throw Object.assign(new Error('Bad credentials (HTTP 401)'), { stderr: 'HTTP 401' });
      return { stdout: JSON.stringify({ data: { repository: { pullRequest: { number: 1, title: 'fixture', headRefOid: 'a'.repeat(40), comments: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
    },
  });
  assert.equal(context.number, 1);
  assert.deepEqual(seen, ['codex-reviewer@other-org-1', 'codex-reviewer@other-org-2']);
  assert.equal(calls[1].force, true);
  await refreshReviewerTokensForSideCalls([reviewerEnv], { pinBotTokenEnv: reviewerEnv, env: process.env, fetchImpl: options.fetchImpl, readFileImpl: options.readFileImpl, log: quiet });
  await clearPendingReviewsForSelf({ repo: 'other-org/x', prNumber: 1, token: process.env[reviewerEnv], tokenEnv: reviewerEnv, selfLogin: 'codex-reviewer', log: quiet,
    fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, 'token codex-reviewer@other-org-2'); return ok([]); } });
  await postExactHeadReview({ repo: 'other-org/x', prNumber: 1, reviewerHeadSha: 'a'.repeat(40), reviewBody: 'fixture review', env: process.env,
    execFileImpl: async (_cmd, _args, options) => { assert.equal(options.env.GH_TOKEN, 'codex-reviewer@other-org-2'); return { stdout: '{}', stderr: '' }; } });
});


test('reviewer posting retries once with a fresh owner token after a failed owner write', async () => {
  const env = { ...brokerEnv, [reviewerEnv]: 'reviewer-home', CODEX_REVIEWER_AUTH_VIA_BROKER: 'true',
    GHA_ADAPTER_BIN: '', AGENT_OS_GITHUB_ADAPTER_BIN: '', AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0',
    GHO_API_CALL_LOG_DISABLE: '1', GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH };
  const { calls } = install(), tokens = [], brokerUrls = [];
  await reviewer.postGitHubReview('other-org/x', 1, 'Synthetic review', reviewerEnv, async (_cmd, _args, options) => {
    tokens.push(options.env.GH_TOKEN);
    if (tokens.length === 1) throw Object.assign(new Error('Bad credentials (HTTP 401)'), { stderr: 'HTTP 401', status: 401 });
    return { stdout: '{}', stderr: '' };
  }, { env, reviewerIdentity: 'codex-reviewer', log: quiet, readFileImpl: () => 'synthetic-secret',
    fetchImpl: async url => {
      if (url.startsWith('http://broker.fixture/')) {
        brokerUrls.push(url);
        return ok(response({ access_token: 'reviewer-home-new', metadata: { app_id: '1001', installation_id: '1001' } }));
      }
      return ok([]);
    },
  });
  assert.deepEqual(tokens, ['codex-reviewer@other-org-1', 'codex-reviewer@other-org-2']);
  assert.equal(calls[1].force, true);
  assert.deepEqual(brokerUrls, ['http://broker.fixture/token?provider=github-app-codex-reviewer&force=1']);
  assert.equal(env[reviewerEnv], 'reviewer-home-new', 'owner tokens never replace the reviewer home environment');
});


test('failed owner mint is isolated and a later call can recover without stale single-flight state', async () => {
  let calls = 0;
  const { selector } = install({ mint: () => {
    if (++calls === 1) throw new Error('temporary fixture refusal');
    return { token: 'recovered-owner', expiresAtMs: Date.now() + 3600_000 };
  } });
  const args = { token: 'reviewer-home', env: { [reviewerEnv]: 'reviewer-home' }, target: 'other-org/x' };
  await assert.rejects(selector.select(args), outage);
  assert.equal(await selector.select(args), 'recovered-owner');
});


test('GitHub API pre-admission leaves managed hammer credentials to the entitlement seam', async t => {
  const values = { GH_TOKEN: 'managed', GITHUB_TOKEN: 'managed', MERGE_AGENT_GH_TOKEN: 'managed',
    MERGE_AGENT_GH_TOKEN_EXPIRES_AT: new Date(Date.now() + 3600_000).toISOString(), HAM_ROOT_DIR: 'fixture-root' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  install({ mint: () => { throw new Error('must not mint'); } });
  await githubApi.execGhJson(async (_cmd, _args, options) => {
    assert.equal(options.env.GH_TOKEN, 'managed'); return { stdout: '{}', stderr: '' };
  }, ['api', 'repos/other-org/x/pulls/1']);
});


test('cropped child env can mint from Node broker config without forwarding that config', async t => {
  const names = { OAUTH_BROKER_SHARED_SECRET_FILE: 'fixture-secret', [reviewerEnv]: 'inherited-reviewer' };
  const before = Object.fromEntries(Object.keys(names).map(key => [key, process.env[key]]));
  Object.assign(process.env, names);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const { calls } = install();
  const child = { GH_TOKEN: 'inherited-reviewer' };
  const selected = await githubEnvForTarget(child, 'other-org/x');
  assert.equal(selected.GH_TOKEN, 'codex-reviewer@other-org-1');
  assert.equal(calls[0].env.OAUTH_BROKER_SHARED_SECRET_FILE, 'fixture-secret');
  assert.equal(selected.OAUTH_BROKER_SHARED_SECRET_FILE, undefined);
  assert.deepEqual(child, { GH_TOKEN: 'inherited-reviewer' });
});

test('adapter service selection respects GITHUB_TOKEN precedence and budgets the selected owner token', async () => {
  const env = { ...serviceEnv(), GH_TOKEN: 'different-reviewer', [reviewerEnv]: 'different-reviewer', GHA_ADAPTER_BIN: 'fixture-adapter' };
  const { calls } = install();
  await adapter.runGitHubAdapter('pull-request', { repo: 'other-org/x', prNumber: 1 }, { env,
    execFileImpl: async (_cmd, args, options) => {
      assert.equal(options.env.GITHUB_TOKEN, 'merge-agent@other-org-1');
      assert.equal(options.env.GH_TOKEN, options.env.GITHUB_TOKEN);
      assert.equal(args[args.indexOf('--auth') + 1], 'merge-agent');
      assert.equal(githubAdapterReadCredential(options.env, 'other-org/x'), githubCredential({ env: options.env }));
      return { stdout: '{"ok":true}', stderr: '' };
    },
  });
  assert.equal(calls[0].role, 'merge-agent');
});

test('raw REST identity-probe authentication failure invalidates its owner cache', async () => {
  const env = { [reviewerEnv]: 'raw-home' };
  await clearPendingReviewsForSelf({ repo: 'other-org/x', prNumber: 1, token: 'raw-home', tokenEnv: reviewerEnv, env, log: quiet,
    fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.throws(() => githubOwnerTokens.sync({ token: 'raw-home', tokenEnv: reviewerEnv, env, target: 'other-org/x' }), outage);
});

test('home owner is read once for all known targets in a selector', async () => {
  let reads = 0;
  const { selector } = install({ readHomeOwner: () => { reads++; return 'HOME-ORG'; } });
  const args = { token: 'fixture-home', env: { [reviewerEnv]: 'fixture-home' } };
  assert.equal(await selector.select({ ...args, target: 'home-org/x' }), 'fixture-home');
  assert.equal(await selector.select({ ...args, target: 'other-org/x' }), 'codex-reviewer@other-org-1');
  assert.equal(reads, 1);
});
