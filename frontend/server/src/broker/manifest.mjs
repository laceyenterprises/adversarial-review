/**
 * The role -> identity manifest, and the broker config it lives in (ARF-07).
 *
 * SPEC §5 is explicit that ARF does not invent a new identity *registry*: in-OS
 * it projects the existing declarative sources, standalone it owns an equivalent
 * manifest. This is that manifest. It carries the same fields the in-OS
 * descriptors do — `app_id`, `installation_id`, a `credential_ref`, a PAT
 * fallback ref, a broker scope — under ARF's own names, resolved from ARF's own
 * config so nothing is imported from agent-os.
 *
 * Validation is mode-aware and happens at **load** time, not at mint time. A
 * `github_app` role missing its `installationId` is a broken mapping; finding
 * that out in the middle of step 4 of a standup wizard, after the App has
 * already been created and installed, is strictly worse than refusing to boot.
 *
 * Two rules here are the fail-loud gate in structural form:
 *
 *   1. **No wildcard role keys.** `*`, `default`, and friends are refused as
 *      role names, so a "catch-all mapping" cannot be configured into
 *      existence. There is no key an unmapped role can match.
 *   2. **External roles must carry a scope.** The scope is what tells the far
 *      broker *which* identity to mint. Omitting it is precisely the request
 *      that invites a broker's default credential back — the 2026-07-23
 *      ambient-fallback shape, one process over.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { BrokerConfigError } from './errors.mjs';
import { expandHome } from '../paths.mjs';
import { DEFAULT_RETRY_ATTEMPTS, DEFAULT_RETRY_DELAY_MS } from './retry.mjs';
import { parseSecretRef } from './secrets.mjs';

export const BROKER_MODE_BUNDLED = 'bundled';
export const BROKER_MODE_EXTERNAL = 'external';
export const BROKER_MODES = [BROKER_MODE_BUNDLED, BROKER_MODE_EXTERNAL];

export const PROVIDER_GITHUB_APP = 'github_app';
export const PROVIDER_GITHUB_PAT = 'github_pat';
export const PROVIDER_EXTERNAL = 'external';

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

/**
 * Role names ARF accepts. Anchored, so `*` and `` are structurally impossible.
 * Wildcards are refused by construction rather than by lookup discipline: a
 * lookup rule can be forgotten at one call site, a name that cannot be spelled
 * cannot be.
 */
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether `role` is a name ARF will accept as a mapping key.
 *
 * Exported so the standup wizard (ARF-05) validates an inbound role against the
 * *same* rule the manifest enforces rather than restating the pattern. A second
 * copy would be free to drift, and the direction it would drift is toward
 * accepting something this one refuses — a wildcard, an empty string, a name
 * with a path separator in it — which is exactly the class of key this pattern
 * exists to make unspellable.
 */
export function isValidRoleName(role) {
  return typeof role === 'string' && ROLE_NAME_PATTERN.test(role);
}

const BROKER_KEYS = new Set([
  'mode', 'endpoint', 'endpointTokenRef', 'githubApiUrl', 'roles', 'rolesFile',
  'requestTimeoutMs', 'refreshLeadSeconds', 'patFallbackTtlSeconds',
  'transientRetryAttempts', 'transientRetryDelayMs',
]);

const ROLE_KEYS = new Set([
  'provider', 'appId', 'installationId', 'privateKeyRef', 'patFallbackRef',
  'tokenRef', 'ttlSeconds', 'scope', 'principal', 'endpoint',
]);

function requireObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerConfigError(`${what} must be a JSON object`);
  }
  return value;
}

function requireKnownKeys(value, known, what) {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      // Same reasoning as the top-level config loader: a silently ignored
      // `privateKeyReff` leaves the role looking mapped and failing at mint.
      throw new BrokerConfigError(
        `${what} has unknown key ${JSON.stringify(key)} (known: ${[...known].join(', ')})`,
      );
    }
  }
  return value;
}

function requireString(value, what) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BrokerConfigError(`${what} must be a non-empty string`);
  }
  return value.trim();
}

function optionalPositiveNumber(value, what, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new BrokerConfigError(`${what} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return num;
}

function normalizeEndpoint(value, what) {
  const text = requireString(value, what);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new BrokerConfigError(`${what} must be an absolute URL, got ${JSON.stringify(text)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BrokerConfigError(`${what} must be http(s), got ${JSON.stringify(text)}`);
  }
  return url.href.replace(/\/+$/, '');
}

/**
 * Validate one role entry against the active mode.
 *
 * @param {string} role
 * @param {object} raw
 * @param {string} mode
 * @returns {object} a frozen, normalized entry
 */
export function normalizeRoleEntry(role, raw, mode) {
  if (!isValidRoleName(role)) {
    throw new BrokerConfigError(
      `broker.roles key ${JSON.stringify(role)} is not a valid role name. `
      + 'Wildcard and catch-all role keys are refused: ARF must never have a mapping '
      + 'an unrequested identity can match.',
    );
  }
  const what = `broker.roles[${JSON.stringify(role)}]`;
  requireObject(raw, what);
  requireKnownKeys(raw, ROLE_KEYS, what);

  const provider = raw.provider === undefined
    ? (mode === BROKER_MODE_EXTERNAL ? PROVIDER_EXTERNAL : PROVIDER_GITHUB_APP)
    : requireString(raw.provider, `${what}.provider`);

  const entry = {
    role,
    provider,
    appId: null,
    installationId: null,
    privateKeyRef: null,
    patFallbackRef: null,
    tokenRef: null,
    ttlSeconds: null,
    scope: raw.scope === undefined ? null : requireString(raw.scope, `${what}.scope`),
    principal: raw.principal === undefined ? null : requireString(raw.principal, `${what}.principal`),
    endpoint: raw.endpoint === undefined ? null : normalizeEndpoint(raw.endpoint, `${what}.endpoint`),
  };

  if (mode === BROKER_MODE_EXTERNAL) {
    if (provider === PROVIDER_GITHUB_PAT || provider === PROVIDER_GITHUB_APP
      || provider === PROVIDER_EXTERNAL) {
      // The scope is the identity selector the far broker keys on. Without it
      // the request degenerates into "give me a token", which is the request an
      // ambient default answers.
      if (!entry.scope && !entry.principal) {
        throw new BrokerConfigError(
          `${what} needs a scope (or principal) in external mode — it is what names the `
          + 'identity to the broker. Without it the request cannot be distinguished from '
          + "a request for the broker's default credential.",
        );
      }
    } else {
      throw new BrokerConfigError(
        `${what}.provider ${JSON.stringify(provider)} is not one of `
        + `${[PROVIDER_EXTERNAL, PROVIDER_GITHUB_APP, PROVIDER_GITHUB_PAT].join(', ')}`,
      );
    }
    // App coordinates are optional in external mode (the broker holds them),
    // but if given they are still validated and echoed in describe().
    if (raw.appId !== undefined) entry.appId = requireString(raw.appId, `${what}.appId`);
    if (raw.installationId !== undefined) {
      entry.installationId = requireString(raw.installationId, `${what}.installationId`);
    }
    return Object.freeze(entry);
  }

  if (provider === PROVIDER_GITHUB_APP) {
    entry.appId = requireString(raw.appId, `${what}.appId`);
    entry.installationId = requireString(raw.installationId, `${what}.installationId`);
    entry.privateKeyRef = parseSecretRef(raw.privateKeyRef, {
      field: `${what}.privateKeyRef`, role,
    }).raw;
    if (raw.patFallbackRef !== undefined && raw.patFallbackRef !== null) {
      entry.patFallbackRef = parseSecretRef(raw.patFallbackRef, {
        field: `${what}.patFallbackRef`, role,
      }).raw;
    }
    entry.ttlSeconds = optionalPositiveNumber(raw.ttlSeconds, `${what}.ttlSeconds`, null);
    return Object.freeze(entry);
  }

  if (provider === PROVIDER_GITHUB_PAT) {
    entry.tokenRef = parseSecretRef(raw.tokenRef, { field: `${what}.tokenRef`, role }).raw;
    entry.ttlSeconds = optionalPositiveNumber(raw.ttlSeconds, `${what}.ttlSeconds`, null);
    return Object.freeze(entry);
  }

  throw new BrokerConfigError(
    `${what}.provider ${JSON.stringify(provider)} is not one of `
    + `${[PROVIDER_GITHUB_APP, PROVIDER_GITHUB_PAT].join(', ')} in ${BROKER_MODE_BUNDLED} mode`,
  );
}

/**
 * Resolve `rolesFile` against a *persistent* directory, never the process cwd.
 *
 * ARF's shipping shape is a background service. launchd starts a LaunchAgent
 * with `cwd=/` unless the plist says otherwise, so a `rolesFile: "roles.json"`
 * written next to `~/.arf/config.json` would resolve to `/roles.json` and crash
 * the daemon at boot — while the same config loaded by hand from `~/.arf` would
 * work, which is the worst version of this bug. The caller therefore passes the
 * directory the config actually lives in (see `loadConfig`), and a relative path
 * with no such base is refused rather than silently anchored somewhere.
 */
function resolveRolesFile(value, baseDir) {
  // `~/` first: nothing between an operator's JSON file and here runs a shell,
  // so an unexpanded tilde would become a literal `~` directory under baseDir.
  // Every other ARF path key goes through the same expansion (`paths.mjs`).
  const path = expandHome(value);
  if (isAbsolute(path)) return resolvePath(path);
  if (!baseDir) {
    throw new BrokerConfigError(
      `broker.rolesFile ${JSON.stringify(path)} is relative and there is no config directory `
      + 'to resolve it against. Use an absolute path: ARF runs as a background service, so '
      + 'the process working directory is not a stable base.',
    );
  }
  return resolvePath(baseDir, value);
}

/**
 * Read the roles manifest.
 *
 * An **absent** file is an empty manifest, not an error. `rolesFile` names the
 * file ARF keeps mappings in, and on a fresh install that file does not exist
 * until the first identity is stood up — refusing to boot without it would make
 * ARF-05's whole flow depend on an operator hand-creating `{"roles": {}}` first,
 * which is the sort of undocumented prerequisite ARF exists to remove.
 *
 * Nothing is weakened by this. A manifest with no entries is a broker with no
 * mapped roles, so every `resolveToken` still fails loud — and its error names
 * the roles it knows about (none) rather than pretending one exists. A path typo
 * therefore surfaces at the first use with the offending path in the message,
 * instead of at boot; `describe().rolesFileExists` reports it before then.
 *
 * A file that exists but cannot be read (permissions, a directory) still throws.
 * That one is a real misconfiguration — the operator's mappings are there and ARF
 * cannot see them — and continuing with zero roles would be the wrong answer.
 */
function readRolesFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new BrokerConfigError(`broker.rolesFile ${path} is unreadable: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BrokerConfigError(`broker.rolesFile ${path} is not valid JSON: ${err.message}`);
  }
  requireObject(parsed, `broker.rolesFile ${path}`);
  // Accept either `{roles: {...}}` or a bare role map, so the file can be
  // hand-written or lifted straight out of a config file's broker section.
  const roles = parsed.roles === undefined ? parsed : parsed.roles;
  return requireObject(roles, `broker.rolesFile ${path} roles`);
}

/**
 * Resolve the effective broker config from the file layer + the env layer.
 *
 * @param {object} [options]
 * @param {object|undefined} options.file  the config file's `broker` section
 * @param {object} [options.env]           already-extracted ARF_BROKER_* values
 * @param {string|null} [options.baseDir]  persistent directory a relative
 *   `rolesFile` is resolved against. Never the process cwd — see below.
 * @returns {{
 *   mode: string, endpoint: string|null, endpointTokenRef: string|null,
 *   githubApiUrl: string, requestTimeoutMs: number, refreshLeadSeconds: number,
 *   patFallbackTtlSeconds: number, transientRetryAttempts: number,
 *   transientRetryDelayMs: number, rolesFile: string|null,
 *   roles: Map<string, object>, configured: boolean
 * }}
 */
export function normalizeBrokerConfig({ file, env = {}, baseDir = null } = {}) {
  const fileSection = file === undefined || file === null
    ? {}
    : requireKnownKeys(requireObject(file, 'config broker section'), BROKER_KEYS, 'config broker section');

  const merged = { ...fileSection, ...env };

  const mode = merged.mode === undefined
    ? BROKER_MODE_BUNDLED
    : requireString(merged.mode, 'broker.mode');
  if (!BROKER_MODES.includes(mode)) {
    throw new BrokerConfigError(
      `broker.mode must be one of ${BROKER_MODES.join(' | ')}, got ${JSON.stringify(mode)}`,
    );
  }

  const endpoint = merged.endpoint === undefined || merged.endpoint === null
    ? null
    : normalizeEndpoint(merged.endpoint, 'broker.endpoint');
  if (mode === BROKER_MODE_EXTERNAL && !endpoint) {
    throw new BrokerConfigError('broker.mode=external requires broker.endpoint');
  }

  const endpointTokenRef = merged.endpointTokenRef === undefined || merged.endpointTokenRef === null
    ? null
    : parseSecretRef(merged.endpointTokenRef, { field: 'broker.endpointTokenRef' }).raw;

  const rolesFile = merged.rolesFile === undefined || merged.rolesFile === null
    ? null
    : resolveRolesFile(String(merged.rolesFile), baseDir);

  const fromFile = rolesFile ? readRolesFile(rolesFile) : {};
  const inline = merged.roles === undefined || merged.roles === null
    ? {}
    : requireObject(merged.roles, 'broker.roles');
  // Inline entries win over the file so a config file can pin one role without
  // restating the manifest; documented, and the source is reported per role.
  const rawRoles = { ...fromFile, ...inline };

  const roles = new Map();
  for (const [role, raw] of Object.entries(rawRoles)) {
    const entry = normalizeRoleEntry(role, raw, mode);
    roles.set(role, {
      ...entry,
      source: Object.hasOwn(inline, role) ? 'config' : 'rolesFile',
    });
  }

  return {
    mode,
    endpoint,
    endpointTokenRef,
    githubApiUrl: merged.githubApiUrl === undefined
      ? DEFAULT_GITHUB_API_URL
      : normalizeEndpoint(merged.githubApiUrl, 'broker.githubApiUrl'),
    requestTimeoutMs: optionalPositiveNumber(merged.requestTimeoutMs, 'broker.requestTimeoutMs', 10000),
    // Refresh before the deadline rather than at it. A token handed out with two
    // seconds of life left is a request that fails somewhere downstream instead
    // of here, which is the shape of the 2026-07-12 refresh-deadline miss.
    refreshLeadSeconds: optionalPositiveNumber(merged.refreshLeadSeconds, 'broker.refreshLeadSeconds', 60),
    patFallbackTtlSeconds: optionalPositiveNumber(
      merged.patFallbackTtlSeconds, 'broker.patFallbackTtlSeconds', 60,
    ),
    // Transient failures — a `op` spawn blip, a 503, a reset connection — get a
    // bounded retry before they escalate (or reach the PAT fallback). `1` means
    // one attempt and no retry, which is how an operator turns this off without
    // reaching for a code change.
    transientRetryAttempts: optionalPositiveNumber(
      merged.transientRetryAttempts, 'broker.transientRetryAttempts', DEFAULT_RETRY_ATTEMPTS,
    ),
    transientRetryDelayMs: optionalPositiveNumber(
      merged.transientRetryDelayMs, 'broker.transientRetryDelayMs', DEFAULT_RETRY_DELAY_MS,
    ),
    rolesFile,
    // Whether the manifest is one ARF is reading or one it has yet to create.
    // Surfaced because an absent manifest is now a legitimate state rather than
    // a boot failure, and "no roles are mapped" reads very differently depending
    // on which of the two it is.
    rolesFileExists: rolesFile ? existsSync(rolesFile) : false,
    roles,
    // "Configured" is about having a mapping, not about having a mode: a broker
    // with zero roles is a broker every resolveToken() call fails loud against.
    configured: roles.size > 0,
  };
}

/** Secret refs an entry consumes — refs only, safe to print. */
export function entrySecretRefs(entry) {
  return [entry.privateKeyRef, entry.patFallbackRef, entry.tokenRef].filter(Boolean);
}
