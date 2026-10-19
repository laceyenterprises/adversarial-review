import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

function fixture(body, check, localBody) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-class-vaults-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, body);
    if (localBody) writeFileSync(join(dir, 'config.local.yaml'), localBody);
    check(loadConfig({ topPath, env: {}, tolerateUnknown: false }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('strict Node loader accepts fleet-defined worker vaults from canonical YAML', () => {
  fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      claude-code-corp:
        vault: ExampleVault
        service_account_token_ref: op://ExampleVault/worker/credential
        shared_vault_optin: []
      research:
        vault: ResearchVault
`, cfg => {
    assert.deepEqual(cfg.get('worker_pool.secrets.worker_class_vaults.claude-code-corp'), {
      vault: 'ExampleVault',
      service_account_token_ref: 'op://ExampleVault/worker/credential',
      shared_vault_optin: [],
    });
    assert.equal(cfg.get('worker_pool.secrets.worker_class_vaults.research.vault'), 'ResearchVault');
    assert.deepEqual(cfg.get('worker_pool.secrets.worker_class_vaults.research.shared_vault_optin'), []);
  });
});

for (const workerClass of ['research', 'dream', 'claude-code-corp']) {
  test(`${workerClass} vault entry receives canonical leaf defaults`, () => {
    fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      ${workerClass}:
        vault: ExampleVault
`, cfg => {
      assert.deepEqual(cfg.get(`worker_pool.secrets.worker_class_vaults.${workerClass}`), {
        vault: 'ExampleVault',
        service_account_token_ref: null,
        shared_vault_optin: [],
      });
    });
  });

  for (const [leaf, value] of [
    ['vault', 123],
    ['service_account_token_ref', 123],
    ['shared_vault_optin', 'wrong'],
    ['shared_vault_optin', [123]],
    ['misspelled', 'value'],
    ['service_account_token_ref', 'plain-token'],
    ['service_account_token_ref', 'op://ExampleVault/worker'],
    ['service_account_token_ref', 'https://ExampleVault/worker/credential'],
  ]) {
    test(`${workerClass} rejects ${leaf}: ${JSON.stringify(value)}`, () => {
      assert.throws(() => fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      ${workerClass}:
        ${leaf}: ${JSON.stringify(value)}
`, () => {}), error => {
        assert.ok(error instanceof AgentOSConfigError);
        const suffix = Array.isArray(value) ? '[0]' : '';
        assert.equal(error.key, `worker_pool.secrets.worker_class_vaults.${workerClass}.${leaf}${suffix}`);
        return true;
      });
    });
  }

  for (const ref of [null, '', 'op://ExampleVault/worker/credential', 'op://ExampleVault/worker/section/credential']) {
    test(`${workerClass} accepts token reference ${JSON.stringify(ref)}`, () => {
      fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      ${workerClass}:
        service_account_token_ref: ${JSON.stringify(ref)}
`, cfg => {
        assert.deepEqual(cfg.get(`worker_pool.secrets.worker_class_vaults.${workerClass}`), {
          vault: null,
          service_account_token_ref: ref,
          shared_vault_optin: [],
        });
      });
    });
  }
}

test('fleet vault defaults are backfilled after local overrides merge', () => {
  fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      claude-code-corp:
        vault: ExampleVault
        shared_vault_optin: [SharedVault]
`, cfg => {
    assert.deepEqual(cfg.get('worker_pool.secrets.worker_class_vaults.claude-code-corp'), {
      vault: 'ExampleVault',
      service_account_token_ref: 'op://ExampleVault/worker/credential',
      shared_vault_optin: ['SharedVault'],
    });
  }, `version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      claude-code-corp:
        service_account_token_ref: op://ExampleVault/worker/credential
`);
});

test('known worker vault entries retain Python leaf validation', () => {
  assert.throws(() => fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vaults:
      research:
        shared_vault_optin: wrong
`, () => {}), AgentOSConfigError);
});

test('strict Node loader still refuses misspelled secrets keys', () => {
  assert.throws(() => fixture(`version: 1
worker_pool:
  secrets:
    worker_class_vault: {}
`, () => {}), AgentOSConfigError);
});
