// gh-cli-auth-outage-remint.test.mjs — RTOK-01.
//
// The watcher authenticates to GitHub with a broker-minted GitHub App
// INSTALLATION token, which GitHub expires after one hour. On 2026-09-07 a
// watcher with 9h21m of uptime was still holding the token it minted at
// startup; every `gh` call it made returned 401, so no review was generated or
// posted, AMA reported `verdict-not-settled-success`, and nothing merged for
// five hours. Restarting re-minted the token, which is why the pipeline
// reliably worked for exactly one hour after each bounce and looked healthy
// whenever anyone checked it right after a restart.
//
// This suite pins the two behaviours that make that self-healing, plus the
// negative case that keeps the attempt budget meaningful:
//
//   1. A 401 forces a token re-mint and retries the call EXACTLY once. If the
//      re-mint produces a working credential the original call succeeds.
//   2. A 401 that survives the re-mint raises a distinct auth-outage signal
//      (GithubAuthOutageError / `github-auth-outage`) instead of a bare exec
//      failure, and the re-mint is never attempted more than once per call.
//   3. Non-auth failures are untouched: transient errors still use the ordinary
//      retry budget and never trigger a re-mint.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GH_AUTH_OUTAGE_FAILURE_CLASS,
  GithubAuthOutageError,
  execGhWithRetry,
  isGhAuthFailure,
} from '../src/gh-cli.mjs';

const SILENT_LOG = { warn() {}, log() {}, error() {} };

function ghError(stderr, extra = {}) {
  const err = new Error(`Command failed: gh\n${stderr}`);
  err.stderr = stderr;
  return Object.assign(err, extra);
}

// The exact stderr the live watcher produced against the expired ghs_ token.
const BAD_CREDENTIALS = 'gh: Bad credentials (HTTP 401)';

test('isGhAuthFailure recognises rejected credentials but not 403', () => {
  assert.equal(isGhAuthFailure(ghError(BAD_CREDENTIALS)), true);
  assert.equal(isGhAuthFailure(ghError('HTTP 401: Unauthorized (https://api.github.com/user)')), true);
  assert.equal(isGhAuthFailure(ghError('gh: This endpoint requires authentication')), true);
  // 403 on a VALID token is permissions/rate-limit; re-minting cannot fix it.
  assert.equal(isGhAuthFailure(ghError('gh: Resource not accessible by integration (HTTP 403)')), false);
  assert.equal(isGhAuthFailure(ghError('gh: Not Found (HTTP 404)')), false);
  assert.equal(isGhAuthFailure(null), false);
});

test('a 401 forces exactly one re-mint and the retry succeeds on the fresh token', async () => {
  const calls = [];
  let reminted = 0;
  const env = { GITHUB_TOKEN: 'ghs_expired', PATH: '/usr/bin', HOME: '/tmp' };

  const result = await execGhWithRetry({
    args: ['pr', 'diff', '6366'],
    env,
    log: SILENT_LOG,
    execFileImpl: async (_bin, _args, opts) => {
      calls.push(opts.env.GH_TOKEN);
      if (opts.env.GH_TOKEN === 'ghs_expired') throw ghError(BAD_CREDENTIALS);
      return { stdout: 'diff --git a/x b/x', stderr: '' };
    },
    refreshGhAuthImpl: async ({ env: targetEnv }) => {
      reminted += 1;
      targetEnv.GITHUB_TOKEN = 'ghs_fresh';
      return { refreshed: true, role: 'merge-agent', skipped: null, failed: null };
    },
  });

  assert.equal(result.stdout, 'diff --git a/x b/x');
  assert.equal(reminted, 1, 're-mint must fire exactly once');
  // The retry has to actually pick up the new credential, not replay the dead one.
  assert.deepEqual(calls, ['ghs_expired', 'ghs_fresh']);
});

test('a 401 that survives the re-mint raises an auth outage, and only re-mints once', async () => {
  let attempts = 0;
  let reminted = 0;

  await assert.rejects(
    execGhWithRetry({
      args: ['pr', 'diff', '6367'],
      env: { GITHUB_TOKEN: 'ghs_expired', PATH: '/usr/bin', HOME: '/tmp' },
      log: SILENT_LOG,
      execFileImpl: async () => {
        attempts += 1;
        throw ghError(BAD_CREDENTIALS);
      },
      refreshGhAuthImpl: async ({ env: targetEnv }) => {
        reminted += 1;
        targetEnv.GITHUB_TOKEN = 'ghs_also_dead';
        return { refreshed: true, role: 'merge-agent', skipped: null, failed: null };
      },
    }),
    (err) => {
      assert.ok(err instanceof GithubAuthOutageError, 'must be the distinct auth-outage error');
      assert.equal(err.failureClass, GH_AUTH_OUTAGE_FAILURE_CLASS);
      assert.equal(err.authOutage, true);
      assert.equal(err.remintAttempted, true);
      // The original gh output survives for downstream classification/logging.
      assert.match(err.message, /bad credentials/i);
      assert.equal(err.stderr, BAD_CREDENTIALS);
      return true;
    }
  );

  assert.equal(reminted, 1, 'a dead broker must not become an unbounded mint loop');
  assert.equal(attempts, 2, 'original call plus exactly one retry');
});

test('a 401 with no re-mintable credential fails fast as an auth outage', async () => {
  let attempts = 0;

  await assert.rejects(
    execGhWithRetry({
      args: ['pr', 'view', '6368'],
      env: { GITHUB_TOKEN: 'ghp_static_pat', PATH: '/usr/bin', HOME: '/tmp' },
      log: SILENT_LOG,
      execFileImpl: async () => {
        attempts += 1;
        throw ghError(BAD_CREDENTIALS);
      },
      // Broker mode disabled: GITHUB_TOKEN is a static PAT, nothing to re-mint.
      refreshGhAuthImpl: async () => ({
        refreshed: false,
        skipped: 'broker-mode-disabled',
        failed: null,
        role: null,
      }),
    }),
    (err) => {
      assert.ok(err instanceof GithubAuthOutageError);
      assert.equal(err.remintAttempted, false);
      assert.match(err.message, /broker-mode-disabled/);
      return true;
    }
  );

  // No point replaying a credential we could not replace.
  assert.equal(attempts, 1);
});

test('a re-mint that throws still surfaces as an auth outage, not an unhandled rejection', async () => {
  await assert.rejects(
    execGhWithRetry({
      args: ['pr', 'diff', '6369'],
      env: { GITHUB_TOKEN: 'ghs_expired', PATH: '/usr/bin', HOME: '/tmp' },
      log: SILENT_LOG,
      execFileImpl: async () => {
        throw ghError(BAD_CREDENTIALS);
      },
      refreshGhAuthImpl: async () => {
        throw new Error('broker connect ECONNREFUSED');
      },
    }),
    (err) => {
      assert.ok(err instanceof GithubAuthOutageError);
      assert.match(err.message, /re-mint threw: broker connect ECONNREFUSED/);
      return true;
    }
  );
});

test('non-auth failures keep the ordinary retry budget and never re-mint', async () => {
  let attempts = 0;
  let reminted = 0;

  // Transient: still retried on the existing backoff budget.
  const ok = await execGhWithRetry({
    args: ['pr', 'list'],
    env: { GITHUB_TOKEN: 'ghs_fine', PATH: '/usr/bin', HOME: '/tmp' },
    log: SILENT_LOG,
    sleep: async () => {},
    execFileImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw ghError('gh: HTTP 502 Bad Gateway');
      return { stdout: '[]', stderr: '' };
    },
    refreshGhAuthImpl: async () => {
      reminted += 1;
      return { refreshed: true };
    },
  });
  assert.equal(ok.stdout, '[]');
  assert.equal(attempts, 3);
  assert.equal(reminted, 0, 'a 502 is not an auth problem');

  // Non-transient, non-auth: thrown verbatim, unchanged by this work.
  let notFoundAttempts = 0;
  await assert.rejects(
    execGhWithRetry({
      args: ['pr', 'view', '999999'],
      env: { GITHUB_TOKEN: 'ghs_fine', PATH: '/usr/bin', HOME: '/tmp' },
      log: SILENT_LOG,
      execFileImpl: async () => {
        notFoundAttempts += 1;
        throw ghError('gh: Not Found (HTTP 404)');
      },
      refreshGhAuthImpl: async () => {
        reminted += 1;
        return { refreshed: true };
      },
    }),
    (err) => {
      assert.ok(!(err instanceof GithubAuthOutageError));
      assert.match(err.stderr, /404/);
      return true;
    }
  );
  assert.equal(notFoundAttempts, 1);
  assert.equal(reminted, 0);
});
