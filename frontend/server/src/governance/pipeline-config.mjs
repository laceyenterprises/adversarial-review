/**
 * The `pipeline` config section (ARF-04): where the governance read surface
 * looks for its inputs.
 *
 * Everything here is a *pointer*, never a value. ARF does not hold a copy of
 * the pipeline's governance state; it reads the pipeline's own files each time
 * it is asked, so an operator's edit shows up on the next request instead of at
 * the next ARF restart.
 *
 * Validated at load like the broker section, and for the same reason: a
 * `heartbeatStaleMs` typo that silently kept the default would make a stalled
 * watcher render as `up`, which is the one thing a liveness readout must not do.
 */

import { delimiter, join } from 'node:path';

import { absolutize } from '../paths.mjs';

/** Relative to a pipeline checkout root. */
const MODULE_CONFIG = 'config.yaml';
const MODULE_LOCAL_CONFIG = 'config.local.yaml';
const WATCHER_HEARTBEAT = join('data', 'watcher-heartbeat.json');

/** The watcher's own stall watchdog trips at 10 minutes. */
export const DEFAULT_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

const FILE_KEYS = new Set(['configFiles', 'envFile', 'heartbeatStaleMs', 'heartbeats']);
const HEARTBEAT_IDS = ['watcher', 'followUp', 'autoMerge'];
const HEARTBEAT_ENTRY_KEYS = new Set(['path', 'field']);

export class ArfPipelineConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArfPipelineConfigError';
  }
}

/**
 * The pipeline's own config layers, LOWEST precedence first.
 *
 * The order mirrors the adversarial-review loader's checked-in module layers:
 * `config.yaml`, then its local sibling. Getting this order wrong would resolve
 * a key to a layer the pipeline overrides, which is a wrong answer rather than
 * an unknown one — the one class of error this surface cannot tolerate.
 */
function defaultConfigFiles(pipelineRoot) {
  return [
    { path: join(pipelineRoot, MODULE_CONFIG), label: 'module' },
    { path: join(pipelineRoot, MODULE_LOCAL_CONFIG), label: 'module local' },
  ];
}

function coerceMs(key, value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new ArfPipelineConfigError(`pipeline.${key} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return Math.floor(ms);
}

function normalizeHeartbeat(id, raw, cwd) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'string') return { path: absolutize(raw, cwd), field: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArfPipelineConfigError(
      `pipeline.heartbeats.${id} must be a path string or an object with {path, field}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!HEARTBEAT_ENTRY_KEYS.has(key)) {
      throw new ArfPipelineConfigError(
        `pipeline.heartbeats.${id} has unknown key "${key}" (known: path, field)`,
      );
    }
  }
  if (!raw.path || typeof raw.path !== 'string') {
    throw new ArfPipelineConfigError(`pipeline.heartbeats.${id}.path is required`);
  }
  return {
    path: absolutize(raw.path, cwd),
    // `field: 'mtime'` probes the file's modification time instead of a field
    // inside it, which is what a daemon that only touches a file needs.
    field: raw.field === undefined || raw.field === null ? null : String(raw.field),
  };
}

/**
 * Normalize the `pipeline` section.
 *
 * @param {object} options
 * @param {object} [options.file] the `pipeline` object from the config file
 * @param {Record<string, string>} [options.env] already-mapped env values
 * @param {string} options.pipelineRoot
 * @param {string} options.cwd
 */
export function normalizePipelineConfig({ file, env = {}, pipelineRoot, cwd } = {}) {
  const section = file ?? {};
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    throw new ArfPipelineConfigError('config file key "pipeline" must be a JSON object');
  }
  for (const key of Object.keys(section)) {
    if (!FILE_KEYS.has(key)) {
      throw new ArfPipelineConfigError(
        `pipeline has unknown key "${key}" (known: ${[...FILE_KEYS].join(', ')})`,
      );
    }
  }

  let configFiles;
  let configFilesSource;
  const envFiles = env.configFiles
    ? String(env.configFiles).split(delimiter).map((part) => part.trim()).filter(Boolean)
    : null;
  const fileFiles = section.configFiles ?? null;
  if (fileFiles !== null && !Array.isArray(fileFiles)) {
    throw new ArfPipelineConfigError('pipeline.configFiles must be an array of paths, lowest precedence first');
  }
  const chosen = envFiles ?? fileFiles;
  if (chosen) {
    configFiles = chosen.map((entry, index) => {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new ArfPipelineConfigError(`pipeline.configFiles[${index}] must be a non-empty path`);
      }
      return { path: absolutize(entry.trim(), cwd), label: `layer ${index + 1}` };
    });
    configFilesSource = 'configured';
  } else {
    configFiles = defaultConfigFiles(pipelineRoot);
    configFilesSource = 'pipeline-default';
  }

  const heartbeatsRaw = section.heartbeats ?? {};
  if (heartbeatsRaw === null || typeof heartbeatsRaw !== 'object' || Array.isArray(heartbeatsRaw)) {
    throw new ArfPipelineConfigError('pipeline.heartbeats must be an object keyed by daemon id');
  }
  for (const key of Object.keys(heartbeatsRaw)) {
    if (!HEARTBEAT_IDS.includes(key)) {
      throw new ArfPipelineConfigError(
        `pipeline.heartbeats has unknown daemon "${key}" (known: ${HEARTBEAT_IDS.join(', ')})`,
      );
    }
  }

  const envHeartbeats = {
    watcher: env.watcherHeartbeat,
    followUp: env.followUpHeartbeat,
    autoMerge: env.autoMergeHeartbeat,
  };
  const heartbeats = {};
  for (const id of HEARTBEAT_IDS) {
    const raw = envHeartbeats[id] ?? heartbeatsRaw[id];
    if (raw !== undefined && raw !== null && raw !== '') {
      heartbeats[id] = normalizeHeartbeat(id, raw, cwd);
      continue;
    }
    // Only the watcher writes a daemon-level heartbeat today. The follow-up
    // daemon heartbeats per job and the Python auto-merge daemon writes none, so
    // they default to *no source* and their liveness reports `unknown` rather
    // than a fabricated `down`. For the auto-merge daemon that distinction is
    // load-bearing: its liveness IS its arm state.
    heartbeats[id] = id === 'watcher'
      ? { path: join(pipelineRoot, WATCHER_HEARTBEAT), field: null }
      : null;
  }

  const envFileRaw = env.envFile ?? section.envFile ?? null;

  return {
    configFiles,
    configFilesSource,
    // A JSON snapshot of the daemon's environment. Absent by default, because
    // ARF must not present its own `process.env` as the daemon's — config layer
    // 5 outranks every file and a plist pin is invisible from here.
    envFile: envFileRaw ? absolutize(String(envFileRaw), cwd) : null,
    heartbeatStaleMs: env.heartbeatStaleMs !== undefined
      ? coerceMs('heartbeatStaleMs', env.heartbeatStaleMs)
      : section.heartbeatStaleMs === undefined
        ? DEFAULT_HEARTBEAT_STALE_MS
        : coerceMs('heartbeatStaleMs', section.heartbeatStaleMs),
    heartbeats,
  };
}
