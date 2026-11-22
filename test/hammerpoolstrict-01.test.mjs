import './helpers/registry-session-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOSConfigError, loadConfig, loadConfigForIdentityTokenPool, resetConfigCache,
  resetRuntimeUnknownWarningCacheForTests } from '../src/config-loader.mjs';
import { resolveIdentityTokenPools } from '../src/role-config.mjs';
import { evidenceUnknownReason, selectWorkerTokenAccount } from '../src/worker-token-pool.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';

const defaults = JSON.parse(readFileSync(new URL('./fixtures/identity-token-selection.v1.json', import.meta.url))).defaults;

// Synthetic hammer pool and a matching owner reply (codex family fixture).
function hammerWire() {
  const wire = structuredClone(defaults);
  const members = ['openai-corporate', 'openai-primary'];
  wire.oauth.identity_token_pools.hammer = members;
  wire.request.identity = wire.request.snapshot.identity = 'hammer';
  wire.request.identity_models = wire.request.requested_models = wire.request.snapshot.requested_models = ['gpt-6'];
  wire.selection = { version: 1, identity: 'hammer', generation: wire.request.generation,
    status: 'selected', account_id: members[0], reason: 'preferred-ready',
    considered: [{ account_id: members[0], reason: 'ready', component: null }] };
  return wire;
}

function fixtureConfig(t, extra = {}, mutateOauth = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hammerpoolstrict-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); resetConfigCache(); });
  resetConfigCache();
  resetRuntimeUnknownWarningCacheForTests();
  const wire = hammerWire();
  mutateOauth(wire.oauth);
  const topPath = join(dir, 'config.yaml');
  writeFileSync(topPath, JSON.stringify({ version: 1, oauth: wire.oauth, ...extra }));
  return { wire, topPath, env: { AGENT_OS_CONFIG_PATH: topPath } };
}

const newerHostKey = { worker_pool: { synthetic_new_key: { enabled: false, nested: { depth: 2 } } } };

test('HAMMERPOOLSTRICT-01 the strict general reader still refuses the unknown key (control)', t => {
  const { topPath } = fixtureConfig(t, newerHostKey);
  assert.throws(() => loadConfig({ topPath, env: {} }),
    /worker_pool\.synthetic_new_key: unknown key/);
});

test('HAMMERPOOLSTRICT-01 an unknown checked-in key no longer holds the pool read; it is dropped and recorded', t => {
  const { topPath, env } = fixtureConfig(t, newerHostKey);
  const cfg = loadConfigForIdentityTokenPool({ topPath, env: {}, identity: 'hammer' });
  assert.ok(cfg.runtimeDroppedUnknownKeys.some(entry => entry.key === 'worker_pool.synthetic_new_key'));
  const pools = resolveIdentityTokenPools({ env, identity: 'hammer' });
  assert.deepEqual(pools.identity_token_pools.hammer, ['openai-corporate', 'openai-primary']);
  assert.equal(JSON.stringify(pools).includes('synthetic_new_key'), false);
});

test('HAMMERPOOLSTRICT-01 selectWorkerTokenAccount reaches the owner instead of evidence-unknown', async t => {
  const { wire, env } = fixtureConfig(t, newerHostKey);
  let proposals = 0;
  const result = await selectWorkerTokenAccount({ identity: 'hammer', model: 'gpt-6', env,
    ownerImpl: async request => {
      proposals++;
      assert.equal(request.identity, 'hammer');
      return wire;
    } });
  assert.equal(proposals, 1);
  assert.equal(result.hold, false);
  assert.equal(result.status, 'selected');
  assert.equal(result.tokenAccountId, wire.selection.account_id);
});

test('HAMMERPOOLSTRICT-01 the known-but-mirrored host knob no longer warns', t => {
  const { topPath } = fixtureConfig(t, { worker_pool: { worktree_reuse: { enabled: false } } });
  const cfg = loadConfigForIdentityTokenPool({ topPath, env: {}, identity: 'hammer' });
  assert.deepEqual(cfg.runtimeDroppedUnknownKeys, []);
  assert.equal(cfg.get('worker_pool.worktree_reuse.enabled'), false);
  assert.doesNotThrow(() => loadConfig({ topPath, env: {} }));
});

for (const [name, mutate] of [
  ['an account list with a non-string member', oauth => { oauth.identity_token_pools.hammer = [7]; }],
  ['a pool declared as a scalar', oauth => { oauth.identity_token_pools.hammer = 'openai-primary'; }],
  ['a pool referencing an undeclared account', oauth => { oauth.identity_token_pools.hammer = ['no-such-account']; }],
]) {
  test(`HAMMERPOOLSTRICT-01 ${name} still fails closed alongside an unknown key`, async t => {
    const { env } = fixtureConfig(t, newerHostKey, mutate);
    assert.throws(() => resolveIdentityTokenPools({ env, identity: 'hammer' }));
    const result = await selectWorkerTokenAccount({ identity: 'hammer', model: 'gpt-6', env,
      ownerImpl: async () => assert.fail('a malformed declaration must not reach the owner') });
    assert.equal(result.hold, true);
    assert.equal(result.status, 'held');
    assert.notEqual(result.status, 'selected');
  });
}

test('HAMMERPOOLSTRICT-01 a malformed pool value is a typed config-load-error naming only class and key path', async t => {
  const { env } = fixtureConfig(t, newerHostKey, oauth => {
    oauth.identity_token_pools.hammer = { synthetic_secret_marker: 'do-not-echo' };
  });
  const result = await selectWorkerTokenAccount({ identity: 'hammer', model: 'gpt-6', env,
    ownerImpl: async () => assert.fail('must fail closed') });
  assert.equal(result.hold, true);
  assert.equal(result.reason, 'config-load-error');
  assert.equal(result.configLoadError.errorClass, 'AgentOSConfigError');
  assert.match(result.configLoadError.keyPath, /^oauth\.identity_token_pools/);
  assert.equal(JSON.stringify(result).includes('do-not-echo'), false);
});

test('HAMMERPOOLSTRICT-01 non-config faults keep the evidence-unknown reason', async () => {
  assert.deepEqual(evidenceUnknownReason(new Error('owner transport')), { reason: 'evidence-unknown' });
  const result = await selectWorkerTokenAccount({ identity: 'hammer', model: 'gpt-6',
    oauth: hammerWire().oauth, ownerImpl: async () => { throw new Error('owner transport'); } });
  assert.equal(result.reason, 'evidence-unknown');
  assert.equal(result.configLoadError, undefined);
});

test('HAMMERPOOLSTRICT-01 a forced load error reaches the closer resolution as config-load-error with class and key only', async () => {
  const resolvePoolsImpl = () => { throw new AgentOSConfigError('worker_pool.future_key: secret-value-42 rejected',
    { key: 'worker_pool.future_key', got: 'secret-value-42' }); };
  const closer = await resolveCloserDispatchHarness({ workerClass: 'hammer', env: {},
    codexAccountPolicy: 'pinned', execFileImpl: async () => ({ stdout: '{}' }),
    selectAccountImpl: request => selectWorkerTokenAccount({ ...request, resolvePoolsImpl,
      ownerImpl: () => assert.fail('no owner read after a config error') }) });
  assert.equal(closer.hold, true);
  assert.equal(closer.reason, 'config-load-error');
  assert.deepEqual(closer.configLoadError, { errorClass: 'AgentOSConfigError', keyPath: 'worker_pool.future_key' });
  assert.equal(JSON.stringify(closer).includes('secret-value-42'), false);
});
