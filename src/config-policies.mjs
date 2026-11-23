// ONS-07 — checks on merged config that CFG's JSON Schema cannot express
// (search policy, worker vaults, public hygiene, goal lineage, Grok role pins,
// CI hosting invariants, OSG arms, OAuth declarations). Python runs the same
// checks in agent_os_config.validation / loaders.
import { readFileSync, statSync } from 'node:fs';
import { osgArmFields } from './config-schema.mjs';
import { TOKEN_POOL_DECLARATION_PATHS, validateTokenPoolDeclarations } from './config-token-pools.mjs';
import { grokRolePinViolations } from './config-grok.mjs';
import { AgentOSConfigError, MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS, SEARCH_OPERATIONS } from './config-base.mjs';
import { MISSING, getLeaf, setLeaf } from './config-paths.mjs';

const SEARCH_MONEY_PATTERN = '^[0-9]{1,12}([.][0-9]{1,9})?$';

const SEARCH_REF_PATTERN = String.raw`^op://[^/\s?#%](?:[^/?#%\r\n]*[^/\s?#%])?/[^/\s?#%](?:[^/?#%\r\n]*[^/\s?#%])?/[^/\s?#%](?:[^/?#%\r\n]*[^/\s?#%])?$`;

const SEARCH_COUNT_LIMITS = ['max_results', 'max_pages', 'max_urls', 'max_input_tokens', 'max_output_tokens', 'max_duration_seconds'];

export function validateSearch(search = {}) {
  if (!search || typeof search !== 'object') return;
  const fail = (path, reason) => {
    const key = `services.hcp.search${path}`;
    throw new AgentOSConfigError(`${key}: ${reason}`, { key });
  };
  const money = (value, path) => {
    if (typeof value !== 'string' || !(new RegExp(SEARCH_MONEY_PATTERN).test(value)) || value.endsWith('\n')) {
      fail(path, 'expected nonnegative finite decimal USD string');
    }
    // Only positivity is compared: decimal billing arithmetic belongs to HCP.
    return /[1-9]/.test(value);
  };
  const runPositive = !Object.hasOwn(search, 'run_budget_usd') || money(search.run_budget_usd, '.run_budget_usd');
  if (Object.hasOwn(search, 'run_watch_threshold_usd')) money(search.run_watch_threshold_usd, '.run_watch_threshold_usd');
  if (search.enabled && !runPositive) fail('.run_budget_usd', 'enabled gateway requires a positive budget');
  for (const [provider, entry] of Object.entries(search.providers ?? {})) {
    const path = `.providers.${provider}`;
    if (!Object.hasOwn(SEARCH_OPERATIONS, provider)) fail(path, 'unknown provider');
    if (!entry || typeof entry !== 'object') continue;
    const positive = !Object.hasOwn(entry, 'budget_usd') || money(entry.budget_usd, `${path}.budget_usd`);
    if (Object.hasOwn(entry, 'watch_threshold_usd')) money(entry.watch_threshold_usd, `${path}.watch_threshold_usd`);
    for (const field of ['credential_ref', 'answers_credential_ref']) {
      if (Object.hasOwn(entry, field) && (!(new RegExp(SEARCH_REF_PATTERN).test(entry[field])) || entry[field].endsWith('\n'))) {
        fail(`${path}.${field}`, 'expected unambiguous op reference metadata');
      }
      if (entry[field]?.split('/')[3]?.trim().replace(/\s+/g, ' ').toLowerCase() === 'exa kb pat') {
        fail(`${path}.${field}`, 'Exa KB PAT is outside the search credential inventory');
      }
    }
    const operations = entry.allowed_operations ?? [];
    if (new Set(operations).size !== operations.length || operations.some(op => !SEARCH_OPERATIONS[provider].includes(op))) {
      fail(`${path}.allowed_operations`, 'expected unique supported operation IDs');
    }
    const limits = entry.operation_limits ?? {};
    for (const [operation, limit] of Object.entries(limits)) {
      const opPath = `${path}.operation_limits.${operation}`;
      if (!SEARCH_OPERATIONS[provider].includes(operation) || !operations.includes(operation)) fail(opPath, 'operation must be supported and explicitly allowed');
      if (Object.hasOwn(limit, 'max_charge_usd') && !money(limit.max_charge_usd, `${opPath}.max_charge_usd`)) fail(opPath, 'maximum charge must be positive');
      if (Object.hasOwn(limit, 'max_charge_usd') && (limit.currency !== 'USD' || typeof limit.pricing_provenance !== 'string' || !limit.pricing_provenance.trim() || /[\r\n]/.test(limit.pricing_provenance))) {
        fail(opPath, 'USD currency and pricing provenance are required');
      }
      if (Object.hasOwn(limit, 'processor') && /[\r\n]/.test(limit.processor)) fail(opPath, 'invalid processor');
      if (!SEARCH_COUNT_LIMITS.some(key => Object.hasOwn(limit, key))) fail(opPath, 'at least one request ceiling is required');
    }
    if (entry.enabled) {
      if (!positive || !runPositive) fail(path, 'configured provider and run budgets must be positive when enabled');
      if (!entry.credential_ref || !operations.length || !Object.keys(limits).length) fail(path, 'enabled provider requires credential metadata and a bounded operation');
      if (provider === 'brave' && operations.some(op => ['answer', 'research'].includes(op)) && !entry.answers_credential_ref) {
        fail(path, 'Brave answer/research requires separate Answers credential metadata');
      }
    }
  }
}


// -------- YAML 1.2 strict-bool loader --------------------------------------

// js-yaml's DEFAULT_SCHEMA is already YAML 1.2 — `yes`/`no`/`on`/`off`
// parse as strings out of the box. We re-affirm here by NOT using
// JS_COMPAT_SCHEMA. The schema-validator catches them downstream.

// Mirrors agent_os_config.validation._validate_secrets_config (rejection only;
// this reader consumes no vault policy, so it does not normalize one).
export function validateWorkerClassVaults(secrets, trace = {}) {
  if (!secrets || typeof secrets !== 'object') return;
  const shared = Array.isArray(secrets.shared_vaults) ? secrets.shared_vaults : [];
  const policies = Object.entries(secrets.worker_class_vaults ?? {}).map(([name, policy]) => [`worker_pool.secrets.worker_class_vaults.${name}`, policy]);
  const fallback = secrets.default_vault_policy;
  if (fallback && Object.values(fallback).some(value => ![null, '', undefined].includes(value)
    && !(Array.isArray(value) && !value.length))) policies.push(['worker_pool.secrets.default_vault_policy', fallback]);
  for (const [key, policy] of policies) {
    const { vault = null, service_account_token_ref: ref = null } = policy ?? {};
    const optin = policy?.shared_vault_optin ?? [];
    const fail = (leaf, message) => {
      const full = `${key}.${leaf}`;
      // A missing required leaf has no file entry; attribute it to the policy's
      // explicitly configured sibling rather than its generated default.
      const entry = trace[full]?.filter(item => item.path).at(-1)
        ?? Object.entries(trace).filter(([path]) => path.startsWith(`${key}.`))
          .flatMap(([, entries]) => entries.filter(item => item.path)).at(-1);
      throw new AgentOSConfigError(`${full}: ${message}`, {
        key: full, source: entry?.path ?? entry?.source ?? 'merged-config',
      });
    };
    if (!Array.isArray(optin)) fail('shared_vault_optin', 'expected list');
    if (vault === null && ref === null && !optin.length) continue;
    if (typeof vault !== 'string' || !vault.trim()) fail('vault', 'required non-empty string');
    if (typeof ref !== 'string' || !/^op:\/\/([^/]+)\/(.+)\/([^/]+)$/.test(ref.trim())) {
      fail('service_account_token_ref', 'expected full op://<vault>/<item>/<field> ref');
    }
    optin.forEach((item, index) => {
      if (!shared.includes(item)) fail(`shared_vault_optin[${index}]`, `${JSON.stringify(item)} not present in worker_pool.secrets.shared_vaults`);
    });
  }
}

export function validatePublicHygiene(policy = {}) {
  policy ??= {};
  const refuse = field => { throw new AgentOSConfigError(
    `worker_pool.public_hygiene.${field}: invalid public hygiene policy; repair host configuration`,
    { key: `worker_pool.public_hygiene.${field}` },
  ); };
  const repos = policy.repos ?? [];
  if (!Array.isArray(repos) || repos.some(repo => typeof repo !== 'string'
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    || repo.endsWith('.git') || repo.split('/').some(part => ['.', '..'].includes(part)))) refuse('repos');
  const identities = policy.identities ?? {};
  for (const [workerClass, identity] of Object.entries(identities)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(workerClass) || !identity
      || Object.keys(identity).sort().join(',') !== 'email,name'
      || Object.values(identity).some(value => typeof value !== 'string' || !value.trim() || /[|\r\n\0]/.test(value))) refuse('identities');
  }
  if (repos.length || Object.hasOwn(policy, 'denylist_path')) {
    const path = policy.denylist_path;
    if (typeof path !== 'string' || !path.startsWith('/') || /[\r\n\0]/.test(path)) refuse('denylist_path');
    try {
      if (!statSync(path).isFile()) refuse('denylist_path');
      new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    } catch { refuse('denylist_path'); }
  }
}

export function validateGoalLineageConfig(merged, trace) {
  const maxKey = 'worker_pool.dispatch.goal_lineage.max_bytes';
  const excerptKey = 'worker_pool.dispatch.goal_lineage.spec_excerpt_bytes';
  const maxBytes = getLeaf(merged, maxKey);
  const specExcerptBytes = getLeaf(merged, excerptKey);
  if (maxBytes === MISSING || specExcerptBytes === MISSING) return;
  if (Number(specExcerptBytes) <= Number(maxBytes)) return;
  const entries = trace[excerptKey] || [];
  const source = entries.length ? entries[entries.length - 1].source : 'merged-config';
  throw new AgentOSConfigError(
    `${excerptKey}: expected <= ${maxKey} (${maxBytes}), got ${specExcerptBytes}`,
    {
      key: excerptKey,
      expected: `<= ${maxKey} (${maxBytes})`,
      got: specExcerptBytes,
      source,
    },
  );
}

// GRK-09: a role pin may name a Grok lane only while that lane is enabled.
// Lane enablement mirrors _validate_grok_role_pins in the Python loader.
// GRK-12's pending-v2 closer refusal also requires the Agent OS companion
// loader/fixture update before deployment (docs/changes/GRK-12.md).
export function validateGrokRolePins(merged, trace) {
  for (const key of ['roles.merge_agent_worker_class',
    'roles.adversarial.merge_authority.worker_class',
    'roles.adversarial.merge_authority.worker_class_fallback']) {
    const value = getLeaf(merged, key);
    if ((Array.isArray(value) ? value : [value]).some(pin => String(pin ?? '').trim() === 'hammer-grok')) {
      throw new AgentOSConfigError(`${key}: grok-closer-pending-merge-authority-v2`, {
        key, expected: 'Merge Authority v2 executor', got: value, source: 'merged-config',
      });
    }
  }
  const [violation] = grokRolePinViolations(merged);
  if (!violation) return;
  const { key, value, required } = violation;
  const entries = trace[key] || [];
  const source = entries.length ? entries[entries.length - 1].source : 'merged-config';
  throw new AgentOSConfigError(
    `${key}: ${JSON.stringify(value)} selects a disabled Grok lane; set ${required}: true `
      + 'to make it dispatchable, or choose another value',
    { key, expected: `${required}: true`, got: value, source },
  );
}

export function enforceCiHostingSecurityInvariants(merged, trace) {
  const excluded = getLeaf(merged, 'ci.hosting.excluded_workflows');
  if (!Array.isArray(excluded)) return;
  const normalized = [
    ...MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS,
    ...excluded.filter(
      (workflow) => !MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS.includes(workflow),
    ),
  ];
  if (
    normalized.length === excluded.length &&
    normalized.every((workflow, index) => workflow === excluded[index])
  ) return;
  setLeaf(merged, 'ci.hosting.excluded_workflows', normalized);
  const key = 'ci.hosting.excluded_workflows';
  (trace[key] = trace[key] || []).push({
    source: 'security-invariant',
    value: normalized,
    path: null,
  });
}

export function validateOsgShape(value, source = null, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentOSConfigError('osg: expected mapping', { key: 'osg', source });
  }
  for (const key of ['policy', 'double_blind', 'router']) {
    if (Object.hasOwn(value, key) && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw new AgentOSConfigError(`osg.${key}: expected mapping`, { key: `osg.${key}`, source });
    }
  }
  if (Array.isArray(value.arms)) {
    const fields = Object.entries(osgArmFields(schema)).filter(([, field]) => field.__required);
    for (const arm of value.arms) {
      if (!arm || fields.some(([key]) => !Object.hasOwn(arm, key))) {
        throw new AgentOSConfigError('osg.arms: incomplete arm', { key: 'osg.arms', source });
      }
    }
  }
}

export function validateOAuthDeclarations(oauth, trace = null, source = null) {
  try {
    validateTokenPoolDeclarations(oauth);
  } catch (error) {
    // Never copy trace values: descriptors and bindings must remain redacted.
    const declarationSources = Object.fromEntries([...TOKEN_POOL_DECLARATION_PATHS].map(key => {
      const winner = trace?.[key]?.at(-1);
      return [key, { source: winner?.source ?? source, path: winner?.path ?? source }];
    }));
    const key = error.message.split(':', 1)[0];
    const mapKey = [...TOKEN_POOL_DECLARATION_PATHS].find(path => key === path || key.startsWith(`${path}.`));
    const winner = declarationSources[mapKey];
    const origins = Object.entries(declarationSources)
      .filter(([, origin]) => origin.path || origin.source)
      .map(([path, origin]) => `${path} from ${origin.path || origin.source}`);
    const wrapped = new AgentOSConfigError(
      `${error.message}${origins.length ? ` (${origins.join('; ')})` : ''}`,
      { key, expected: 'valid token pool declaration', source: winner?.path || winner?.source },
    );
    wrapped.declarationSources = declarationSources;
    throw wrapped;
  }
}
