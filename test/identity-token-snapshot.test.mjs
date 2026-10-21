import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fleet from '../src/fleet-quota-status.mjs';
import * as roles from '../src/role-config.mjs';

// Dynamic loading lets the exact acceptance tests report missing capabilities
// individually when replayed against the pre-change parent's source.
const readerUrl = new URL('../src/identity-token-snapshot.mjs', import.meta.url);
const reader = await import(readerUrl.href).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === readerUrl.href) return {};
  throw error;
});
const { identityPoolsFromSnapshot } = fleet;
const { resolveIdentityTokenPools } = roles;

const vectors = JSON.parse(readFileSync(new URL('./fixtures/identity-token-selection.v1.json', import.meta.url)));
const outcomes = JSON.parse(readFileSync(new URL('./fixtures/identity-token-outcomes.v1.json', import.meta.url)));
function merge(base, patch) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
      ? merge(result[key], value) : structuredClone(value);
  }
  return result;
}
const inputs = () => structuredClone(vectors.defaults);

test('published outcome coverage matches every versioned owner vector', () => {
  assert.equal(vectors.version, 1);
  assert.equal(outcomes.version, vectors.version);
  assert.deepEqual(outcomes.cases.map(c => c.name), vectors.cases.map(c => c.name));
});

test('Claude remediator fallback vectors degrade the preferred corporate account', () => {
  for (const reason of ['quota-exhausted', 'not-ready', 'reserve-refused', 'model-denied', 'capacity-saturated']) {
    const vector = vectors.cases.find(c => c.name === `remediator-claude-${reason}`);
    const value = merge(vectors.defaults, vector.patch);
    const [preferred, fallback] = value.oauth.identity_token_pools['remediator-claude'];
    assert.deepEqual(Object.keys(vector.patch.request.snapshot.accounts), [preferred]);
    assert.equal(vector.expected.account_id, fallback);
    assert.equal(vector.expected.considered[0].account_id, preferred);
    assert.equal(vector.expected.considered[0].reason, reason);
  }
});

for (const [index, vector] of vectors.cases.entries()) {
  test(`ITP-10 consumes Python outcome: ${vector.name}`, () => {
    assert.equal(typeof reader.readAccountSelection, 'function');
    const value = merge(vectors.defaults, vector.patch ?? {});
    const before = structuredClone(value);
    const outcome = outcomes.cases[index];
    if (vector.error) {
      assert.match(outcome.error, new RegExp(vector.error));
      assert.throws(() => reader.readAccountSelection(outcome.result, value), new RegExp(vector.error));
    } else {
      const receipt = reader.readAccountSelection(outcome.result, value);
      assert.deepEqual(receipt, outcome.result);
      for (const [key, expected] of Object.entries(vector.expected)) assert.deepEqual(receipt[key], expected);
      assert.ok(Object.isFrozen(receipt));
      assert.ok(Object.isFrozen(receipt.considered));
    }
    assert.deepEqual(value, before);
  });
}

test('canonical reviewer receipt retains identity and account without a twin class', () => {
  const value = inputs();
  value.request.identity = value.request.snapshot.identity = 'codex-reviewer';
  const result = { ...structuredClone(outcomes.cases[0].result), identity: 'codex-reviewer' };
  const receipt = reader.readAccountSelection(result, value);
  assert.equal(receipt.identity, 'codex-reviewer');
  assert.equal(receipt.account_id, 'openai-corporate');
  result.considered[0].reason = 'changed';
  assert.equal(receipt.considered[0].reason, 'ready');
});

test('snapshot reader copies and freezes evidence; missing components stay missing', () => {
  const value = inputs();
  value.request.snapshot.accounts['openai-corporate'].quota = null;
  const snapshot = reader.readSelectionSnapshot(value.request.snapshot, value.oauth);
  value.request.snapshot.accounts = {};
  assert.equal(snapshot.accounts['openai-corporate'].quota, null);
  assert.ok(Object.isFrozen(snapshot.accounts['openai-corporate']));
});

for (const mutate of [
  value => { value.request.snapshot.version = 2; },
  value => { value.oauth.token_accounts.other = { ...value.oauth.token_accounts['agy-login-a'] }; },
  value => { value.request.snapshot.access_token = 'Bearer synthetic-secret-sentinel'; },
  value => { value.request.snapshot.accounts['openai-corporate'].quota.token = 'synthetic-secret-sentinel'; },
  value => { value.request.snapshot.generation = 'Bearer synthetic-secret-sentinel'; },
]) {
  test(`ITP-10 rejects invalid/credential-bearing snapshot: ${mutate}`, () => {
    assert.equal(typeof reader.readAccountSelection, 'function');
    const value = inputs();
    mutate(value);
    assert.throws(() => reader.readAccountSelection(outcomes.cases[0].result, value), error => {
      assert.ok(!error.message.includes('synthetic-secret-sentinel'));
      return true;
    });
  });
}

test('legacy Gemini holders must agree with the new ordered declaration', () => {
  assert.equal(typeof reader.readIdentityTokenPools, 'function');
  const { oauth } = inputs();
  assert.doesNotThrow(() => reader.readIdentityTokenPools(oauth, { legacyGeminiHolders: ['agy-a', 'agy-b'] }));
  for (const holders of [['agy-b', 'agy-a'], ['agy-a'], ['agy-a', 'agy-a']]) {
    assert.throws(() => reader.readIdentityTokenPools(oauth, { legacyGeminiHolders: holders }), /reviewer.gemini.identities/);
  }
  assert.deepEqual(reader.readIdentityTokenPools({}, { legacyGeminiHolders: ['agy-a'] }),
    { token_accounts: {}, identity_token_pools: {} });
});

test('role config reads effective declarations without changing routing or pin provenance', () => {
  const { oauth } = inputs();
  const values = { 'oauth.token_accounts': oauth.token_accounts, 'oauth.identity_token_pools': oauth.identity_token_pools,
    'reviewer.gemini.identities': ['agy-a', 'agy-b'] };
  const resolved = resolveIdentityTokenPools({ env: {}, topPath: '/unused', modulePaths: [],
    loaderImpl: () => ({ get: (key, fallback) => values[key] ?? fallback }) });
  assert.deepEqual(resolved, oauth);
});

test('role config normalizes legacy Gemini holder scalars like the legacy resolver', () => {
  const { oauth } = inputs();
  // YAML boolean scalars stringify to valid opaque holder IDs. Numeric IDs
  // remain invalid under the owner's alphabetic-prefix declaration contract.
  oauth.token_accounts['agy-login-a'].holder_user = 'true';
  oauth.token_accounts['agy-login-b'].holder_user = 'false';
  const values = { 'oauth.token_accounts': oauth.token_accounts, 'oauth.identity_token_pools': oauth.identity_token_pools,
    'reviewer.gemini.identities': [true, false] };
  const options = { env: {}, topPath: '/unused', modulePaths: [],
    loaderImpl: () => ({ get: (key, fallback) => values[key] ?? fallback }) };
  assert.deepEqual(roles.resolveGeminiReviewerIdentities(options), ['true', 'false']);
  assert.deepEqual(resolveIdentityTokenPools(options), oauth);
  values['reviewer.gemini.identities'] = [false, true];
  assert.throws(() => resolveIdentityTokenPools(options), /conflicting legacy\/new declaration/);
  oauth.token_accounts['agy-login-a'].holder_user = '101';
  assert.throws(() => resolveIdentityTokenPools(options), /expected opaque ID/);
});

test('temporary effective config rejects old/new holder conflict and retains legacy-only config', () => {
  assert.equal(typeof resolveIdentityTokenPools, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'itp-reader-'));
  const topPath = join(dir, 'config.yaml');
  const { oauth } = inputs();
  const write = (accounts, holders) => writeFileSync(topPath, JSON.stringify({ version: 1,
    oauth: accounts, reviewer: { gemini: { identities: holders } } }));
  const options = { topPath, modulePaths: [], env: {} };
  try {
    write(oauth, ['agy-a', 'agy-b']);
    assert.deepEqual(resolveIdentityTokenPools(options), oauth);
    write(oauth, ['agy-b', 'agy-a']);
    assert.throws(() => resolveIdentityTokenPools(options), /conflicting legacy\/new declaration/);
    write({}, ['agy-a']);
    assert.deepEqual(resolveIdentityTokenPools(options), { token_accounts: {}, identity_token_pools: {} });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fleetFixture() {
  return { identityPools: { 'codex-reviewer': {
    identity: 'codex-reviewer', requestedModels: ['gpt-6'], generation: 'cfg-7',
    capacity: 1, active: null, free: 1, held: 1,
    tokens: [
      { tokenAccountId: 'openai-corporate', brokerProvider: 'codex-corp', holderRef: null,
        capacity: 1, active: 0, free: 1, held: 0, reason: 'ready', component: null },
      { tokenAccountId: 'openai-primary', brokerProvider: 'codex', holderRef: null,
        capacity: 0, active: null, free: 0, held: 1, reason: 'evidence-unknown', component: 'quota' },
    ],
  } } };
}

test('fleet reader supports old state and preserves account-level unknowns', () => {
  for (const payload of [null, undefined, false, 0, 'uninitialized', {}]) {
    assert.equal(identityPoolsFromSnapshot(payload, {}), null);
  }
  assert.equal(identityPoolsFromSnapshot({ identityPools: {} }, {} ) !== null, true);
  const payload = fleetFixture();
  const pools = identityPoolsFromSnapshot(payload, inputs().oauth);
  assert.deepEqual(pools, payload.identityPools);
  assert.equal(pools['codex-reviewer'].active, null);
  payload.identityPools['codex-reviewer'].tokens[0].free = 0;
  assert.equal(pools['codex-reviewer'].tokens[0].free, 1);
});

for (const [status, reason] of [['unavailable', 'accounts-unavailable'], ['hold', 'capacity-saturated']]) {
  for (const terminalReason of ['ready', 'evidence-unknown']) {
    test(`${status} receipt rejects terminal ${terminalReason} candidate without selected account`, () => {
      const value = inputs();
      const result = { ...structuredClone(outcomes.cases[0].result), status, reason, account_id: null,
        considered: value.oauth.identity_token_pools[value.request.identity].map((account_id, index) => ({
          account_id, reason: index === 0 ? 'quota-exhausted' : terminalReason,
          component: terminalReason === 'ready' && index !== 0 ? null : 'quota',
        })) };
      assert.throws(() => reader.readAccountSelection(result, value), /candidate must refuse/);
    });
  }
}

test('accounts-unavailable receipt must consider every declared account', () => {
  const value = inputs();
  const result = { ...structuredClone(outcomes.cases[0].result), status: 'unavailable',
    reason: 'accounts-unavailable', account_id: null, considered: [] };
  for (const considered of [[], [{ account_id: 'openai-corporate', reason: 'quota-exhausted', component: 'quota' }]]) {
    result.considered = considered;
    assert.throws(() => reader.readAccountSelection(result, value), /all accounts must be considered/);
  }
});

for (const mutate of [
  p => { p.identityPools['codex-reviewer'].tokens[1] = p.identityPools['codex-reviewer'].tokens[0]; },
  p => { p.identityPools['codex-reviewer'].tokens[0].brokerProvider = 'codex'; },
  p => { p.identityPools['codex-reviewer'].capacity = 2; },
  p => { p.identityPools['codex-reviewer'].tokens[0].oauth = 'synthetic-secret-sentinel'; },
  p => { p.identityPools = null; },
]) {
  test(`fleet projection rejects inconsistent or credential-bearing metadata: ${mutate}`, () => {
    assert.equal(typeof identityPoolsFromSnapshot, 'function');
    const payload = fleetFixture(); mutate(payload);
    assert.throws(() => identityPoolsFromSnapshot(payload, inputs().oauth));
  });
}

for (const [name, mutate] of [
  ['version', r => { r.version = 2; }],
  ['identity', r => { r.identity = 'hammer'; }],
  ['generation', r => { r.generation = 'cfg-6'; }],
  ['account model denial', (r, v) => { v.oauth.token_accounts['openai-corporate'].allowed_models = ['other-model']; }],
  ['duplicate candidate', r => { r.considered.push(structuredClone(r.considered[0])); }],
  ['unknown before fallback', r => { r.considered.unshift({ account_id: 'openai-corporate', reason: 'evidence-unknown', component: 'quota' }); }],
  ['status/reason mismatch', r => { r.status = 'hold'; }],
  ['bearer metadata', r => { r.access_token = 'synthetic-secret-sentinel'; }],
  ['bearer in reason', r => { r.reason = 'Bearer synthetic-secret-sentinel'; }],
  ['bearer in candidate', r => { r.considered[0].token = 'synthetic-secret-sentinel'; }],
]) {
  test(`receipt rejects ${name}`, () => {
    assert.equal(typeof reader.readAccountSelection, 'function');
    const value = inputs();
    const result = structuredClone(outcomes.cases[0].result);
    mutate(result, value);
    assert.throws(() => reader.readAccountSelection(result, value), error => {
      assert.ok(!error.message.includes('synthetic-secret-sentinel'));
      return true;
    });
  });
}
