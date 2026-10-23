import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { meteredExecFile, meteredExecFileSync } from '../src/metered-gh.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { hammerTokenSession } from '../src/hammer-token.mjs';

const expired = 'synthetic-expired-token';
const fresh = 'synthetic-fresh-token';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const refreshes = join(dir, 'refreshes');
  const command = join(dir, 'refresh.cjs');
  writeFileSync(command, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(refreshes)}, 'refresh\\n');
process.stderr.write(${JSON.stringify(fresh)});
process.stdout.write(${JSON.stringify(fresh)});
`);
  const env = { PATH: dir, HOME: dir, HAM_ROOT_DIR: dir, HAMMER_LACEY_GH_TOKEN: expired,
    GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json'),
    HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: `${quote(process.execPath)} ${quote(command)}` };
  return { dir, env, refreshes, count: () => readFileSync(refreshes, 'utf8').trim().split('\n').length };
}
const rejected = () => Object.assign(new Error('gh: Bad credentials (HTTP 401)'), { stderr: 'Bad credentials', code: 1 });

for (const mode of ['async', 'sync', 'spawn']) {
  test(`${mode}: refresh an aged launch token before each GitHub call and once more after 401`, async t => {
    const f = fixture(t);
    let calls = 0;
    const execute = (_command, _args, options) => {
      calls++;
      assert.equal(options.env.GH_TOKEN, fresh);
      assert.equal(options.env.GITHUB_TOKEN, fresh);
      assert.equal(options.credentialEnv, undefined);
      if (calls === 1) {
        if (mode === 'spawn') return { status: 1, stderr: 'HTTP/2.0 401 Unauthorized', stdout: expired };
        throw rejected();
      }
      return mode === 'sync' ? 'ok' : { status: 0, stdout: 'ok', stderr: '' };
    };
    const run = () => mode === 'async'
      ? meteredExecFile(async (...args) => execute(...args), 'gh', ['api', 'fixture'], { env: f.env })
      : meteredExecFileSync(execute, 'gh', ['api', 'fixture'], { env: f.env });
    const result = await run();
    assert.equal(mode === 'sync' ? result : result.stdout, 'ok');
    assert.equal(calls, 2);
    assert.equal(f.count(), 2, 'one pre-call refresh and exactly one refresh after rejection');
    // A later call cannot reuse the token captured before a CI wait.
    await run();
    assert.equal(f.count(), 3);
  });

  test(`${mode}: second rejection stops with the refresh outcome`, async t => {
    const f = fixture(t);
    let calls = 0;
    const execute = () => {
      calls++;
      if (mode === 'spawn') return { status: 1, stderr: 'Bad credentials', stdout: fresh };
      throw rejected();
    };
    const run = () => mode === 'async'
      ? meteredExecFile(async () => execute(), 'gh', ['api', 'fixture'], { env: f.env })
      : meteredExecFileSync(execute, 'gh', ['api', 'fixture'], { env: f.env });
    await assert.rejects(async () => run(), error => {
      assert.equal(error.hammerAuthHandled, true);
      assert.match(error.message, /refresh succeeded, but GitHub rejected the retried call/);
      assert.doesNotMatch(error.stderr, new RegExp(`${expired}|${fresh}`));
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(f.count(), 2);
  });
}

test('without a refresh command the entitled variable is used unchanged', async () => {
  const env = { HAM_ROOT_DIR: '/synthetic/closer', HAMMER_LACEY_GH_TOKEN: expired, GH_TOKEN: 'synthetic-other-token' };
  const result = await meteredExecFile(async (_command, _args, options) => {
    assert.equal(options.env.GH_TOKEN, expired);
    assert.equal(options.env.GITHUB_TOKEN, expired);
    return { stdout: 'ok' };
  }, 'gh', ['api', 'fixture'], { env });
  assert.equal(result.stdout, 'ok');
});

test('legacy variable command wins over the launch fallback; dedicated identity wins over legacy', t => {
  const f = fixture(t);
  const command = f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
  const env = { ...f.env, HAMMER_LACEY_GH_TOKEN: '', MERGE_AGENT_GH_TOKEN: expired,
    MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND: command,
    HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND: 'exit 99' };
  assert.equal(hammerTokenSession({ env }).prepare().env.GH_TOKEN, fresh);
  env.HAMMER_LACEY_GH_TOKEN = expired;
  env.MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND = 'exit 99';
  assert.equal(hammerTokenSession({ env }).prepare().env.GH_TOKEN, fresh);
  delete env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
  env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND = command;
  assert.equal(hammerTokenSession({ env }).prepare().env.GH_TOKEN, fresh);
});

test('credentialEnv survives gh-cli allowlisting without falling through to watcher broker refresh', async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(execGhWithRetry({ env: f.env, args: ['api', 'fixture'],
    execFileImpl: async (_command, _args, options) => {
      calls++;
      assert.equal(options.env.GH_TOKEN, fresh);
      throw rejected();
    },
    refreshGhAuthImpl: () => assert.fail('closer must never use the watcher broker'),
  }), /refresh succeeded, but GitHub rejected/);
  assert.equal(calls, 2);
  assert.equal(f.count(), 2);
});

for (const command of ['exit 1', "printf ''", "printf 'invalid output'"]) {
  test(`failed refresh fails before GitHub: ${command}`, async () => {
    await assert.rejects(meteredExecFile(async () => assert.fail('no GitHub call'), 'gh', ['api', 'fixture'], {
      env: { HAM_ROOT_DIR: '/synthetic/closer', HAMMER_LACEY_GH_TOKEN: expired, HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: command },
    }), /refresh failed/);
  });
}

test('refresh command has a fixed timeout and discards its diagnostics', t => {
  const f = fixture(t);
  const command = `exec ${quote(process.execPath)} -e 'process.stderr.write("synthetic-secret"); setInterval(() => {}, 1000)'`;
  assert.throws(() => hammerTokenSession({ env: { ...f.env, HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: command } }).prepare(),
    error => /refresh failed \(timeout or signal\)/.test(error.message) && !error.message.includes('synthetic-secret'));
});

for (const failure of [false, true]) {
  test(`metered CLI never emits token values on ${failure ? 'failure' : 'success'}`, t => {
    const f = fixture(t);
    writeFileSync(join(f.dir, 'gh'), `#!${process.execPath}
process.stdout.write(process.env.GH_TOKEN);
process.stderr.write(process.env.GITHUB_TOKEN + ${JSON.stringify(failure ? ' HTTP 401 Bad credentials' : '')});
process.exit(${failure ? 1 : 0});
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [resolve('bin/metered-gh.mjs'), 'exec', 'api', 'fixture'], {
      env: f.env, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, failure ? 1 : 0);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${expired}|${fresh}`));
    assert.equal(f.count(), failure ? 2 : 1);
  });
}

test('real synchronous gh execution receives a refreshed token', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'gh'), `#!${process.execPath}
if (process.env.GH_TOKEN !== ${JSON.stringify(fresh)}) process.exit(99);
process.stdout.write('ok');
`, { mode: 0o755 });
  assert.equal(meteredExecFileSync(execFileSync, 'gh', ['api', 'fixture'], { env: f.env, encoding: 'utf8' }), 'ok');
});

test('a missing refresh command reports unavailable without repeating a rejected call', async () => {
  let calls = 0;
  await assert.rejects(meteredExecFile(async () => { calls++; throw rejected(); }, 'gh', ['api', 'fixture'], {
    env: { HAM_ROOT_DIR: '/synthetic/closer', MERGE_AGENT_GH_TOKEN: expired },
  }), /refresh unavailable \(no launch refresh command\)/);
  assert.equal(calls, 1);
});

test('a refresh failure after rejection reports the failed refresh without a second GitHub call', async t => {
  const f = fixture(t);
  const command = f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
  f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND = `if [ -f ${quote(f.refreshes)} ]; then exit 1; fi; ${command}`;
  let calls = 0;
  await assert.rejects(meteredExecFile(async () => { calls++; throw rejected(); }, 'gh', ['api', 'fixture'], {
    env: f.env,
  }), /refresh failed \(command error\)/);
  assert.equal(calls, 1);
});

test('permissions failures retain their status and redact both current and refreshed tokens', t => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => meteredExecFileSync(() => {
    calls++;
    throw Object.assign(new Error(`HTTP 403 ${expired}`), { stderr: fresh, stdout: expired, status: 7 });
  }, 'gh', ['api', 'fixture'], { env: f.env }), error => {
    assert.equal(error.status, 7);
    assert.doesNotMatch(error.message + error.stderr + error.stdout + error.stack, new RegExp(`${expired}|${fresh}`));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(f.count(), 1);
});

test('admission cache separates entitled identities even when the ambient credential is identical', async () => {
  const { withAdmissionReadCache } = await import('../src/watcher-admission-read-cache.mjs');
  let calls = 0;
  const execute = async (_command, _args, options) => {
    calls++;
    return { stdout: options.env.GH_TOKEN === expired ? 'first' : 'second' };
  };
  await withAdmissionReadCache(async () => {
    for (const [token, expected] of [[expired, 'first'], [fresh, 'second']]) {
      const result = await meteredExecFile(execute, 'gh', ['pr', 'view', '42', '--json', 'headRefOid,statusCheckRollup'], {
        env: { HAM_ROOT_DIR: '/synthetic/closer', GH_TOKEN: 'synthetic-ambient-token', HAMMER_LACEY_GH_TOKEN: token },
      });
      assert.equal(result.stdout, expected);
    }
  });
  assert.equal(calls, 2);
});

test('service and reviewer calls keep explicit credentials outside closer context', async () => {
  const env = { GH_TOKEN: 'synthetic-reviewer-token', MERGE_AGENT_GH_TOKEN: expired,
    MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND: 'exit 99' };
  const result = await execGhWithRetry({ env, args: ['api', 'fixture'],
    execFileImpl: async (_command, _args, options) => {
      assert.equal(options.env.GH_TOKEN, env.GH_TOKEN);
      return { stdout: 'ok' };
    },
  });
  assert.equal(result.stdout, 'ok');
});
