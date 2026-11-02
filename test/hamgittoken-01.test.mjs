import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hammerGitOptions } from '../src/hammer-token.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES } from '../src/ama/hammer-phase-outcome.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';

const root = resolve('.');
const head = 'a'.repeat(40);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const verify = readFileSync('bin/hammer-verify-head.sh', 'utf8');
const bounded = verify.slice(verify.indexOf('ham_update_branch_transient() {'), verify.indexOf('ham_update_branch_with_retries() {'));
const publish = readFileSync('bin/hammer-publish.sh', 'utf8').match(/^ham_git\(\) \{[\s\S]*?^\}/m)[0];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hamgittoken-01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'clock'), '0');
  writeFileSync(join(dir, 'count'), '0');
  writeFileSync(join(dir, 'config.yaml'), 'version: 1\n');
  const refresh = join(dir, 'refresh.cjs');
  writeFileSync(refresh, `const fs = require('node:fs');
const dir = process.env.FIXTURE_DIR;
const count = Number(fs.readFileSync(dir + '/count')) + 1;
fs.writeFileSync(dir + '/count', String(count));
const token = ['synthetic', 'mint', fs.readFileSync(dir + '/clock', 'utf8'), count].join('-');
process.stderr.write(token);
if (process.env.FAIL_REFRESH === '1') { process.stdout.write(token); process.exit(1); }
if (process.env.FAIL_REFRESH === 'invalid') { process.stdout.write('invalid ' + token); process.exit(0); }
process.stdout.write('export GH_TOKEN=' + token + '\\n');
`);
  // A fake remote uses real Git's credential protocol. It rejects credentials
  // older than 3600 simulated seconds and logs its entire environment/argv.
  // No fixture writes the minted password to disk, even on the success path.
  writeFileSync(join(dir, 'bin', 'git'), `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process');
const dir = process.env.FIXTURE_DIR, args = process.argv.slice(2);
if (['fetch', 'push', 'ls-remote', 'submodule'].includes(args[0])) {
  fs.appendFileSync(dir + '/remote.log', JSON.stringify({ args, env: process.env,
    url: 'https://github.com/fixture/repo.git' }) + '\\n');
  const result = cp.spawnSync('/usr/bin/git', ['credential', 'fill'], {
    env: process.env, encoding: 'utf8', input: 'protocol=https\\nhost=github.com\\n\\n', timeout: 10000 });
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(128); }
  const password = result.stdout.match(/^password=(.*)$/m)?.[1];
  const match = /^synthetic-mint-(\\d+)-(\\d+)$/.exec(password || '');
  if (!match || Number(fs.readFileSync(dir + '/clock')) - Number(match[1]) > 3600) {
    console.error('fake remote rejected expired credential'); process.exit(128);
  }
  fs.appendFileSync(dir + '/accepted', match[2] + '\\n');
  console.log('remote accepted');
} else if (args[0] === 'rev-parse') console.log('${head}');
`, { mode: 0o755 });
  const expired = ['synthetic', 'mint', '0', '0'].join('-');
  const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, TMPDIR: dir,
    FIXTURE_DIR: dir, AGENT_OS_CONFIG_PATH: join(dir, 'config.yaml'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    HAM_ROOT_DIR: root, HAM_HQ_ROOT: dir, HAM_RUN_DIR: dir,
    HAM_REPO: 'fixture/repo', HAM_PR_NUMBER: '42', HAM_TARGET_REMEDIATION_SHA: head,
    HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', HAM_NODE_BIN: process.execPath,
    HAMMER_LACEY_GH_TOKEN: expired, GH_TOKEN: expired, GITHUB_TOKEN: expired,
    HAMMER_LACEY_GH_TOKEN_EXPIRES_AT: '2099-01-01T00:00:00Z',
    HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: `${quote(process.execPath)} ${quote(refresh)}`,
    GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_CURL_VERBOSE: '1' };
  const run = (script, overrides = {}, baseEnv = env) => spawnSync('/bin/bash', ['-c', script.replaceAll('<<ROOT_DIR>>', root)
    .replaceAll('<<RUN_DIR>>', dir).replaceAll('<<PR_NUMBER>>', '42')], {
    cwd: dir, env: { ...baseEnv, ...overrides }, encoding: 'utf8', timeout: 20000,
  });
  const count = () => Number(readFileSync(join(dir, 'count'), 'utf8'));
  const noLeaks = result => {
    let output = result.stdout + result.stderr;
    const collect = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) collect(full);
        else output += readFileSync(full, 'utf8');
      }
    };
    collect(dir);
    assert.doesNotMatch(output, /synthetic-mint-\d+-\d+/);
  };
  return { dir, env, run, count, noLeaks };
}

test('HAMGITTOKEN-01: base fetch after an hour mints again; publish and ls-remote share the helper', t => {
  const f = fixture(t);
  let result = f.run(`${bounded}\nBASE_BRANCH=main\nham_capture_current_base_sha`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.count(), 1);
  f.noLeaks(result);
  writeFileSync(join(f.dir, 'clock'), '4000');
  result = f.run(`${bounded}\nBASE_BRANCH=main\nham_capture_current_base_sha\n${publish}\nham_git push origin HEAD:refs/heads/fixture --force-with-lease=refs/heads/fixture:${head}\nham_git ls-remote origin`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.count(), 4);
  assert.equal(readFileSync(join(f.dir, 'accepted'), 'utf8'), '1\n2\n3\n4\n');
  f.noLeaks(result);
  const log = readFileSync(join(f.dir, 'remote.log'), 'utf8');
  assert.doesNotMatch(log, /gh auth git-credential|GIT_TRACE|GIT_CURL_VERBOSE/);
  assert.match(log, /hammer-git-credential/);
});

for (const fail of ['1', 'invalid']) test(`HAMGITTOKEN-01: ${fail} refresh is explicit, retryable and secret-free`, t => {
  const f = fixture(t);
  const result = f.run(`${bounded}\nBASE_BRANCH=main\nHAM_PHASE_OUTCOME=merge-lease-base-read-failed\nham_capture_current_base_sha\nprintf '%s' "$HAM_PHASE_OUTCOME"`, { FAIL_REFRESH: fail });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'git-credential-refresh-failed');
  assert.match(readFileSync(join(f.dir, 'fetch-base.stderr'), 'utf8'), /git-credential-refresh-failed/);
  assert.equal(f.count(), 1, 'no held-token fallback or retry of a broken mint');
  const attempt = readAmaAuditEntry(f.dir, 'fixture/repo', 42, head).attempts.at(-1);
  assert.equal(attempt.reason, 'git-credential-refresh-failed');
  assert.equal(attempt.outcome, 'deferred');
  assert.ok(HAMMER_RETRYABLE_READ_OUTCOMES.has(attempt.reason));
  f.noLeaks(result);
});

test('HAMGITTOKEN-01: missing refresh command fails without using the held token', t => {
  const f = fixture(t);
  const env = { ...f.env };
  delete env.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND;
  const result = f.run(`${publish}\nham_git ls-remote origin`, {}, env);
  assert.equal(result.status, 76, result.stderr);
  assert.match(result.stderr, /git-credential-refresh-failed/);
  assert.equal(f.count(), 0);
  f.noLeaks(result);
});

test('HAMGITTOKEN-01: failed publication mint returns the same phase outcome', t => {
  const f = fixture(t);
  const result = f.run(`${publish}\nham_git push origin HEAD:fixture\nstatus=$?\nprintf '%s:%s' "$status" "$HAM_PHASE_OUTCOME"`, { FAIL_REFRESH: '1' });
  assert.equal(result.stdout, '76:git-credential-refresh-failed');
  f.noLeaks(result);
});

test('HAMGITTOKEN-01: rebase reads preserve a failed mint and stop before another attempt', t => {
  const f = fixture(t);
  const rebase = verify.match(/^ham_rebase_head\(\) \{[\s\S]*?^\}/m)[0]
    .replace(/<<[A-Z0-9_]+>>/g, head);
  for (const prior of ['', 'git-credential-refresh-failed']) {
    const result = f.run(`${rebase}
POST_REMEDIATION_SHA=${head}
ham_release_merge_lease() { :; }
ham_capture_current_base_sha() { HAM_PHASE_OUTCOME=git-credential-refresh-failed; return 1; }
HAM_PHASE_OUTCOME='${prior}'
ham_rebase_head
status=$?
printf '%s:%s' "$status" "$HAM_PHASE_OUTCOME"`);
    assert.equal(result.stdout, '76:git-credential-refresh-failed', result.stderr);
  }
  assert.equal(f.count(), 0);
});

test('HAMGITTOKEN-01: controller environment covers direct git calls without inherited credentials', t => {
  const f = fixture(t);
  const env = hammerGitOptions({ env: f.env }).env;
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.HAMMER_LACEY_GH_TOKEN, undefined);
  const result = f.run('git ls-remote origin\ngit submodule update --recursive', {}, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.count(), 2);
  f.noLeaks(result);
});

test('HAMGITTOKEN-01: credential helper supports direct executable invocation', t => {
  const f = fixture(t);
  const result = spawnSync(resolve('bin/hammer-git-credential.mjs'), ['get'], {
    env: f.env, encoding: 'utf8', timeout: 10000,
    input: 'protocol=https\nhost=github.com\n\n',
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.match(result.stdout, /^username=x-access-token\npassword=synthetic-mint-0-1\n\n$/);
  assert.equal(f.count(), 1);
  f.noLeaks({ stdout: '', stderr: result.stderr });
});

for (const fail of ['', '1', 'invalid']) {
  test(`HAMGITTOKEN-01: rebased submodule sync ${fail || 'success'} preserves classification before lease release`, t => {
    const f = fixture(t);
    const rebase = verify.match(/^ham_rebase_head\(\) \{[\s\S]*?^\}/m)[0]
      .replaceAll('<<REPO>>', 'fixture/repo').replaceAll('<<PR_URL>>', 'https://github.com/fixture/repo/pull/42');
    const result = f.run(`${bounded}
${rebase}
POST_REMEDIATION_SHA=${head}
HAM_PHASE_OUTCOME=verify-head
HAM_REBASE_ATTEMPTS=0
HAM_REBASE_ATTEMPT_CAP=3
ham_capture_current_base_sha() { HAM_CAPTURED_BASE_SHA=${head}; }
ham_update_branch_with_retries() { HAM_REBASE_PUBLISHED_HEAD=${head}; }
ham_settle_rebase_snapshot() { :; }
ham_is_full_sha() { :; }
ham_bounded_git_sync() { :; }
ham_release_merge_lease() { printf 'release:%s\\n' "$HAM_PHASE_OUTCOME"; }
ham_rebase_head
status=$?
printf '%s:%s' "$status" "$HAM_PHASE_OUTCOME"`, { FAIL_REFRESH: fail });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, fail
      ? 'release:git-credential-refresh-failed\n1:git-credential-refresh-failed'
      : 'remote accepted\n0:verify-head');
    assert.equal(f.count(), 1);
    assert.ok(HAMMER_RETRYABLE_READ_OUTCOMES.has('git-credential-refresh-failed'));
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'remote.log'), 'utf8')).args,
      ['submodule', 'update', '--recursive']);
    f.noLeaks(result);
  });
}
