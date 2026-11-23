// ONS-07 — config reader basics: the error type, shared constants and the
// runtime unknown-key / deprecated-env diagnostics. No other config module may
// be imported here.
import { resolveHomePath } from './account-home.mjs';

export const SCHEMA_VERSION = 1;

// Default top-level path resolves relative to the current user's home dir so
// the loader works on any host. Operators can override with topPath= or the
// AGENT_OS_CONFIG_PATH env var.
export const DEFAULT_TOP_LEVEL_PATH = resolveHomePath(process.env, 'agent-os', 'config.yaml');

// -------- AgentOSConfigError ------------------------------------------------

export class AgentOSConfigError extends Error {
  constructor(message, { key, expected, got, source, envName, allowed, conflictingEnvNames } = {}) {
    super(message);
    this.name = 'AgentOSConfigError';
    this.key = key ?? null;
    this.expected = expected ?? null;
    this.got = got ?? null;
    this.source = source ?? null;
    this.envName = normalizeEnvName(
      envName ?? (typeof source === 'string' && source.startsWith('env:') ? source.slice('env:'.length) : null),
    );
    this.allowed = allowed ?? null;
    this.conflictingEnvNames = Array.isArray(conflictingEnvNames)
      ? conflictingEnvNames.map(normalizeEnvName).filter(Boolean)
      : [];
  }
}

function normalizeEnvName(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

const DEPRECATED_ENV_VARS = {
  AMA_ENABLED: {
    key: 'roles.adversarial.merge_authority.enabled',
    replacement: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED',
  },
};

export function checkDeprecatedEnvVars(env) {
  for (const [envName, info] of Object.entries(DEPRECATED_ENV_VARS)) {
    if (!(envName in env)) continue;
    if (isFalseyDeprecatedEnvValue(env[envName])) continue;
    throw new AgentOSConfigError(
      `${info.key}: deprecated env var ${envName} is no longer supported; use ${info.replacement} instead`,
      {
        key: info.key,
        expected: `${info.replacement} or config.local.yaml`,
        got: env[envName],
        source: `env:${envName}`,
        envName,
      },
    );
  }
}

function isFalseyDeprecatedEnvValue(value) {
  const lower = String(value ?? '').trim().toLowerCase();
  return lower === '' || lower === 'false' || lower === '0';
}

// Silent by default. We deliberately do NOT console.warn unknown-key drops:
// agent-os#1738 showed a config-loader warning leaking onto stderr can corrupt
// positional config captures downstream. Opt in with ADVERSARIAL_CONFIG_DEBUG.
export function configDebugLog(message) {
  if (process.env.ADVERSARIAL_CONFIG_DEBUG) {
    process.stderr.write(`[adversarial-config] ${message}\n`);
  }
}

const _RUNTIME_UNKNOWN_WARNED_KEYS = new Set();

export function runtimeWarningSource(source) {
  if (!source) return '(unknown source)';
  const match = String(source).match(/^(.*):[0-9]+$/);
  if (match) return match[1];
  return String(source);
}

export function warnRuntimeUnknownKeyOnce(keyPath, source, hint = '') {
  const warningSource = runtimeWarningSource(source);
  const warnedKey = `${warningSource}\0${keyPath}`;
  if (_RUNTIME_UNKNOWN_WARNED_KEYS.has(warnedKey)) return;
  _RUNTIME_UNKNOWN_WARNED_KEYS.add(warnedKey);
  const suffix = hint ? ` — ${hint.trim()}` : '';
  configDebugLog(
    `ignoring unknown key ${JSON.stringify(keyPath)} ` +
      `in runtime config ${warningSource}${suffix} (not in this reader's schema)`,
  );
}

export function resetRuntimeUnknownWarningCacheForTests() {
  _RUNTIME_UNKNOWN_WARNED_KEYS.clear();
}

// -------- Schema declaration -----------------------------------------------

// -------- Schema (generated) ---------------------------------------------

// ONS-07: schemaV1() is the CFG JSON Schema generated from the Python
// schema_v1 plus the inventoried Node-only keys; see config-schema.mjs.
// Never declare a key here.
export const TYPE_STRING = 'string';

export const TYPE_BOOL = 'bool';

export const TYPE_INT = 'int';

export const TYPE_FLOAT = 'float';

export const TYPE_LIST = 'list';

export const TYPE_DICT = 'dict';

export const MANDATORY_CI_HOSTING_EXCLUDED_WORKFLOWS = ['release-freeze-gate.yml'];

// SPE-01: search cross-field semantics; metadata only, no secret resolution.
export const SEARCH_OPERATIONS = Object.freeze({
  brave: ['web_search', 'news_search', 'answer', 'research', 'brave.image_search', 'brave.video_search', 'brave.local_search', 'brave.place_search', 'brave.llm_context'],
  exa: ['web_search', 'fetch', 'extract', 'answer', 'research'],
  firecrawl: ['web_search', 'news_search', 'fetch', 'extract', 'firecrawl.map', 'firecrawl.crawl', 'firecrawl.agent'],
  parallel: ['web_search', 'extract', 'answer', 'research'],
  perplexity: ['web_search', 'answer', 'research', 'perplexity.reason'],
  tavily: ['web_search', 'news_search', 'fetch', 'extract', 'research', 'tavily.map', 'tavily.crawl'],
});

export const SEARCH_LIMIT_PATHS = new Set(Object.keys(SEARCH_OPERATIONS).map(p => `services.hcp.search.providers.${p}.operation_limits`));

// Keyed maps whose keys are repository slugs (`owner/name`) and may contain
// dots. A layer replaces the complete map, like the search provider limits
// (see SEARCH_LIMIT_PATHS), so a key is never split into a provenance path and dropped.
export const ATOMIC_KEYED_MAP_PATHS = new Set(['remediation.git_identity_repo_overrides']);
