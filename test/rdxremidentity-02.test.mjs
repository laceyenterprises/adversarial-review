// RDXREMIDENTITY-02: repository remediation git identities can come from the
// config key `remediation.git_identity_repo_overrides`, not only from
// REMEDIATION_WORKER_GIT_IDENTITY_REPO_OVERRIDES. Fixtures are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentOSConfigError, loadConfig } from '../src/config-loader.mjs';
import { resetRoleConfigCache } from '../src/role-config.mjs';
import {
  configureRemediationWorkspaceIdentity,
  remediationWorkerGitIdentity,
} from '../src/remediation-worker-provenance.mjs';
import {
  REPO_IDENTITY_OVERRIDES_CONFIG_KEY,
  configureRemediationWorkspaceIdentityWithConfig,
  remediationWorkerGitIdentityWithConfig,
} from '../src/remediation-identity-config.mjs';

const REPO = 'example-org/example-repo';
const ENV_KEY = 'REMEDIATION_WORKER_GIT_IDENTITY_REPO_OVERRIDES';
const MODULE_CONFIG = new URL('../config.yaml', import.meta.url).pathname;
const CONFIG_IDENTITY = { name: 'Config Agent', email: '12345+example-agent[bot]@users.noreply.github.com' };
const ENV_IDENTITY = { name: 'Env Agent', email: '23456+example-env-agent[bot]@users.noreply.github.com' };
const CLASS_IDENTITY = { name: 'Class Agent', email: '34567+example-class-agent[bot]@users.noreply.github.com' };
const CLASS_ENV = {
  REMEDIATION_WORKER_GIT_NAME_CODEX: CLASS_IDENTITY.name,
  REMEDIATION_WORKER_GIT_EMAIL_CODEX: CLASS_IDENTITY.email,
};
const WARNING_PREFIX = '[remediation-worker] Ignoring malformed';

function yamlOverrides(overrides) {
  const lines = ['version: 1', 'remediation:', '  git_identity_repo_overrides:'];
  const entries = Object.entries(overrides);
  if (entries.length === 0) return `${lines.join('\n')} {}\n`;
  for (const [repo, classes] of entries) {
    lines.push(`    ${repo}:`);
    for (const [workerClass, identity] of Object.entries(classes)) {
      lines.push(`      ${workerClass}:`);
      for (const [field, value] of Object.entries(identity)) {
        lines.push(`        ${field}: ${JSON.stringify(value)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function configEnv(t, contents, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rdxremidentity-02-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    resetRoleConfigCache();
  });
  const topPath = path.join(dir, 'config.yaml');
  writeFileSync(topPath, contents, 'utf8');
  resetRoleConfigCache();
  return { AGENT_OS_CONFIG_PATH: topPath, ...extra };
}

function identityWithConfig(workerClass, env, options = { repo: REPO }) {
  return remediationWorkerGitIdentityWithConfig(workerClass, env, options);
}

test('config key supplies the repository identity ahead of class env and defaults', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const env = configEnv(t, yamlOverrides({ [REPO]: { codex: CONFIG_IDENTITY } }), CLASS_ENV);
  assert.deepEqual(identityWithConfig('codex', env), CONFIG_IDENTITY);
  // Lookup is case-insensitive on the repository, like the env layer.
  assert.deepEqual(identityWithConfig('codex', env, { repo: 'Example-Org/Example-Repo' }), CONFIG_IDENTITY);
  // The harness fallback applies to config entries too.
  assert.deepEqual(identityWithConfig('remediator-codex', env), CONFIG_IDENTITY);
  // Other repositories, a missing repo and other classes keep the old chain.
  assert.deepEqual(identityWithConfig('codex', env, { repo: 'example-org/other-repo' }), CLASS_IDENTITY);
  assert.deepEqual(identityWithConfig('codex', env, {}), CLASS_IDENTITY);
  const defaults = remediationWorkerGitIdentity('claude-code', {});
  assert.deepEqual(identityWithConfig('claude-code', env), defaults);
  assert.equal(warn.mock.callCount(), 0);
});

test('config key without class env still beats the built-in default', (t) => {
  const env = configEnv(t, yamlOverrides({ [REPO]: { codex: CONFIG_IDENTITY } }));
  assert.deepEqual(identityWithConfig('codex', env), CONFIG_IDENTITY);
});

test('dotted repository names survive the config cascade', (t) => {
  const env = configEnv(t, yamlOverrides({ 'example-org/example.repo': { codex: CONFIG_IDENTITY } }));
  assert.deepEqual(identityWithConfig('codex', env, { repo: 'example-org/example.repo' }), CONFIG_IDENTITY);
});

test('env var wins over the config key when both name the repository', (t) => {
  const env = configEnv(t, yamlOverrides({ [REPO]: { codex: CONFIG_IDENTITY } }), {
    ...CLASS_ENV,
    [ENV_KEY]: JSON.stringify({ [REPO]: { codex: ENV_IDENTITY } }),
  });
  assert.deepEqual(identityWithConfig('codex', env), ENV_IDENTITY);
});

test('an env entry for another repository does not shadow the config entry', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const env = configEnv(t, yamlOverrides({ [REPO]: { codex: CONFIG_IDENTITY } }), {
    [ENV_KEY]: JSON.stringify({ 'example-org/other-repo': { codex: ENV_IDENTITY } }),
  });
  assert.deepEqual(identityWithConfig('codex', env), CONFIG_IDENTITY);
  assert.equal(warn.mock.callCount(), 0);
});

test('malformed env layer warns once and falls through to the config key', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const env = configEnv(t, yamlOverrides({ [REPO]: { codex: CONFIG_IDENTITY } }), {
    [ENV_KEY]: '{ "example-secret":',
  });
  assert.deepEqual(identityWithConfig('codex', env), CONFIG_IDENTITY);
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), [
    [`${WARNING_PREFIX} ${ENV_KEY} configuration`],
  ]);
});

test('empty config default keeps today\'s behavior and does not warn', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const defaults = remediationWorkerGitIdentity('codex', {});
  const explicitEmpty = configEnv(t, yamlOverrides({}));
  assert.deepEqual(identityWithConfig('codex', explicitEmpty), defaults);
  assert.deepEqual(identityWithConfig('codex', { ...explicitEmpty, ...CLASS_ENV }), CLASS_IDENTITY);
  const unset = configEnv(t, 'version: 1\n');
  assert.deepEqual(identityWithConfig('codex', unset), defaults);
  assert.deepEqual(
    identityWithConfig('codex', { ...unset, [ENV_KEY]: JSON.stringify({ [REPO]: { codex: ENV_IDENTITY } }) }),
    ENV_IDENTITY,
  );
  assert.equal(warn.mock.callCount(), 0);
});

test('checked-in config.yaml declares the key with an empty default', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rdxremidentity-02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = path.join(dir, 'config.yaml');
  writeFileSync(topPath, 'version: 1\n', 'utf8');
  const config = loadConfig({ topPath, modulePaths: [MODULE_CONFIG], env: {} });
  const value = config.get(REPO_IDENTITY_OVERRIDES_CONFIG_KEY, null);
  assert.ok(value === null || Object.keys(value).length === 0, 'default must be an empty map');
});

test('malformed config entries fall through with one fixed warning and no values', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const secret = 'example-secret';
  const malformed = [
    'example-secret',
    [],
    { [REPO]: [] },
    { [REPO]: 'example-secret' },
    { [REPO]: { codex: [] } },
    { [REPO]: { codex: { name: secret } } },
    { [REPO]: { codex: { name: secret, email: 42 } } },
    { [REPO]: { codex: { ...CONFIG_IDENTITY, email: `${secret}\0` } } },
    { [REPO]: { codex: { ...CONFIG_IDENTITY, email: `<${secret}>` } } },
    { [REPO]: { codex: { ...CONFIG_IDENTITY, name: `${secret}\r\n` } } },
    { [REPO]: { codex: { ...CONFIG_IDENTITY, name: '   ' } } },
  ];
  for (const configOverrides of malformed) {
    warn.mock.resetCalls();
    const identity = remediationWorkerGitIdentity('codex', CLASS_ENV, { repo: REPO, configOverrides });
    assert.deepEqual(identity, CLASS_IDENTITY, JSON.stringify(configOverrides));
    assert.equal(warn.mock.callCount(), 1, JSON.stringify(configOverrides));
    assert.deepEqual(warn.mock.calls[0].arguments, [
      `${WARNING_PREFIX} ${REPO_IDENTITY_OVERRIDES_CONFIG_KEY} configuration`,
    ]);
  }
});

test('an unreadable config warns with the fixed message and falls through', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const configOverrides = () => { throw new Error('example-secret'); };
  assert.deepEqual(
    remediationWorkerGitIdentity('codex', CLASS_ENV, { repo: REPO, configOverrides }),
    CLASS_IDENTITY,
  );
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), [
    [`${WARNING_PREFIX} ${REPO_IDENTITY_OVERRIDES_CONFIG_KEY} configuration`],
  ]);
  // A loader that fails through the real reader behaves the same way.
  warn.mock.resetCalls();
  const brokenLoader = () => { throw new AgentOSConfigError('example-secret', {}); };
  assert.deepEqual(
    remediationWorkerGitIdentityWithConfig('codex', CLASS_ENV, { repo: REPO, loaderImpl: brokenLoader }),
    CLASS_IDENTITY,
  );
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(!JSON.stringify(warn.mock.calls[0].arguments).includes('example-secret'));
});

test('malformed config entry for another repository or class is not consulted', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const configOverrides = { 'example-org/other-repo': 'example-secret', [REPO]: { gemini: 'example-secret' } };
  assert.deepEqual(
    remediationWorkerGitIdentity('codex', CLASS_ENV, { repo: REPO, configOverrides }),
    CLASS_IDENTITY,
  );
  assert.equal(warn.mock.callCount(), 0);
});

test('the config layer is only read when the env layer did not settle the identity', () => {
  let reads = 0;
  const configOverrides = () => { reads += 1; return { [REPO]: { codex: CONFIG_IDENTITY } }; };
  const env = { [ENV_KEY]: JSON.stringify({ [REPO]: { codex: ENV_IDENTITY } }) };
  assert.deepEqual(remediationWorkerGitIdentity('codex', env, { repo: REPO, configOverrides }), ENV_IDENTITY);
  assert.equal(remediationWorkerGitIdentity('codex', {}, { configOverrides }).name.length > 0, true);
  assert.equal(reads, 0);
  assert.deepEqual(remediationWorkerGitIdentity('codex', {}, { repo: REPO, configOverrides }), CONFIG_IDENTITY);
  assert.equal(reads, 1);
});

test('schema rejects a bad identity field in the config key', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rdxremidentity-02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const load = (identity) => {
    const topPath = path.join(dir, 'config.yaml');
    writeFileSync(topPath, yamlOverrides({ [REPO]: { codex: identity } }), 'utf8');
    return loadConfig({ topPath, modulePaths: [], env: {} });
  };
  assert.deepEqual(
    load(CONFIG_IDENTITY).get(REPO_IDENTITY_OVERRIDES_CONFIG_KEY),
    { [REPO]: { codex: CONFIG_IDENTITY } },
  );
  for (const bad of [
    { ...CONFIG_IDENTITY, email: 'example-agent>@users.noreply.github.com' },
    { ...CONFIG_IDENTITY, email: '<example-agent@users.noreply.github.com' },
    { ...CONFIG_IDENTITY, name: 'Example\nAgent' },
    { ...CONFIG_IDENTITY, name: 'Example\rAgent' },
    { ...CONFIG_IDENTITY, name: 'Example\u0000Agent' },
    { ...CONFIG_IDENTITY, name: '   ' },
    { ...CONFIG_IDENTITY, name: '' },
  ]) {
    assert.throws(() => load(bad), AgentOSConfigError, JSON.stringify(bad));
  }
  const nonString = path.join(dir, 'non-string.yaml');
  writeFileSync(nonString, [
    'version: 1', 'remediation:', '  git_identity_repo_overrides:', `    ${REPO}:`,
    '      codex:', '        name: 7', `        email: "${CONFIG_IDENTITY.email}"`, '',
  ].join('\n'), 'utf8');
  assert.throws(() => loadConfig({ topPath: nonString, modulePaths: [], env: {} }), AgentOSConfigError);
});

test('configureRemediationWorkspaceIdentity writes the config-supplied identity', async (t) => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'rdxremidentity-02-ws-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, '.git'));
  const calls = [];
  await configureRemediationWorkspaceIdentity({
    workspaceDir,
    workerClass: 'codex',
    repo: REPO,
    env: CLASS_ENV,
    execFileImpl: async (file, args) => { calls.push(args.slice(2)); return { stdout: '', stderr: '' }; },
    configOverrides: () => ({ [REPO]: { codex: CONFIG_IDENTITY } }),
  });
  assert.deepEqual(calls.slice(1), [
    ['config', '--worktree', 'user.name', CONFIG_IDENTITY.name],
    ['config', '--worktree', 'user.email', CONFIG_IDENTITY.email],
  ]);
});

test('the config-wired workspace setup reads the identity from the config key', async (t) => {
  const env = configEnv(t, yamlOverrides({ [REPO]: { codex: CONFIG_IDENTITY } }), CLASS_ENV);
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'rdxremidentity-02-ws-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, '.git'));
  const calls = [];
  await configureRemediationWorkspaceIdentityWithConfig({
    workspaceDir,
    workerClass: 'codex',
    repo: REPO,
    env,
    execFileImpl: async (file, args) => { calls.push(args.slice(2)); return { stdout: '', stderr: '' }; },
  });
  assert.deepEqual(calls.slice(1), [
    ['config', '--worktree', 'user.name', CONFIG_IDENTITY.name],
    ['config', '--worktree', 'user.email', CONFIG_IDENTITY.email],
  ]);
});

test('the config-wired workspace setup forwards an injected config loader', async (t) => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), 'rdxremidentity-02-ws-'));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  mkdirSync(path.join(workspaceDir, '.git'));
  const loader = t.mock.fn(() => ({
    get(key) {
      assert.equal(key, REPO_IDENTITY_OVERRIDES_CONFIG_KEY);
      return { [REPO]: { codex: CONFIG_IDENTITY } };
    },
  }));
  const calls = [];
  await configureRemediationWorkspaceIdentityWithConfig({
    workspaceDir,
    workerClass: 'codex',
    repo: REPO,
    env: CLASS_ENV,
    loaderImpl: loader,
    execFileImpl: async (file, args) => { calls.push(args.slice(2)); return { stdout: '', stderr: '' }; },
  });
  assert.equal(loader.mock.callCount(), 1);
  assert.deepEqual(calls.slice(1), [
    ['config', '--worktree', 'user.name', CONFIG_IDENTITY.name],
    ['config', '--worktree', 'user.email', CONFIG_IDENTITY.email],
  ]);
});
