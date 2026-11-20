import './helpers/rate-limit-state-isolation.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SERIAL_TEST_FILES, orderFiles, workerCount, suiteTimeoutMs } from './helpers/parallel-plan.mjs';
import { fixtureGitEnv } from './helpers/fixture-git-env.mjs';

const helper = path.join(import.meta.dirname, 'helpers', 'parallel-runner.mjs');

test('local parallelism uses half the available cores up to four, or an override', () => {
  assert.equal(workerCount(100, {}, 16), 4);
  assert.equal(workerCount(100, {}, 7), 3);
  assert.equal(workerCount(100, {}, 1), 1);
  assert.equal(workerCount(3, {}, 16), 3);
  assert.equal(workerCount(0, {}, 16), 0);
  assert.equal(workerCount(100, { AR_TEST_CONCURRENCY: '6' }, 16), 6);
  for (const invalid of ['', '0', '-1', '2.5', 'Infinity', '9007199254740992']) {
    assert.equal(workerCount(100, { AR_TEST_CONCURRENCY: invalid }, 16), 4);
  }
  assert.equal(workerCount(100, { CI: 'true', AR_TEST_CONCURRENCY: '1' }, 2), 8);
  assert.equal(workerCount(3, { CI: '1' }, 2), 3);
});

test('suite deadline scales with the configured limit only when parallel files queue', () => {
  for (const [limit, seconds] of [[1, 7200], [2, 3600], [4, 1800], [8, 900], [16, 900]]) {
    const env = { AR_TEST_CONCURRENCY: String(limit) };
    assert.equal(suiteTimeoutMs(100, env, 16), seconds * 1000);
    for (const files of [0, 1, limit]) {
      assert.equal(suiteTimeoutMs(files, env, 16), 900_000);
    }
  }
  assert.equal(suiteTimeoutMs(100, {}, 16), 1_800_000);
  assert.equal(suiteTimeoutMs(4, {}, 16), 900_000);
  for (const files of [0, 1, 2, 8, 100]) {
    assert.equal(suiteTimeoutMs(files, { CI: 'true', AR_TEST_CONCURRENCY: '1' }, 2), 900_000);
  }
});

test('fixture commits, push and fetch skip auto-maintenance in a fresh home', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'fixture-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  mkdirSync(home);
  const trace = path.join(root, 'git-trace.jsonl');
  const env = fixtureGitEnv({ ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '9', GIT_CONFIG_KEY_8: 'maintenance.auto', GIT_CONFIG_VALUE_8: 'true',
    GIT_CONFIG_PARAMETERS: 'invalid inherited config',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_TRACE2_EVENT: trace });
  assert.equal(env.GIT_CONFIG_KEY_8, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '--quiet', '--template=');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  git('init', '--quiet', '--bare', '--template=', path.join(root, 'remote.git'));
  // Git transport strips command config on the receiving side. Configure that
  // separate fixture explicitly; the runner environment controls the client.
  git('--git-dir', path.join(root, 'remote.git'), 'config', 'maintenance.auto', 'false');
  git('push', '--quiet', path.join(root, 'remote.git'), 'HEAD:refs/heads/fixture');
  git('fetch', '--quiet', path.join(root, 'remote.git'), 'refs/heads/fixture');
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0'], ['gc.autoDetach', 'false']]) {
    assert.equal(git('config', '--get', key), value);
  }
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const command of ['commit', 'push', 'fetch']) {
    assert.ok(events.some(event => event.event === 'start' && event.argv.includes(command)), command);
  }
  assert.deepEqual(events.filter(event => ['start', 'child_start'].includes(event.event)
    && event.argv?.includes('maintenance')), []);
});

test('measured order is longest first with deterministic ties and unknown files', () => {
  assert.deepEqual([...SERIAL_TEST_FILES], ['test/smv.test.mjs']);
  const files = ['e', 'd', 'c', 'b', 'a'];
  const durations = { a: 8, b: 7, c: 6, d: 5 };
  const expected = ['a', 'b', 'e', 'c', 'd'];
  assert.deepEqual(orderFiles(files, durations), expected);
  assert.deepEqual(orderFiles([...files].reverse(), durations), expected);
  assert.deepEqual(orderFiles(['z', 'a', 'b'], {}), ['a', 'b', 'z']);
  assert.deepEqual(orderFiles([], {}), []);
});

for (const failure of [false, true]) test(`exclusive phase completes before parallel work and aggregates TAP (failure=${failure})`, t => {
  const root = mkdtempSync(path.join(tmpdir(), 'serial-phase-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['serial.mjs', 'a.mjs', 'b.mjs'];
  const paths = Object.fromEntries(files.map(file => [file, path.join(root, file)]));
  const done = path.join(root, 'done');
  writeFileSync(paths['serial.mjs'], `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    test('exclusive assertion', t => {
      t.diagnostic('exclusive diagnostic retained');
      writeFileSync(${JSON.stringify(done)}, '');
      assert.equal(${failure}, false);
    });
  `);
  for (const file of ['a.mjs', 'b.mjs']) writeFileSync(paths[file], `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    assert.ok(existsSync(${JSON.stringify(done)}), 'exclusive file has completed');
  `);
  const config = path.join(root, 'config.json'), report = path.join(root, 'report.json');
  writeFileSync(config, JSON.stringify({ files, paths, logDir: root, reportPath: report,
    nodeArgs: [], serialFiles: ['serial.mjs'], parallelFiles: files.slice(1), concurrency: 2 }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [helper, config],
    { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, failure ? 1 : 0, child.stdout + child.stderr);
  assert.equal((child.stdout.match(/^1\.\./gm) ?? []).length, 1, child.stdout);
  assert.match(child.stdout, /^1\.\.3$/m);
  assert.match(child.stdout, /^# tests 3$/m);
  assert.match(child.stdout, /exclusive diagnostic retained/);
  assert.match(child.stdout, new RegExp(`^# fail ${failure ? 1 : 0}$`, 'm'));
  assert.equal(JSON.parse(readFileSync(report, 'utf8')).files.length, 3);
  if (failure) assert.match(child.stderr, /Failed test file: serial.mjs/);
});

for (const failure of [false, true]) test(`real parallel processes report every file and propagate failure=${failure}`, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallel-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['b.mjs', 'a.mjs'];
  const paths = Object.fromEntries(files.map((file) => [file, path.join(root, file)]));
  const preload = path.join(root, 'preload.mjs');
  writeFileSync(preload, 'globalThis.parallelFixturePreloaded = true;');
  const assertPreloaded = "import assert from 'node:assert/strict'; assert.equal(globalThis.parallelFixturePreloaded, true);";
  writeFileSync(paths['a.mjs'], `${assertPreloaded} console.log('fixture-a'); process.exitCode = ${failure ? 9 : 0};`);
  writeFileSync(paths['b.mjs'], `${assertPreloaded} console.log('fixture-b');`);
  const reportPath = path.join(root, 'report.json');
  const config = path.join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ files, paths, logDir: root, nodeArgs: ['--import', preload], reportPath,
    parallelFiles: files, concurrency: 2 }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [helper, config], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, failure ? 1 : 0, child.stderr);
  assert.match(child.stdout, /fixture-a[\s\S]*fixture-b/);
  if (failure) assert.match(child.stderr, /Failed test file: a.mjs/);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(report.files.map((r) => r.file), ['a.mjs', 'b.mjs']);
  assert.ok(report.files.every((r) => r.durationMs > 0));
  assert.ok(report.wallMs > 0);
});

for (const [files, ci, seconds] of [[1, 'false', 900], [2, 'false', 7200], [1, 'true', 900], [2, 'true', 900]]) test(`suite timeout bounds ${files} files with CI=${ci} and removes the running sandbox`, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ready = path.join(root, 'ready');
  const hook = path.join(root, 'deadline.mjs');
  writeFileSync(hook, `
    import { existsSync } from 'node:fs';
    import { ChildProcess } from 'node:child_process';
    const emit = ChildProcess.prototype.emit;
    const started = new Set();
    ChildProcess.prototype.emit = function (event, ...args) {
      const result = emit.call(this, event, ...args);
      // Observe only after the runner's message handler has recorded the file.
      if (event === 'message' && args[0].phase === 'started') started.add(args[0].file);
      return result;
    };
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms !== ${seconds * 1000}) return schedule(callback, ms, ...args);
      const check = () => started.has('test/hq-root-runner-probe.test.mjs')
        && started.size === ${ci === 'true' ? files : 1} && existsSync(${JSON.stringify(ready)})
        ? callback(...args) : schedule(check, 10);
      return schedule(check, 10);
    };
  `);
  const env = { ...process.env, ADVERSARIAL_REVIEW_TEST_TEMP_BASE: root,
    HQ_ROOT_FIXTURE_HOLD: ready, HQ_ROOT_FIXTURE_FAIL: '0', CI: ci, AR_TEST_CONCURRENCY: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', hook,
    path.join(import.meta.dirname, 'run-tests.mjs'), 'hq-root-runner-probe.test.mjs',
    ...(files > 1 ? ['hq-root.test.mjs'] : [])], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stderr, new RegExp(`Test suite timed out after ${seconds} seconds`));
  const waiting = files === 2 && ci === 'false' ? 1 : 0;
  assert.match(child.stderr, new RegExp(`${waiting} files waiting to start\\. Active test files: [^\\n]*test/hq-root-runner-probe\\.test\\.mjs`));
  assert.equal(readdirSync(root).some((file) => file.startsWith('art-')), false);
});

test('deadline tracking removes an out-of-order completed file and counts only queued files', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-completion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.dirname(import.meta.dirname);
  mkdirSync(path.join(root, 'test', 'fixtures'), { recursive: true });
  mkdirSync(path.join(root, 'test', 'adapters'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'test', 'run-tests.mjs'), readFileSync(path.join(repo, 'test/run-tests.mjs')));
  for (const name of ['src', 'node_modules', 'test/helpers']) {
    symlinkSync(path.join(repo, name), path.join(root, name), 'dir');
  }
  const held = 'test/a-held.test.mjs', finished = 'test/b-finished.test.mjs';
  writeFileSync(path.join(root, held), `
    import test from 'node:test';
    test('held until the deadline', () => new Promise(resolve => setTimeout(resolve, 60_000)));
  `);
  writeFileSync(path.join(root, finished), "import test from 'node:test'; test('finished first', () => {});");
  writeFileSync(path.join(root, 'test/fixtures/suite-durations.json'), '{}');
  const hook = path.join(root, 'deadline.mjs');
  writeFileSync(hook, `
    import { ChildProcess } from 'node:child_process';
    const emit = ChildProcess.prototype.emit;
    const active = new Set(), completed = new Set();
    ChildProcess.prototype.emit = function (event, ...args) {
      const result = emit.call(this, event, ...args);
      if (event === 'message') {
        const { file, phase } = args[0];
        if (phase === 'started') active.add(file);
        if (phase === 'completed') { active.delete(file); completed.add(file); }
      }
      return result;
    };
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms !== 900_000) return schedule(callback, ms, ...args);
      const check = () => active.has(${JSON.stringify(held)}) && completed.has(${JSON.stringify(finished)})
        ? callback(...args) : schedule(check, 10);
      return schedule(check, 10);
    };
  `);
  const env = { ...process.env, ADVERSARIAL_REVIEW_TEST_TEMP_BASE: root, CI: 'true' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', hook, path.join(root, 'test/run-tests.mjs')], {
    cwd: root, encoding: 'utf8', env, timeout: 20_000,
  });
  assert.equal(child.error, undefined, child.stdout + child.stderr);
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stderr, /Test suite timed out after 900 seconds/);
  assert.match(child.stderr, /0 files waiting to start\. Active test files: test\/a-held\.test\.mjs\./);
  assert.doesNotMatch(child.stderr, /Active test files: [^\n]*b-finished/);
  assert.equal(readdirSync(root).some(file => file.startsWith('art-')), false);
});

test('coordinator finishes native workers after its parent disconnects IPC', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-disconnect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = path.join(root, 'disconnected');
  const file = 'fixture.mjs', fixture = path.join(root, file);
  writeFileSync(fixture, `
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    for (let i = 0; i < 500 && !existsSync(${JSON.stringify(release)}); i++) await delay(10);
    assert.ok(existsSync(${JSON.stringify(release)}), 'parent disconnected before worker completes');
  `);
  const config = path.join(root, 'config.json'), reportPath = path.join(root, 'report.json');
  writeFileSync(config, JSON.stringify({ files: [file], paths: { [file]: fixture },
    logDir: root, nodeArgs: [], parallelFiles: [file], concurrency: 1, reportPath }));
  const launcher = path.join(root, 'launcher.mjs');
  writeFileSync(launcher, `
    import { fork } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = fork(${JSON.stringify(helper)}, [${JSON.stringify(config)}], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.once('message', () => child.disconnect());
    child.once('disconnect', () => writeFileSync(${JSON.stringify(release)}, ''));
    child.once('close', code => { process.exitCode = code ?? 1; });
  `);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [launcher], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.doesNotMatch(child.stderr, /ERR_IPC_CHANNEL_CLOSED|Unhandled 'error'/);
  assert.equal(JSON.parse(readFileSync(reportPath, 'utf8')).files[0].status, 0);
});

test('native scheduling overlaps files within the configured worker bound', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallel-bound-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const active = path.join(root, 'active'), ready = path.join(root, 'ready');
  mkdirSync(active); mkdirSync(ready);
  const files = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs'];
  const paths = Object.fromEntries(files.map(file => [file, path.join(root, file)]));
  for (const [index, file] of files.entries()) writeFileSync(paths[file], `
    import assert from 'node:assert/strict';
    import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const marker = ${JSON.stringify(active)} + '/' + process.pid;
    writeFileSync(marker, '');
    assert.ok(readdirSync(${JSON.stringify(active)}).length <= 2, 'worker bound');
    if (${index} < 2) {
      writeFileSync(${JSON.stringify(ready)} + '/' + process.pid, '');
      // The first two files must coexist; a serial scheduler cannot pass.
      while (readdirSync(${JSON.stringify(ready)}).length < 2) await delay(10);
    }
    unlinkSync(marker);
  `);
  const config = path.join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ files, paths, logDir: root,
    nodeArgs: [], parallelFiles: files, concurrency: 2 }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [helper, config],
    { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(readdirSync(ready).length, 2);
  assert.equal(readdirSync(active).length, 0);
});


for (const failure of [false, true]) test(`exclusive phase preserves aggregate output and failure=${failure}`, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallel-phases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const done = path.join(root, 'done');
  const files = ['serial.mjs', 'a.mjs', 'b.mjs'];
  const paths = Object.fromEntries(files.map(file => [file, path.join(root, file)]));
  writeFileSync(paths['serial.mjs'], `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    test('exclusive', t => {
      writeFileSync(${JSON.stringify(done)}, '');
      t.diagnostic('phase diagnostic retained');
      assert.equal(${failure}, false);
    });
  `);
  for (const file of files.slice(1)) writeFileSync(paths[file], `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    test('parallel', () => assert.ok(existsSync(${JSON.stringify(done)})));
  `);
  const config = path.join(root, 'config.json'), reportPath = path.join(root, 'report.json');
  writeFileSync(config, JSON.stringify({ files, paths, logDir: root, reportPath,
    nodeArgs: [], serialFiles: ['serial.mjs'], parallelFiles: files.slice(1), concurrency: 2 }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [helper, config],
    { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(child.status, failure ? 1 : 0, child.stdout + child.stderr);
  assert.equal(child.stdout.match(/^1\.\.3$/gm)?.length, 1, child.stdout);
  assert.match(child.stdout, /# tests 3/);
  assert.match(child.stdout, new RegExp(`# fail ${failure ? 1 : 0}`));
  assert.match(child.stdout, /phase diagnostic retained/);
  assert.equal(JSON.parse(readFileSync(reportPath)).files.length, 3);
  if (failure) assert.match(child.stderr, /Failed test file: serial.mjs/);
});

test('runner executes measured order across double-digit worker ranks', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.dirname(import.meta.dirname);
  mkdirSync(path.join(root, 'test', 'fixtures'), { recursive: true });
  mkdirSync(path.join(root, 'test', 'adapters'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'test', 'run-tests.mjs'),
    readFileSync(path.join(import.meta.dirname, 'run-tests.mjs')));
  for (const name of ['src', 'node_modules']) {
    symlinkSync(path.join(repo, name), path.join(root, name), 'dir');
  }
  mkdirSync(path.join(root, 'test', 'helpers'));
  for (const name of readdirSync(path.join(repo, 'test/helpers'))) {
    symlinkSync(path.join(repo, 'test/helpers', name), path.join(root, 'test/helpers', name));
  }
  const trace = path.join(root, 'order');
  const names = Array.from({ length: 12 }, (_, n) => `test/f${String(n).padStart(2, '0')}.test.mjs`);
  for (const file of names) writeFileSync(path.join(root, file), `
    import test from 'node:test';
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(trace)}, ${JSON.stringify(file + '\n')});
    test('ordered fixture', () => {});
  `);
  writeFileSync(path.join(root, 'test', 'fixtures', 'suite-durations.json'),
    JSON.stringify(Object.fromEntries(names.map((file, n) => [file, n + 1]))));
  // Force one slot to observe dispatch order independently of CPU capacity.
  const env = { ...process.env, CI: 'false', AR_TEST_CONCURRENCY: '1',
    ADVERSARIAL_REVIEW_TEST_TEMP_BASE: root, AR_TEST_TIMINGS: 'timings.json' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, [path.join(root, 'test', 'run-tests.mjs')],
    { cwd: root, env, encoding: 'utf8', timeout: 45_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stderr, /12 files, 0 exclusive, 1 parallel workers/);
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), names.reverse());
  const report = JSON.parse(readFileSync(path.join(root, 'timings.json'), 'utf8'));
  assert.equal(report.files.length, names.length);
  assert.ok(report.files.every(file => file.status === 0));
  assert.equal(readdirSync(root).some(file => file.startsWith('art-')), false);
});
