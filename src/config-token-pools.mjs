// Published ITP-01 vocabulary from agent_os_config/identity-token-pools.v1.json.
// Keep that owner artifact and the shared vectors byte-identical on publication.
// This validates inert declarations only; no routing, credential or lease I/O.
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('./identity-token-pools.v1.json', import.meta.url)));
const idPattern = new RegExp(`^(?:${contract.id_pattern})$`);
const modelPattern = new RegExp(`^(?:${contract.model_pattern})$`);
export const TOKEN_POOL_DECLARATION_PATHS = new Set(['oauth.token_accounts', 'oauth.identity_token_pools']);
const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(condition, path, reason) {
  if (!condition) throw new Error(`${path}: ${reason}`);
}
function identifier(value, path) {
  requireValue(typeof value === 'string' && idPattern.test(value), path, 'expected opaque ID');
}

export function validateTokenPoolDeclarations(oauth) {
  const accounts = oauth.token_accounts === undefined ? {} : oauth.token_accounts;
  const pools = oauth.identity_token_pools === undefined ? {} : oauth.identity_token_pools;
  requireValue(mapping(accounts), 'oauth.token_accounts', 'expected mapping');
  requireValue(mapping(pools), 'oauth.identity_token_pools', 'expected mapping');
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
    const identity = `${bindingKey}:${binding}`;
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
