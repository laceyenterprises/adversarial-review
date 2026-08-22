/**
 * ARF config source (SPEC §2 "own config source", §9 boundaries).
 *
 * Resolution order, lowest precedence first:
 *   1. built-in defaults (below)
 *   2. a JSON config file (`ARF_CONFIG_FILE`, else `<stateRoot>/config.json`)
 *   3. environment variables
 *
 * The one decision this module exists to make is **standalone vs in-OS**, and
 * the store path that follows from it:
 *
 *   mode=standalone (default) — ARF owns its own SQLite file and may create it.
 *   mode=in-os                — ARF reads a live pipeline's `reviews.db`, and
 *                               the handle is read-only, always. `reviews.db`
 *                               is single-writer (better-sqlite3, watcher-owned);
 *                               a second writer is a corruption hazard, so
 *                               `readOnly` is derived from the mode here and is
 *                               NOT an independently settable knob.
 *
 * The second decision, added by ARF-02, is **where the GitHub token comes from**.
 * It is always a *configured* source — an env var this config names, or a file
 * this config points at. There is deliberately no ambient fallback: no `gh`
 * config, no keychain, no bare `GITHUB_TOKEN` unless an operator names it. The
 * 2026-07-23 RCA in SPEC §6 is exactly this failure — a missing mapping silently
 * resolving to an ambient identity and masking the misconfiguration.
 *
 * It also carries the `broker` section (ARF-07): the token/identity-broker mode
 * and its role -> token manifest. That section is normalized and validated by
 * `broker/manifest.mjs` at load time, so a malformed or incomplete role mapping
 * is a boot-time refusal rather than a failure four steps into a standup wizard.
 * It holds secret *references* only — never secret values.
 *
 * ARF-08 adds two more, on the same pattern:
 *
 *   `governance` — where the arm/disarm gate document and its audit trail live.
 *                  Both default under the state root, so a standalone ARF owns
 *                  its own governance state with nothing configured.
 *   `supervisor` — the process manager's program list and restart policy,
 *                  normalized by `supervisor/src/program-config.mjs`.
 *
 * And the `standup` section (ARF-06): where the harness manifest and the reviewer
 * allowlist live, and what the harness runtime probe is permitted to execute.
 * Same load-time validation, same reason.
 *
 * This module imports nothing outside `node:` builtins and ARF's own tree. ARF
 * talks only to its own store, GitHub, and a configured broker endpoint — no
 * agent-os runtime libraries.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeSupervisorConfig } from '../../supervisor/src/program-config.mjs';
import { normalizeBrokerConfig } from './broker/manifest.mjs';
import { normalizePipelineConfig } from './governance/pipeline-config.mjs';
import { normalizeStandupConfig } from './standup/config.mjs';
import { absolutize } from './paths.mjs';

export const MODE_STANDALONE = 'standalone';
export const MODE_IN_OS = 'in-os';
const MODES = new Set([MODE_STANDALONE, MODE_IN_OS]);

/** Path, relative to a pipeline checkout root, of the live review-state store. */
export const PIPELINE_REVIEWS_DB_RELPATH = join('data', 'reviews.db');

/** Filename ARF gives its own store when it owns one (standalone mode). */
export const STANDALONE_STORE_FILENAME = 'review-store.db';

/**
 * Where the arm/disarm gate document and its audit trail live under the state
 * root (ARF-08).
 *
 * Their own subdirectory, not the state root itself: the pipeline daemons read
 * the gate and may run as a different OS user than ARF, so this is the one
 * directory that has to be traversable by them. Keeping it apart from the store
 * files and the broker's role manifest means granting that access does not also
 * grant access to a manifest of secret references.
 */
export const GOVERNANCE_DIRNAME = 'governance';
export const GATE_FILENAME = 'gate.json';
export const GATE_AUDIT_FILENAME = 'gate-audit.jsonl';

/**
 * Filename of the GitHub mirror cache.
 *
 * A separate file from the review store in **both** modes, never the pipeline's
 * `reviews.db`. In `in-os` mode that separation is load-bearing: `reviews.db` is
 * pipeline-owned and ARF's handle on it is read-only forever, so the mirror —
 * which ARF writes — cannot live there. Keeping it separate in standalone mode
 * too means one code path rather than a mode-dependent one.
 */
export const MIRROR_STORE_FILENAME = 'github-mirror.db';

/** Env var the GitHub token is read from unless `githubTokenEnv` names another. */
export const DEFAULT_GITHUB_TOKEN_ENV = 'ARF_GITHUB_TOKEN';

/** Public GitHub. An operator on GHES points `githubApiBase` at their host. */
export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// src -> server -> frontend -> <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export class ArfConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArfConfigError';
  }
}

function defaultStateRoot() {
  return join(homedir(), '.arf');
}

const FILE_KEYS = new Map([
  ['mode', 'mode'],
  ['stateRoot', 'stateRoot'],
  ['storePath', 'storePath'],
  ['pipelineRoot', 'pipelineRoot'],
  ['host', 'host'],
  ['port', 'port'],
  ['busyTimeoutMs', 'busyTimeoutMs'],
  ['githubApiBase', 'githubApiBase'],
  ['githubTokenEnv', 'githubTokenEnv'],
  ['githubTokenFile', 'githubTokenFile'],
  ['githubMirrorPath', 'githubMirrorPath'],
  ['githubMirrorTtlMs', 'githubMirrorTtlMs'],
  ['githubMinRefreshIntervalMs', 'githubMinRefreshIntervalMs'],
  ['githubRequestTimeoutMs', 'githubRequestTimeoutMs'],
  ['githubMaxConcurrentRefreshes', 'githubMaxConcurrentRefreshes'],
  ['githubRefreshBudget', 'githubRefreshBudget'],
  ['githubMaxPages', 'githubMaxPages'],
  // The token/identity-broker section (ARF-07). Nested, and validated by
  // `broker/manifest.mjs` — including its own unknown-key refusal, so a typo in
  // `broker.roles.<role>.privateKeyRef` fails at load rather than mid-standup.
  ['broker', 'broker'],
  // The pipeline-governance read section (ARF-04): where the merge-authority
  // config layers, the daemon heartbeats, and the daemon environment snapshot
  // live. Normalized below.
  ['pipeline', 'pipeline'],
  // ARF-08.
  ['gatePath', 'gatePath'],
  ['gateAuditPath', 'gateAuditPath'],
  // The process manager's section. Nested, and validated by
  // `supervisor/src/program-config.mjs` with the same unknown-key refusal.
  ['supervisor', 'supervisor'],
  // The harness-standup section (ARF-06); validated by `standup/config.mjs`.
  ['standup', 'standup'],
]);

// `ARF_GITHUB_TOKEN` is deliberately absent: this map holds keys that configure
// ARF, and the token itself is a *value* read through the source these keys
// name. Putting it here would put a secret into the resolved config object,
// which `/github/status` and every log line would then be one typo away from
// echoing.
const ENV_KEYS = new Map([
  ['ARF_MODE', 'mode'],
  ['ARF_STATE_ROOT', 'stateRoot'],
  ['ARF_STORE_PATH', 'storePath'],
  ['ARF_PIPELINE_ROOT', 'pipelineRoot'],
  ['ARF_HOST', 'host'],
  ['ARF_PORT', 'port'],
  ['ARF_STORE_BUSY_TIMEOUT_MS', 'busyTimeoutMs'],
  ['ARF_GITHUB_API_BASE', 'githubApiBase'],
  ['ARF_GITHUB_TOKEN_ENV', 'githubTokenEnv'],
  ['ARF_GITHUB_TOKEN_FILE', 'githubTokenFile'],
  ['ARF_GITHUB_MIRROR_PATH', 'githubMirrorPath'],
  ['ARF_GITHUB_MIRROR_TTL_MS', 'githubMirrorTtlMs'],
  ['ARF_GITHUB_MIN_REFRESH_MS', 'githubMinRefreshIntervalMs'],
  ['ARF_GITHUB_REQUEST_TIMEOUT_MS', 'githubRequestTimeoutMs'],
  ['ARF_GITHUB_MAX_CONCURRENT_REFRESHES', 'githubMaxConcurrentRefreshes'],
  ['ARF_GITHUB_REFRESH_BUDGET', 'githubRefreshBudget'],
  ['ARF_GITHUB_MAX_PAGES', 'githubMaxPages'],
  // ARF-08. `ARF_GATE_FILE` is the name the *pipeline* side reads too — the
  // supervisor exports it into every child it spawns — so one variable points
  // ARF's writer and a daemon's reader at the same document.
  ['ARF_GATE_FILE', 'gatePath'],
  ['ARF_GATE_AUDIT_FILE', 'gateAuditPath'],
]);

/**
 * Supervisor scalars that can come from the environment. The program *list*
 * cannot — it is nested — so it lives in the config file or in the JSON file
 * `ARF_SUPERVISOR_PROGRAMS_FILE` names, the same seam `broker.rolesFile` uses.
 */
const SUPERVISOR_ENV_KEYS = new Map([
  ['ARF_SUPERVISOR_LOG_DIR', 'logDir'],
  ['ARF_SUPERVISOR_RUN_DIR', 'runDir'],
  ['ARF_SUPERVISOR_SHUTDOWN_TIMEOUT_MS', 'shutdownTimeoutMs'],
  ['ARF_SUPERVISOR_SERVER_ENABLED', 'serverEnabled'],
  ['ARF_SUPERVISOR_PROGRAMS_FILE', 'programsFile'],
]);

/**
 * Pipeline-governance scalars that can come from the environment (ARF-04).
 *
 * The heartbeat *map* has no env form for the same reason the broker role map
 * does not: it is nested. The three paths do, because a launchd deploy pins
 * them per host.
 */
const PIPELINE_ENV_KEYS = new Map([
  ['ARF_PIPELINE_CONFIG_FILES', 'configFiles'],
  ['ARF_PIPELINE_ENV_FILE', 'envFile'],
  ['ARF_PIPELINE_HEARTBEAT_STALE_MS', 'heartbeatStaleMs'],
  ['ARF_PIPELINE_WATCHER_HEARTBEAT', 'watcherHeartbeat'],
  ['ARF_PIPELINE_FOLLOW_UP_HEARTBEAT', 'followUpHeartbeat'],
  ['ARF_PIPELINE_AUTO_MERGE_HEARTBEAT', 'autoMergeHeartbeat'],
]);

/**
 * Broker scalars that can come from the environment. The role *map* cannot —
 * it is a nested structure, so it lives in the config file or in the JSON file
 * `ARF_BROKER_ROLES_FILE` points at.
 */
const BROKER_ENV_KEYS = new Map([
  ['ARF_BROKER_MODE', 'mode'],
  ['ARF_BROKER_ENDPOINT', 'endpoint'],
  ['ARF_BROKER_ENDPOINT_TOKEN_REF', 'endpointTokenRef'],
  ['ARF_BROKER_GITHUB_API_URL', 'githubApiUrl'],
  ['ARF_BROKER_ROLES_FILE', 'rolesFile'],
  ['ARF_BROKER_REQUEST_TIMEOUT_MS', 'requestTimeoutMs'],
  ['ARF_BROKER_REFRESH_LEAD_SECONDS', 'refreshLeadSeconds'],
  ['ARF_BROKER_PAT_FALLBACK_TTL_SECONDS', 'patFallbackTtlSeconds'],
  ['ARF_BROKER_TRANSIENT_RETRY_ATTEMPTS', 'transientRetryAttempts'],
  ['ARF_BROKER_TRANSIENT_RETRY_DELAY_MS', 'transientRetryDelayMs'],
]);

/**
 * Standup scalars that can come from the environment. `runtimeCommandAllowlist`
 * and `runtimeSearchPath` are lists, so they stay in the config file: an
 * allowlist assembled from a delimiter-split env string is one quoting mistake
 * away from allowing something nobody chose.
 */
const STANDUP_ENV_KEYS = new Map([
  ['ARF_STANDUP_HARNESS_MANIFEST_PATH', 'harnessManifestPath'],
  ['ARF_STANDUP_REVIEWER_ALLOWLIST_PATH', 'reviewerAllowlistPath'],
  ['ARF_STANDUP_RUNTIME_PROBE_TIMEOUT_MS', 'runtimeProbeTimeoutMs'],
  ['ARF_STANDUP_ALLOW_RUNTIME_INSTALL', 'allowRuntimeInstall'],
]);

function readConfigFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // An explicitly-pointed-at config file that cannot be read is a config
    // error; an absent default-location file just means "no file layer".
    if (err && err.code === 'ENOENT') return null;
    throw new ArfConfigError(`config file ${path} is unreadable: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ArfConfigError(`config file ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArfConfigError(`config file ${path} must contain a JSON object`);
  }
  const layer = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!FILE_KEYS.has(key)) {
      // Fail loud on unknown keys: a silently-ignored `storePath` typo would
      // point ARF at the wrong store and it would look merely empty.
      throw new ArfConfigError(
        `config file ${path} has unknown key "${key}" (known: ${[...FILE_KEYS.keys()].join(', ')})`,
      );
    }
    if (value === null || value === undefined) continue;
    layer[FILE_KEYS.get(key)] = value;
  }
  return layer;
}

function envLayer(env, keys = ENV_KEYS) {
  const layer = {};
  for (const [envKey, key] of keys) {
    const value = env[envKey];
    if (value === undefined || String(value).trim() === '') continue;
    layer[key] = String(value).trim();
  }
  return layer;
}

function coercePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ArfConfigError(`port must be an integer in 0..65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

function coerceBusyTimeout(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new ArfConfigError(`busyTimeoutMs must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  return Math.floor(ms);
}

/** A positive-integer millisecond/count knob, with a named key for the error. */
function coerceCount(key, value, { min = 0 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min) {
    throw new ArfConfigError(`${key} must be a number >= ${min}, got ${JSON.stringify(value)}`);
  }
  return Math.floor(num);
}

/**
 * The GitHub API base, normalized without a trailing slash.
 *
 * Validated as an http(s) URL rather than accepted as a string, because every
 * request path is appended to it: a value that is not a URL would produce a
 * request to something unintended, and an operator would read the resulting
 * failure as "GitHub is down" rather than "my base URL is wrong".
 */
function coerceApiBase(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new ArfConfigError(`githubApiBase must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ArfConfigError(`githubApiBase must be http(s), got ${JSON.stringify(value)}`);
  }
  return url.href.replace(/\/+$/, '');
}

function coerceTokenEnv(value) {
  const name = String(value).trim();
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new ArfConfigError(
      `githubTokenEnv must be an environment variable name, got ${JSON.stringify(value)}`,
    );
  }
  return name;
}

/**
 * Resolve the effective ARF config.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] environment to read (defaults to process.env)
 * @param {string} [options.cwd] base for relativising paths (defaults to process.cwd())
 * @returns {{
 *   mode: string, readOnly: boolean, stateRoot: string, storePath: string,
 *   pipelineRoot: string, host: string, port: number, busyTimeoutMs: number,
 *   storePathSource: string, configFile: string|null, github: object,
 *   broker: ReturnType<import('./broker/manifest.mjs').normalizeBrokerConfig>,
 *   standup: ReturnType<import('./standup/config.mjs').normalizeStandupConfig>
 * }}
 */
export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const envValues = envLayer(env);

  const stateRootRaw = envValues.stateRoot ?? null;
  const explicitConfigFile = env.ARF_CONFIG_FILE && String(env.ARF_CONFIG_FILE).trim()
    ? absolutize(String(env.ARF_CONFIG_FILE).trim(), cwd)
    : null;
  // The default config-file location lives under the state root, so it has to be
  // resolved before the file layer can be read; env/default only (no chicken-egg).
  const preFileStateRoot = stateRootRaw ? absolutize(stateRootRaw, cwd) : defaultStateRoot();
  const configFile = explicitConfigFile ?? join(preFileStateRoot, 'config.json');
  const fileLayer = readConfigFile(configFile);
  if (explicitConfigFile && fileLayer === null) {
    // An operator who names a config file and gets silence has no way to tell
    // "my overrides applied" from "the path was wrong".
    throw new ArfConfigError(`config file ${explicitConfigFile} does not exist`);
  }
  const fileValues = fileLayer ?? {};

  const merged = { ...fileValues, ...envValues };

  const mode = String(merged.mode ?? MODE_STANDALONE).trim();
  if (!MODES.has(mode)) {
    throw new ArfConfigError(`mode must be one of ${[...MODES].join(' | ')}, got ${JSON.stringify(mode)}`);
  }

  const stateRoot = merged.stateRoot ? absolutize(merged.stateRoot, cwd) : defaultStateRoot();
  const pipelineRoot = merged.pipelineRoot ? absolutize(merged.pipelineRoot, cwd) : REPO_ROOT;

  let storePath;
  let storePathSource;
  if (merged.storePath) {
    storePath = absolutize(merged.storePath, cwd);
    storePathSource = 'configured';
  } else if (mode === MODE_IN_OS) {
    storePath = join(pipelineRoot, PIPELINE_REVIEWS_DB_RELPATH);
    storePathSource = 'pipeline-default';
  } else {
    storePath = join(stateRoot, STANDALONE_STORE_FILENAME);
    storePathSource = 'standalone-default';
  }

  const mirrorPath = merged.githubMirrorPath
    ? absolutize(merged.githubMirrorPath, cwd)
    : join(stateRoot, MIRROR_STORE_FILENAME);
  if (mirrorPath === storePath) {
    // ARF writes the mirror and only ever reads the review store. Letting the
    // two resolve to one file would mean a write against the path that, in
    // `in-os` mode, IS the pipeline's single-writer reviews.db.
    throw new ArfConfigError(
      `githubMirrorPath must not be the review store (${storePath}): ARF writes the `
      + 'mirror cache and never writes review state',
    );
  }

  const gatePath = merged.gatePath
    ? absolutize(merged.gatePath, cwd)
    : join(stateRoot, GOVERNANCE_DIRNAME, GATE_FILENAME);
  const gateAuditPath = merged.gateAuditPath
    ? absolutize(merged.gateAuditPath, cwd)
    : join(stateRoot, GOVERNANCE_DIRNAME, GATE_AUDIT_FILENAME);
  if (gateAuditPath === gatePath) {
    // The audit is append-only and the gate is replaced by rename. Pointed at
    // one file, the first audit line would append to the live gate document and
    // every merge path would fail closed on a malformed gate.
    throw new ArfConfigError(
      `gateAuditPath must not be the gate document (${gatePath}): the audit is appended to and the `
      + 'gate is replaced atomically',
    );
  }

  return {
    mode,
    // Derived, never independently configurable — see the module header.
    readOnly: mode === MODE_IN_OS,
    stateRoot,
    storePath,
    storePathSource,
    pipelineRoot,
    host: String(merged.host ?? '127.0.0.1'),
    port: merged.port === undefined ? 8787 : coercePort(merged.port),
    busyTimeoutMs: merged.busyTimeoutMs === undefined ? 2000 : coerceBusyTimeout(merged.busyTimeoutMs),
    // Always present, even with no `broker` section: an unconfigured broker is a
    // broker with zero mapped roles, which fails loud on every resolveToken()
    // rather than being absent and inviting a caller to improvise a credential.
    broker: normalizeBrokerConfig({
      file: merged.broker,
      env: envLayer(env, BROKER_ENV_KEYS),
      // A relative `rolesFile` is anchored to the directory the config lives in
      // (or the state root when there is no config file) — never to `cwd`. ARF
      // ships as a LaunchAgent, whose working directory is `/`, so anchoring to
      // cwd would turn `~/.arf/roles.json` into `/roles.json` at boot and fail
      // only under the daemon. Both bases are directories ARF itself owns.
      baseDir: fileLayer === null ? stateRoot : dirname(configFile),
    }),
    // Pointers to the pipeline's governance inputs (ARF-04). Always present:
    // an unconfigured section still resolves the pipeline-default layer paths,
    // and a deploy where none of them exists reports every key as *unknown*
    // rather than falling back to schema defaults it cannot vouch for.
    pipeline: normalizePipelineConfig({
      file: merged.pipeline,
      env: envLayer(env, PIPELINE_ENV_KEYS),
      pipelineRoot,
      cwd,
    }),
    // The load-independent arm/disarm gate (ARF-08). Always present, and always
    // pointing somewhere under ARF's own state root by default, so `arf gate
    // init` works on a fresh standalone install with no config at all.
    governance: { gatePath, gateAuditPath },
    supervisor: normalizeSupervisorConfig({
      file: merged.supervisor,
      env: envLayer(env, SUPERVISOR_ENV_KEYS),
      stateRoot,
      // Same anchoring rule as the broker's `rolesFile`, for the same reason:
      // the supervisor is the thing that runs with no shell and no meaningful
      // working directory, so a relative path must resolve against a directory
      // ARF owns rather than against cwd.
      baseDir: fileLayer === null ? stateRoot : dirname(configFile),
    }),
    // Harness standup (ARF-06). Its two state files live under the state root by
    // default — they are ARF's own manifests, not pipeline state — and its
    // runtime-command allowlist is here rather than in a request body.
    standup: normalizeStandupConfig({
      file: merged.standup,
      env: envLayer(env, STANDUP_ENV_KEYS),
      stateRoot,
    }),
    // The file that was actually read, or null when no file layer existed.
    configFile: fileLayer === null ? null : configFile,
    github: {
      apiBase: merged.githubApiBase === undefined
        ? DEFAULT_GITHUB_API_BASE
        : coerceApiBase(merged.githubApiBase),
      // The *name* of the env var holding the token, never the token.
      tokenEnv: merged.githubTokenEnv === undefined
        ? DEFAULT_GITHUB_TOKEN_ENV
        : coerceTokenEnv(merged.githubTokenEnv),
      // A file whose whole contents are the token — the shape a secret manager
      // materializes into. Takes precedence over the env source when set.
      tokenFile: merged.githubTokenFile ? absolutize(merged.githubTokenFile, cwd) : null,
      mirrorPath,
      // How long a mirror row is served without refetching. The bound that keeps
      // a dashboard refresh loop off the GitHub API.
      mirrorTtlMs: merged.githubMirrorTtlMs === undefined
        ? 60_000
        : coerceCount('githubMirrorTtlMs', merged.githubMirrorTtlMs),
      // A floor under refetching that even `force` respects, so a caller cannot
      // turn a manual-refresh button into an API hammer.
      minRefreshIntervalMs: merged.githubMinRefreshIntervalMs === undefined
        ? 10_000
        : coerceCount('githubMinRefreshIntervalMs', merged.githubMinRefreshIntervalMs),
      requestTimeoutMs: merged.githubRequestTimeoutMs === undefined
        ? 10_000
        : coerceCount('githubRequestTimeoutMs', merged.githubRequestTimeoutMs, { min: 1 }),
      maxConcurrentRefreshes: merged.githubMaxConcurrentRefreshes === undefined
        ? 3
        : coerceCount('githubMaxConcurrentRefreshes', merged.githubMaxConcurrentRefreshes, { min: 1 }),
      // Cap on how many PRs one batch call may refresh. Refs past the budget are
      // served from cache and reported as deferred, never silently dropped.
      refreshBudget: merged.githubRefreshBudget === undefined
        ? 25
        : coerceCount('githubRefreshBudget', merged.githubRefreshBudget, { min: 1 }),
      // Pages one paginated collection (reviews, check runs, commit statuses) may
      // walk. 10 pages x per_page=100 is 1000 rows — far past any real PR, and a
      // bound on what one refresh can cost. Exceeding it raises rather than
      // returning a short list: a truncated check set produces a rollup stuck in
      // `pending`, which is the failure this bound exists to prevent, not cause.
      maxPages: merged.githubMaxPages === undefined
        ? 10
        : coerceCount('githubMaxPages', merged.githubMaxPages, { min: 1 }),
    },
  };
}
