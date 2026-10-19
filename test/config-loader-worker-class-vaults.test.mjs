import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AgentOSConfigError } from '../src/config-loader.mjs';

function fixture(body, check) {
  const dir = mkdtempSync(join(tmpdir(), 'worker-class-vaults-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, body);
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
