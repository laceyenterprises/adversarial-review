import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config-loader.mjs';
import { resolveIdentityTokenPools } from '../src/role-config.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const accounts = {
  corp: { family: 'codex', broker_provider: 'codex-corp', allowed_models: ['gpt-6'], concurrency: 1 },
  personal: { family: 'codex', broker_provider: 'codex', allowed_models: ['gpt-6'], concurrency: 1 },
};

test('ITP-17 strict loader default is corporate-first before any role selector', () => {
  assert.equal(loadConfig({ topPath: '/nonexistent/itp17/config.yaml', modulePaths: [], env: {} }).get('roles.codex_worker_account_order'), 'corporate-first');
});

for (const [key, value] of [
  ['roles.codex_worker_account_order', 'personal-first'],
  ['roles.remediator', 'codex'],
  ['roles.adversarial.merge_authority.worker_class', 'hammer'],
]) test(`ITP-17 conflicting legacy override refuses with exact path: ${key}`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'itp17-conflict-'));
  try {
    const topPath = join(dir, 'config.yaml');
    writeFileSync(topPath, JSON.stringify({ version: 1, oauth: {
      token_accounts: accounts, identity_token_pools: {
        hammer: ['corp', 'personal'], 'remediator-codex': ['corp', 'personal'],
      },
    } }));
    const local = {};
    const parts = key.split('.');
    let node = local;
    for (const part of parts.slice(0, -1)) node = node[part] = {};
    node[parts.at(-1)] = value;
    writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify(local));
    assert.throws(() => resolveIdentityTokenPools({ topPath, modulePaths: [], env: {} }), error =>
      error.message.includes(key) && error.message.includes('local:'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
