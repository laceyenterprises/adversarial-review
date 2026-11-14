import './helpers/load-aware-timeout-fixture.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
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
  return { ...process.env, PATH: `${dir}:${process.env.PATH}`, HQ_WORKER_RUN_ID: '',
    HAM_RUN_DIR: '', HAM_AUDIT_DIR: '' };
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
  assert.equal(result.status, 127, result.stderr);
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
