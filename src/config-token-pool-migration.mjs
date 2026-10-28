// Runtime refusal only. The inspect-only migration/report owner lives in
// cwp_dispatch.config_token_pool_migration and publishes no host configuration.
import { CLASS_ALIASES, canonicalWorkerClass } from './worker-class-aliases.mjs';

export class PoolConfigConflictError extends Error {
  constructor(keys, source) {
    super(`${keys[0]}: conflicting legacy/new account policy (${source}); inspect migration report`);
    this.name = 'PoolConfigConflictError';
    this.key = keys[0];
    this.keys = Object.freeze([...keys]);
  }
}

const warnedKeys = new Set();
const warnedRedundantKeys = new Set();
export function warnPoolConfigConflicts(keys, warn = console.warn) {
  for (const key of keys) {
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    warn(`pool-config-conflict: ${key}`);
  }
}

export function warnPoolConfigRedundancies(keys, warn = console.warn) {
  for (const key of keys) {
    if (warnedRedundantKeys.has(key)) continue;
    warnedRedundantKeys.add(key);
    warn(`pool-config-redundant: ${key}; declared pools own account order`);
  }
}

// Explicit test/reload boundary; inspection never changes either warning scope.
export function resetLegacyPoolOverrideWarnings() {
  warnedKeys.clear();
  warnedRedundantKeys.clear();
}

export function inspectLegacyPoolOverrides(cfg) {
  const result = { conflicts: [], redundant: [] };
  const pools = cfg.get('oauth.identity_token_pools', {});
  if (pools == null || !Object.keys(pools).length) return result;
  const { conflicts, redundant } = result;
  const source = key => cfg.resolutionTrace?.(key)?.at(-1)?.source || 'code-default';
  const paths = {
    'roles.remediator': { codex: 'remediator-codex', 'claude-code': 'remediator-claude', claude: 'remediator-claude' },
    'roles.adversarial.merge_authority.worker_class': {},
    'roles.merge_agent_worker_class': {},
    'roles.build_pack_default_worker_class': {},
  };
  for (const [key, renames] of Object.entries(paths)) {
    const requested = cfg.get(key);
    const value = canonicalWorkerClass(requested);
    const role = Object.hasOwn(renames, value) ? renames[value] : value;
    // Canonical names (including remediator harness spellings) choose roles.
    // Only an exact account-affine alias can conflict with that role's pool.
    if (Object.hasOwn(pools, role) && Object.hasOwn(CLASS_ALIASES, requested)
      && source(key) !== 'code-default') conflicts.push(key);
  }
  const key = 'roles.codex_worker_account_order';
  const orderSetting = cfg.get(key);
  if (['personal-first', 'corporate-first'].includes(orderSetting) && source(key) !== 'code-default') {
    const accounts = cfg.get('oauth.token_accounts', {}) ?? {};
    const orders = Object.entries(pools)
      .filter(([role]) => ['codex', 'codex-reviewer', 'hammer', 'remediator-codex'].includes(role))
      .map(([, members]) => Array.isArray(members)
        ? members.map(member => accounts[member]?.broker_provider) : null);
    if (!orders.length) return result;
    const preferred = orderSetting === 'personal-first' ? ['codex', 'codex-corp'] : ['codex-corp', 'codex'];
    // Legacy Gemini reads may intentionally bypass unrelated OAuth validation.
    // Unresolved providers cannot prove agreement and must remain conflicts.
    const agrees = orders.every(order => order?.length > 0
      && order.every(provider => preferred.includes(provider))
      && order.join(',') === preferred.filter(p => order.includes(p)).join(','));
    if (!agrees) conflicts.push(key);
    else redundant.push(key);
  }
  return result;
}

export function legacyPoolOverrideConflicts(cfg) {
  return inspectLegacyPoolOverrides(cfg).conflicts;
}

export function validateLegacyPoolOverrides(cfg, warn = console.warn) {
  const { conflicts: keys, redundant } = inspectLegacyPoolOverrides(cfg);
  warnPoolConfigRedundancies(redundant, warn);
  if (keys.length) throw new PoolConfigConflictError(keys,
    cfg.resolutionTrace?.(keys[0])?.at(-1)?.source || 'code-default');
}
