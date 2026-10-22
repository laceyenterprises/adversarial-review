import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __test__ } from '../src/reviewer.mjs';
import { fetchPRContext } from '../src/reviewer-context-auth.mjs';
import { BROKER_REVIEWER_ROLES } from '../src/reviewer-broker-refresh.mjs';
import { GithubAuthOutageError } from '../src/gh-cli.mjs';

const head = 'a'.repeat(40);
const rejected = () => Object.assign(new Error('gh: Bad credentials (HTTP 401)'), {
  stderr: 'gh: Bad credentials (HTTP 401)', code: 1, status: 401,
});
const payload = (body = 'required context', hasNextPage = false) => ({
  data: { repository: { pullRequest: {
    id: 'PR_fixture', number: 42, title: 'fixture', body, headRefOid: head,
    baseRefName: 'main', author: { login: 'fixture-builder' },
    comments: { nodes: [], pageInfo: { hasNextPage, endCursor: 'page-1' } },
  } } },
});

function fixture(t, selected = BROKER_REVIEWER_ROLES[2], overrides = {}) {
  const upper = selected.role.replaceAll('-', '_').toUpperCase();
  const values = {
    GH_TOKEN: 'fixture-operator', GITHUB_TOKEN: 'fixture-merge-agent',
    WATCHER_GH_AUTH_VIA_BROKER: 'true', WATCHER_GH_BROKER_ROLE: 'merge-agent',
    OAUTH_BROKER_URL: 'http://broker.fixture', OAUTH_BROKER_URL_FALLBACK: 'http://broker.fixture',
    OAUTH_BROKER_SHARED_SECRET_FILE: '/fixture/secret',
    GEMINI_REVIEWER_GH_TOKEN: undefined,
    GHA_ADAPTER_BIN: '', AGENT_OS_GITHUB_ADAPTER_BIN: '', AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY: '0',
    GHO_DISABLE_GRAPHQL_ROLLUP: '0',
  };
  for (const role of BROKER_REVIEWER_ROLES) {
    values[role.flag] = role === selected ? 'true' : 'false';
    values[role.envVar] = role === selected ? 'fixture-rejected' : `fixture-other-${role.role}`;
    values[`${role.envVar}_SOURCE`] = undefined;
    values[`${role.envVar}_BROKER_PROVIDER`] = undefined;
  }
  values[`OAUTH_BROKER_${upper}_PROVIDER`] = `github-app-${selected.role}`;
  values[`OAUTH_BROKER_${upper}_EXPECTED_APP_ID`] = '123';
  values[`OAUTH_BROKER_${upper}_EXPECTED_INSTALLATION_ID`] = '456';
  Object.assign(values, overrides);
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  function apply(env) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  apply(values);
  t.after(() => apply(previous));
  const calls = { reads: [], mints: [], logs: [], telemetry: [] };
  const response = {
    access_token: 'fixture-replacement', provider: `github-app-${selected.role}`,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    metadata: { app_id: '123', installation_id: '456' },
  };
  const options = {
    botTokenEnv: selected.envVar,
    log: { warn: message => calls.logs.push(message) },
    recordApiCallImpl: event => calls.telemetry.push(event),
    readFileImpl: path => { assert.equal(path, '/fixture/secret'); return 'fixture-broker-secret'; },
    fetchImpl: async (url, opts) => {
      calls.mints.push(url);
      assert.equal(url, `http://broker.fixture/token?provider=github-app-${selected.role}&force=1`);
      assert.equal(opts.headers.Authorization, 'Bearer fixture-broker-secret');
      assert.ok(opts.signal);
      return { ok: true, json: async () => response };
    },
    execFileImpl: async (command, args, opts) => {
      assert.equal(command, 'gh');
      assert.ok(args.some(arg => arg.includes('query PullRequestReviewContext')));
      assert.ok(args.includes('prNumber=42'));
      calls.reads.push(opts.env.GH_TOKEN);
      assert.equal(opts.env.GH_TOKEN, process.env[selected.envVar]);
      assert.equal(opts.env.GITHUB_TOKEN, process.env[selected.envVar]);
      assert.equal(opts.env.OAUTH_BROKER_SHARED_SECRET_FILE, undefined);
      if (opts.env.GH_TOKEN === 'fixture-rejected') throw rejected();
      return { stdout: JSON.stringify(payload()) };
    },
  };
  return { selected, options, calls, response };
}

for (const role of BROKER_REVIEWER_ROLES) {
  test(`LAC-2082: ${role.role} context 401 forces only its broker and re-pins reads and exact-head posting`, async t => {
    const { options, calls } = fixture(t, role);
    const context = await fetchPRContext('fixture/repo', 42, options);
    assert.equal(context.body, 'required context');
    assert.equal(context.headRefOid, head);
    assert.deepEqual(calls.reads, ['fixture-rejected', 'fixture-replacement']);
    assert.equal(calls.mints.length, 1);
    assert.equal(process.env.GH_TOKEN, 'fixture-replacement');
    assert.equal(process.env.GITHUB_TOKEN, 'fixture-replacement');
    for (const other of BROKER_REVIEWER_ROLES.filter(other => other !== role)) {
      assert.equal(process.env[other.envVar], `fixture-other-${other.role}`);
    }
    assert.deepEqual(calls.telemetry.map(event => event.status), [401, 200]);
    assert.doesNotMatch(calls.logs.join('\n'), /fixture-rejected|fixture-replacement|fixture-broker-secret/);

    const rootDir = mkdtempSync(join(tmpdir(), 'context-post-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let posts = 0;
    await __test__.postGitHubReview('fixture/repo', 42, '## Verdict\nComment only', role.envVar,
      async (_command, args, opts) => {
        posts++;
        assert.ok(args.includes('repos/fixture/repo/pulls/42/reviews'));
        assert.equal(opts.env.GH_TOKEN, 'fixture-replacement');
        assert.equal(JSON.parse(opts.input).commit_id, head);
        return { stdout: JSON.stringify({ id: 7, commit_id: head }) };
      }, {
        env: process.env, rootDir, reviewerHeadSha: head, log: options.log,
        prepareReviewWrite: async ({ token }) => assert.equal(token, 'fixture-replacement'),
      });
    assert.equal(posts, 1);
  });
}

test('context re-mint is bounded when GitHub rejects the replacement too', async t => {
  const { options, calls } = fixture(t);
  options.execFileImpl = async (_command, _args, opts) => {
    calls.reads.push(opts.env.GH_TOKEN);
    throw rejected();
  };
  await assert.rejects(fetchPRContext('fixture/repo', 42, options), err =>
    err instanceof GithubAuthOutageError && err.remintAttempted && /after one broker re-mint/.test(err.message));
  assert.deepEqual(calls.reads, ['fixture-rejected', 'fixture-replacement']);
  assert.equal(calls.mints.length, 1);
});

test('healthy selected token captures context without a broker request', async t => {
  const { options, calls } = fixture(t, BROKER_REVIEWER_ROLES[2], { GH_GEMINI_REVIEWER_TOKEN: 'fixture-still-valid' });
  const context = await fetchPRContext('fixture/repo', 42, options);
  assert.equal(context.headRefOid, head);
  assert.deepEqual(calls.reads, ['fixture-still-valid']);
  assert.deepEqual(calls.mints, []);
});

for (const [name, patch] of [
  ['wrong provider', { provider: 'github-app-merge-agent' }],
  ['wrong App', { metadata: { app_id: '999', installation_id: '456' } }],
  ['wrong installation', { metadata: { app_id: '123', installation_id: '999' } }],
  ['PAT fallback with matching App IDs', { metadata: {
    app_id: '123', installation_id: '456', credential_source: 'github_pat_fallback',
  } }],
  ['unchanged rejected token', { access_token: 'fixture-rejected' }],
  ['expired replacement', { expires_at: '2020-01-01T00:00:00Z' }],
  ['unknown expiry', { expires_at: undefined }],
]) {
  test(`context fails closed on ${name} without replay or credential drift`, async t => {
    const { options, calls, response, selected } = fixture(t);
    Object.assign(response, patch);
    await assert.rejects(fetchPRContext('fixture/repo', 42, options), GithubAuthOutageError);
    assert.deepEqual(calls.reads, ['fixture-rejected']);
    assert.equal(calls.mints.length, 1);
    assert.equal(process.env[selected.envVar], 'fixture-rejected');
    assert.equal(process.env.GH_TOKEN, 'fixture-rejected');
    assert.equal(process.env.GITHUB_TOKEN, 'fixture-rejected');
  });
}

test('static selected token never refreshes watcher credentials or uses operator auth', async t => {
  const { options, calls } = fixture(t, BROKER_REVIEWER_ROLES[2], { GEMINI_REVIEWER_AUTH_VIA_BROKER: 'false' });
  await assert.rejects(fetchPRContext('fixture/repo', 42, options), GithubAuthOutageError);
  assert.deepEqual(calls.reads, ['fixture-rejected']);
  assert.equal(calls.mints.length, 0);
});

test('missing selected token refuses context before any GitHub or broker request', async t => {
  const { options, calls } = fixture(t, BROKER_REVIEWER_ROLES[2], { GH_GEMINI_REVIEWER_TOKEN: undefined });
  await assert.rejects(fetchPRContext('fixture/repo', 42, options), GithubAuthOutageError);
  assert.deepEqual(calls.reads, []);
  assert.deepEqual(calls.mints, []);
});

test('broker authorization/key failure is terminal for this read and does not try standby', async t => {
  const { options, calls } = fixture(t);
  process.env.OAUTH_BROKER_URL_FALLBACK = 'http://standby.fixture';
  options.fetchImpl = async url => {
    calls.mints.push(url);
    return { ok: false, status: 403, json: () => assert.fail('do not log broker response bodies') };
  };
  await assert.rejects(fetchPRContext('fixture/repo', 42, options), GithubAuthOutageError);
  assert.equal(calls.mints.length, 1);
  assert.deepEqual(calls.reads, ['fixture-rejected']);
});

for (const source of ['secret file', 'transport', 'timeout']) {
  test(`broker ${source} failure is preserved as the outage cause without public detail leakage`, async t => {
    const { options, calls, selected } = fixture(t);
    const brokerErr = new Error(`fixture-broker-secret ${source} failure`);
    if (source === 'timeout') brokerErr.name = 'AbortError';
    if (source === 'secret file') {
      options.readFileImpl = () => { throw brokerErr; };
    } else {
      options.fetchImpl = async url => {
        calls.mints.push(url);
        throw brokerErr;
      };
    }
    await assert.rejects(fetchPRContext('fixture/repo', 42, options), err => {
      assert.ok(err instanceof GithubAuthOutageError);
      assert.equal(err.failureClass, 'github-auth-outage');
      assert.equal(err.remintAttempted, true);
      assert.equal(err.cause, brokerErr);
      assert.match(err.message, /broker re-mint failed/);
      assert.doesNotMatch(err.message, /fixture-broker-secret/);
      return true;
    });
    assert.deepEqual(calls.reads, ['fixture-rejected']);
    assert.equal(calls.mints.length, source === 'secret file' ? 0 : 1);
    assert.equal(process.env[selected.envVar], 'fixture-rejected');
    assert.equal(process.env.GH_TOKEN, 'fixture-rejected');
    assert.equal(process.env.GITHUB_TOKEN, 'fixture-rejected');
    assert.doesNotMatch(calls.logs.join('\n'), /fixture-broker-secret/);
  });
}

test('a later scheduled attempt recovers after broker repair with the same selected role', async t => {
  const { options, calls } = fixture(t);
  const mint = options.fetchImpl;
  options.fetchImpl = async url => {
    calls.mints.push(url);
    return { ok: false, status: 403 };
  };
  await assert.rejects(fetchPRContext('fixture/repo', 42, options), GithubAuthOutageError);
  assert.deepEqual(calls.reads, ['fixture-rejected']);
  assert.equal(calls.mints.length, 1);

  // The scheduler's existing hold/claim logic is covered by the outage-budget
  // and claim-loop suites. Its next invocation needs no reset or role change.
  options.fetchImpl = mint;
  const context = await fetchPRContext('fixture/repo', 42, options);
  assert.equal(context.headRefOid, head);
  assert.deepEqual(calls.reads, ['fixture-rejected', 'fixture-rejected', 'fixture-replacement']);
  assert.equal(calls.mints.length, 2);
});

test('transient primary broker failure tries standby once with the same forced selected provider', async t => {
  const { options, calls, response } = fixture(t);
  process.env.OAUTH_BROKER_URL_FALLBACK = 'http://standby.fixture';
  options.fetchImpl = async url => {
    calls.mints.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('provider'), 'github-app-gemini-reviewer');
    assert.equal(parsed.searchParams.get('force'), '1');
    if (calls.mints.length === 1) return { ok: false, status: 503 };
    assert.equal(parsed.origin, 'http://standby.fixture');
    return { ok: true, json: async () => response };
  };
  const context = await fetchPRContext('fixture/repo', 42, options);
  assert.equal(context.headRefOid, head);
  assert.equal(calls.mints.length, 2);
  assert.deepEqual(calls.reads, ['fixture-rejected', 'fixture-replacement']);
});

for (const detail of ['gh: Resource not accessible by integration (HTTP 403)', 'gh: Not Found (HTTP 404)', 'gh: provider quota exhausted']) {
  test(`non-401 context failure does not mint: ${detail}`, async t => {
    const { options, calls } = fixture(t);
    const failure = Object.assign(new Error(detail), { stderr: detail });
    options.execFileImpl = async () => { throw failure; };
    await assert.rejects(fetchPRContext('fixture/repo', 42, options), err => err === failure);
    assert.deepEqual(calls.mints, []);
  });
}

test('401 on a later context page restarts capture; partial first-pass context is discarded', async t => {
  const { options, calls } = fixture(t);
  let page = 0;
  options.execFileImpl = async (_command, args, opts) => {
    calls.reads.push(opts.env.GH_TOKEN);
    page++;
    if (page === 1) return { stdout: JSON.stringify(payload('partial stale context', true)) };
    if (page === 2) { assert.ok(args.includes('commentsAfter=page-1')); throw rejected(); }
    assert.ok(!args.includes('commentsAfter=page-1'));
    return { stdout: JSON.stringify(payload()) };
  };
  const context = await fetchPRContext('fixture/repo', 42, options);
  assert.equal(context.body, 'required context');
  assert.deepEqual(calls.reads, ['fixture-rejected', 'fixture-rejected', 'fixture-replacement']);
  assert.equal(calls.mints.length, 1);
});
