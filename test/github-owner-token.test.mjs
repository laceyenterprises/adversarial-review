import { fixtureAdapterBin, legacyMint, tokenFixture } from './helpers/github-adapter-token-fixture.mjs';
import './helpers/rate-limit-state-isolation.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Octokit } from '@octokit/rest';
import { createGithubOwnerTokenSelector, githubOwnerTokens, githubTargetOwner, githubTargetRepo,
  githubTokenForTarget, githubTokenRole, githubEnvForTarget, recordGithubToken } from '../src/github-owner-token.mjs';
import { fetchReviewerTokenFromBroker, refreshWatcherGithubToken } from '../src/reviewer-broker-refresh.mjs';
import { createWatcherOctokit } from '../src/conditional-request.mjs';
import { meteredExecFile, meteredExecFileSync } from '../src/metered-gh.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { __test__ as adapter, writeAdapterPullRequestReview, githubAdapterReadCredential } from '../src/github-adapter-client.mjs';
import { clearPendingReviewsForSelf } from '../src/reviewer-pre-write.mjs';
import { assertWorkflowPushCapabilityForJob } from '../src/remediation-workflow-push-capability.mjs';
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
function install(options = {}) {
  const calls = [];
  const selector = createGithubOwnerTokenSelector({ readHomeOwner: () => 'home-org',
    mint: async args => { calls.push(args); return { token: `${args.role}@${args.owner ?? args.repo.split('/')[0]}-${calls.length}`, expiresAtMs: Date.now() + 3600_000 }; },
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

test('adapter token request requires the repository and role and preserves force refresh', async () => {
  const requests = [];
  const env = { ...brokerEnv, GHA_ADAPTER_BIN: fixtureAdapterBin };
  const result = await fetchReviewerTokenFromBroker({ role: 'codex-reviewer', repo: 'other-org/x', env, force: true,
    execFileImpl: tokenFixture(({ role, repo, force }) => { requests.push({ role, repo, force }); return response(); }),
  });
  assert.equal(result.token, 'owner-token');
  assert.equal(githubCredential({ token: result.token, env }), 'installation-1001-2002');
  assert.deepEqual(requests, [{ role: 'codex-reviewer', repo: 'other-org/x', force: true }]);
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

test('Octokit repository selectors retain the complete repo for token resolution', () => {
  assert.equal(githubTargetRepo({ owner: 'Other-Org', repo: 'repo' }), 'other-org/repo');
  assert.equal(githubTargetRepo({ url: '/repos/Other-Org/repo/pulls' }), 'other-org/repo');
  assert.equal(githubTargetRepo({ owner: 'other-org' }), null);
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
    GHA_ADAPTER_BIN: fixtureAdapterBin };
  assert.equal(githubTokenRole(env.GITHUB_TOKEN, env), undefined);
  const result = await refreshWatcherGithubToken({ env, repo: 'home-org/x', force: true, log: quiet,
    execFileImpl: tokenFixture(() => response({ provider: 'github-app-merge-agent', access_token: 'production-refreshed-service',
      metadata: { app_id: '1001', installation_id: '1001' } })) });
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
  const execFileImpl = async (_cmd, args, options) => {
    const expectedToken = args.includes('--role') ? undefined : 'merge-agent@other-org-1';
    assert.equal(options.env.GH_TOKEN, expectedToken);
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
      assert.equal('credentialEnv' in options, false, 'executors never receive the credential map');
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
    assert.equal('credentialEnv' in options, false, 'executors never receive the credential map');
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

test('adapter reviewer writes and service reads delegate routed credentials', async () => {
  const env = { ...serviceEnv(), [reviewerEnv]: 'reviewer-home', GHA_ADAPTER_BIN: fixtureAdapterBin }, seen = [];
  const execFileImpl = async (_bin, args, options) => {
    seen.push({ args, env: options.env }); return { stdout: '{"ok":true}', stderr: '' };
  };
  for (const [role, run] of [
    ['codex-reviewer', () => writeAdapterPullRequestReview('other-org/x', 1, { body: 'fixture', reviewerLogin: 'codex-reviewer' }, { execFileImpl, env })],
    ['merge-agent', () => adapter.runGitHubAdapter('pull-request', { repo: 'other-org/x', prNumber: 1 }, { execFileImpl, env })],
  ]) {
    await run();
    const { args, env: childEnv } = seen.at(-1);
    assert.equal(args[args.indexOf('--role') + 1], role);
    assert.equal(args[args.indexOf('--repo') + 1], 'other-org/x');
    assert.equal(childEnv.GH_TOKEN, undefined);
    assert.equal(childEnv[reviewerEnv], undefined);
  }
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

test('alternate-owner workflow preflight requires a reader and uses the guarded publication resolver', async () => {
  const job = { repo: 'other-org/x', prNumber: 1, changedPaths: ['.github/workflows/fixture.yml'] };
  const opts = { env: serviceEnv(), log: quiet, workerClass: 'codex', retryDelaysMs: [],
    fetchImpl: () => assert.fail('alternate owner must not reach home workflow escalation'),
    deliverAlertImpl: () => assert.fail('alternate-owner refusal uses the publication hold'),
  };
  await assert.rejects(assertWorkflowPushCapabilityForJob({ ...opts, job,
    execFileImpl: () => assert.fail('missing reader must hold before any command'),
  }), { code: 'remediation-owner-auth-hold', reason: 'no declared reader role' });
  const calls = [];
  const result = await assertWorkflowPushCapabilityForJob({ ...opts, job: { ...job, reviewerRole: 'codex-reviewer' },
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, ...args.slice(-4)]);
      return { stdout: JSON.stringify({ token: 'owner-token', expires_at: '2099-01-01T00:00:00Z' }) };
    },
  });
  assert.equal(result.ownerPushRoute.url, 'https://github.com/other-org/x.git');
  assert.deepEqual(calls, [['bash', 'other-org/x', 'other-org', 'github-app-merge-agent', 'workflow']]);
