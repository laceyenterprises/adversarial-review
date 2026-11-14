import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../src/merge-lane-inventory.mjs';
import { FakeClock } from './helpers/load-time-kit.mjs';
const OPERATOR_HOLD_LABELS = ['no-merge-hold', 'do-not-merge', 'merge-agent-skip'];

test('default inventory reader retains the shared 25 MiB buffer for large PR rollups', async () => {
  const codeRoot = fileURLToPath(new URL('..', import.meta.url));
  const execute = promisify(execFile);
  const titleLength = 2 * 1024 * 1024;
  let calls = 0;
  const result = await collect(codeRoot, 'unused-data', {
    config: { repos: ['example/repo'] }, holdLabels: [], stderr: null,
    execFileImpl: async (command, args, options) => {
      calls += 1;
      assert.equal(command, 'gh');
      assert.deepEqual(args.slice(0, 4), ['pr', 'list', '--repo', 'example/repo']);
      assert.equal(options.maxBuffer, 25 * 1024 * 1024);
      // Exercise a real child above Node's 1 MiB default, without GitHub I/O.
      return execute(process.execPath, ['-e',
        `process.stdout.write(JSON.stringify([{ number: 42, title: 'x'.repeat(${titleLength}) }]))`,
      ], options);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.repositories['example/repo'][0].number, 42);
  assert.equal(result.repositories['example/repo'][0].title.length, titleLength);
});

test('default inventory reader bounds a hanging lookup and records the failure', async t => {
  const clock = new FakeClock(t);
  const codeRoot = fileURLToPath(new URL('..', import.meta.url));
  const progress = [];
  let signal;
  let calls = 0;
  let childStarted;
  const started = new Promise(resolve => { childStarted = resolve; });
  let settled = false;
  const pending = collect(codeRoot, 'unused-data', {
    config: { repos: ['example/repo'] }, holdLabels: [], budgetMs: 50,
    stderr: { write: text => progress.push(text) },
    execFileImpl: async (_command, _args, options) => {
      calls += 1;
      signal = options.signal;
      childStarted();
      return new Promise(() => {});
    },
  }).then(result => { settled = true; return result; });
  // Real metering admission does filesystem I/O. Reach the child explicitly
  // before advancing the budget; a Promise-only drain cannot prove admission.
  await started;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  await clock.advance(49);
  assert.equal(settled, false);
  assert.equal(signal.aborted, false);
  await clock.advance(1);
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.deepEqual(result.repositories, {});
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].reason, 'merge-lane-inventory-lookup-timeout');
  assert.match(result.errors[0].error, /waiting for `gh pr list` to exit; 1 attempt/);
  assert.match(progress.join(''), /\[github-read\] start merge lane inventory lookup/);
});

test('one PR list invocation per watched repository, actual review hold policy', async () => {
  const calls = [];
  const result = await collect('unused-code', 'unused-data', {
    holdLabels: OPERATOR_HOLD_LABELS,
    config: { org: 'org', repos: ['org/explicit'], excludeRepos: ['excluded'] },
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'api') return [[
        { name: 'repo', full_name: 'org/repo' },
        { name: 'archived', full_name: 'org/archived', archived: true },
        { name: 'excluded', full_name: 'org/excluded' },
        { name: 'missing-full-name' },
        { name: 'null-full-name', full_name: null },
        { name: 'empty-full-name', full_name: '' },
        null,
      ]];
      return [];
    },
  });
  assert.deepEqual(Object.keys(result.repositories), ['org/explicit', 'org/repo']);
  assert.deepEqual(result.holdLabels, OPERATOR_HOLD_LABELS);
  assert.equal(calls.filter(args => args[0] === 'pr').length, 2);
  assert.deepEqual(result.errors, []);
  assert.ok(calls.every(args => args[0] === 'api' || args[1] === 'list'));
});

test('GitHub errors and truncated/malformed reads remain probe errors', async () => {
  for (const response of [null, Array(10000).fill({}), new Error('GitHub unavailable')]) {
    const result = await collect('unused-code', 'unused-data', { holdLabels: [], config: { repos: ['org/repo'] },
      run: async () => { if (response instanceof Error) throw response; return response; } });
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.repositories, {});
  }
});

test('discovery failure stays visible while explicit repositories are probed', async () => {
  const result = await collect('unused-code', 'unused-data', { holdLabels: [], config: { org: 'org', repos: ['org/explicit'] },
    run: async (args) => { if (args[0] === 'api') throw new Error('read failed'); return []; } });
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.repositories, { 'org/explicit': [] });
});


test('boundary reads modules and config from code root with an empty HQ data root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-age-review-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codeRoot = join(root, 'deploy/tools/adversarial-review');
  const dataRoot = join(root, 'hq/adversarial-review');
  await mkdir(join(codeRoot, 'src'), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(codeRoot, 'config.json'), JSON.stringify({ repos: ['fixture/repo'] }));
  await writeFile(join(codeRoot, 'src/operator-hold-labels.mjs'),
    "export const OPERATOR_HOLD_LABELS = ['Fixture-Hold'];");
  await writeFile(join(codeRoot, 'src/operator-gh-read.mjs'), `
    import assert from 'node:assert/strict';
    export async function runOperatorGhRead(options) {
      const { args } = options;
      assert.deepEqual(args.slice(0, 7), ['pr', 'list', '--repo', 'fixture/repo', '--state', 'open', '--limit']);
      assert.equal(options.timeoutReason, 'merge-lane-inventory-lookup-timeout');
      assert.equal(options.stderr, process.stderr);
      assert.equal(options.env, process.env);
      return { stdout: JSON.stringify([{ number: 42 }]) };
    }
  `);
  assert.deepEqual(await collect(codeRoot, dataRoot), {
    holdLabels: ['Fixture-Hold'],
    repositories: { 'fixture/repo': [{ number: 42 }] },
    errors: [],
  });
  assert.deepEqual(await readdir(dataRoot), []);
});


test('missing code-root config names its expected path without calling GitHub', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-age-missing-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codeRoot = join(root, 'code');
  const dataRoot = join(root, 'data');
  await mkdir(join(codeRoot, 'src'), { recursive: true });
  await mkdir(dataRoot);
  await writeFile(join(codeRoot, 'src/operator-gh-read.mjs'), `
    export async function runOperatorGhRead() { throw new Error('GitHub must not be called'); }
  `);
  await writeFile(join(codeRoot, 'src/operator-hold-labels.mjs'),
    'export const OPERATOR_HOLD_LABELS = [];');
  await assert.rejects(collect(codeRoot, dataRoot), error => error.message.includes(join(codeRoot, 'config.json')));
});


test('missing code reports the named root before reading config or calling GitHub', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-age-missing-code-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(collect(root, join(root, 'missing-data')), {
    message: `review service code root ${root} has no src/operator-gh-read.mjs`,
  });
});

test('missing hold-label module names the file before reading config or calling GitHub', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pr-age-missing-holds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/operator-gh-read.mjs'), `
    export async function runOperatorGhRead() { throw new Error('GitHub must not be called'); }
  `);
  await assert.rejects(collect(root, join(root, 'missing-data')), {
    message: `review service code root ${root} has no src/operator-hold-labels.mjs`,
  });
});

