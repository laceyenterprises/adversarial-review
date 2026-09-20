import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultRefreshWorkspaceAuthEnv,
  isWorkspaceAuthFailure,
  runWorkspaceNetworkCommandWithTransientRetry,
} from '../src/remediation-git-pr-io.mjs';

// Regression cover for the `push-auth-invalid` round-burner.
//
// A remediation worker inherits a GitHub App installation token at spawn
// (~36 min TTL on the reference host). A round that runs longer than the
// remaining life pushes at the very END with a dead token. Before this fix an
// expired credential did not match the transient-network set, so the push threw
// on the first attempt with no re-mint: the work was committed locally and
// never published, and the whole round was wasted.
//
// Observed: adversarial-review#1076, job 04:03:48Z -> 04:43:42Z against a
// merge-agent token that expired 04:21:46Z.

const quietLog = { log() {} };

test('isWorkspaceAuthFailure matches the git and gh auth vocabularies', () => {
  const authFailures = [
    { stderr: 'remote: Invalid username or password.\nfatal: Authentication failed for https://github.com/o/r.git/' },
    { stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled' },
    { message: 'HTTP 401: Bad credentials' },
    { stderr: 'requires authentication' },
    { stderr: 'token has expired' },
  ];
  for (const err of authFailures) {
    assert.equal(isWorkspaceAuthFailure(err), true, `expected auth failure: ${JSON.stringify(err)}`);
  }
});

test('isWorkspaceAuthFailure does not swallow transient network errors', () => {
  const notAuth = [
    { stderr: 'fatal: unable to access: Could not resolve host: github.com' },
    { stderr: 'The requested URL returned error: 502' },
    { stderr: 'RPC failed; curl 56 recv failure: Connection reset by peer' },
    {},
  ];
  for (const err of notAuth) {
    assert.equal(isWorkspaceAuthFailure(err), false, `expected NOT auth: ${JSON.stringify(err)}`);
  }
});

test('an expired credential is re-minted once and the command retried with the NEW env', async () => {
  const seen = [];
  let calls = 0;
  const execFileImpl = async (_cmd, _args, options) => {
    calls += 1;
    seen.push(options.env.GITHUB_TOKEN);
    if (calls === 1) {
      const err = new Error('push failed');
      err.stderr = 'fatal: Authentication failed for https://github.com/o/r.git/';
      throw err;
    }
    return { stdout: 'pushed' };
  };

  const result = await runWorkspaceNetworkCommandWithTransientRetry({
    execFileImpl,
    command: 'git',
    args: ['push', 'origin', 'HEAD'],
    options: { env: { GITHUB_TOKEN: 'expired-token' } },
    log: quietLog,
    refreshAuthEnvImpl: async () => ({
      refreshed: true,
      detail: 'role=merge-agent',
      env: { GITHUB_TOKEN: 'fresh-token' },
    }),
  });

  assert.equal(result.stdout, 'pushed');
  assert.equal(calls, 2, 'expected exactly one retry');
  assert.deepEqual(seen, ['expired-token', 'fresh-token'], 'retry must use the rebuilt env, not the snapshot');
});

test('default auth refresh preserves process env when a gh call omitted options.env', async () => {
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousGhToken = process.env.GH_TOKEN;
  const previousPath = process.env.PATH;
  try {
    process.env.GITHUB_TOKEN = 'expired-token';
    process.env.GH_TOKEN = 'expired-token';
    process.env.PATH = '/fixture/bin';

    const refresh = await defaultRefreshWorkspaceAuthEnv({
      log: quietLog,
      refreshWatcherGithubTokenImpl: async ({ env, force }) => {
        assert.equal(env, process.env, 'no-env callers must refresh the live process env');
        assert.equal(force, true);
        env.GITHUB_TOKEN = 'fresh-token';
        env.GH_TOKEN = 'fresh-token';
        return { refreshed: true, role: 'merge-agent' };
      },
      withGhGitCredentialEnvImpl: (baseEnv) => {
        assert.equal(baseEnv, process.env, 'retry env must be rebuilt from the refreshed process env');
        return { ...baseEnv, GIT_TERMINAL_PROMPT: '0' };
      },
    });

    assert.equal(refresh.refreshed, true);
    assert.equal(refresh.env.GITHUB_TOKEN, 'fresh-token');
    assert.equal(refresh.env.GH_TOKEN, 'fresh-token');
    assert.equal(refresh.env.PATH, '/fixture/bin');
    assert.equal(refresh.env.GIT_TERMINAL_PROMPT, '0');
  } finally {
    if (previousGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousGithubToken;
    }
    if (previousGhToken === undefined) {
      delete process.env.GH_TOKEN;
    } else {
      process.env.GH_TOKEN = previousGhToken;
    }
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

test('a re-mint that lands no new credential fails fast instead of retrying the dead token', async () => {
  let calls = 0;
  const execFileImpl = async () => {
    calls += 1;
    const err = new Error('push failed');
    err.stderr = 'fatal: Authentication failed for https://github.com/o/r.git/';
    throw err;
  };

  await assert.rejects(
    runWorkspaceNetworkCommandWithTransientRetry({
      execFileImpl,
      command: 'git',
      args: ['push', 'origin', 'HEAD'],
      options: { env: { GITHUB_TOKEN: 'expired-token' } },
      log: quietLog,
      // Broker off / down: there is no new credential to try.
      refreshAuthEnvImpl: async () => ({ refreshed: false, detail: 'broker-disabled', env: null }),
    }),
    (err) => {
      assert.match(err.message, /rejected by GitHub authentication/);
      assert.match(err.message, /broker-disabled/);
      assert.match(err.message, /committed locally but unpushed/);
      return true;
    }
  );
  assert.equal(calls, 1, 'must not retry with the same rejected token');
});

test('only one re-mint per call — a second rejection after a fresh credential surfaces', async () => {
  let calls = 0;
  let remints = 0;
  const execFileImpl = async () => {
    calls += 1;
    const err = new Error('push failed');
    err.stderr = 'remote: Invalid username or password.';
    throw err;
  };

  await assert.rejects(
    runWorkspaceNetworkCommandWithTransientRetry({
      execFileImpl,
      command: 'git',
      args: ['push', 'origin', 'HEAD'],
      options: { env: { GITHUB_TOKEN: 'expired-token' } },
      log: quietLog,
      refreshAuthEnvImpl: async () => {
        remints += 1;
        return { refreshed: true, detail: 'role=merge-agent', env: { GITHUB_TOKEN: `fresh-${remints}` } };
      },
    }),
    (err) => {
      assert.match(err.message, /Invalid username or password/);
      return true;
    }
  );
  assert.equal(remints, 1, 'a real authorization problem must not loop the broker');
  assert.equal(calls, 2, 'one original attempt plus one post-re-mint attempt');
});

test('a re-mint that throws does not mask the original auth error', async () => {
  const execFileImpl = async () => {
    const err = new Error('push failed');
    err.stderr = 'fatal: Authentication failed';
    throw err;
  };

  await assert.rejects(
    runWorkspaceNetworkCommandWithTransientRetry({
      execFileImpl,
      command: 'git',
      args: ['push', 'origin', 'HEAD'],
      options: { env: {} },
      log: quietLog,
      refreshAuthEnvImpl: async () => {
        throw new Error('broker unreachable');
      },
    }),
    (err) => {
      assert.match(err.message, /Authentication failed/);
      assert.match(err.message, /re-mint threw: broker unreachable/);
      return true;
    }
  );
});

test('transient network retry behaviour is unchanged', async () => {
  let calls = 0;
  const execFileImpl = async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('net');
      err.stderr = 'fatal: unable to access: Could not resolve host: github.com';
      throw err;
    }
    return { stdout: 'ok' };
  };

  const result = await runWorkspaceNetworkCommandWithTransientRetry({
    execFileImpl,
    command: 'git',
    args: ['fetch'],
    options: { env: {} },
    retryDelaysMs: [1, 1, 1],
    log: quietLog,
    refreshAuthEnvImpl: async () => {
      throw new Error('re-mint must not be consulted for a network error');
    },
  });

  assert.equal(result.stdout, 'ok');
  assert.equal(calls, 3);
});
