import './helpers/rate-limit-state-isolation.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SERIAL_TEST_FILES, orderFiles, workerCount } from './helpers/parallel-plan.mjs';

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

test('fixture commits skip auto-maintenance in a fresh home', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'fixture-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  mkdirSync(home);
  const trace = path.join(root, 'git-trace.jsonl');
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_TRACE2_EVENT: trace };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 }).trim();
  git('init', '--quiet', '--template=');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0'], ['gc.autoDetach', 'false']]) {
    assert.equal(git('config', '--get', key), value);
  }
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === 'start' && event.argv.includes('commit')));
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

test('suite timeout names the unchanged 900-second cap and removes the running sandbox', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'runner-deadline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ready = path.join(root, 'ready');
  const hook = path.join(root, 'deadline.mjs');
  writeFileSync(hook, `
    import { existsSync } from 'node:fs';
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms !== 900_000) return schedule(callback, ms, ...args);
      const check = () => existsSync(${JSON.stringify(ready)}) ? callback(...args) : schedule(check, 10);
      return schedule(check, 10);
    };
  `);
  const env = { ...process.env, ADVERSARIAL_REVIEW_TEST_TEMP_BASE: root,
    HQ_ROOT_FIXTURE_HOLD: ready, HQ_ROOT_FIXTURE_FAIL: '0' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', hook,
    path.join(import.meta.dirname, 'run-tests.mjs'), 'hq-root-runner-probe.test.mjs'], {
    encoding: 'utf8', env, timeout: 30_000,
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stderr, /Test suite timed out after 900 seconds/);
  assert.equal(readdirSync(root).some((file) => file.startsWith('art-')), false);
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
