import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

// ONS-07: worker vault policies follow the Python loader exactly: leaf types
// from the generated schema, then _validate_secrets_config on the merged view.
function fixture(body, check, localBody) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-class-vaults-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, body);
    if (localBody) writeFileSync(join(dir, 'config.local.yaml'), localBody);
    check(loadConfig({ topPath, env: {} }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const vaults = entry => `version: 1
worker_pool:
  secrets:
    shared_vaults: [SharedVault]
    worker_class_vaults:
      research:
${Object.entries(entry).map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`).join('\n')}
`;

test('strict Node loader accepts a complete worker vault policy', () => {
  fixture(vaults({ vault: 'ExampleVault', service_account_token_ref: 'op://ExampleVault/worker/credential' }), cfg => {
    assert.deepEqual(cfg.get('worker_pool.secrets.worker_class_vaults.research'), {
      vault: 'ExampleVault',
      service_account_token_ref: 'op://ExampleVault/worker/credential',
      shared_vault_optin: [],
    });
  });
});

for (const [entry, key] of [
  [{ vault: 123 }, 'vault'],
  [{ service_account_token_ref: 123 }, 'service_account_token_ref'],
  [{ shared_vault_optin: 'wrong' }, 'shared_vault_optin'],
  [{ shared_vault_optin: [123] }, 'shared_vault_optin[0]'],
  [{ vault: 'ExampleVault' }, 'service_account_token_ref'],
  [{ service_account_token_ref: 'op://ExampleVault/worker/credential' }, 'vault'],
  [{ service_account_token_ref: '' }, 'vault'],
  [{ vault: 'ExampleVault', service_account_token_ref: 'plain-token' }, 'service_account_token_ref'],
  [{ vault: 'ExampleVault', service_account_token_ref: 'op://ExampleVault/worker' }, 'service_account_token_ref'],
  [{ vault: 'V', service_account_token_ref: 'op://V/i/f', shared_vault_optin: ['Other'] }, 'shared_vault_optin[0]'],
]) {
  test(`worker vault policy rejects ${JSON.stringify(entry)} at ${key}`, () => {
    assert.throws(() => fixture(vaults(entry), () => {}), error => {
      assert.ok(error instanceof AgentOSConfigError);
      assert.equal(error.key, `worker_pool.secrets.worker_class_vaults.research.${key}`);
      return true;
    });
  });
}

test('an empty policy (all leaves unset) is accepted', () => {
  fixture(vaults({ service_account_token_ref: null }), cfg => {
    assert.equal(cfg.get('worker_pool.secrets.worker_class_vaults.research.vault'), null);
  });
});

test('vault policies merge across layers before semantic validation', () => {
  fixture(vaults({ vault: 'ExampleVault', shared_vault_optin: ['SharedVault'] }), cfg => {
    assert.deepEqual(cfg.get('worker_pool.secrets.worker_class_vaults.research'), {
      vault: 'ExampleVault',
      service_account_token_ref: 'op://ExampleVault/worker/credential',
      shared_vault_optin: ['SharedVault'],
    });
  }, 'worker_pool:\n  secrets:\n    worker_class_vaults:\n      research:\n        service_account_token_ref: op://ExampleVault/worker/credential\n');
});

test('unknown secrets and vault fields fail like the Python loader', () => {
  assert.throws(() => fixture('version: 1\nworker_pool:\n  secrets:\n    worker_class_vault: {}\n', () => {}),
    /worker_pool\.secrets\.worker_class_vault: unknown key \(strict schema\)/);
  assert.throws(() => fixture(vaults({ future_example: true }), () => {}),
    /worker_pool\.secrets\.worker_class_vaults\.research\.future_example: unknown key \(strict schema\)/);
});
