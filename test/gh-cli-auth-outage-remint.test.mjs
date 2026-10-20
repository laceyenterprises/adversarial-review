import './helpers/load-aware-timeout-fixture.mjs';
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
  isTransientGhError,
} from '../src/gh-cli.mjs';

const SILENT_LOG = { warn() {}, log() {}, error() {} };

function ghError(stderr, extra = {}) {
  const err = new Error(`Command failed: gh\n${stderr}`);
  err.stderr = stderr;
  return Object.assign(err, extra);
}

// The exact stderr the live watcher produced against the expired ghs_ token.
const BAD_CREDENTIALS = 'gh: Bad credentials (HTTP 401)';

test('I/O and transport failures use bounded backoff without retrying permanent failures', async () => {
  for (const error of [
    ghError('spawn gh EIO', { code: 'EIO' }),
    ghError('error connecting: connection reset by peer'),
    ghError('socket hang up'),
    ghError('unexpected EOF'),
    ghError('network is unreachable'),
  ]) {
    assert.equal(isTransientGhError(error), true);
    let attempts = 0;
    const delays = [];
    await assert.rejects(execGhWithRetry({
      args: ['pr', 'view', '7'],
      env: {},
      execFileImpl: async () => { attempts += 1; throw error; },
      sleep: async ms => { delays.push(ms); },
      refreshGhAuthImpl: async () => { assert.fail('transport failure must not refresh authentication'); },
    }), thrown => thrown === error);
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [500, 1000]);
  }
  for (const error of [
    ghError('Resource not accessible by integration (HTTP 403)'),
    ghError('spawn gh ENOENT', { code: 'ENOENT' }),
    ghError('spawn gh EACCES', { code: 'EACCES' }),
  ]) {
    assert.equal(isTransientGhError(error), false);
    let attempts = 0;
    await assert.rejects(execGhWithRetry({
      args: ['pr', 'view', '7'], env: {},
      execFileImpl: async () => { attempts += 1; throw error; },
      sleep: async () => { assert.fail('permanent failure must not back off'); },
    }), thrown => thrown === error);
    assert.equal(attempts, 1);
  }
});

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
  const logger = {
    warnings: [],
    warn(message) { this.warnings.push(message); },
  };

  const result = await execGhWithRetry({
    args: ['pr', 'diff', '6366'],
    env,
    log: logger,
    execFileImpl: async (_bin, _args, opts) => {
      calls.push(opts.env.GH_TOKEN);
      if (opts.env.GH_TOKEN === 'ghs_expired') throw ghError(BAD_CREDENTIALS);
      return { stdout: 'diff --git a/x b/x', stderr: '' };
    },
    refreshGhAuthImpl: async ({ env: targetEnv, log }) => {
      assert.equal(log, logger, 'auth refresh retains the logger object');
      reminted += 1;
      targetEnv.GITHUB_TOKEN = 'ghs_fresh';
      return { refreshed: true, role: 'merge-agent', skipped: null, failed: null };
    },
  });

  assert.equal(result.stdout, 'diff --git a/x b/x');
  assert.equal(reminted, 1, 're-mint must fire exactly once');
  // The retry has to actually pick up the new credential, not replay the dead one.
  assert.deepEqual(calls, ['ghs_expired', 'ghs_fresh']);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /gh pr diff hit GitHub 401.*retrying once/);
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

test('GHBUDGET-01: src gh executions use the shared meter', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { parse } = await import('acorn');
  const root = new URL('../src/', import.meta.url);
  function visit(node, fn) {
    if (!node || typeof node !== 'object') return;
    fn(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, fn));
      else if (value?.type) visit(value, fn);
    }
  }
  const offenders = [];
  for (const file of readdirSync(root, { recursive: true }).filter(file => file.endsWith('.mjs'))) {
    if (file === 'metered-gh.mjs') continue;
    const source = readFileSync(new URL(file, root), 'utf8');
    visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true }), node => {
      if (node.type !== 'CallExpression') return;
      const callee = source.slice(node.callee.start, node.callee.end);
      if (node.arguments[0]?.value === 'gh' && callee !== 'formatCommandForLog') {
        offenders.push(`${file}:${node.loc.start.line}`);
      }
      let shellGh = false;
      for (const arg of node.arguments) visit(arg, child => {
        if (child.type === 'Literal' && /\bgh\s+/.test(String(child.value))) shellGh = true;
      });
      if (/^(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)(?:Impl|Async)?$/.test(callee) && shellGh) {
        offenders.push(`${file}:${node.loc.start.line}: shell command`);
      }
    });
  }
  const python = readFileSync(new URL('adapters/health/github-read.py', root), 'utf8');
  assert.doesNotMatch(python, /\["gh"/);
  assert.match(python, /metered-gh\.mjs/);
  assert.deepEqual(offenders, []);
});

test('GHBUDGET-01: debug envelopes record every resource and discard HTTP bodies', async () => {
  const { parseGhDebug } = await import('../src/metered-gh.mjs');
  const parsed = parseGhDebug(`* Request at fixture\n> Authorization: fixture-secret\n< HTTP/2.0 200 OK\n< X-Ratelimit-Resource: graphql\n< X-Ratelimit-Remaining: 4999\n< X-Ratelimit-Reset: 4102444800\n\nfixture-private-body\n* Request took 1ms\n* Request at fixture\n< HTTP/2.0 429 Too Many Requests\n< X-Ratelimit-Resource: core\n< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: 4102444800\n* Request took 1ms\ngh: rate limit exceeded\n`);
  assert.deepEqual(parsed.observations.map(({ resource, remaining, rateLimited }) => ({ resource, remaining, rateLimited })), [
    { resource: 'graphql', remaining: 4999, rateLimited: false },
    { resource: 'core', remaining: 0, rateLimited: true },
  ]);
  assert.equal(parsed.stderr, 'gh: rate limit exceeded\n');
  assert.doesNotMatch(JSON.stringify(parsed), /fixture-secret|fixture-private-body/);
});

test('GHBUDGET-01: unfinished debug traces retain transport diagnostics without headers or bodies', async () => {
  const { parseGhDebug } = await import('../src/metered-gh.mjs');
  for (const diagnostic of [
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    'Get "https://api.github.com/repos/fixture/repo": dial tcp: lookup api.github.com: no such host',
    'gh: connection reset by peer\nCheck your internet connection.',
    'net/http: TLS handshake timeout',
    'error connecting: connection reset by peer',
    'unexpected EOF',
  ]) {
    const parsed = parseGhDebug(`* Request at fixture\n* Request to https://api.github.com/graphql\n> Authorization: fixture-secret\n\n{"query":"fixture-private-body"}\n* dial tcp: transport failure\n${diagnostic}\n`);
    assert.equal(parsed.stderr, `${diagnostic}\n`);
    assert.deepEqual(parsed.observations, []);
    assert.doesNotMatch(JSON.stringify(parsed), /fixture-secret|fixture-private-body|\* /);
  }
  const completed = parseGhDebug('* Request at fixture\n< HTTP/2.0 200 OK\n\nfailed to finish a task in this private body\nprivate continuation\n* Request took 1ms\n');
  assert.equal(completed.stderr, '');
});

test('GHBUDGET-01: unfinished traces preserve async/sync errors and activate bounded retries', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { meteredExecFileSync } = await import('../src/metered-gh.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'metered-transport-'));
  const prior = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(dir, 'state.json');
  t.after(() => {
    if (prior === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  const diagnostic = 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout\n';
  const stderr = `* Request at fixture\n> Authorization: fixture-secret\n${diagnostic}`;
  let attempts = 0;
  const delays = [];
  let lastError;
  await assert.rejects(execGhWithRetry({
    args: ['pr', 'view', '7'], env: {}, log: SILENT_LOG,
    execFileImpl: async () => { attempts++; lastError = ghError(stderr, { code: 1 }); throw lastError; },
    sleep: async ms => { delays.push(ms); },
    refreshGhAuthImpl: async () => { assert.fail('transport failure must not refresh authentication'); },
  }), error => error === lastError && error.stderr === diagnostic && isTransientGhError(error));
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(lastError.message, `Command failed: gh\n${diagnostic}`);
  const syncError = ghError(stderr, { status: 1, output: [null, '', stderr] });
  assert.throws(() => meteredExecFileSync(() => { throw syncError; }, 'gh', ['api', 'graphql']),
    error => error === syncError && isTransientGhError(error));
  assert.equal(syncError.stderr, diagnostic);
  assert.equal(syncError.message, `Command failed: gh\n${diagnostic}`);
  assert.equal(syncError.output[2], diagnostic);
});

test('metered gh preserves explicit budget env and inherits only missing settings', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { meteredExecFile, meteredExecFileSync } = await import('../src/metered-gh.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'metered-env-'));
  const keys = ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR'];
  const previous = keys.map(key => process.env[key]);
  process.env[keys[0]] = join(dir, 'ambient.json');
  process.env[keys[1]] = '200';
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(dir, { recursive: true, force: true });
  });
  for (const injected of [{}, { [keys[0]]: join(dir, 'explicit.json'), [keys[1]]: '50' }, { [keys[0]]: '', [keys[1]]: '' }]) {
    const env = { FIXTURE: 'preserved', ...injected };
    const inspect = (_command, _args, options) => {
      for (const key of keys) assert.equal(options.env[key], injected[key] ?? process.env[key]);
      assert.equal(options.env.FIXTURE, 'preserved');
      assert.equal(options.env.GH_DEBUG, 'api');
      return { stdout: '{}', stderr: '' };
    };
    await meteredExecFile(inspect, 'gh', ['api', 'repos/fixture/repo'], { env });
    meteredExecFileSync(inspect, 'gh', ['api', 'repos/fixture/repo'], { env });
    assert.deepEqual(env, { FIXTURE: 'preserved', ...injected });
  }
});

test('GHBUDGET-01: fake gh keeps stdout and diagnostics while recording both pools', async t => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { meteredExecFile } = await import('../src/metered-gh.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'metered-gh-'));
  const prior = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(dir, 'state.json');
  t.after(() => {
    if (prior === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
process.stdout.write('fixture stdout');
for (const resource of ['core', 'graphql']) {
  process.stderr.write('* Request at fixture\\n> Authorization: fixture-secret\\n< HTTP/2.0 200 OK\\n< X-Ratelimit-Resource: ' + resource + '\\n< X-Ratelimit-Remaining: 4900\\n< X-Ratelimit-Reset: 4102444800\\n\\nfixture-body\\n* Request took 1ms\\n');
}
process.stderr.write('fixture diagnostic\\n');
`, { mode: 0o755 });
  const result = await meteredExecFile(promisify(execFile), 'gh', ['pr', 'view', '1'], {
    env: { PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 2000,
  });
  assert.equal(result.stdout, 'fixture stdout');
  assert.equal(result.stderr, 'fixture diagnostic\n');
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(state.buckets.core.remaining, 4900);
  assert.equal(state.buckets.graphql.remaining, 4900);
  assert.doesNotMatch(JSON.stringify(state), /fixture-secret|fixture-body/);
});

test('GHBUDGET-01: successful body text and ordinary 403 permissions are not rate-limited reads', async () => {
  const { meteredExecFile, parseGhDebug } = await import('../src/metered-gh.mjs');
  const { withGitHubBudgetScope } = await import('../src/rate-limit-throttle.mjs');
  await withGitHubBudgetScope({}, async scope => {
    const result = await meteredExecFile(async () => ({ stdout: JSON.stringify({ body: 'Fix rate limit exhaustion' }), stderr: '' }), 'gh', ['api', 'repos/fixture/repo/pulls/42']);
    assert.equal(result.rateLimited, undefined);
    assert.equal(scope.rateLimited, false);
  });
  const parsed = parseGhDebug('* Request at fixture\n< HTTP/2.0 403 Forbidden\n< X-Ratelimit-Resource: core\n< X-Ratelimit-Remaining: 4000\n< X-Ratelimit-Reset: 4102444800\n{"message":"Resource not accessible"}\n* Request took 1ms\n');
  assert.equal(parsed.observations[0].rateLimited, false);
});

test('GHBUDGET-01: failed fake gh responses record the window count and preserve the original error', async t => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { meteredExecFile } = await import('../src/metered-gh.mjs');
  const { recordResponseRateLimit, withGitHubBudgetScope } = await import('../src/rate-limit-throttle.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'metered-errors-'));
  const prior = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(dir, 'state.json');
  t.after(() => { process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = prior; rmSync(dir, { recursive: true, force: true }); });
  await recordResponseRateLimit({ resource: 'graphql', remaining: 4900, resetAt: 4102444800 });
  const err = Object.assign(new Error('Command failed'), { stderr: '* Request at fixture\n< HTTP/2.0 429 Too Many Requests\n< X-Ratelimit-Resource: graphql\n< X-Ratelimit-Remaining: 4900\n< X-Ratelimit-Reset: 4102444800\nfixture-private-body\n* Request took 1ms\ngh: rate limit exceeded\n', code: 1 });
  await withGitHubBudgetScope({}, async scope => {
    await assert.rejects(meteredExecFile(async () => { throw err; }, 'gh', ['api', 'graphql']), candidate => candidate === err);
    assert.equal(scope.rateLimited, true);
  });
  assert.equal(err.stderr, 'gh: rate limit exceeded\n');
  assert.equal(err.code, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).buckets.graphql.rateLimitedCalls, 1);
});

test('GHBUDGET-01: native synchronous gh accounts a rejected response exactly once', async t => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { meteredExecFileSync } = await import('../src/metered-gh.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'metered-sync-'));
  const prior = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = join(dir, 'state.json');
  t.after(() => { if (prior === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH; else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = prior; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
process.stderr.write('* Request at fixture\\n< HTTP/2.0 429 Too Many Requests\\n< X-Ratelimit-Resource: graphql\\n< X-Ratelimit-Remaining: 4900\\n< X-Ratelimit-Reset: 4102444800\\nfixture-private-body\\n* Request took 1ms\\ngh: rate limit exceeded\\n');
process.exit(1);
`, { mode: 0o755 });
  assert.throws(() => meteredExecFileSync(execFileSync, 'gh', ['api', 'graphql'], {
    env: { PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8', timeout: 2000,
  }), err => err.stderr === 'gh: rate limit exceeded\n' && !err.message.includes('fixture-private-body'));
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.equal(state.buckets.graphql.rateLimitedCalls, 1);
});
