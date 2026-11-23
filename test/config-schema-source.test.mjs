import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadConfig, loadConfigCached, loadConfigRuntime } from '../src/config-loader.mjs';
import { validateOsgShape } from '../src/config-policies.mjs';
import { CFG_JSON_SCHEMA, contractSchemaPath, fromJsonSchema } from '../src/config-schema.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cfg-schema-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const topPath = join(root, 'config.yaml');
  writeFileSync(topPath, 'version: 1\nroots:\n  hq: /fixture/hq\n');
  const contractPath = join(root, 'platform', 'contracts', 'generated', 'config.schema.json');
  return { root, topPath, contractPath };
}

function writeContract(contractPath, minimum = 1) {
  const contract = structuredClone(CFG_JSON_SCHEMA);
  contract.properties.roots.properties.example_retention_days = { type: 'integer', minimum };
  const bytes = JSON.stringify(contract);
  mkdirSync(dirname(contractPath), { recursive: true });
  writeFileSync(contractPath, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

test('checkout schema validates a contract-only key in local overlays and module aliases', t => {
  const { root, topPath, contractPath } = fixture(t);
  const digest = writeContract(contractPath);
  const log = t.mock.method(console, 'error', () => {});
  const localPath = join(root, 'config.local.yaml');
  const modulePath = join(root, 'module.yaml');
  writeFileSync(modulePath, '__aliases:\n  days: roots.example_retention_days\ndays: 3\n');
  const options = { topPath, modulePaths: [modulePath], env: { AGENT_OS_ROOT: root } };

  for (const version of ['', 'version: 1\n']) {
    writeFileSync(localPath, `${version}roots:\n  example_retention_days: 7\n`);
    for (const load of [loadConfig, loadConfigRuntime, loadConfigCached]) {
      const config = load(options);
      assert.equal(config.get('roots.example_retention_days'), 7);
      assert.deepEqual(config.resolutionTrace('roots.example_retention_days').map(entry => entry.value), [3, 7]);
    }
  }
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], new RegExp(`schema source=contract sha256=${digest}`));

  writeFileSync(topPath, 'version: 1\nroots:\n  genuinely_unknown_example: 7\n');
  assert.throws(() => loadConfig(options), { key: 'roots.genuinely_unknown_example' });
});

test('profile overlays validate contract-only keys in both document forms', t => {
  const { root, topPath, contractPath } = fixture(t);
  writeContract(contractPath);
  t.mock.method(console, 'error', () => {});
  const overlayPath = join(root, 'config.profile.reference-host.yaml');
  const options = { topPath, env: { AGENT_OS_ROOT: root, AGENT_OS_PROFILE: 'reference-host' } };
  for (const version of ['', 'version: 1\n']) {
    writeFileSync(overlayPath, `${version}roots:\n  example_retention_days: 7\n`);
    const config = loadConfig(options);
    assert.equal(config.get('roots.example_retention_days'), 7);
    assert.equal(config.resolutionTrace('roots.example_retention_days').at(-1).source, `profile:${overlayPath}`);
  }
});

test('schema path resolution defaults to the process environment', t => {
  const { root, contractPath } = fixture(t);
  const previousRoot = process.env.AGENT_OS_ROOT;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.AGENT_OS_ROOT;
    else process.env.AGENT_OS_ROOT = previousRoot;
  });
  process.env.AGENT_OS_ROOT = root;
  assert.equal(contractSchemaPath(), contractPath);
});

test('OSG shape validation honors required arm fields declared by the schema', () => {
  const contract = structuredClone(CFG_JSON_SCHEMA);
  const osg = contract.properties.osg;
  const arm = osg.properties.arms.items;
  arm.properties.example_optional_field = { type: 'string' };
  const schema = fromJsonSchema(contract);
  const validArm = Object.fromEntries(arm.required.map(key => [key, true]));
  validateOsgShape({ arms: [validArm] }, null, schema);
  for (const key of arm.required) {
    const incomplete = { ...validArm };
    delete incomplete[key];
    assert.throws(() => validateOsgShape({ arms: [incomplete] }, null, schema), { key: 'osg.arms' });
  }

  const partialSchema = fromJsonSchema({ type: 'object' });
  validateOsgShape({ arms: [{}] }, null, partialSchema);
  assert.throws(() => validateOsgShape({ arms: [null] }, null, partialSchema), { key: 'osg.arms' });
});

test('cached loads track the deploy contract and recover after it is replaced', t => {
  const { root, topPath, contractPath } = fixture(t);
  t.mock.method(console, 'error', () => {});
  const options = { topPath, env: { AGENT_OS_DEPLOY_CHECKOUT: root } };
  writeFileSync(join(root, 'config.local.yaml'), 'roots:\n  example_retention_days: 7\n');

  assert.equal(loadConfigCached(options).get('roots.example_retention_days'), null);
  writeContract(contractPath);
  assert.equal(loadConfigCached(options).get('roots.example_retention_days'), 7);
  writeContract(contractPath, 8);
  assert.throws(() => loadConfigCached(options), { key: 'roots.example_retention_days' });
  rmSync(contractPath);
  assert.equal(loadConfigCached(options).get('roots.example_retention_days'), null);
});

function subprocessLogs(root, topPath, expectedDays) {
  for (const name of ['src', 'node_modules']) {
    symlinkSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(root, name), 'dir');
  }
  const output = execFileSync(process.execPath, ['--preserve-symlinks', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { loadConfig } from './src/config-loader.mjs';
    const messages = [];
    console.error = message => messages.push(message);
    for (let i = 0; i < 2; i++) {
      const config = loadConfig({ topPath: ${JSON.stringify(topPath)}, env: {} });
      assert.equal(config.get('roots.hq'), '/fixture/hq');
      assert.equal(config.get('roots.example_retention_days'), ${JSON.stringify(expectedDays)});
    }
    console.log(JSON.stringify(messages));
  `], { cwd: root, encoding: 'utf8' });
  return JSON.parse(output);
}

test('standalone loads use the bundled schema and report its digest once', t => {
  const { root, topPath } = fixture(t);
  const messages = subprocessLogs(root, topPath, null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /schema source=bundled sha256=[a-f0-9]{64} fallback=no checkout/);
});

test('the deployed module layout selects the checkout schema for staged config', t => {
  const { root: checkout, contractPath } = fixture(t);
  const { root: stagedRoot, topPath } = fixture(t);
  const digest = writeContract(contractPath);
  const reviewModule = join(checkout, 'tools', 'adversarial-review');
  mkdirSync(reviewModule, { recursive: true });
  writeFileSync(join(stagedRoot, 'config.local.yaml'), 'roots:\n  example_retention_days: 7\n');
  const messages = subprocessLogs(reviewModule, topPath, 7);
  assert.equal(messages.length, 1);
  assert.match(messages[0], new RegExp(`schema source=contract sha256=${digest}`));
});

test('unreadable and unparsable contracts fall back and report the reason', t => {
  const { root, topPath, contractPath } = fixture(t);
  const log = t.mock.method(console, 'error', () => {});
  const options = { topPath, env: { AGENT_OS_ROOT: root } };
  // A directory remains unreadable as a schema file even under root.
  mkdirSync(contractPath, { recursive: true });
  for (let i = 0; i < 2; i++) assert.equal(loadConfig(options).get('roots.hq'), '/fixture/hq');
  assert.equal(log.mock.callCount(), 1);
  assert.match(log.mock.calls[0].arguments[0], /schema source=bundled sha256=[a-f0-9]{64} fallback=contract unavailable \(unreadable file\)/);

  rmSync(contractPath, { recursive: true });
  writeFileSync(contractPath, '{not JSON');
  assert.equal(loadConfig(options).get('roots.hq'), '/fixture/hq');
  assert.equal(log.mock.callCount(), 2);
  assert.match(log.mock.calls[1].arguments[0], /fallback=contract unavailable \(invalid schema\)/);
});
