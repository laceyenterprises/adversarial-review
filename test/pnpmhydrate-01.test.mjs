import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonicalHammerValidation } from '../src/ama/hammer-canonical-validation.mjs';
import { ValidationSelectionError } from '../src/ama/pnpm-validation.mjs';

const validate = fileURLToPath(new URL('../bin/hammer-validate.mjs', import.meta.url));
function fixture(t, { pin = 'pnpm@10.11.0', run = 'pnpm format:check\npnpm lint\npnpm test' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pnpmhydrate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: pin,
    engines: { node: process.versions.node },
    scripts: { 'format:check': 'prettier --check .', lint: 'eslint .', test: 'vitest run' } }));
  writeFileSync(join(root, '.github/workflows/ci.yaml'), `name: standup-ci
on: [pull_request]
jobs:
  checks:
    steps:
      - run: pnpm install --frozen-lockfile
      - run: |
${run.split('\n').map(line => `          ${line}`).join('\n')}
`);
  return root;
}

test('pnpm PR workflow selects formatting, lint and tests under the exact packageManager pin', t => {
  const root = fixture(t);
  const runner = canonicalHammerValidation(root, ['README.md', 'test/example.test.ts']);
  assert.equal(runner.command, 'npm');
  assert.equal(runner.required, true);
  assert.deepEqual(runner.args.slice(0, 6), ['exec', '--yes', '--package=pnpm@10.11.0', '--', 'node',
    fileURLToPath(new URL('../bin/validate-pnpm-scripts.mjs', import.meta.url))]);
  assert.deepEqual(JSON.parse(runner.args[6]), [['format:check'], ['lint'], ['test']]);
});

test('missing or floating pnpm pins fail command selection', t => {
  for (const pin of [null, 'pnpm@latest', 'pnpm@^10.0.0', 'npm@10.0.0']) {
    assert.throws(() => canonicalHammerValidation(fixture(t, { pin }), ['README.md']),
      ValidationSelectionError);
  }
});

test('unrepresentable workflow commands fail selection rather than dropping a required check', t => {
  for (const run of ['pnpm lint && pnpm test', 'pnpm run missing', 'pnpm test $ARGS',
    'pnpm lint\nCI=true pnpm test']) {
    assert.throws(() => canonicalHammerValidation(fixture(t, { run }), ['README.md']),
      ValidationSelectionError);
  }
});

function stub(_t, root, name, content) {
  const dir = join(root, 'bin');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${content}\n`);
  chmodSync(path, 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HQ_WORKER_RUN_ID: '',
    HAM_RUN_DIR: '', HAM_AUDIT_DIR: '' };
  if (name === 'npm') {
    // The pinned runtime's bin leads PATH, so keep the offline npm stub there.
    env.HAM_NODE_BIN = join(dir, 'node');
    symlinkSync(process.execPath, env.HAM_NODE_BIN);
  }
  return env;
}

test('selected workflow scripts run in order and stop on a formatter failure, offline', t => {
  const root = fixture(t), runner = canonicalHammerValidation(root, ['README.md']);
  const env = stub(t, root, 'pnpm', 'echo "$*" >> calls\n[ "$2" != "format:check" ]');
  // Exercise the script runner without npm exec: no install or network in tests.
  const result = spawnSync(process.execPath, runner.args.slice(5), { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'run format:check\n');
});

test('a successful battery executes format, lint and test with workflow arguments, offline', t => {
  const root = fixture(t, { run: 'pnpm format:check\npnpm run lint\npnpm test -- --run' });
  const runner = canonicalHammerValidation(root, ['README.md']);
  const env = stub(t, root, 'pnpm', 'echo "$*" >> calls\nexit 0');
  const result = spawnSync(process.execPath, runner.args.slice(5), { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'calls'), 'utf8'),
    'run format:check\nrun lint\nrun test -- --run\n');
});

test('canonical pnpm validation never converts missing tools into a successful skipped battery', t => {
  const root = fixture(t);
  const env = stub(t, root, 'npm', 'exit 127');
  const result = spawnSync(process.execPath, [validate, '--canonical', '--', 'README.md'],
    { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /validation-environment-failed/);
  assert.doesNotMatch(result.stderr, /local-battery-skipped/);
});

test('invalid pnpm selection exits nonzero without invoking an install', t => {
  const root = fixture(t, { pin: null });
  const env = stub(t, root, 'npm', 'echo forbidden > calls\nexit 0');
  const result = spawnSync(process.execPath, [validate, '--canonical', '--', 'README.md'],
    { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pnpm-validation-selection-failed/);
  assert.doesNotMatch(result.stderr, /local-battery-skipped/);
  assert.equal(existsSync(join(root, 'calls')), false);
});

function workflow(root, text) {
  writeFileSync(join(root, '.github/workflows/ci.yaml'), text);
}

for (const [name, text] of Object.entries({
  'workflow env': 'env: {CI: true}\non: [pull_request]\njobs: {checks: {steps: [{run: pnpm test}]}}',
  'job env': 'on: [pull_request]\njobs: {checks: {env: {CI: true}, steps: [{run: pnpm test}]}}',
  'step env': 'on: [pull_request]\njobs: {checks: {steps: [{env: {CI: true}, run: pnpm test}]}}',
  matrix: 'on: [pull_request]\njobs: {checks: {strategy: {matrix: {node: [22, 24]}}, steps: [{run: pnpm test}]}}',
  'working-directory': 'on: [pull_request]\njobs: {checks: {steps: [{working-directory: app, run: pnpm test}]}}',
  'non-PR trigger': 'on: [push]\njobs: {checks: {steps: [{run: pnpm test}]}}',
  'reusable job': 'on: [pull_request]\njobs: {checks: {uses: org/repo/.github/workflows/ci.yml@main}}',
})) {
  test(`unsupported ${name} uses the exact-head GitHub fallback without provisioning`, t => {
    const root = fixture(t);
    workflow(root, text);
    const env = stub(t, root, 'npm', 'echo forbidden > calls; exit 1');
    const result = spawnSync(process.execPath, [validate, '--canonical', '--', 'README.md'],
      { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /pnpm-validation-unsupported/);
    assert.match(result.stderr, /local-battery-skipped-github-required-gate-authoritative/);
    assert.equal(existsSync(join(root, 'calls')), false);
  });
}

for (const run of ['echo "STORE_PATH=$(pnpm store path)" >> $GITHUB_ENV',
  'pnpm exec playwright install', 'pnpm -r test', 'pnpm --filter x lint']) {
  test(`unmodelled command falls back without a world failure: ${run}`, t => {
    const root = fixture(t, { run });
    const result = spawnSync(process.execPath, [validate, '--canonical', '--', 'README.md'],
      { cwd: root, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /local-battery-skipped/);
  });
}

test('job and step conditions exclude push-only and gated scripts', t => {
  const root = fixture(t);
  workflow(root, `on: [push, pull_request]
jobs:
  release:
    if: github.event_name == 'push'
    steps:
      - run: pnpm lint
  checks:
    steps:
      - if: github.event_name == 'push'
        run: pnpm format:check
      - run: pnpm test
`);
  const runner = canonicalHammerValidation(root, ['README.md']);
  assert.deepEqual(JSON.parse(runner.args[6]), [['test']]);
  assert.equal(runner.nominalSeconds, 1800);
});

test('npm startup failure retries once and exits as an environment fault, offline', t => {
  const root = fixture(t);
  const env = stub(t, root, 'npm', 'echo startup >> calls; exit 1');
  const result = spawnSync(process.execPath, [validate, '--canonical', '--', 'README.md'],
    { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /validation-environment-failed/);
  assert.doesNotMatch(result.stderr, /local-battery-skipped/);
  assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'startup\nstartup\n');
});

for (const code of [1, 78, 127]) {
  test(`repository script exit ${code} remains a real failure without retry`, t => {
    const root = fixture(t);
    stub(t, root, 'pnpm', `echo script >> calls; exit ${code}`);
    const env = stub(t, root, 'npm', 'shift 4; exec "$@"');
    const result = spawnSync(process.execPath, [validate, '--canonical', '--', 'README.md'],
      { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, code === 78 ? 1 : code, result.stderr);
    assert.doesNotMatch(result.stderr, /validation-environment-failed|local-battery-skipped/);
    assert.equal(readFileSync(join(root, 'calls'), 'utf8'), 'script\n');
  });
}

test('integrity suffixes select the documented version-only pin', t => {
  const runner = canonicalHammerValidation(fixture(t, { pin: 'pnpm@10.11.0+sha512.abcdef' }), ['README.md']);
  assert.equal(runner.args[2], '--package=pnpm@10.11.0');
});

test('pnpm default timeout is larger and explicit nominal overrides remain authoritative', t => {
  const root = fixture(t);
  const env = stub(t, root, 'npm', 'exit 1');
  for (const [args, timeout] of [[[], 1800000], [['--nominal-timeout', '10'], 10000]]) {
    const result = spawnSync(process.execPath, [validate, '--canonical', ...args, '--', 'README.md'],
      { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 78, result.stderr);
    // CLI children read real host load (1x..6x, capped at one hour).
    // Deadline accounting can consume a millisecond before the first spawn.
    const absolute = Number(/started absolute=(\d+)ms/.exec(result.stderr)?.[1]);
    assert.ok(absolute <= Math.min(timeout * 6, 3600000)
      && absolute >= timeout - 1000, result.stderr);
  }
});
