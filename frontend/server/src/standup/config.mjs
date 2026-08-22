/**
 * The `standup` config section (ARF-06).
 *
 * Three things live here, and only one of them is a path:
 *
 *   - where ARF keeps the harness manifest and the reviewer allowlist it owns;
 *   - how long a runtime probe may take;
 *   - **what the runtime probe is allowed to execute**.
 *
 * That last one is the reason this module validates rather than merely reads.
 * The harness standup wizard is driven from an HTTP request, and one of its
 * steps runs the harness runtime to check it is reachable. If the command came
 * from the request body, `POST /api/standup/harness/runs` would be a remote
 * command-execution endpoint wearing a wizard costume. So the command an
 * operator may probe is server-side configuration: a request selects from
 * `runtimeCommandAllowlist`, it cannot introduce a command. Probe argv is fixed
 * by the server-side manifest normalizer; a request cannot turn an allowed
 * interpreter into `node -e` or `python3 -c` executable behavior.
 *
 * Installing a runtime is gated harder still: `allowRuntimeInstall` defaults to
 * `false`, so a run can verify a runtime but cannot install one until an
 * operator has said so in config, out of band from any request.
 */

import { isAbsolute, resolve as resolvePath } from 'node:path';

import { expandHome } from '../paths.mjs';

export class StandupConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StandupConfigError';
  }
}

/** Filenames ARF gives the two files this subsystem owns. */
export const HARNESS_MANIFEST_FILENAME = 'harnesses.json';
export const REVIEWER_ALLOWLIST_FILENAME = 'reviewer-allowlist.json';

/**
 * Runtime commands a probe may execute out of the box.
 *
 * These are the harness CLIs the catalog ships templates for. An operator adding
 * a harness for a runtime that is not here adds the command to
 * `standup.runtimeCommandAllowlist` — a config edit, deliberately, because it is
 * a decision about what this daemon may execute.
 */
export const DEFAULT_RUNTIME_COMMAND_ALLOWLIST = Object.freeze([
  'claude', 'codex', 'gemini', 'agy', 'node', 'python3',
]);

const STANDUP_KEYS = new Set([
  'harnessManifestPath', 'reviewerAllowlistPath', 'runtimeProbeTimeoutMs',
  'runtimeCommandAllowlist', 'runtimeSearchPath', 'allowRuntimeInstall',
]);

function requireObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StandupConfigError(`${what} must be a JSON object`);
  }
  return value;
}

function requireStringArray(value, what) {
  if (!Array.isArray(value)) throw new StandupConfigError(`${what} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new StandupConfigError(`${what}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function coerceBoolean(value, what) {
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  throw new StandupConfigError(`${what} must be a boolean, got ${JSON.stringify(value)}`);
}

function coercePositiveInt(value, what, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    throw new StandupConfigError(`${what} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return Math.floor(num);
}

/**
 * Anchor a state path to a *persistent* directory, never the process cwd.
 *
 * Same rule, and the same reason, as `broker.rolesFile`: ARF ships as a
 * background service and launchd gives a LaunchAgent `cwd=/`, so a relative
 * `harnesses.json` anchored to cwd would mean `/harnesses.json` under the daemon
 * and `~/.arf/harnesses.json` in a shell — a divergence that only shows up in
 * production.
 */
function resolveStatePath(value, stateRoot, what) {
  const path = expandHome(String(value));
  if (path.trim() === '') throw new StandupConfigError(`${what} must be a non-empty string`);
  return isAbsolute(path) ? resolvePath(path) : resolvePath(stateRoot, path);
}

/**
 * Resolve the effective standup config.
 *
 * @param {object} options
 * @param {object|undefined} options.file  the config file's `standup` section
 * @param {object} [options.env]           already-extracted ARF_STANDUP_* values
 * @param {string} options.stateRoot       base for relative state paths
 */
export function normalizeStandupConfig({ file, env = {}, stateRoot } = {}) {
  const fileSection = file === undefined || file === null
    ? {}
    : requireObject(file, 'config standup section');
  for (const key of Object.keys(fileSection)) {
    if (!STANDUP_KEYS.has(key)) {
      throw new StandupConfigError(
        `config standup section has unknown key ${JSON.stringify(key)} `
        + `(known: ${[...STANDUP_KEYS].join(', ')})`,
      );
    }
  }
  const merged = { ...fileSection, ...env };

  const extraCommands = merged.runtimeCommandAllowlist === undefined
    ? []
    : requireStringArray(merged.runtimeCommandAllowlist, 'standup.runtimeCommandAllowlist');

  return Object.freeze({
    harnessManifestPath: resolveStatePath(
      merged.harnessManifestPath ?? HARNESS_MANIFEST_FILENAME,
      stateRoot,
      'standup.harnessManifestPath',
    ),
    // The allowlist is its own file rather than a key inside the harness
    // manifest. In-OS it may be pointed at a file the pipeline reads, and a
    // reviewer allowlist that lives inside ARF's private manifest could not be.
    reviewerAllowlistPath: resolveStatePath(
      merged.reviewerAllowlistPath ?? REVIEWER_ALLOWLIST_FILENAME,
      stateRoot,
      'standup.reviewerAllowlistPath',
    ),
    runtimeProbeTimeoutMs: coercePositiveInt(
      merged.runtimeProbeTimeoutMs, 'standup.runtimeProbeTimeoutMs', 15000,
    ),
    // Operator additions extend the built-ins rather than replacing them, so
    // adding one runtime cannot silently un-allow the rest.
    runtimeCommandAllowlist: Object.freeze(
      [...new Set([...DEFAULT_RUNTIME_COMMAND_ALLOWLIST, ...extraCommands])],
    ),
    // Extra directories to look for a runtime binary in, ahead of `PATH`. A
    // LaunchAgent inherits a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so
    // a probe for a Homebrew-installed CLI fails under the daemon while passing
    // in a shell. Naming the directory here is the fix that survives a restart.
    runtimeSearchPath: Object.freeze(
      merged.runtimeSearchPath === undefined
        ? []
        : requireStringArray(merged.runtimeSearchPath, 'standup.runtimeSearchPath')
          .map((dir) => resolveStatePath(dir, stateRoot, 'standup.runtimeSearchPath')),
    ),
    allowRuntimeInstall: merged.allowRuntimeInstall === undefined
      ? false
      : coerceBoolean(merged.allowRuntimeInstall, 'standup.allowRuntimeInstall'),
  });
}
