/**
 * The supervisor's config section, normalized (ARF-08).
 *
 * A pure normalizer over a plain object, in the shape `broker/manifest.mjs`
 * established: `server/src/config.mjs` calls it while resolving the config, so a
 * malformed program list is a boot-time refusal rather than a child that fails
 * to spawn twenty seconds later with a message about `undefined`.
 *
 * It lives under `supervisor/` because SPEC §9 puts the process manager here,
 * and it imports only `paths.mjs` — which imports nothing local — so the
 * config → supervisor → paths direction closes no cycle.
 *
 * ## Why a program list at all
 *
 * Standalone ARF has to come up with no launchd, no session-ledger, and no
 * broker (SPEC §2/§6). Something has to keep the server alive and, when ARF is
 * the whole deployment, the pipeline daemons too. That something is a list of
 * child processes with a restart policy — which is all a process manager is,
 * once you are not trying to be launchd.
 *
 * ## `role` is not decoration
 *
 * A `pipeline` program is refused outside standalone mode. In `in-os` mode
 * launchd already owns the watcher and the auto-merge daemon; a second
 * supervisor starting its own copies would give the pipeline two watchers
 * racing the same review claims and the same merge lease. The role field is what
 * lets that be caught in config rather than in production.
 */

import { readFileSync } from 'node:fs';

import { absolutize } from '../../server/src/paths.mjs';

const PROGRAM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The id the built-in ARF server program takes; a user program may not claim it. */
export const ARF_SERVER_PROGRAM_ID = 'arf-server';

/**
 * What a supervised program is *for*.
 *
 * - `arf-server` — the ARF API + SPA host. Exactly one, supplied by ARF itself.
 * - `frontend`   — a separately-hosted frontend. ARF's SPA is served in-process
 *                  by `arf-server` (no build step, no bundler), so this exists
 *                  for a deployment that fronts it with something else rather
 *                  than describing a process ARF invents.
 * - `pipeline`   — an adversarial-review daemon. Standalone mode only.
 * - `aux`        — anything else an operator wants kept alive beside ARF.
 */
export const PROGRAM_ROLES = Object.freeze(['arf-server', 'frontend', 'pipeline', 'aux']);

const SUPERVISOR_KEYS = new Set([
  'logDir', 'runDir', 'shutdownTimeoutMs', 'restart', 'programs', 'serverEnabled', 'serverArgs',
]);
const RESTART_KEYS = new Set(['initialDelayMs', 'maxDelayMs', 'healthyAfterMs', 'maxConsecutiveFailures']);
const PROGRAM_KEYS = new Set(['id', 'role', 'command', 'args', 'cwd', 'env', 'autoRestart', 'enabled']);

export class SupervisorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupervisorConfigError';
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknown(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new SupervisorConfigError(
        `${where} has unknown key "${key}" (known: ${[...allowed].join(', ')})`,
      );
    }
  }
}

function coerceMs(where, value, fallback, { min = 0 } = {}) {
  if (value === undefined || value === null) return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < min) {
    throw new SupervisorConfigError(`${where} must be a number >= ${min}, got ${JSON.stringify(value)}`);
  }
  return Math.floor(ms);
}

function coerceBool(where, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  throw new SupervisorConfigError(`${where} must be a boolean, got ${JSON.stringify(value)}`);
}

function coerceStringArray(where, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new SupervisorConfigError(`${where} must be an array of strings`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new SupervisorConfigError(`${where}[${index}] must be a string, got ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

/**
 * A program's environment additions.
 *
 * Values must already be strings: a number or a boolean here would be coerced by
 * `spawn` anyway, but `false` becoming `"false"` — which every shell and every
 * config loader reads as *set* — is a specific way to arm something an operator
 * meant to disable.
 */
function coerceEnv(where, value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new SupervisorConfigError(`${where} must be an object of string values`);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new SupervisorConfigError(
        `${where}.${key} must be a string (got ${typeof entry}); write "true"/"false" explicitly`,
      );
    }
    out[key] = entry;
  }
  return out;
}

function normalizeProgram(raw, index, baseDir) {
  if (!isObject(raw)) throw new SupervisorConfigError(`supervisor.programs[${index}] must be an object`);
  refuseUnknown(raw, PROGRAM_KEYS, `supervisor.programs[${index}]`);

  const id = String(raw.id ?? '').trim();
  if (!PROGRAM_ID_PATTERN.test(id)) {
    throw new SupervisorConfigError(
      `supervisor.programs[${index}].id must match ${PROGRAM_ID_PATTERN} (got ${JSON.stringify(raw.id)})`,
    );
  }
  if (id === ARF_SERVER_PROGRAM_ID) {
    throw new SupervisorConfigError(
      `supervisor.programs[${index}].id "${ARF_SERVER_PROGRAM_ID}" is reserved for the built-in ARF `
      + 'server program; set supervisor.serverEnabled=false to replace it',
    );
  }

  const role = String(raw.role ?? 'aux').trim();
  if (!PROGRAM_ROLES.includes(role)) {
    throw new SupervisorConfigError(
      `supervisor.programs[${index}].role must be one of ${PROGRAM_ROLES.join(' | ')}, got ${JSON.stringify(raw.role)}`,
    );
  }
  if (role === ARF_SERVER_PROGRAM_ID) {
    throw new SupervisorConfigError(
      `supervisor.programs[${index}].role "${ARF_SERVER_PROGRAM_ID}" is the built-in program's role`,
    );
  }

  const command = String(raw.command ?? '').trim();
  if (command === '') {
    throw new SupervisorConfigError(`supervisor.programs[${index}].command is required`);
  }

  return {
    id,
    role,
    command,
    args: coerceStringArray(`supervisor.programs[${index}].args`, raw.args),
    cwd: raw.cwd ? absolutize(String(raw.cwd), baseDir) : null,
    env: coerceEnv(`supervisor.programs[${index}].env`, raw.env),
    autoRestart: coerceBool(`supervisor.programs[${index}].autoRestart`, raw.autoRestart, true),
    enabled: coerceBool(`supervisor.programs[${index}].enabled`, raw.enabled, true),
  };
}

/**
 * Normalize the `supervisor` config section.
 *
 * @param {object} options
 * @param {unknown} [options.file] the `supervisor` object from the config file
 * @param {Record<string,string>} [options.env] already-extracted env values
 * @param {string} options.stateRoot
 * @param {string} options.baseDir directory relative paths are anchored to
 * @param {(path: string) => string} [options.readFile] injectable, for tests
 */
export function normalizeSupervisorConfig({
  file, env = {}, stateRoot, baseDir, readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const section = file === undefined || file === null ? {} : file;
  if (!isObject(section)) throw new SupervisorConfigError('supervisor must be an object');
  refuseUnknown(section, SUPERVISOR_KEYS, 'supervisor');

  const restartRaw = section.restart ?? {};
  if (!isObject(restartRaw)) throw new SupervisorConfigError('supervisor.restart must be an object');
  refuseUnknown(restartRaw, RESTART_KEYS, 'supervisor.restart');

  let programsRaw = section.programs;
  const programsFile = env.programsFile ? absolutize(env.programsFile, baseDir) : null;
  if (programsFile) {
    // A nested list cannot come through the environment, so the env layer names
    // a file instead — the same seam `broker.rolesFile` uses.
    let text;
    try {
      text = readFile(programsFile);
    } catch (err) {
      // Named explicitly and missing is an error, not an empty list: an operator
      // who points at a program file and gets a supervisor with one child has no
      // way to tell "the path was wrong" from "the file said nothing".
      throw new SupervisorConfigError(`supervisor programs file ${programsFile} is unreadable: ${err.message}`);
    }
    try {
      programsRaw = JSON.parse(text);
    } catch (err) {
      throw new SupervisorConfigError(`supervisor programs file ${programsFile} is not valid JSON: ${err.message}`);
    }
  }

  if (programsRaw !== undefined && programsRaw !== null && !Array.isArray(programsRaw)) {
    throw new SupervisorConfigError('supervisor.programs must be an array');
  }
  const programs = (programsRaw ?? []).map((raw, index) => normalizeProgram(raw, index, baseDir));

  const seen = new Set();
  for (const program of programs) {
    if (seen.has(program.id)) {
      // Two programs with one id would collide on their log file, their status
      // entry, and the restart bookkeeping — silently supervising one of them.
      throw new SupervisorConfigError(`supervisor.programs has duplicate id "${program.id}"`);
    }
    seen.add(program.id);
  }

  return {
    logDir: env.logDir ? absolutize(env.logDir, baseDir)
      : section.logDir ? absolutize(String(section.logDir), baseDir)
        : absolutize('logs', stateRoot),
    runDir: env.runDir ? absolutize(env.runDir, baseDir)
      : section.runDir ? absolutize(String(section.runDir), baseDir)
        : absolutize('run', stateRoot),
    shutdownTimeoutMs: coerceMs(
      'supervisor.shutdownTimeoutMs',
      env.shutdownTimeoutMs ?? section.shutdownTimeoutMs,
      10_000,
      { min: 1 },
    ),
    serverEnabled: coerceBool('supervisor.serverEnabled', env.serverEnabled ?? section.serverEnabled, true),
    serverArgs: coerceStringArray('supervisor.serverArgs', section.serverArgs),
    restart: {
      initialDelayMs: coerceMs('supervisor.restart.initialDelayMs', restartRaw.initialDelayMs, 500, { min: 0 }),
      maxDelayMs: coerceMs('supervisor.restart.maxDelayMs', restartRaw.maxDelayMs, 30_000, { min: 0 }),
      // How long a child must stay up before its backoff resets. Without it, a
      // child that crashes every hour would eventually be waiting the maximum
      // delay for a failure that has nothing to do with the previous one.
      healthyAfterMs: coerceMs('supervisor.restart.healthyAfterMs', restartRaw.healthyAfterMs, 10_000, { min: 0 }),
      // Consecutive fast failures before the supervisor stops restarting and
      // says so. An unbounded restart loop of a misconfigured binary burns a
      // core and buries the real error under a thousand identical ones.
      maxConsecutiveFailures: coerceMs(
        'supervisor.restart.maxConsecutiveFailures',
        restartRaw.maxConsecutiveFailures,
        10,
        { min: 1 },
      ),
    },
    programs,
  };
}
