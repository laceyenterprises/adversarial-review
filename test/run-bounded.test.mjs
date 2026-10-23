import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runBounded } from '../src/ama/bounded-command.mjs';
import { LEASE_VALIDATION_IDLE_MS, pytestValidationEnvironment } from '../src/ama/lease-validation.mjs';
import { buildMergeAgentPrompt, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER } from '../src/merge-agent-prompt.mjs';

async function run(code, options = {}) {
  let out = ''; let err = '';
  const status = await runBounded(process.execPath, ['-e', code], {
    timeoutMs: 3000, idleMs: 1000, graceMs: 100,
    stdout: { write: chunk => { out += chunk; } },
    stderr: { write: chunk => { err += chunk; } }, ...options,
  });
  return { status, out, err };
}

test('legacy lease-owning prompt requires the same bounded validation helper and release trap', () => {
  const prompt = buildMergeAgentPrompt({ repo: 'fixture/repo', prNumber: 42, baseBranch: 'main' },
    { trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER });
  assert.ok(prompt.includes("hammer-validate.mjs' --pytest -- <required test paths>"));
  assert.ok(prompt.includes('unscaled 120s no-output bound'));
  assert.ok(prompt.includes('Any timeout, cancellation or test failure must exit nonzero'));
  assert.ok(prompt.includes('trap cleanup_merge_lease EXIT'));
  assert.ok(prompt.includes('--changed-files-from "$POST_REMEDIATION_SHA"'));
});

test('lease validator permits a project nominal budget but refuses malformed or missing input', () => {
  for (const args of [['--nominal-timeout', '0', '--', 'true'],
    ['--nominal-timeout', '3601', '--', 'true'], ['--nominal-timeout'], ['--pytest', '--']]) {
    const result = spawnSync(process.execPath, ['bin/hammer-validate.mjs', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 64, result.stderr);
  }
  const result = spawnSync(process.execPath, ['bin/hammer-validate.mjs', '--nominal-timeout', '10',
    '--', process.execPath, '-e', 'process.exit(0)'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /idle=120000ms/);
});

test('reserved cleanup failure retains private scratch instead of unlinking evidence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ham-retain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['bin/hammer-validate.mjs', '--', process.execPath,
    '-e', 'process.exit(125)'], { env: { ...process.env, TMPDIR: dir }, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 125, result.stderr);
  assert.match(result.stderr, /scratch retained for canonical cleanup/);
  assert.equal(readdirSync(dir).filter(name => name.startsWith('ham-validation-')).length, 1);
});

test('silent CPU work fails on idle, independently of a load-expanded ceiling', async () => {
  const result = await run('while(true) {}', { timeoutMs: 2160_000, idleMs: 200 });
  assert.equal(result.status, 124);
  assert.match(result.err, /no-progress-timeout.*bytes=0/);
});

test('child stdout and stderr advance idle; progress never defeats absolute deadline', async () => {
  const result = await run('setInterval(() => {process.stdout.write("p"); process.stderr.write("e")}, 40)',
    { idleMs: 300, timeoutMs: 650, tailBytes: 8 });
  assert.equal(result.status, 124);
  assert.match(result.err, /absolute-timeout/);
  assert.ok(Buffer.byteLength(result.out) <= 9);
  assert.match(result.out, /[pe]/);
});

test('failure and signal exit statuses stay failures; missing command fails closed', async () => {
  assert.equal((await run('console.error("failure"); process.exit(7)')).status, 7);
  assert.equal((await run('process.kill(process.pid, "SIGTERM")')).status, 143);
  const status = await runBounded('/does-not-exist-ham-fixture', [], {
    stdout: { write() {} }, stderr: { write() {} },
  });
  assert.equal(status, 127);
});

test('unreadable cleanup never reports success or holds the lease indefinitely', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 42424, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { throw Object.assign(new Error('fixture permission refusal'), { code: 'EPERM' }); },
    unref() { this.unreferenced = true; },
  });
  let err = '';
  const signals = [];
  const started = performance.now();
  const status = await runBounded('fixture', [], {
    timeoutMs: 10_000, idleMs: 50, graceMs: 50,
    spawnImpl: () => child,
    killImpl: (_pid, signal) => {
      signals.push(signal);
      throw Object.assign(new Error('fixture permission refusal'), { code: 'EPERM' });
    },
    stdout: { write() {} }, stderr: { write(chunk) { err += chunk; } },
  });
  assert.equal(status, 125);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.match(err, /cleanup=unconfirmed/);
  assert.ok(child.unreferenced && child.stdout.destroyed && child.stderr.destroyed);
  assert.ok(performance.now() - started < 3000);
});

test('idle failure after first output stops a lease-owning script before its audit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ham-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn('/bin/bash', ['-c', `
    trap 'printf released > "$1/release"' EXIT
    bin/run-bounded.sh --timeout 20 --idle-timeout 1 -- node -e 'console.log("test-start"); setInterval(()=>{},1000)' || exit $?
    printf validated > "$1/audit"
  `, '_', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', chunk => { out += chunk; });
  let err = ''; child.stderr.on('data', chunk => { err += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 124);
  assert.match(out, /test-start/);
  assert.match(err, /no-progress-timeout/);
  assert.equal(readFileSync(join(dir, 'release'), 'utf8'), 'released');
  assert.throws(() => readFileSync(join(dir, 'audit')), { code: 'ENOENT' });
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM']) {
  test(`cancellation ${signal} cleans a TERM-ignoring descendant after leader exit`, { timeout: 12_000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'ham-cancel-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pidFile = join(dir, 'pid');
    const child = spawn(process.execPath, ['bin/run-bounded.mjs', '--timeout', '20', '--', process.execPath, '-e', `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], {stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',()=>{
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(child.pid));
        fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});
        console.log('ready');
      });
      setInterval(()=>{},1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const done = once(child, 'close');
        child.kill('SIGTERM');
        await done;
      }
    });
    let err = ''; child.stderr.on('data', chunk => { err += chunk; });
    // The supervisor buffers output, so readiness comes from the fixture PID file.
    const readyDeadline = Date.now() + 3000;
    let pid;
    while (true) {
      try {
        const raw = readFileSync(pidFile, 'utf8').trim();
        const candidate = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : 0;
        if (Number.isSafeInteger(candidate) && candidate > 1) { pid = candidate; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(Date.now() < readyDeadline, 'fixture did not become ready');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(pid > 1, 'never probe the caller process group as PID zero');
    const done = once(child, 'close');
    child.kill(signal);
    const [code] = await done;
    assert.equal(code, { SIGTERM: 143, SIGINT: 130, SIGHUP: 129, SIGALRM: 124 }[signal]);
    assert.match(err, /canceled:|external-timeout:/);
    // Linux can retain a dead orphan zombie; it holds no resources.
    const reapDeadline = Date.now() + 1000;
    do {
      try { process.kill(pid, 0); }
      catch (error) { assert.equal(error.code, 'ESRCH'); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < reapDeadline);
    // An unreadable probe cannot prove exit. Only a confirmed zombie qualifies.
    const state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    assert.ok(state.startsWith('Z'), `descendant remains live: ${state}`);
  });
}

test('pytest routing removes inherited live settings but retains required disposable tests', () => {
  const profile = pytestValidationEnvironment({
    AGENT_OS_SESSION_LEDGER_DSN: 'live', AGENT_OS_SESSION_LEDGER_DSN_DIRECT: 'live-direct',
    AGENT_OS_SESSION_LEDGER_VDB: 'true', AGENT_OS_SESSION_LEDGER_DB_PATH: '/live.db',
    AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'required',
    AGENT_OS_SESSION_LEDGER_TEST_DSN: 'disposable', AGENT_OS_TEST_ALLOW_PG: '1',
    SESSION_LEDGER_ALEMBIC_TEST_DSN: 'disposable-migration', PYTEST_ADDOPTS: '--strict-markers',
  }, '/fixture', '/plugin');
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_DSN, undefined);
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_DSN_DIRECT, undefined);
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_VDB, 'false');
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_BACKEND, 'sqlite');
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME, 'off');
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_DB_PATH, '/fixture/ledger.db');
  assert.equal(profile.AGENT_OS_SESSION_LEDGER_TEST_DSN, 'disposable');
  assert.equal(profile.SESSION_LEDGER_ALEMBIC_TEST_DSN, 'disposable-migration');
  assert.equal(profile.AGENT_OS_TEST_ALLOW_PG, '1');
  assert.equal(profile.PYTEST_ADDOPTS, '--strict-markers');
  assert.equal(LEASE_VALIDATION_IDLE_MS, 120_000);
});

test('pytest phase evidence bypasses capture and records actual outcomes without heartbeats', () => {
  const result = spawnSync('python3', ['-c', `
import contextlib, io, runpy, types
captured = io.StringIO()
with contextlib.redirect_stderr(captured):
    p = runpy.run_path('bin/pytest/ham_pytest_progress.py')
    session = types.SimpleNamespace(items=[1, 2])
    p['pytest_sessionstart'](session)
    p['pytest_collectstart'](types.SimpleNamespace(nodeid='fixture.py'))
    p['pytest_collection_finish'](session)
    p['pytest_runtest_logstart']('fixture.py::test_real', None)
    p['pytest_runtest_logreport'](types.SimpleNamespace(when='call', outcome='failed', nodeid='fixture.py::test_real'))
    p['pytest_sessionfinish'](session, 1)
assert captured.getvalue() == ''
`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  for (const phase of ['plugin-loaded', 'session-start', 'collect fixture.py', 'collected 2',
    'test-start fixture.py::test_real', 'call:failed fixture.py::test_real', 'session-finish 1']) {
    assert.ok(result.stderr.includes(`HAM pytest: ${phase}`), result.stderr);
  }
});
