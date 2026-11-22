import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __testYamlHooks, AgentOSConfigError, configSignatureStatus, loadConfig, loadConfigCached,
  resetConfigCache, validateSchema,
} from '../src/config-loader.mjs';
import { validatePublicHygiene } from '../src/config-policies.mjs';

test('public hygiene validation leaves mutable, sealed and frozen policies unchanged', () => {
  for (const protect of [value => value, Object.seal, Object.freeze]) {
    for (const input of [{}, { repos: null, identities: null }, { identities: { codex: { name: 'Fixture', email: 'fixture@example.invalid' } } }]) {
      const before = structuredClone(input);
      const policy = protect(input);
      assert.doesNotThrow(() => validatePublicHygiene(policy));
      assert.deepEqual(policy, before);
    }
    assert.throws(() => validatePublicHygiene(protect({ repos: ['invalid'] })), AgentOSConfigError);
  }
});

test('public hygiene accepts empty and populated policy without host defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    const defaults = loadConfig({ topPath, env: {} });
    assert.deepEqual(defaults.get('worker_pool.public_hygiene'), { repos: [], identities: {} });
    assert.deepEqual(defaults.resolutionTrace('worker_pool.public_hygiene.identities'), [
      { source: 'code-default', value: {}, path: null },
    ]);
    const denylistPath = join(dir, 'private-rules');
    writeFileSync(denylistPath, 'literal:invented-fixture\n');
    const policy = { repos: ['fixture-org/public-repo'], identities: { codex: { name: 'Fixture Bot', email: 'fixture@example.invalid' } }, denylist_path: denylistPath };
    writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: policy } }));
    assert.deepEqual(loadConfig({ topPath, env: {} }).get('worker_pool.public_hygiene'), policy);
    for (const invalid of [
      { ...policy, extra: true },
      { ...policy, denylist_path: null },
      { ...policy, denylist_path: 'relative' },
      { ...policy, denylist_path: join(dir, 'absent') },
      { ...policy, identities: { codex: { name: 'bad|fixture', email: 'fixture@example.invalid' } } },
      { ...policy, identities: { codex: { name: 'Fixture' } } },
      { ...policy, identities: { codex: { name: 'Fixture', email: 'fixture@example.invalid', extra: true } } },
    ]) {
      assert.throws(() => validateSchema({ version: 1, worker_pool: { public_hygiene: invalid } }));
      writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: invalid } }));
      assert.throws(() => loadConfig({ topPath, env: {} }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cached policy refuses after private denylist removal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-cache-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const denylistPath = join(dir, 'private-rules');
    writeFileSync(denylistPath, 'literal:invented-fixture\n');
    writeFileSync(topPath, JSON.stringify({ version: 1, worker_pool: { public_hygiene: { repos: ['fixture-org/public-repo'], denylist_path: denylistPath } } }));
    loadConfigCached({ topPath, env: {} });
    rmSync(denylistPath);
    assert.throws(() => loadConfigCached({ topPath, env: {} }));
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cached loads tolerate a missing public hygiene projection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-missing-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, 'version: 1\n');
    const options = { topPath, env: {} };
    const cached = loadConfigCached(options);
    const get = cached.get;
    t.mock.method(cached, 'get', function (key, ...args) {
      return key === 'worker_pool.public_hygiene' ? null : get.call(this, key, ...args);
    });
    assert.equal(loadConfigCached(options), cached);
    assert.doesNotThrow(() => validateSchema({ version: 1 }));
    assert.throws(
      () => validateSchema({ version: 1, worker_pool: { public_hygiene: null } }),
      AgentOSConfigError,
    );
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ONS-07: as in the Python loader, every layer's identity is complete on its
// own (CFG marks name and email required); a later complete identity wins.
test('identity records are complete per layer and replace field by field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-layers-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const localPath = join(dir, 'config.local.yaml');
    const identity = { name: 'Fixture Bot', email: 'fixture@example.invalid' };
    const doc = identities => ({ version: 1, worker_pool: { public_hygiene: { identities } } });
    writeFileSync(topPath, JSON.stringify(doc({ codex: identity })));
    writeFileSync(localPath, JSON.stringify(doc({ codex: { ...identity, email: 'overlay@example.invalid' } })));
    const config = loadConfig({ topPath, env: {} });
    assert.deepEqual(config.get('worker_pool.public_hygiene.identities.codex'), {
      ...identity, email: 'overlay@example.invalid',
    });
    assert.equal(config.resolutionTrace('worker_pool.public_hygiene.identities.codex.email').at(-1).path, localPath);
    writeFileSync(localPath, JSON.stringify(doc({ codex: { email: 'overlay@example.invalid' } })));
    assert.throws(() => loadConfig({ topPath, env: {} }), /identities\.codex\.name: required key is missing/);
    rmSync(localPath);
    assert.throws(() => validateSchema(doc({ codex: { name: identity.name } })), AgentOSConfigError);
    assert.throws(() => validateSchema({ worker_pool: {} }), AgentOSConfigError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cached denylist checks reuse content digests and only revalidate changed files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-io-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const denylistPath = join(dir, 'private-rules');
    writeFileSync(denylistPath, 'literal:invented-fixture\n');
    writeFileSync(topPath, JSON.stringify({
      version: 1,
      worker_pool: { public_hygiene: { repos: ['fixture-org/public-repo'], denylist_path: denylistPath } },
    }));
    let nowMs = Date.now();
    t.mock.method(Date, 'now', () => nowMs);
    const options = { topPath, env: {} };
    const cached = loadConfigCached(options);
    const reads = t.mock.method(fs, 'readFileSync');
    const decodes = t.mock.method(TextDecoder.prototype, 'decode');
    syncBuiltinESMExports();
    for (let i = 0; i < 10; i++) assert.equal(loadConfigCached(options), cached);
    assert.equal(reads.mock.callCount(), 0, 'ordinary cache hits must not read file bytes');
    assert.equal(decodes.mock.callCount(), 0, 'ordinary cache hits must not decode the denylist');

    nowMs += 1001;
    assert.equal(loadConfigCached(options), cached);
    assert.equal(reads.mock.calls.filter(call => call.arguments[0] === denylistPath).length, 1);
    assert.equal(decodes.mock.callCount(), 0, 'digest TTL expiry alone does not revalidate policy');
    assert.equal(configSignatureStatus(options).inSync, true);

    writeFileSync(denylistPath, 'literal:updated-fixture\n');
    const refreshed = loadConfigCached(options);
    assert.notEqual(refreshed, cached);
    assert.equal(decodes.mock.callCount(), 1);
    assert.equal(loadConfigCached(options), refreshed);
    assert.equal(decodes.mock.callCount(), 1);
    assert.equal(configSignatureStatus(options).inSync, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cached denylist changes fail closed and track a replacement policy path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-replace-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const first = join(dir, 'first-rules');
    const second = join(dir, 'second-rules');
    const writePolicy = denylist_path => writeFileSync(topPath, JSON.stringify({
      version: 1, worker_pool: { public_hygiene: { denylist_path } },
    }));
    writeFileSync(first, 'literal:invented-fixture\n');
    writeFileSync(second, 'literal:replacement-fixture\n');
    writePolicy(first);
    const options = { topPath, env: {} };
    const cached = loadConfigCached(options);
    writeFileSync(first, Buffer.from([0xff]));
    assert.equal(configSignatureStatus(options).inSync, false);
    assert.throws(() => loadConfigCached(options), AgentOSConfigError);
    writeFileSync(first, 'literal:repaired-fixture\n');
    assert.notEqual(loadConfigCached(options), cached);

    writePolicy(second);
    const replaced = loadConfigCached(options);
    assert.equal(replaced.get('worker_pool.public_hygiene.denylist_path'), second);
    rmSync(first);
    assert.equal(loadConfigCached(options), replaced, 'superseded denylist is no longer watched');
    writeFileSync(second, Buffer.from([0xff]));
    assert.throws(() => loadConfigCached(options), AgentOSConfigError);
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adding a denylist dependency preserves the pre-load YAML signature', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'public-hygiene-load-edit-'));
  try {
    const topPath = join(dir, 'config.yaml');
    const denylistPath = join(dir, 'private-rules');
    writeFileSync(denylistPath, 'literal:invented-fixture\n');
    const writePolicy = repos => writeFileSync(topPath, JSON.stringify({
      version: 1, worker_pool: { public_hygiene: { repos, denylist_path: denylistPath } },
    }));
    writePolicy(['fixture-org/initial']);
    const load = __testYamlHooks.load;
    let edited = false;
    t.mock.method(__testYamlHooks, 'load', (text, options) => {
      const doc = load(text, options);
      if (options?.filename === topPath && !edited) {
        edited = true;
        writePolicy(['fixture-org/updated']);
      }
      return doc;
    });
    const options = { topPath, env: {} };
    const initial = loadConfigCached(options);
    assert.deepEqual(initial.get('worker_pool.public_hygiene.repos'), ['fixture-org/initial']);
    assert.equal(configSignatureStatus(options).inSync, false);
    const refreshed = loadConfigCached(options);
    assert.notEqual(refreshed, initial);
    assert.deepEqual(refreshed.get('worker_pool.public_hygiene.repos'), ['fixture-org/updated']);
    assert.equal(configSignatureStatus(options).inSync, true);
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
