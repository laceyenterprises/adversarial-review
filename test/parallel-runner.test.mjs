import './helpers/rate-limit-state-isolation.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { orderFiles, planShards, workerCount } from './helpers/parallel-plan.mjs';

const helper = path.join(import.meta.dirname, 'helpers', 'parallel-runner.mjs');

test('CPU-derived parallelism is bounded by CPUs, sixteen workers and the file count', () => {
  assert.equal(workerCount(1, 100), 8);
  assert.equal(workerCount(2, 100), 16);
  assert.equal(workerCount(64, 100), 16);
  assert.equal(workerCount(64, 3), 3);
  assert.equal(workerCount(1, 0), 0);
});

test('shards balance measured durations longest first with deterministic ties and unknown files', () => {
  const files = ['e', 'd', 'c', 'b', 'a'];
  const durations = { a: 8, b: 7, c: 6, d: 5 };
  const expected = [
    { files: ['a', 'c', 'd'], durationMs: 19 },
    { files: ['b', 'e'], durationMs: 14 },
  ];
  assert.deepEqual(planShards(files, durations, 2), expected);
  assert.deepEqual(planShards([...files].reverse(), durations, 2), expected);
  assert.deepEqual(orderFiles(files, durations), ['a', 'b', 'e', 'c', 'd']);
  assert.deepEqual(planShards(['z', 'a', 'b'], {}, 2).map((s) => s.files), [['a', 'z'], ['b']]);
  assert.deepEqual(planShards([], {}, 2), []);
  assert.throws(() => planShards(files, durations, 0), /positive worker count/);
  assert.equal(new Set(planShards(files, durations, 8).flatMap((s) => s.files)).size, files.length);
});

for (const failure of [false, true]) test(`real parallel processes report every file and propagate failure=${failure}`, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'parallel-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['b.mjs', 'a.mjs'];
  const paths = Object.fromEntries(files.map((file) => [file, path.join(root, file)]));
  writeFileSync(paths['a.mjs'], `console.log('fixture-a'); process.exitCode = ${failure ? 9 : 0};`);
  writeFileSync(paths['b.mjs'], "console.log('fixture-b');");
  const reportPath = path.join(root, 'report.json');
  const config = path.join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ files, paths, logDir: root, nodeArgs: ['--test', '--test-concurrency=1', '--test-reporter',
      path.join(import.meta.dirname, 'helpers', 'parallel-reporter.mjs')], reportPath,
    shards: planShards(files, {}, 2) }));
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


test('runner executes measured order across double-digit worker ranks', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'native-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.dirname(import.meta.dirname);
  mkdirSync(path.join(root, 'test', 'fixtures'), { recursive: true });
  mkdirSync(path.join(root, 'test', 'adapters'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(root, 'test', 'run-tests.mjs'),
    readFileSync(path.join(import.meta.dirname, 'run-tests.mjs')));
  for (const name of ['src', 'node_modules', 'test/helpers']) {
    symlinkSync(path.join(repo, name), path.join(root, name), 'dir');
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
  const hook = path.join(root, 'cpu.mjs');
  writeFileSync(hook, `import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.availableParallelism = () => 0; syncBuiltinESMExports();`);
  const env = { ...process.env, ADVERSARIAL_REVIEW_TEST_TEMP_BASE: root };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(process.execPath, ['--import', hook, path.join(root, 'test', 'run-tests.mjs')],
    { env, encoding: 'utf8', timeout: 45_000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), names.reverse());
});
