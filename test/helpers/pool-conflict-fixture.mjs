import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function poolConflictFixture(t, { identities = ['codex'], invalidAccounts = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pool-conflict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const topPath = join(dir, 'config.yaml');
  const oauth = {
    token_accounts: {
      first: { family: 'codex', broker_provider: 'codex-corp', allowed_models: ['gpt-6'], concurrency: invalidAccounts ? 0 : 1 },
      second: { family: 'codex', broker_provider: 'codex', allowed_models: ['gpt-6'], concurrency: 1 },
    },
    identity_token_pools: Object.fromEntries(identities.map(role => [role, ['first', 'second']])),
  };
  writeFileSync(topPath, JSON.stringify({ version: 1, oauth }));
  writeFileSync(join(dir, 'config.local.yaml'), JSON.stringify({ roles: {
    build_pack_default_worker_class: 'codex', codex_worker_account_order: 'personal-first',
  } }));
  return { oauth, options: { topPath, modulePaths: [], env: {} },
    env: { AGENT_OS_CONFIG_PATH: topPath } };
}
