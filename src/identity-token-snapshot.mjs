// ITP-10 wire readers. Policy stays in agent_os_core.identity_token_selection;
// these functions validate its inputs/results, never choose an account or lease.
import { readFileSync } from 'node:fs';
import { modelSubsetAllowed, validateTokenPoolDeclarations } from './config-token-pools.mjs';

const selection = JSON.parse(readFileSync(new URL('./identity-token-selection.v1.json', import.meta.url)));
const declarations = JSON.parse(readFileSync(new URL('./identity-token-pools.v1.json', import.meta.url)));
if (selection.version !== 1 || declarations.version !== selection.version) {
  throw new Error('identity token vocabulary: unsupported version');
}
const pattern = value => new RegExp(`^(?:${value})$(?![\\s\\S])`);
const generationPattern = pattern(selection.generation_pattern);
const modelPattern = pattern(declarations.model_pattern);
const mapping = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const has = (value, key) => Object.hasOwn(value, key);
function requireValue(condition, field, reason) {
  // Never echo unvalidated field names or values (including bearer bytes).
  if (!condition) throw new Error(`${field}: ${reason}`);
}
function object(value, fields, field) {
  requireValue(mapping(value), field, 'expected mapping');
  requireValue(Object.keys(value).every(key => fields.includes(key)), field, 'unknown field');
  return value;
}
function generation(value, field, required = false) {
  requireValue((!required && value == null)
    || (typeof value === 'string' && generationPattern.test(value)), field, 'expected generation ID');
}
function time(value, field, required = false) {
  requireValue((!required && value == null) || (typeof value === 'number'
    && Number.isFinite(value) && value >= 0 && value <= selection.max_timestamp), field,
  'expected finite nonnegative Unix seconds');
}
function models(value, field) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= declarations.max_models,
    field, 'expected bounded model IDs');
  requireValue(value.every(model => typeof model === 'string' && modelPattern.test(model)), field, 'expected model IDs');
  requireValue(new Set(value).size === value.length, field, 'duplicate model ID');
}
function canonicalRole(value, field) {
  requireValue(typeof value === 'string' && has(declarations.role_families, value), field, 'expected canonical role');
}
function frozenCopy(value) {
  const copy = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(copy);
}

export function readIdentityTokenPools(oauth, { legacyGeminiHolders } = {}) {
  requireValue(mapping(oauth), 'oauth', 'expected mapping');
  validateTokenPoolDeclarations(oauth);
  const accounts = oauth.token_accounts ?? {};
  const pools = oauth.identity_token_pools ?? {};
  // Only an explicitly supplied legacy list constrains the new declaration.
  // Absence keeps old singleton/owner state interpretable without inventing IDs.
  if (legacyGeminiHolders !== undefined && has(pools, 'gemini-reviewer')) {
    const holders = pools['gemini-reviewer'].map(id => accounts[id].holder_user);
    requireValue(Array.isArray(legacyGeminiHolders)
      && holders.length === legacyGeminiHolders.length
      && holders.every((holder, index) => holder === legacyGeminiHolders[index]),
    'reviewer.gemini.identities', 'conflicting legacy/new declaration');
  }
  return frozenCopy({ token_accounts: accounts, identity_token_pools: pools });
}

export function readSelectionSnapshot(value, oauth) {
  const pools = readIdentityTokenPools(oauth);
  const record = object(value, selection.snapshot_fields, 'snapshot');
  requireValue(record.version === selection.version, 'snapshot.version', 'unsupported version');
  canonicalRole(record.identity, 'snapshot.identity');
  models(record.requested_models, 'snapshot.requested_models');
  generation(record.generation, 'snapshot.generation');
  const accounts = record.accounts === undefined ? {} : record.accounts;
  requireValue(mapping(accounts), 'snapshot.accounts', 'expected mapping');
  for (const [accountId, account] of Object.entries(accounts)) {
    requireValue(has(pools.token_accounts, accountId), 'snapshot.accounts', 'unknown account');
    if (account === null) continue;
    object(account, Object.keys(selection.components), 'snapshot.accounts.evidence');
    for (const [component, states] of Object.entries(selection.components)) {
      const evidence = account[component];
      if (evidence == null) continue;
      object(evidence, [...selection.evidence_fields, ...(component === 'capacity' ? ['active_leases'] : [])], component);
      requireValue(states.includes(evidence.state === undefined ? 'unknown' : evidence.state), component, 'unknown evidence state');
      generation(evidence.generation, `${component}.generation`);
      time(evidence.observed_at, `${component}.observed_at`);
      time(evidence.expires_at, `${component}.expires_at`);
      if (component === 'capacity') {
        requireValue(evidence.active_leases == null || (Number.isInteger(evidence.active_leases)
          && evidence.active_leases >= 0 && evidence.active_leases <= selection.max_active_leases),
        'capacity.active_leases', 'expected bounded nonnegative integer');
      }
    }
  }
  const exemptions = record.reserve_exemptions === undefined ? [] : record.reserve_exemptions;
  requireValue(Array.isArray(exemptions), 'reserve_exemptions', 'expected list');
  requireValue(exemptions.length <= Object.keys(pools.token_accounts).length * Object.keys(pools.identity_token_pools).length,
    'reserve_exemptions', 'too many exemptions');
  const seen = new Set();
  for (const exemption of exemptions) {
    object(exemption, ['identity', 'account_id'], 'reserve_exemptions');
    const { identity, account_id: accountId } = exemption;
    requireValue(typeof identity === 'string' && typeof accountId === 'string'
      && has(pools.identity_token_pools, identity) && pools.identity_token_pools[identity].includes(accountId),
    'reserve_exemptions', 'expected declared role/account pair');
    requireValue(selection.corporate_providers.includes(pools.token_accounts[accountId].broker_provider),
      'reserve_exemptions', 'expected corporate account');
    const pair = `${identity}:${accountId}`;
    requireValue(!seen.has(pair), 'reserve_exemptions', 'duplicate exemption');
    seen.add(pair);
  }
  return frozenCopy(record);
}

function readRequest(request, oauth) {
  object(request, ['identity', 'family', 'identity_models', 'requested_models', 'generation', 'now', 'snapshot'], 'request');
  canonicalRole(request.identity, 'identity');
  requireValue(request.family === declarations.role_families[request.identity], 'family', 'identity family mismatch');
  models(request.identity_models, 'identity_models');
  models(request.requested_models, 'requested_models');
  requireValue(request.requested_models.every(model => request.identity_models.includes(model)),
    'requested_models', 'identity model denied');
  generation(request.generation, 'generation', true);
  time(request.now, 'now', true);
  readSelectionSnapshot(request.snapshot, oauth);
}

const evidenceReasons = ['evidence-unknown', 'evidence-stale', 'evidence-generation-mismatch', 'evidence-contradictory'];
const candidateReasons = [...evidenceReasons, 'disabled', 'absent', 'model-denied', 'not-ready',
  'quota-exhausted', 'reserve-refused', 'capacity-saturated', 'ready'];
const refusalReasons = ['disabled', 'absent', 'model-denied', 'not-ready',
  'quota-exhausted', 'reserve-refused', 'capacity-saturated'];
const resultReasons = [...evidenceReasons, 'evidence-request-mismatch', 'pool-undeclared',
  'preferred-ready', 'fallback-ready', 'capacity-saturated', 'accounts-unavailable'];

export function readAccountSelection(value, { oauth, request }) {
  const pools = readIdentityTokenPools(oauth);
  readRequest(request, pools);
  const record = object(value, selection.result_fields, 'selection');
  requireValue(selection.result_fields.every(key => has(record, key)), 'selection', 'missing result field');
  requireValue(record.version === selection.version, 'selection.version', 'unsupported version');
  requireValue(record.identity === request.identity, 'selection.identity', 'request mismatch');
  requireValue(record.generation === request.generation, 'selection.generation', 'request mismatch');
  requireValue(selection.result_statuses.includes(record.status), 'selection.status', 'unknown status');
  requireValue(resultReasons.includes(record.reason), 'selection.reason', 'unknown reason');
  const members = pools.identity_token_pools[request.identity] ?? [];
  requireValue(record.account_id === null || members.includes(record.account_id), 'selection.account_id', 'undeclared account');
  requireValue(Array.isArray(record.considered) && record.considered.length <= members.length,
    'selection.considered', 'expected bounded candidates');
  for (const [index, candidate] of record.considered.entries()) {
    object(candidate, ['account_id', 'reason', 'component'], 'selection.considered');
    requireValue(candidate.account_id === members[index], 'selection.considered', 'candidate order mismatch');
    requireValue(candidateReasons.includes(candidate.reason), 'selection.considered', 'unknown reason');
    requireValue(candidate.component === null || has(selection.components, candidate.component),
      'selection.considered', 'unknown component');
    if (index < record.considered.length - 1) {
      requireValue(refusalReasons.includes(candidate.reason), 'selection.considered', 'nonterminal candidate must refuse');
    }
  }
  if (record.status === 'selected') {
    const account = pools.token_accounts[record.account_id];
    requireValue(account && modelSubsetAllowed(account, request.identity_models, request.requested_models),
      'selection.account_id', 'account model denied');
    requireValue(record.considered.at(-1)?.account_id === record.account_id
      && record.considered.at(-1)?.reason === 'ready'
      && record.considered.at(-1)?.component === null
      && record.reason === (record.considered.length === 1 ? 'preferred-ready' : 'fallback-ready'),
    'selection', 'inconsistent selected result');
    requireValue(request.snapshot.identity === request.identity
      && request.snapshot.generation === request.generation
      && request.snapshot.requested_models.length === request.requested_models.length
      && request.requested_models.every(model => request.snapshot.requested_models.includes(model)),
    'selection', 'snapshot request mismatch');
  } else {
    if (record.status === 'unavailable') {
      requireValue(record.account_id === null && ['pool-undeclared', 'accounts-unavailable'].includes(record.reason),
        'selection', 'inconsistent unavailable result');
    } else {
      requireValue([...evidenceReasons, 'evidence-request-mismatch', 'capacity-saturated'].includes(record.reason),
        'selection', 'inconsistent held result');
      if (record.account_id !== null) {
        requireValue(evidenceReasons.includes(record.reason)
          && record.considered.at(-1)?.account_id === record.account_id
          && record.considered.at(-1)?.reason === record.reason, 'selection', 'held account mismatch');
      }
    }
  }
  // This is the owner's outcome, not a new admission/attestation. Lease and
  // freshness revalidation at dispatch remain the consuming ticket's concern.
  return frozenCopy(record);
}

export function readIdentityPoolProjection(value, oauth) {
  const pools = readIdentityTokenPools(oauth);
  requireValue(mapping(value), 'identityPools', 'expected mapping');
  for (const [identity, row] of Object.entries(value)) {
    requireValue(has(pools.identity_token_pools, identity), 'identityPools', 'undeclared role');
    object(row, ['identity', 'requestedModels', 'generation', 'capacity', 'active', 'free', 'held', 'tokens'], 'identityPools.role');
    requireValue(row.identity === identity, 'identityPools.role', 'identity mismatch');
    if (has(row, 'requestedModels')) models(row.requestedModels, 'identityPools.requestedModels');
    if (has(row, 'generation')) generation(row.generation, 'identityPools.generation', true);
    const members = pools.identity_token_pools[identity];
    requireValue(Array.isArray(row.tokens) && row.tokens.length === members.length, 'identityPools.tokens', 'account count mismatch');
    for (const [index, token] of row.tokens.entries()) {
      object(token, ['tokenAccountId', 'brokerProvider', 'holderRef', 'capacity', 'active', 'free', 'held', 'reason', 'component'], 'identityPools.tokens');
      const account = pools.token_accounts[members[index]];
      requireValue(token.tokenAccountId === members[index]
        && token.brokerProvider === (account.broker_provider ?? null)
        && token.holderRef === (account.holder_user ?? null), 'identityPools.tokens', 'account binding/order mismatch');
      for (const key of ['capacity', 'active', 'free', 'held']) {
        requireValue((key === 'active' && token[key] === null)
          || (Number.isInteger(token[key]) && token[key] >= 0 && token[key] <= selection.max_active_leases),
        'identityPools.tokens', 'invalid slot count');
      }
      requireValue([0, account.concurrency].includes(token.capacity)
        && token.held === account.concurrency - token.capacity
        && token.free === (token.capacity && token.active !== null ? Math.max(0, token.capacity - token.active) : 0),
      'identityPools.tokens', 'inconsistent slot counts');
      requireValue(candidateReasons.includes(token.reason) || resultReasons.includes(token.reason), 'identityPools.tokens', 'unknown reason');
      requireValue(token.component === null || has(selection.components, token.component), 'identityPools.tokens', 'unknown component');
    }
    for (const key of ['capacity', 'active', 'free', 'held']) {
      const expected = key === 'active' && row.tokens.some(token => token.active === null)
        ? null : row.tokens.reduce((sum, token) => sum + token[key], 0);
      requireValue(row[key] === expected, 'identityPools.role', 'aggregate slot count mismatch');
    }
  }
  return frozenCopy(value);
}
