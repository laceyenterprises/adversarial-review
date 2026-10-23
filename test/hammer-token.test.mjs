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
import { githubCredential, githubBudgetKey, markGitHubRateLimited, withGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

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

test('shell credential guards admit refresh-only entitlements and reject ambient credentials', () => {
  for (const [file, expectedCount] of [['bin/hammer-publish.sh', 2], ['bin/hammer-verify-head.sh', 1]]) {
    const source = readFileSync(resolve(file), 'utf8');
    const guards = [...source.matchAll(/if (\[ -z [^\n]+); then\n\s+echo "HAM hard-blocker: no entitled hammer token/g)];
    assert.equal(guards.length, expectedCount, file);
    for (const [, condition] of guards) {
      for (const variable of ['HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN',
        'HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND', 'MERGE_AGENT_GH_TOKEN_REFRESH_COMMAND',
        'HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND', 'missing']) {
        const env = { GH_TOKEN: 'synthetic-ambient', GITHUB_TOKEN: 'synthetic-ambient' };
        if (variable !== 'missing') env[variable] = 'synthetic-entitlement';
        const result = spawnSync('/bin/bash', ['-c', `if ${condition}; then exit 1; fi`], { env, timeout: 5000 });
        assert.equal(result.status, variable === 'missing' ? 1 : 0, `${file}: ${variable}`);
      }
    }
  }
});

test('context history refreshes and retries entitled credentials before HAM_ROOT_DIR is exported', t => {
  const f = fixture(t);
  delete f.env.HAM_ROOT_DIR;
  f.env.GH_TOKEN = 'synthetic-ambient-token';
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const requests = join(f.dir, 'requests.jsonl');
  const rejectedOnce = join(f.dir, 'rejected-once');
  writeFileSync(join(f.dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const path = process.argv[3];
fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(path) + '\\n');
if (process.env.GH_TOKEN !== ${JSON.stringify(fresh)}) {
  process.stderr.write('Bad credentials (HTTP 401)'); process.exit(1);
}
if (path.includes('/compare/')) {
  if (!fs.existsSync(${JSON.stringify(rejectedOnce)})) {
    fs.writeFileSync(${JSON.stringify(rejectedOnce)}, '');
    process.stderr.write('Bad credentials (HTTP 401)'); process.exit(1);
  }
  console.log(JSON.stringify({status:'ahead',total_commits:1,merge_base_commit:{sha:'${base}'},
    commits:[{sha:'${head}',parents:[{sha:'${base}'}],commit:{message:'author change'}}]}));
} else if (path.includes('/git/trees/')) console.log('{"tree":[],"truncated":false}');
else if (path.includes('/reviews?') || path.includes('/statuses?')) console.log('[]');
else if (path.includes('/check-runs?')) console.log('{"check_runs":[]}');
else if (path.includes('/protection')) console.log('{}');
else console.log(JSON.stringify({state:'open',head:{sha:'${head}'},base:{sha:'${base}',ref:'main'}}));
`, { mode: 0o755 });
  const state = join(f.dir, 'state.json');
  writeFileSync(state, '{}');
  const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main',
    resolve('bin/hammer-context.mjs'), 'fixture/repo', '42', '--state-file', state], {
    env: f.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.primaryChange.status, 'available', snapshot.primaryChange.reason);
  assert.equal(snapshot.primaryChange.primaryHead, head);
  const calls = readFileSync(requests, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(path => path.includes('/git/trees/')));
  assert.ok(calls.filter(path => path.includes('/compare/')).length >= 3, 'rejected compare, its retry and author diff');
  assert.equal(f.count(), calls.length, 'every call, including the forced retry, refreshes the entitlement');
});

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

for (const action of ['exec', 'exec-hammer', 'exec-git']) for (const failure of [false, true]) {
  test(`metered CLI ${action} never emits token values on ${failure ? 'failure' : 'success'}`, t => {
    const f = fixture(t);
    writeFileSync(join(f.dir, action === 'exec-git' ? 'git' : 'gh'), `#!${process.execPath}
process.stdout.write(process.env.GH_TOKEN);
process.stderr.write(process.env.GITHUB_TOKEN + ${JSON.stringify(failure ? ' HTTP 401 Bad credentials' : '')});
process.exit(${failure ? 1 : 0});
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, [resolve('bin/metered-gh.mjs'), action, 'api', 'fixture'], {
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

for (const mode of ['async', 'sync', 'spawn']) {
  for (const variable of ['HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN', 'HQ_ENTITLEMENT_GH_TOKEN']) {
    test(`${mode}: ${variable} refresh-only credential owns admission and telemetry`, async t => {
      const f = fixture(t);
      const command = f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
      delete f.env.HAMMER_LACEY_GH_TOKEN;
      delete f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
      f.env[`${variable}_REFRESH_COMMAND`] = command;
      // Generic launch commands require the explicit closer marker.
      const options = { env: f.env, hammerToken: true };
      let calls = 0;
      const execute = (_command, _args, active) => {
        calls++;
        assert.equal(active.env.GH_TOKEN, fresh);
        assert.equal(active.credentialEnv, undefined);
        return { status: 0, stdout: 'ok', stderr: '* Request at fixture\n< HTTP/2.0 200 OK\n< X-Ratelimit-Remaining: 4900\n< X-Ratelimit-Reset: 4102444800\n* Request took 1ms\n' };
      };
      const previous = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
      process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = f.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
      t.after(() => {
        if (previous === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
        else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previous;
      });
      await withGitHubBudgetScope({}, async () => {
        markGitHubRateLimited('core', 'default');
        const result = mode === 'async'
          ? await meteredExecFile(async (...args) => execute(...args), 'gh', ['api', 'fixture'], options)
          : meteredExecFileSync(mode === 'spawn' ? execute : (...args) => {
            const result = execute(...args);
            // Exercise the synchronous exception path and its telemetry too.
            throw Object.assign(new Error('HTTP 403 Forbidden'), result, { status: 1 });
          }, 'gh', ['api', 'fixture'], options);
        assert.equal(result.stdout, 'ok');
      }).catch(error => {
        if (mode !== 'sync') throw error;
        assert.equal(error.status, 1);
        assert.match(error.message, /HTTP 403 Forbidden/);
      });
      assert.equal(calls, 1);
      assert.equal(f.count(), 1);
      const buckets = JSON.parse(readFileSync(f.env.GHO_RATE_LIMIT_SHARED_STATE_PATH, 'utf8')).buckets;
      assert.deepEqual(Object.keys(buckets), [githubBudgetKey('core', githubCredential({ token: fresh }))]);
    });
  }
}

test('refresh-only admission-cache reads are keyed by the resolved credential', async t => {
  const f = fixture(t);
  delete f.env.HAMMER_LACEY_GH_TOKEN;
  const { withAdmissionReadCache } = await import('../src/watcher-admission-read-cache.mjs');
  const other = 'synthetic-second-entitlement';
  let calls = 0;
  const execute = async (_command, _args, options) => {
    calls++;
    return { stdout: options.env.GH_TOKEN === fresh ? 'first' : 'second' };
  };
  await withAdmissionReadCache(async () => {
    for (const expected of ['first', 'second']) {
      const result = await meteredExecFile(execute, 'gh', ['pr', 'view', '42', '--json', 'headRefOid,statusCheckRollup'], { env: f.env });
      assert.equal(result.stdout, expected);
      f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND = `printf %s ${quote(other)}`;
    }
  });
  assert.equal(calls, 2);
});

test('HAM_ROOT_DIR plus a generic launch refresh does not replace service credentials', async t => {
  const f = fixture(t);
  delete f.env.HAMMER_LACEY_GH_TOKEN;
  delete f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
  f.env.GH_TOKEN = 'synthetic-service-token';
  f.env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND = 'exit 99';
  const result = await execGhWithRetry({ env: f.env, args: ['api', 'fixture'],
    execFileImpl: async (_command, _args, options) => {
      assert.equal(options.env.GH_TOKEN, f.env.GH_TOKEN);
      return { stdout: 'ok' };
    },
  });
  assert.equal(result.stdout, 'ok');
});

for (const detail of ['HTTP 401', 'Requires authentication', 'Authentication failed', 'token has expired']) {
  test(`explicit refresh-only CLI context handles ${detail} without watcher remint`, async t => {
    const f = fixture(t);
    delete f.env.HAM_ROOT_DIR;
    delete f.env.HAMMER_LACEY_GH_TOKEN;
    let calls = 0;
    await assert.rejects(execGhWithRetry({ env: f.env, hammerToken: true, args: ['api', 'fixture'],
      execFileImpl: async (_command, _args, options) => {
        calls++;
        assert.equal(options.env.GH_TOKEN, fresh);
        throw new Error(detail);
      },
      refreshGhAuthImpl: () => assert.fail('closer must never use the watcher broker'),
    }), /refresh succeeded, but GitHub rejected/);
    assert.equal(calls, 2);
    assert.equal(f.count(), 2);
  });
}

for (const mode of ['async', 'sync']) {
  test(`${mode}: Git network calls refresh and retry through the entitled credential helper`, async t => {
    const f = fixture(t);
    delete f.env.HAMMER_LACEY_GH_TOKEN;
    f.env.GH_TOKEN = 'synthetic-ambient-worker';
    f.env.GIT_CONFIG_COUNT = '1';
    f.env.GIT_CONFIG_KEY_0 = 'color.ui';
    f.env.GIT_CONFIG_VALUE_0 = 'false';
    let calls = 0;
    const execute = (command, args, options) => {
      calls++;
      assert.equal(command, 'git');
      assert.deepEqual(args, ['push', 'origin', 'HEAD:worker', '--force-with-lease=worker:before']);
      assert.equal(options.env.GH_TOKEN, fresh);
      assert.equal(options.env.GITHUB_TOKEN, fresh);
      assert.equal(options.env.GIT_CONFIG_COUNT, '3');
      assert.equal(options.env.GIT_CONFIG_KEY_0, 'color.ui');
      assert.equal(options.env.GIT_CONFIG_VALUE_0, 'false');
      assert.equal(options.env.GIT_CONFIG_KEY_1, 'credential.helper');
      assert.equal(options.env.GIT_CONFIG_VALUE_1, '');
      assert.equal(options.env.GIT_CONFIG_KEY_2, 'credential.helper');
      assert.equal(options.env.GIT_CONFIG_VALUE_2, '!gh auth git-credential');
      if (calls === 1) throw new Error('fatal: Authentication failed');
      return 'ok';
    };
    const args = ['push', 'origin', 'HEAD:worker', '--force-with-lease=worker:before'];
    const options = { env: f.env, hammerToken: true };
    const result = mode === 'async'
      ? await meteredExecFile(async (...args) => execute(...args), 'git', args, options)
      : meteredExecFileSync(execute, 'git', args, options);
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
    assert.equal(f.count(), 2);
    assert.equal(f.env.GH_TOKEN, 'synthetic-ambient-worker');
  });
}

test('Git credential fill uses the refreshed child token without host configuration', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'gh'), `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'auth git-credential get') process.exit(99);
console.log('username=x-access-token\\npassword=' + process.env.GH_TOKEN + '\\n');
`, { mode: 0o755 });
  const result = meteredExecFileSync(execFileSync, 'git', ['credential', 'fill'], {
    env: { ...f.env, PATH: `${f.dir}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    hammerToken: true, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', timeout: 5000,
  });
  assert.match(result, /password=\[redacted\]/);
  assert.doesNotMatch(result, new RegExp(`${expired}|${fresh}`));
  assert.equal(f.count(), 1);
});

for (const file of ['bin/hammer-publish.sh', 'bin/hammer-merge.sh', 'bin/hammer-verify-head.sh', 'templates/hammer-prompt.md']) {
  test(`${file}: shell gh calls explicitly enable refresh-only hammer credentials`, t => {
    const f = fixture(t);
    const source = readFileSync(resolve(file), 'utf8');
    const definition = source.match(/^ham_gh\(\) \{.*$/m)?.[0];
    assert.ok(definition, file);
    const command = f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
    delete f.env.HAMMER_LACEY_GH_TOKEN;
    delete f.env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
    f.env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND = command;
    f.env.HAM_NODE_BIN = process.execPath;
    writeFileSync(join(f.dir, 'gh'), `#!${process.execPath}
if (process.env.GH_TOKEN !== ${JSON.stringify(fresh)}) process.exit(99);
process.stdout.write('ok');
`, { mode: 0o755 });
    const result = spawnSync('/bin/bash', ['-c', `${definition.replaceAll('<<ROOT_DIR>>', resolve('.'))}\nham_gh api fixture`], {
      env: f.env, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ok');
    assert.equal(f.count(), 1);
  });
}

test('synchronous Git failures capture stderr before redacting credentials', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'git'), `#!${process.execPath}
process.stderr.write(process.env.GH_TOKEN + ' HTTP 401 Bad credentials');
process.exit(1);
`, { mode: 0o755 });
  const script = `import { execFileSync } from 'node:child_process';
import { meteredExecFileSync } from ${JSON.stringify(new URL('../src/metered-gh.mjs', import.meta.url).href)};
try { meteredExecFileSync(execFileSync, 'git', ['push'], { hammerToken: true }); }
catch (error) { process.stderr.write(error.stderr || error.message); process.exitCode = 1; }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: f.env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /refresh succeeded, but GitHub rejected/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${expired}|${fresh}`));
  assert.equal(f.count(), 2);
});
