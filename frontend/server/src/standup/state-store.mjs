/**
 * The JSON state files the standup surface owns: the harness manifest and the
 * reviewer allowlist (ARF-06).
 *
 * Two small files, and four properties that are worth the code:
 *
 * **Read-modify-write is serialized.** Adding an allowlist entry is a read, a
 * mutate, and a write. Two of those interleaved lose one of the entries, and the
 * one that is lost is an allowlist entry — the failure mode that is invisible by
 * construction. Serialization is in two layers because there are two ways to
 * race: an in-process promise chain per path (two requests to one daemon) and an
 * `O_EXCL` lock file (a CLI run against the same state root as a running
 * daemon). The lock wait is bounded. A stale/dead lock fails loudly instead of
 * being removed by pathname, because unlinking a stale path can delete a fresh
 * replacement lock acquired by another writer.
 *
 * **Writes are atomic.** Temp file in the same directory, fsync, rename. A
 * rename within a directory is atomic, so a reader — or a crash — sees either
 * the old document or the new one, never a half-written manifest that then fails
 * to parse and takes the allowlist with it.
 *
 * **A malformed file is an error, never an empty document.** Silently treating
 * an unparseable allowlist as empty would have the next write replace it,
 * discarding entries nobody knew were at risk. Absent is empty; corrupt is loud.
 *
 * **A file owned by another uid is refused before it is opened.** ARF may be run
 * by a different account than the one that provisioned the state — the same
 * cross-uid hazard the store adapter guards on the read side. Writing anyway
 * either fails with a bare `EACCES` three layers up, or (running as root)
 * succeeds and leaves a file the daemon can no longer read. Refusing names the
 * uid to run as.
 */

import { constants as fsConstants } from 'node:fs';
import {
  chmod, mkdir, open, readFile, rename, rm, stat, unlink,
} from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

export class StandupStateError extends Error {
  constructor(message, { code = 'standup_state', path = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StandupStateError';
    this.code = code;
    this.path = path;
  }
}

/** How long a lock may be held before it is treated as abandoned. */
const LOCK_STALE_MS = 30_000;
/** How long a caller waits for a live lock before giving up. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;

/** In-process serialization, keyed by absolute path. */
const chains = new Map();

function serialize(path, fn) {
  const previous = chains.get(path) ?? Promise.resolve();
  // Both handlers, not `.finally`: the next writer must run whether or not the
  // previous one failed, and it must not inherit its rejection.
  const next = previous.then(() => fn(), () => fn());
  // Keep the chain alive but unrejected, so a failed write does not poison
  // every subsequent one with an unhandled rejection.
  const settled = next.then(() => undefined, () => undefined);
  chains.set(path, settled);
  settled.then(() => {
    if (chains.get(path) === settled) chains.delete(path);
  });
  return next;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function ensureDir(path) {
  // 0o700: these files name secret *references*, bot identities, and entitlements.
  // None of it is secret material, but none of it is anyone else's business either.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

/**
 * Refuse a state path owned by a different uid, and say which one.
 *
 * When the path does not exist yet, check the nearest existing parent directory:
 * provisioning the file is this module's job, but provisioning it under another
 * account's directory would create exactly the cross-uid state the write guard
 * exists to prevent.
 */
async function assertOwnedByUs(path) {
  // `process.getuid` is absent on Windows; ARF's shipping shape is macOS/Linux,
  // and a platform with no uid concept has nothing to compare.
  if (typeof process.getuid !== 'function') return;

  const assertInfoOwnedByUs = (checkedPath, info) => {
    const uid = process.getuid();
    if (info.uid !== uid) {
      throw new StandupStateError(
        `${checkedPath} is owned by uid ${info.uid} but ARF is running as uid ${uid}. `
        + 'Refusing to write standup state across accounts: run ARF as uid '
        + `${info.uid}, or point standup at a state root this account owns.`,
        { code: 'standup_state_foreign_owner', path: checkedPath },
      );
    }
  };

  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      let parent = dirname(path);
      for (;;) {
        try {
          const parentInfo = await stat(parent);
          assertInfoOwnedByUs(parent, parentInfo);
          return;
        } catch (parentErr) {
          if (parentErr instanceof StandupStateError) throw parentErr;
          if (parentErr.code !== 'ENOENT') {
            throw new StandupStateError(
              `cannot stat ${parent}: ${parentErr.message}`,
              { path: parent, cause: parentErr },
            );
          }
          const next = dirname(parent);
          if (next === parent) {
            throw new StandupStateError(
              `cannot find an existing parent directory for ${path}`,
              { path, cause: parentErr },
            );
          }
          parent = next;
        }
      }
    }
    throw new StandupStateError(`cannot stat ${path}: ${err.message}`, { path, cause: err });
  }
  assertInfoOwnedByUs(path, info);
}

async function readLockPid(lockPath) {
  try {
    const text = await readFile(lockPath, 'utf8');
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function acquireLock(lockPath, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw new StandupStateError(
          `cannot take the standup state lock ${lockPath}: ${err.message}`,
          { path: lockPath, cause: err },
        );
      }
    }

    // Someone holds it. Mtime alone can be a stalled event loop or a swapping
    // machine, and even a stale/dead holder is not safe to unlink by pathname:
    // two waiters can both decide a lock is stale, one can acquire a replacement
    // lock, and the other can then delete that fresh lock. So stale/dead locks
    // are an explicit operator-facing failure, not an automatic takeover.
    let held;
    try {
      held = await stat(lockPath);
    } catch (statErr) {
      if (statErr.code === 'ENOENT') continue; // released underneath us; retry immediately
      throw new StandupStateError(
        `cannot inspect the standup state lock ${lockPath}: ${statErr.message}`,
        { path: lockPath, cause: statErr },
      );
    }
    await assertOwnedByUs(lockPath);
    const ageMs = Date.now() - held.mtimeMs;
    const ownerPid = await readLockPid(lockPath);
    if (ageMs > staleMs && !processIsAlive(ownerPid)) {
      throw new StandupStateError(
        `standup state lock ${lockPath} is stale (${Math.round(ageMs)}ms old) `
        + `and its recorded owner pid ${ownerPid ?? 'unknown'} is not alive. `
        + 'Refusing automatic stale-lock takeover because another writer may have '
        + 'already acquired a replacement lock; inspect the state file and remove '
        + 'the lock manually if it is truly abandoned.',
        { code: 'standup_state_stale_lock', path: lockPath },
      );
    }
    if (Date.now() > deadline) {
      throw new StandupStateError(
        `timed out after ${waitMs}ms waiting for the standup state lock ${lockPath}; `
        + 'another ARF process is writing this file',
        { code: 'standup_state_locked', path: lockPath },
      );
    }
    await sleep(LOCK_POLL_MS);
  }
}

async function writeAtomic(path, document) {
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  // Same directory as the target: a rename across filesystems is not atomic, and
  // a temp file in /tmp would silently become a copy.
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    // The rename is atomic with respect to *ordering*, not to durability: without
    // the fsync a crash can leave the renamed name pointing at empty content.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new StandupStateError(`cannot write ${path}: ${err.message}`, { path, cause: err });
  }
  // A pre-existing file keeps its own mode through a rename onto it on some
  // platforms; set it explicitly so state written by an earlier, laxer version
  // is tightened rather than inherited.
  await chmod(path, 0o600).catch(() => undefined);
}

/**
 * A JSON document on disk with serialized read-modify-write.
 *
 * @param {string} path absolute path to the document
 * @param {object} options
 * @param {() => object} options.empty      the document a missing file stands for
 * @param {(raw: unknown, ctx: object) => object} [options.parse] shape validation
 */
export function openJsonState(path, {
  empty, parse = (value) => value, lockWaitMs = LOCK_WAIT_MS, lockStaleMs = LOCK_STALE_MS,
}) {
  async function readRaw() {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { document: empty(), exists: false };
      throw new StandupStateError(`cannot read ${path}: ${err.message}`, { path, cause: err });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new StandupStateError(
        `${path} is not valid JSON: ${err.message}. Refusing to overwrite it with a fresh `
        + 'document — fix or move the file so nothing already in it is lost.',
        { code: 'standup_state_corrupt', path, cause: err },
      );
    }
    return { document: parse(parsed, { source: path }), exists: true };
  }

  return {
    path,

    /** Read the current document. A missing file reads as `empty()`. */
    async read() {
      return (await readRaw()).document;
    },

    /** Whether the file exists on disk right now. */
    async exists() {
      return (await readRaw()).exists;
    },

    /**
     * Read, transform, and write back under both locks.
     *
     * `fn(document)` returns `{document, result}` — or `null` to write nothing,
     * which is how an idempotent no-op avoids rewriting a file (and bumping its
     * mtime) for a run that changed nothing. The two-field return is explicit
     * rather than "a document, or a document and a result": a state document
     * that happened to carry a `document` key would otherwise be misread.
     *
     * @returns {Promise<{document: object, result: any, written: boolean}>}
     */
    async update(fn) {
      return serialize(path, async () => {
        await assertOwnedByUs(path);
        await ensureDir(path);
        const lockPath = `${path}.lock`;
        await assertOwnedByUs(lockPath);
        await acquireLock(lockPath, { waitMs: lockWaitMs, staleMs: lockStaleMs });
        try {
          const { document } = await readRaw();
          const outcome = await fn(document);
          if (outcome === null || outcome === undefined) {
            return { document, result: null, written: false };
          }
          const next = outcome.document;
          if (next === null || typeof next !== 'object') {
            throw new StandupStateError(
              `internal: update() callback for ${path} returned no document`, { path },
            );
          }
          await writeAtomic(path, next);
          return { document: next, result: outcome.result ?? null, written: true };
        } finally {
          await assertOwnedByUs(lockPath);
          await unlink(lockPath).catch(() => undefined);
        }
      });
    },
  };
}

export { assertOwnedByUs };
