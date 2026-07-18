import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadDomainConfig } from './domain-config.mjs';

// ARC-03: the watcher no longer assumes a single hardcoded `code-pr` domain.
// The domain registry enumerates `domains/*.json`, validates each config, and
// reports which domains are registered (present + valid) and which are enabled
// (the watcher actively pumps them). Validation is fail-loud: a malformed or
// under-specified domain config aborts registry load rather than silently
// dropping a domain, because a dropped domain means subjects that never get
// reviewed. code-pr is the only `enabled` domain in production config after
// this ticket.

const REQUIRED_STRING_FIELDS = [
  'subjectChannel',
  'commsChannel',
  'reviewerRuntime',
  'promptSet',
];

function domainConfigFileNames(rootDir, { readdirImpl = readdirSync } = {}) {
  let entries;
  try {
    entries = readdirImpl(join(rootDir, 'domains'));
  } catch (err) {
    throw new Error(
      `[domain-registry] unable to enumerate domains directory at ${join(rootDir, 'domains')}: ${err?.message || err}`
    );
  }
  return entries
    .filter((name) => typeof name === 'string' && name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => id.length > 0)
    .sort();
}

function validateDomainConfig(id, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`[domain-registry] domain "${id}" config is not a JSON object`);
  }
  if (config.id !== id) {
    throw new Error(
      `[domain-registry] domain "${id}" config declares id=${JSON.stringify(config.id)}; ` +
      `the "id" field must match the domains/<id>.json filename`
    );
  }
  if (typeof config.enabled !== 'boolean') {
    throw new Error(
      `[domain-registry] domain "${id}" is missing the explicit boolean "enabled" flag ` +
      `(got ${JSON.stringify(config.enabled)}); every registered domain must declare enabled true|false`
    );
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = config[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `[domain-registry] domain "${id}" is missing required string field "${field}" ` +
        `(got ${JSON.stringify(value)})`
      );
    }
  }
  if (config.riskClasses !== undefined
    && (config.riskClasses === null || typeof config.riskClasses !== 'object' || Array.isArray(config.riskClasses))) {
    throw new Error(
      `[domain-registry] domain "${id}" has a non-object "riskClasses" field`
    );
  }
  // ARC-13: the optional `pipeline` block is deep-validated (stages, panel
  // roles) lazily by `resolveDomainPipeline` only when it is enabled; here we
  // fail loud on a structurally wrong shape (non-object, or a non-boolean
  // `enabled` gate) so a typo cannot silently disable the gate check.
  if (config.pipeline !== undefined) {
    if (config.pipeline === null || typeof config.pipeline !== 'object' || Array.isArray(config.pipeline)) {
      throw new Error(`[domain-registry] domain "${id}" has a non-object "pipeline" field`);
    }
    if (config.pipeline.enabled !== undefined && typeof config.pipeline.enabled !== 'boolean') {
      throw new Error(
        `[domain-registry] domain "${id}" pipeline.enabled must be a boolean ` +
        `(got ${JSON.stringify(config.pipeline.enabled)})`
      );
    }
  }
}

// Enumerate + validate every domains/<id>.json. Returns:
//   { domains: [{ id, enabled, config }], enabledDomains: [subset where enabled] }
// both sorted by id. Throws on the first validation failure (fail loud) so a
// bad config can never silently strand a subject type.
function loadDomainRegistry(rootDir, {
  readdirImpl = readdirSync,
  loadConfigImpl = loadDomainConfig,
} = {}) {
  const ids = domainConfigFileNames(rootDir, { readdirImpl });
  if (ids.length === 0) {
    throw new Error(
      `[domain-registry] no domains/*.json configs found under ${rootDir}; ` +
      `at least one registered domain is required`
    );
  }
  const domains = ids.map((id) => {
    let config;
    try {
      config = loadConfigImpl(rootDir, id);
    } catch (err) {
      throw new Error(
        `[domain-registry] failed to read domains/${id}.json: ${err?.message || err}`
      );
    }
    validateDomainConfig(id, config);
    return { id, enabled: config.enabled === true, config };
  });
  const enabledDomains = domains.filter((domain) => domain.enabled);
  return { domains, enabledDomains };
}

function resolveEnabledDomainIds(registry) {
  return (registry?.enabledDomains || []).map((domain) => domain.id);
}

export {
  loadDomainRegistry,
  resolveEnabledDomainIds,
  validateDomainConfig,
};
