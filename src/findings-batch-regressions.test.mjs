// Batch regressions live in src to respect this batch's explicit area boundary.
// Run with: node --test src/findings-batch-regressions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { operationalBlockerOwner } from './remediation-blocker-ownership.mjs';
import { prepareServiceCodexHomeAsync } from './codex-service-home.mjs';
import { probeCodexCli } from './adapters/reviewer-runtime/cli-direct/discovery.mjs';
import { serviceFixtureExec, writeDummyCodexAuth } from '../test/helpers/codex-service-fixture.mjs';

for (const [finding, expected] of [
  ['Required CI is pending. No human decision, operator approval, or intervention is needed.', 'CI'],
  ['Required CI is pending. No human decision or operator approval is needed.', 'CI'],
  ['Required CI is pending. No credentials or permissions are required.', 'CI'],
  ['Required CI is pending. No credentials and permissions are required.', 'CI'],
  ['Required CI is pending. We have no credentials and operator approval is required.', 'human'],
  ['Required CI is pending. We have no credentials, and operator approval is required.', 'human'],
  ['Required CI is pending. We have no additional permissions and operator approval is required.', 'human'],
  ['Required CI is pending. No human decision is needed; operator approval is required.', 'human'],
]) {
  test(`legacy blocker ownership: ${finding}`, () => {
    assert.equal(operationalBlockerOwner({ title: 'CI pending', finding }), expected);
  });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'batch-codex-probe-'));
  const authPath = writeDummyCodexAuth(join(root, '.codex', 'auth.json'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, authPath, env: { HOME: root, CODEX_CLI: '/fixture/codex' } };
}

test('discovery yields during credential and catalog commands without a synchronous executor', async t => {
  const f = fixture(t);
  const calls = [];
  let home;
  await probeCodexCli({ env: f.env, cwd: f.root, ensureWorkerRegistryReadyImpl: async () => {},
    execFileImpl: async (command, args, options) => {
      calls.push(args.join(' '));
      home = options.env.CODEX_HOME;
      assert.notEqual(home, join(f.root, '.codex'));
      assert.equal(options.env.CODEX_AUTH_PATH, join(home, 'auth.json'));
      // This timer must run while discovery is waiting for the subprocess.
      await nextTurn();
      if (['login', 'debug'].includes(args[0])) {
        const stdout = serviceFixtureExec(command, args, options);
        return args[0] === 'login' ? { stdout: '', stderr: stdout } : { stdout };
      }
      assert.match(readFileSync(join(home, 'config.toml'), 'utf8'), /model_catalog_json/);
      return { stdout: args[0] === '--version' ? 'fixture' : '[]' };
    } });
  assert.deepEqual(calls, ['login status', 'debug models', '--version', 'sessions list']);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(f.authPath), true);
});

test('async service authentication errors clean the private store and redact subprocess output', async t => {
  const f = fixture(t);
  let home;
  await assert.rejects(prepareServiceCodexHomeAsync({ env: f.env, workspaceDir: f.root,
    model: 'fixture-model', codexCli: '/fixture/codex', log: { info() {}, warn() {} },
    execFileImpl: async (_command, args, options) => {
      home = options.env.CODEX_HOME;
      assert.deepEqual(args, ['login', 'status']);
      await nextTurn();
      throw new Error('synthetic-secret-from-subprocess');
    } }), error => error.isOAuthError && !error.message.includes('synthetic-secret'));
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(f.authPath), true);
});

test('async catalog rejection retains authenticated server-catalog fallback without leaking CLI output', async t => {
  const f = fixture(t);
  const warnings = [];
  const home = await prepareServiceCodexHomeAsync({ env: f.env, workspaceDir: f.root,
    model: 'fixture-model', codexCli: '/fixture/codex',
    log: { info() {}, warn(message) { warnings.push(message); } },
    execFileImpl: async (command, args, options) => {
      await nextTurn();
      if (args[0] === 'login') return { stdout: serviceFixtureExec(command, args, options) };
      assert.deepEqual(args, ['debug', 'models']);
      throw new Error('synthetic-catalog-secret');
    } });
  try {
    assert.equal(home.catalogPath, null);
    assert.doesNotMatch(readFileSync(join(home.codexHome, 'config.toml'), 'utf8'), /model_catalog_json/);
    assert.equal(existsSync(home.authPath), true);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /synthetic-catalog-secret/);
  } finally { home.cleanup(); }
  assert.equal(existsSync(home.codexHome), false);
  assert.equal(existsSync(f.authPath), true);
});
