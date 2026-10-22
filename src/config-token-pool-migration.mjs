// Runtime refusal only. The inspect-only migration/report owner lives in
// cwp_dispatch.config_token_pool_migration and publishes no host configuration.
import { canonicalWorkerClass } from './worker-class-aliases.mjs';

export function validateLegacyPoolOverrides(cfg) {
  const pools = cfg.get('oauth.identity_token_pools', {});
  if (!Object.keys(pools).length) return;
  const source = key => cfg.resolutionTrace?.(key)?.at(-1)?.source || 'code-default';
  const refuse = key => {
    throw new Error(`${key}: conflicting legacy/new account policy (${source(key)}); inspect migration report`);
  };
  const paths = {
    'roles.remediator': { codex: 'remediator-codex', 'claude-code': 'remediator-claude', claude: 'remediator-claude' },
    'roles.adversarial.merge_authority.worker_class': {},
    'roles.merge_agent_worker_class': {},
    'roles.build_pack_default_worker_class': {},
  };
  for (const [key, renames] of Object.entries(paths)) {
    const value = cfg.get(key);
    const role = Object.hasOwn(renames, value) ? renames[value] : canonicalWorkerClass(value);
    if (Object.hasOwn(pools, role) && source(key) !== 'code-default') refuse(key);
  }
  const key = 'roles.codex_worker_account_order';
  if (cfg.get(key) === 'personal-first' && source(key) !== 'code-default'
    && Object.keys(pools).some(role => ['codex', 'codex-reviewer', 'hammer', 'remediator-codex'].includes(role))) refuse(key);
}
