// Published ITP-01 vocabulary from agent_os_config/identity-token-pools.v1.json.
// Keep that owner artifact and the shared vectors byte-identical on publication.
// This validates inert declarations only; no routing, credential or lease I/O.
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('./identity-token-pools.v1.json', import.meta.url)));
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
validateContract(contract);
const idPattern = new RegExp(`^(?:${contract.id_pattern})$(?![\\s\\S])`);
const modelPattern = new RegExp(`^(?:${contract.model_pattern})$(?![\\s\\S])`);
export const TOKEN_POOL_DECLARATION_PATHS = new Set(['oauth.token_accounts', 'oauth.identity_token_pools', 'oauth.broker_instances']);
function validateContract(value) {
  const requireField = (condition, field) => {
    if (!condition) throw new Error(`invalid ITP-01 vocabulary: ${field}`);
  };
  requireField(mapping(value) && value.version === 1, 'version must be 1');
  for (const key of ['families', 'account_fields', 'required_fields']) {
    const items = value[key];
    requireField(Array.isArray(items) && items.length > 0 &&
      items.every(item => typeof item === 'string' && item.length > 0) &&
      new Set(items).size === items.length, key);
  }
  requireField(value.families.length === 4 &&
    ['codex', 'claude', 'gemini', 'grok'].every(family => value.families.includes(family)), 'families');
  requireField(['family', 'allowed_models', 'concurrency'].every(key => value.required_fields.includes(key)) &&
    value.required_fields.every(key => value.account_fields.includes(key)) &&
    ['broker_provider', 'holder_user'].every(key => value.account_fields.includes(key)), 'account_fields / required_fields');
  requireField(mapping(value.provider_kinds) && value.provider_kinds.grok === 'oauth'
    && value.provider_kinds['grok-api'] === 'api-key', 'provider_kinds');
  requireField(Array.isArray(value.instance_fields) && ['provider', 'custody_dir', 'op_ref'].every(key => value.instance_fields.includes(key)), 'instance_fields');
  for (const key of ['max_concurrency', 'max_models', 'max_pool_accounts', 'max_broker_instances']) {
    requireField(Number.isSafeInteger(value[key]) && value[key] > 0, key);
  }
  for (const key of ['id_pattern', 'model_pattern']) {
    requireField(typeof value[key] === 'string' && value[key].length > 0, key);
    try { new RegExp(`^(?:${value[key]})$`); }
    catch { requireField(false, key); }
  }
  for (const key of ['broker_families', 'role_families']) {
    requireField(mapping(value[key]) && Object.keys(value[key]).length > 0 &&
      Object.entries(value[key]).every(([name, family]) =>
        /^[a-z][a-z0-9_-]{0,63}$/.test(name) && value.families.includes(family) &&
        (key !== 'broker_families' || family !== 'gemini')), key);
  }
}

function requireValue(condition, path, reason) {
  if (!condition) throw new Error(`${path}: ${reason}`);
}
function identifier(value, path) {
  requireValue(typeof value === 'string' && idPattern.test(value), path, 'expected opaque ID');
}

export function validateTokenPoolDeclarations(oauth) {
  requireValue(mapping(oauth), 'oauth', 'expected mapping');
  const accounts = oauth.token_accounts === undefined ? {} : oauth.token_accounts;
  const pools = oauth.identity_token_pools === undefined ? {} : oauth.identity_token_pools;
  requireValue(mapping(accounts), 'oauth.token_accounts', 'expected mapping');
  requireValue(mapping(pools), 'oauth.identity_token_pools', 'expected mapping');
  const instances = oauth.broker_instances === undefined ? {} : oauth.broker_instances;
  requireValue(mapping(instances), 'oauth.broker_instances', 'expected mapping');
  requireValue(Object.keys(instances).length <= contract.max_broker_instances, 'oauth.broker_instances', 'too many instances');
  const custody = [], secrets = new Set();
  for (const [instanceId, instance] of Object.entries(instances)) {
    let path = 'oauth.broker_instances';
    identifier(instanceId, path);
    path += `.${instanceId}`;
    requireValue(mapping(instance), path, 'expected instance descriptor');
    requireValue(Object.keys(instance).every(key => contract.instance_fields.includes(key)), path, 'unknown instance field');
    requireValue(Object.hasOwn(contract.provider_kinds, instance.provider), path, 'unknown instance provider');
    const field = instance.provider === 'grok' ? 'custody_dir' : 'op_ref';
    requireValue(Object.keys(instance).length === 2 && Object.hasOwn(instance, field), path, 'expected provider-compatible custody binding');
    const binding = instance[field];
    requireValue(typeof binding === 'string' && binding.length <= 4096, path, 'expected custody binding');
    const normalized = binding.toLowerCase();
    if (field === 'custody_dir') {
      requireValue(binding.startsWith('/') && binding !== '/' && !binding.startsWith('//')
        && !binding.slice(1).split('/').some(part => ['', '.', '..'].includes(part))
        && !/[\\\x00-\x1f]/.test(binding), path, 'expected canonical absolute custody directory');
      requireValue(!custody.some(old => normalized === old || normalized.startsWith(`${old}/`)
        || old.startsWith(`${normalized}/`)), path, 'duplicate or overlapping custody binding');
      custody.push(normalized);
    } else {
      requireValue(/^op:\/\/[^/\x00-\x1f]+\/[^/\x00-\x1f]+\/[^/\x00-\x1f]+$(?![\s\S])/.test(binding), path, 'expected secret reference');
      requireValue(!secrets.has(normalized), path, 'duplicate secret binding');
      secrets.add(normalized);
    }
  }
  const bindings = new Set();
  for (const [accountId, account] of Object.entries(accounts)) {
    let path = 'oauth.token_accounts';
    identifier(accountId, path);
    path += `.${accountId}`;
    requireValue(mapping(account), path, 'expected descriptor');
    requireValue(Object.keys(account).every(key => contract.account_fields.includes(key)), path, 'unknown descriptor field');
    requireValue(contract.required_fields.every(key => Object.hasOwn(account, key)), path, 'missing descriptor field');
    requireValue(contract.families.includes(account.family), `${path}.family`, 'unknown family');
    const { family, concurrency, allowed_models: models } = account;
    requireValue(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= contract.max_concurrency, `${path}.concurrency`, 'expected bounded positive integer');
    requireValue(Array.isArray(models) && models.length > 0 && models.length <= contract.max_models, `${path}.allowed_models`, 'expected nonempty bounded model list');
    requireValue(models.every(model => typeof model === 'string' && modelPattern.test(model)), `${path}.allowed_models`, 'expected model IDs');
    requireValue(new Set(models).size === models.length, `${path}.allowed_models`, 'duplicate model');
    const bindingKey = family === 'gemini' ? 'holder_user' : 'broker_provider';
    const otherKey = family === 'gemini' ? 'broker_provider' : 'holder_user';
    requireValue(Object.hasOwn(account, bindingKey) && !Object.hasOwn(account, otherKey), path, 'expected exactly one family-compatible binding');
    const binding = account[bindingKey];
    identifier(binding, `${path}.${bindingKey}`);
    if (family === 'gemini') {
      requireValue(concurrency === 1, `${path}.concurrency`, 'holder concurrency must be one');
    } else {
      requireValue(contract.broker_families[binding] === family, `${path}.broker_provider`, 'provider family mismatch');
    }
    let identity;
    if (family === 'grok') {
      requireValue(account.kind === contract.provider_kinds[binding], path, 'account kind/provider mismatch');
      identifier(account.broker_instance, `${path}.broker_instance`);
      requireValue(Object.hasOwn(instances, account.broker_instance), path, 'unknown broker instance');
      requireValue(instances[account.broker_instance].provider === binding, path, 'instance provider mismatch');
      identity = `broker_instance:${account.broker_instance}`;
    } else {
      requireValue(!Object.hasOwn(account, 'kind') && !Object.hasOwn(account, 'broker_instance'), path, 'instance fields require grok family');
      identity = `${bindingKey}:${binding}`;
    }
    requireValue(!bindings.has(identity), path, 'duplicate provider or holder binding');
    bindings.add(identity);
  }
  for (const [role, members] of Object.entries(pools)) {
    let path = 'oauth.identity_token_pools';
    requireValue(Object.hasOwn(contract.role_families, role), path, 'unknown canonical role');
    path += `.${role}`;
    requireValue(Array.isArray(members) && members.length > 0 && members.length <= contract.max_pool_accounts, path, 'expected nonempty bounded account list');
    const seen = new Set();
    for (const member of members) {
      identifier(member, path);
      requireValue(!seen.has(member), path, 'duplicate account reference');
      seen.add(member);
      requireValue(Object.hasOwn(accounts, member), path, 'unknown account reference');
      requireValue(accounts[member].family === contract.role_families[role], path, 'cross-family membership');
    }
  }
}

export function modelSubsetAllowed(account, identityModels, requestedModels) {
  return requestedModels.length > 0 && requestedModels.every(model =>
    identityModels.includes(model) && account.allowed_models.includes(model));
}
