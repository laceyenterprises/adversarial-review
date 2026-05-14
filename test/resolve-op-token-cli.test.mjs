import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'secret-source', 'resolve-op-token-cli.mjs');

function runCli({ env = {}, cwd = REPO_ROOT } = {}) {
  return spawnSync(process.execPath, [CLI_PATH], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'adv-resolve-op-cli-'));
}

test('resolve-op-token CLI prints token to stdout and exits 0 on success', () => {
  const dir = mkTmp();
  try {
    const tokenFile = join(dir, 'op-service-account.token');
    writeFileSync(tokenFile, 'ops_eyJsuccess\n');
    const result = runCli({ env: { ADV_OP_TOKEN_FILE: tokenFile, HOME: dir } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ops_eyJsuccess');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve-op-token CLI emits a single detailed diagnostic to stderr with exit 78 when every source fails', () => {
  const dir = mkTmp();
  try {
    const result = runCli({
      env: {
        ADV_OP_TOKEN_TAG: 'wrapper-test',
        ADV_SECRETS_ROOT: join(dir, 'missing'),
        HOME: dir,
      },
    });
    assert.equal(result.status, 78);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /\[wrapper-test\] FATAL: could not resolve OP_SERVICE_ACCOUNT_TOKEN/);
    assert.match(result.stderr, /Sources checked, in declared precedence:/);
    assert.match(result.stderr, /env:OP_SERVICE_ACCOUNT_TOKEN/);
    assert.match(result.stderr, /env:ADV_OP_TOKEN_FILE/);
    assert.match(result.stderr, /env:ADV_OP_TOKEN_ENV_FILE/);
    assert.match(result.stderr, /default token file/);
    assert.match(result.stderr, /Recommended fix/);
    assert.match(result.stderr, /tools\/adversarial-review\/DEPS\.md/);
    const fatalCount = (result.stderr.match(/FATAL:/g) || []).length;
    assert.equal(fatalCount, 1, 'diagnostic must appear exactly once');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve-op-token CLI honors env-file precedence (KEY=VALUE form)', () => {
  const dir = mkTmp();
  try {
    const envFile = join(dir, 'op-service-account.env');
    writeFileSync(envFile, 'OP_SERVICE_ACCOUNT_TOKEN="ops_eyJzfromenvfile"\n');
    const result = runCli({ env: { ADV_OP_TOKEN_ENV_FILE: envFile, HOME: dir } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ops_eyJzfromenvfile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolve-op-token CLI resolves $ADV_SECRETS_ROOT/op-service-account.token', () => {
  const dir = mkTmp();
  try {
    const root = join(dir, 'secrets');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'op-service-account.token'), 'ops_eyJroot\n');
    const result = runCli({ env: { ADV_SECRETS_ROOT: root, HOME: dir } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'ops_eyJroot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
