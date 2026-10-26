// Runtime refusal only. The inspect-only migration/report owner lives in
// cwp_dispatch.config_token_pool_migration and publishes no host configuration.
import { canonicalWorkerClass } from './worker-class-aliases.mjs';

export class PoolConfigConflictError extends Error {
  constructor(keys, source) {
    super(`${keys[0]}: conflicting legacy/new account policy (${source}); inspect migration report`);
    this.name = 'PoolConfigConflictError';
    this.key = keys[0];
    this.keys = Object.freeze([...keys]);
  }
}

const warnedKeys = new Set();
export function warnPoolConfigConflicts(keys, warn = console.warn) {
  for (const key of keys) {
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    warn(`pool-config-conflict: ${key}`);
  }
}

export function legacyPoolOverrideConflicts(cfg) {
  const pools = cfg.get('oauth.identity_token_pools', {});
  if (pools == null || !Object.keys(pools).length) return [];
  const conflicts = [];
  const source = key => cfg.resolutionTrace?.(key)?.at(-1)?.source || 'code-default';
  const paths = {
    'roles.remediator': { codex: 'remediator-codex', 'claude-code': 'remediator-claude', claude: 'remediator-claude' },
    'roles.adversarial.merge_authority.worker_class': {},
    'roles.merge_agent_worker_class': {},
    'roles.build_pack_default_worker_class': {},
  };
  for (const [key, renames] of Object.entries(paths)) {
    const value = canonicalWorkerClass(cfg.get(key));
    const role = Object.hasOwn(renames, value) ? renames[value] : value;
    if (Object.hasOwn(pools, role) && source(key) !== 'code-default') conflicts.push(key);
  }
  const key = 'roles.codex_worker_account_order';
  if (cfg.get(key) === 'personal-first' && source(key) !== 'code-default'
    && Object.keys(pools).some(role => ['codex', 'codex-reviewer', 'hammer', 'remediator-codex'].includes(role))) conflicts.push(key);
  return conflicts;
}

export function validateLegacyPoolOverrides(cfg) {
  const keys = legacyPoolOverrideConflicts(cfg);
  if (keys.length) throw new PoolConfigConflictError(keys,
    cfg.resolutionTrace?.(keys[0])?.at(-1)?.source || 'code-default');
}
