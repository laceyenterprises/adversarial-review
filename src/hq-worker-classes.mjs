// The hq-published worker-class roster, for load-time validation of role →
// workerClass mappings in the role registry (ARC-12). Two hard rules from the
// ticket: (1) never validate against a hardcoded class list; (2) source the
// list from hq with a cached-snapshot fallback so a transient inability to
// reach the published registry degrades to the last-known-good roster rather
// than failing every worker PR.
//
// Where the list actually lives. The canonical published roster is
// `modules/worker-pool/worker-classes.json` in the agent-os checkout — the same
// file `cwp_dispatch/worker_classes_registry.load_registry()` reads, whose
// top-level keys ARE the published worker-class names. There is deliberately no
// `hq worker-class list` shell-out: `hq` is a bash dispatcher whose only
// class-aware commands (`hq harness health <class>`, `hq worker`, dispatch)
// take a class as INPUT and validate it against the same registry; none
// enumerate it, and neither does any HCP HTTP route. Reading the published JSON
// (keyed by `AGENT_OS_REPO_ROOT`) is therefore the sanctioned, non-hardcoded
// source. If a future `hq` subcommand enumerates classes, swap `readLiveRoster`
// for the shell-out — the snapshot cache and validator above it are unchanged.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from './atomic-write.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Module root (adversarial-review/), one level up from src/.
const MODULE_ROOT = join(__dirname, '..');

// Relative path of the published roster inside the agent-os checkout.
const WORKER_CLASSES_REL_PATH = join('modules', 'worker-pool', 'worker-classes.json');

// Where the last-known-good snapshot is cached. Under the module's own data/
// dir so it travels with the app store and survives a checkout that later
// becomes unreachable (detached worktree, submodule not checked out).
const SNAPSHOT_REL_PATH = join('data', 'hq-worker-classes.snapshot.json');
const SNAPSHOT_SCHEMA_VERSION = 1;

export class WorkerClassRosterError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = 'WorkerClassRosterError';
    if (cause) this.cause = cause;
  }
}

function snapshotPath(rootDir) {
  return join(rootDir, SNAPSHOT_REL_PATH);
}

// Resolve the agent-os checkout that owns the published roster. Mirrors the
// Python loader's precedence: explicit AGENT_OS_REPO_ROOT first, then walk up
// from the module directory looking for the roster file. Returns the resolved
// worker-classes.json path, or null when no checkout is reachable (the caller
// then degrades to the snapshot).
function resolveRosterPath({ env = process.env, moduleRoot = MODULE_ROOT } = {}) {
  const fromEnv = String(env?.AGENT_OS_REPO_ROOT ?? '').trim();
  if (fromEnv) {
    const candidate = join(fromEnv, WORKER_CLASSES_REL_PATH);
    if (existsSync(candidate)) return candidate;
  }
  // Upward walk: the daemon runs from tools/adversarial-review, so the checkout
  // root (two-plus levels up) carries modules/worker-pool/worker-classes.json.
  let dir = moduleRoot;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, WORKER_CLASSES_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseRosterKeys(raw, source) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new WorkerClassRosterError(
      `worker-class roster at ${source} is not valid JSON: ${err.message}`,
      { cause: err },
    );
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new WorkerClassRosterError(`worker-class roster at ${source} must be a JSON object`);
  }
  const classes = Object.keys(doc);
  if (classes.length === 0) {
    throw new WorkerClassRosterError(`worker-class roster at ${source} declares no worker classes`);
  }
  return classes;
}

// Read the live published roster from the agent-os checkout. Returns
// { classes, path } or null when no checkout is reachable. Throws only when a
// reachable roster file is malformed (a corrupt published registry is a loud
// failure, not a silent snapshot fallback).
function readLiveRoster({ env, moduleRoot, readFileImpl = readFileSync } = {}) {
  const rosterPath = resolveRosterPath({ env, moduleRoot });
  if (!rosterPath) return null;
  const raw = readFileImpl(rosterPath, 'utf8');
  return { classes: parseRosterKeys(raw, rosterPath), path: rosterPath };
}

function readSnapshot(rootDir, { readFileImpl = readFileSync } = {}) {
  const path = snapshotPath(rootDir);
  if (!existsSync(path)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileImpl(path, 'utf8'));
  } catch {
    return null;
  }
  const classes = Array.isArray(doc?.classes)
    ? doc.classes.filter((entry) => typeof entry === 'string' && entry !== '')
    : [];
  if (classes.length === 0) return null;
  return { classes, capturedAt: doc.capturedAt || null, path };
}

function writeSnapshot(rootDir, classes, { now = () => new Date().toISOString() } = {}) {
  const path = snapshotPath(rootDir);
  const body = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capturedAt: now(),
    classes: [...classes].sort(),
  };
  writeFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

/**
 * Resolve the hq-published worker-class roster. Reads the live published
 * registry when the agent-os checkout is reachable, refreshing the on-disk
 * snapshot; otherwise degrades to the last cached snapshot. Never returns a
 * hardcoded list — when neither the live registry nor a snapshot is available
 * it throws, so a role registry cannot be "validated" against nothing.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   rootDir?: string,
 *   moduleRoot?: string,
 *   readFileImpl?: typeof readFileSync,
 *   writeSnapshotImpl?: typeof writeSnapshot,
 *   now?: () => string,
 *   log?: Pick<Console, 'warn'>,
 * }} [options]
 * @returns {{ classes: readonly string[], source: 'published' | 'snapshot', path: string | null }}
 */
export function resolvePublishedWorkerClasses({
  env = process.env,
  rootDir = MODULE_ROOT,
  moduleRoot = MODULE_ROOT,
  readFileImpl = readFileSync,
  writeSnapshotImpl = writeSnapshot,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  let live = null;
  let liveError = null;
  try {
    live = readLiveRoster({ env, moduleRoot, readFileImpl });
  } catch (err) {
    // A reachable-but-malformed roster: remember it, but still try the snapshot
    // below so one corrupt publish does not zero out validation fleet-wide.
    liveError = err;
  }

  if (live) {
    try {
      writeSnapshotImpl(rootDir, live.classes, { now });
    } catch (err) {
      log?.warn?.(
        `[hq-worker-classes] failed to refresh worker-class snapshot: ${err?.message || err}`,
      );
    }
    return { classes: live.classes, source: 'published', path: live.path };
  }

  const snapshot = readSnapshot(rootDir, { readFileImpl });
  if (snapshot) {
    log?.warn?.(
      `[hq-worker-classes] published worker-class roster unreachable` +
        `${liveError ? ` (${liveError.message})` : ''}; validating against cached snapshot` +
        `${snapshot.capturedAt ? ` captured ${snapshot.capturedAt}` : ''}`,
    );
    return { classes: snapshot.classes, source: 'snapshot', path: snapshot.path };
  }

  if (liveError) throw liveError;
  throw new WorkerClassRosterError(
    'no hq-published worker-class roster is reachable and no cached snapshot exists; ' +
      'set AGENT_OS_REPO_ROOT to the agent-os checkout, or run once from a checkout to seed the snapshot',
  );
}

/**
 * Convenience: the published worker-class names as a Set for membership checks.
 * @param {Parameters<typeof resolvePublishedWorkerClasses>[0]} [options]
 * @returns {Set<string>}
 */
export function publishedWorkerClassSet(options) {
  return new Set(resolvePublishedWorkerClasses(options).classes);
}

export const __testing = {
  resolveRosterPath,
  parseRosterKeys,
  readSnapshot,
  writeSnapshot,
  snapshotPath,
  SNAPSHOT_REL_PATH,
  WORKER_CLASSES_REL_PATH,
};
