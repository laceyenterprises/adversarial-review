// Read the public worker registry; the app owns its last-known-good cache.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readHostObservationSync } from './dispatch-files-client.mjs';
import { assertCanonicalOwner } from './adapters/agent-runtime/append-only-owner.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Module root (adversarial-review/), one level up from src/.
const MODULE_ROOT = join(__dirname, '..');

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

function readLiveRoster({ env, readHostObservationImpl = readHostObservationSync } = {}) {
  const reply = readHostObservationImpl('worker_registry', {env});
  if (!reply.ok) return null;
  return {classes: parseRosterKeys(JSON.stringify(reply.data?.classes), 'public worker registry'), path: null};
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

function writeSnapshot(rootDir, classes, {
  now = () => new Date().toISOString(),
  ownerGuardOptions = {},
} = {}) {
  const path = snapshotPath(rootDir);
  assertCanonicalOwner(rootDir, path, {
    cannotVerifyMessage: 'cannot verify worker-class snapshot caller ownership',
    crossUserMessage: 'refusing cross-user worker-class snapshot write',
    existingFileMessage: 'refusing write to non-canonical-owned worker-class snapshot',
    ...ownerGuardOptions,
  });
  // Ensure the snapshot's parent dir exists only after proving the canonical
  // owner, so a cross-user caller cannot create a wrong-owned data/ directory.
  mkdirSync(dirname(path), { recursive: true });
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
 * registry when its public owner is reachable, refreshing the on-disk
 * snapshot; otherwise degrades to the last cached snapshot. Never returns a
 * hardcoded list — when neither the live registry nor a snapshot is available
 * it throws, so a role registry cannot be "validated" against nothing.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   rootDir?: string,
 *   readFileImpl?: typeof readFileSync,
 *   writeSnapshotImpl?: typeof writeSnapshot,
 *   readOnly?: boolean,
 *   now?: () => string,
 *   ownerGuardOptions?: object,
 *   log?: Pick<Console, 'warn'>,
 * }} [options]
 * @returns {{ classes: readonly string[], source: 'published' | 'snapshot', path: string | null }}
 */
export function resolvePublishedWorkerClasses({
  env = process.env,
  rootDir = MODULE_ROOT,
  readFileImpl = readFileSync,
  readHostObservationImpl = readHostObservationSync,
  writeSnapshotImpl = writeSnapshot,
  readOnly = false,
  now = () => new Date().toISOString(),
  ownerGuardOptions = {},
  log = console,
} = {}) {
  let live = null;
  let liveError = null;
  try {
    live = readLiveRoster({ env, readHostObservationImpl });
  } catch (err) {
    // A reachable-but-malformed roster: remember it, but still try the snapshot
    // below so one corrupt publish does not zero out validation fleet-wide.
    liveError = err;
  }

  if (live) {
    if (!readOnly) {
      try {
        writeSnapshotImpl(rootDir, live.classes, { now, ownerGuardOptions });
      } catch (err) {
        log?.warn?.(
          `[hq-worker-classes] failed to refresh worker-class snapshot: ${err?.message || err}`,
        );
      }
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
      'authorize the public worker registry or seed the app snapshot from an authorized observation',
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
  parseRosterKeys,
  readSnapshot,
  writeSnapshot,
  snapshotPath,
  SNAPSHOT_REL_PATH,
};
