import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { hammerTokenSession } from '../src/hammer-token.mjs';
import { closureGateClock } from '../src/ama/closure-gate-read.mjs';

const output = "export HAMMER_LACEY_GH_TOKEN=synthetic-fresh\nexport GH_TOKEN_EXPIRES_AT='2099-01-01T00:00:00Z'\n";
function fixture(t, execute) {
  const calls = [];
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (file !== '/bin/sh') return ''; // Load sampler has no host dependency.
    calls.push(options);
    return execute(options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let now = 0;
  t.mock.method(closureGateClock, 'now', () => now);
  t.mock.method(closureGateClock, 'sleep', ms => { now += ms; });
  const env = { HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: 'synthetic-refresh' };
  return { calls, env, session: () => hammerTokenSession({ credentialEnv: env, hammerToken: true }) };
}

for (const path of ['prepare', 'forced', 'gitCredential', 'checkRefresh']) {
  test(`${path}: owner survives a restart longer than the old ten-second deadline`, t => {
    const f = fixture(t, options => {
      // Offline owner: primary is unavailable for 12 seconds, then the same
      // entitled mint succeeds. Its existing retry window is 135 seconds.
      if (options.timeout < 135_000) throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      return output;
    });
    const session = f.session();
    if (path === 'forced') {
      f.env.HAMMER_LACEY_GH_TOKEN = 'synthetic-held';
      const forced = f.session();
      forced.retry(Object.assign(new Error('HTTP 401 Bad credentials'), { status: 401 }));
      assert.equal(forced.prepare().env.GH_TOKEN, 'synthetic-fresh');
    } else if (path === 'prepare') assert.equal(session.prepare().env.GH_TOKEN, 'synthetic-fresh');
    else if (path === 'gitCredential') assert.equal(session.gitCredential(), 'synthetic-fresh');
    else assert.equal(session.checkRefresh().parsed, true);
    assert.equal(f.calls.length, 1, 'the owner owns retries; caller must let it finish');
    assert.ok(f.calls[0].timeout <= 900_000, 'load-scaled deadline remains bounded');
  });
}

test('an explicit caller deadline remains authoritative and is not scaled again', t => {
  const f = fixture(t, () => output);
  assert.equal(f.session().prepare({ timeoutMs: 25 }).env.GH_TOKEN, 'synthetic-fresh');
  assert.equal(f.calls[0].timeout, 25);
  assert.throws(() => f.session().prepare({ timeoutMs: 0 }), /deadline expired/);
});

for (const reason of ['broker_http_401', 'hcp_http_403', 'binding_changed', 'broker_identity_mismatch']) {
  test(`real auth refusal ${reason} stops immediately with a bounded named reason`, t => {
    const f = fixture(t, () => {
      throw Object.assign(new Error('synthetic-sensitive-error'), {
        status: 1,
        stderr: `entitled GitHub re-mint unavailable: ${reason}; refusing credential fallback\nsynthetic-sensitive-detail`,
      });
    });
    assert.throws(() => f.session().prepare(), error => {
      assert.match(error.message, new RegExp(reason));
      assert.doesNotMatch(error.message, /synthetic-sensitive/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  });
}

test('Git credential mint does not retry an explicit authorization refusal', t => {
  const f = fixture(t, () => {
    throw Object.assign(new Error('sensitive'), {
      stderr: 'entitled GitHub re-mint unavailable: broker_http_403; refusing credential fallback\n',
    });
  });
  assert.throws(() => f.session().gitCredential(), error => {
    assert.equal(error.message, 'git-credential-refresh-failed');
    assert.equal(error.refreshRefusal, 'broker_http_403');
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('Git helper emits the bounded refusal reason alongside the existing failure sentinel', () => {
  const result = childProcess.spawnSync(process.execPath,
    [fileURLToPath(new URL('../bin/hammer-git-credential.mjs', import.meta.url)), 'get'], {
      encoding: 'utf8', timeout: 10_000, input: 'protocol=https\nhost=github.com\n\n',
      env: { PATH: '/usr/bin:/bin',
        HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: "printf '%s\\n' 'entitled GitHub re-mint unavailable: broker_http_403; refusing credential fallback' 'synthetic-private-detail' >&2; exit 1" },
    });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /git-credential-refresh-failed\nentitled-refresh-refused:broker_http_403\n/);
  assert.doesNotMatch(result.stderr, /synthetic-private-detail/);
});

test('an explicit revocation cannot fall back to a held entitled token', t => {
  const f = fixture(t, () => {
    throw Object.assign(new Error('sensitive'), {
      stderr: 'entitled GitHub re-mint unavailable: binding_changed; refusing credential fallback\n',
    });
  });
  f.env.HAMMER_LACEY_GH_TOKEN = 'synthetic-held';
  assert.throws(() => f.session().prepare(), /binding_changed/);
  assert.equal(f.calls.length, 1);
});
