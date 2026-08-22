/**
 * SQLite seam for the ARF review-state store.
 *
 * Two invariants live here, and only here:
 *
 * 1. **The read path never holds a writable handle.** `openReadOnly` opens with
 *    `readOnly: true` (SQLITE_OPEN_READONLY — the flag `?mode=ro` sets). This
 *    matters most in `in-os` mode: a live `reviews.db` is single-writer,
 *    better-sqlite3, watcher-owned, and a second writer risks corrupting the
 *    pipeline's own state. It is enforced for standalone reads too, so the
 *    invariant is not mode-dependent and stays testable.
 *
 * 2. **A read never leaves a foreign-owned WAL sidecar behind.** SQLITE_OPEN_READONLY
 *    is not enough: opening a WAL-mode database *creates* `-wal` / `-shm`
 *    sidecars when they do not already exist, owned by the reading process. If
 *    ARF runs as a different macOS account than the pipeline watcher, those
 *    sidecars lock the watcher out of its own database — the 501-vs-502 sidecar
 *    outage class this repo has already paid for. `storeAccess` therefore
 *    resolves the owner first and picks the open strategy from it, matching the
 *    established cross-owner SQLite read discipline elsewhere in the OS
 *    (`cwp_dispatch.dag_chain._connect_readonly_ledger`, Sentinel's
 *    chain-observability findings helper):
 *
 *      same owner                      -> `mode=ro`, locking on. Any sidecar the
 *                                         read creates is ours, which is exactly
 *                                         what the pipeline already expects.
 *      cross-owner, no live sidecars   -> `mode=ro&immutable=1`. `immutable=1`
 *                                         tells SQLite the file cannot change,
 *                                         so it takes no locks and creates no
 *                                         sidecar at all. Sound precisely
 *                                         because no `-wal` exists: every
 *                                         committed row is already in the main
 *                                         database file, so nothing is stranded.
 *      cross-owner, live sidecars      -> fail closed. The database is mid-WAL
 *                                         under another uid; `immutable=1` would
 *                                         read past the WAL and `mode=ro` needs
 *                                         to write the foreign `-shm`. Callers
 *                                         get an honest unavailable-with-reason,
 *                                         which names the fix (run as the owner).
 *
 *    `immutable=1` is NOT used on the same-owner path: a live `reviews.db` is
 *    being written while ARF reads it, so SQLite's locking must stay on or a
 *    read can observe a torn mid-write state. `busy_timeout` waits a concurrent
 *    pipeline write out rather than failing the read into a blank dashboard.
 *
 * 3. **Absent / corrupt / foreign-schema stores degrade, they do not throw.**
 *    Callers get a null handle and project an honest empty.
 *
 * Only `node:` builtins are imported. `node:sqlite` is loaded lazily so a Node
 * without it produces one actionable error at first store use instead of an
 * opaque module-resolution failure at import time.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export class ArfStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArfStoreError';
  }
}

let cachedDatabaseSync = null;
let cachedLoadError = null;

/** The `node:sqlite` DatabaseSync constructor, or a loud actionable error. */
export function databaseSync() {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  if (cachedLoadError) throw cachedLoadError;
  try {
    const mod = require('node:sqlite');
    if (typeof mod?.DatabaseSync !== 'function') {
      throw new Error('node:sqlite has no DatabaseSync export');
    }
    cachedDatabaseSync = mod.DatabaseSync;
    return cachedDatabaseSync;
  } catch (err) {
    cachedLoadError = new ArfStoreError(
      'ARF needs the built-in node:sqlite module (Node >= 23.4, or Node 22.5+ with '
      + `--experimental-sqlite). Running Node ${process.version}: ${err.message}`,
    );
    throw cachedLoadError;
  }
}

/** Sidecars a WAL-mode SQLite database keeps beside the main file. */
export const WAL_SIDECAR_SUFFIXES = ['-wal', '-shm'];

/** The effective uid, or null on a platform without one (Windows). */
function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Decide how — or whether — `path` may be opened for reading, without opening
 * it. See invariant 2 in the module header for why ownership is resolved before
 * the handle exists rather than after.
 *
 * `reason` is non-null only for the fail-closed case: an absent or unreadable
 * path is an ordinary empty store, and the caller already has a better sentence
 * for it than this module does.
 *
 * @param {string} path
 * @param {{uid?: number|null}} [options] `uid` is injectable so the cross-owner
 *   branches are testable without a second account.
 * @returns {{open: boolean, immutable: boolean, reason: string|null}}
 */
export function storeAccess(path, { uid = currentUid() } = {}) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return { open: false, immutable: false, reason: null };
  }
  if (!stat.isFile()) return { open: false, immutable: false, reason: null };
  // No uid to compare against means no cross-user hazard to guard: keep locking
  // on rather than silently downgrading every read to `immutable=1`.
  if (uid === null || stat.uid === uid) return { open: true, immutable: false, reason: null };

  // SQLite creates `-wal` / `-shm` beside the file it actually opens, so a
  // symlinked store keeps its sidecars next to the TARGET. Suffixing the link's
  // own path would find nothing, fall through to `immutable=1`, and read past a
  // live WAL — stale rows served as current. `statSync` above already followed
  // the link for the ownership test; the sidecar test has to follow it too.
  let resolved;
  try {
    resolved = realpathSync(path);
  } catch {
    // The chain resolved a moment ago for `statSync` and does not now. We cannot
    // say where this store's sidecars live, and this is already the cross-owner
    // branch, so refuse rather than guess an answer that could strand the
    // pipeline's own WAL.
    return {
      open: false,
      immutable: false,
      reason: `store at ${path} is owned by uid ${stat.uid} and its real path could `
        + 'not be resolved, so a read cannot prove it would create no WAL sidecar '
        + `under another uid; run ARF as uid ${stat.uid}`,
    };
  }

  const live = WAL_SIDECAR_SUFFIXES.filter((suffix) => existsSync(`${resolved}${suffix}`));
  if (live.length > 0) {
    return {
      open: false,
      immutable: false,
      reason: `store is owned by uid ${stat.uid} and has live WAL sidecars `
        + `(${live.join(', ')}); run ARF as uid ${stat.uid} so a read cannot take `
        + "ownership of the pipeline's sidecar files",
    };
  }
  return { open: true, immutable: true, reason: null };
}

/** `file://` URI for a path, with the read flags the access decision picked. */
function readOnlyUri(path, immutable) {
  return `${pathToFileURL(path).href}?mode=ro${immutable ? '&immutable=1' : ''}`;
}

/**
 * Open a read-only handle, or a null handle when the store cannot be read.
 *
 * The handle is null for an absent file (a fresh standalone install, or an in-OS
 * deploy pointed at a pipeline that has not run yet), for a present file that is
 * not a database (a stray file at that path), and for a cross-owner store the
 * read must not touch (invariant 2). Only the last carries a `reason`; the
 * others are ordinary empties the caller describes better. A missing
 * `node:sqlite` is NOT degraded — that is an environment fault, not an empty
 * store.
 *
 * @param {string} path
 * @param {{busyTimeoutMs?: number, uid?: number|null}} [options]
 * @returns {{db: import('node:sqlite').DatabaseSync|null, reason: string|null}}
 */
export function openReadOnly(path, { busyTimeoutMs = 2000, uid = currentUid() } = {}) {
  const DatabaseSync = databaseSync();
  const access = storeAccess(path, { uid });
  if (!access.open) return { db: null, reason: access.reason };
  let db;
  try {
    // `readOnly: true` and the URI's own `mode=ro` are the same flag stated
    // twice on purpose: the invariant must survive someone editing either one.
    db = new DatabaseSync(readOnlyUri(path, access.immutable), { readOnly: true });
  } catch {
    return { db: null, reason: null };
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`);
    // Touch the schema so a present-but-not-a-database file fails here, where it
    // degrades, rather than inside a projection query.
    db.prepare('SELECT name FROM sqlite_master WHERE type = ? LIMIT 1').get('table');
  } catch {
    try {
      db.close();
    } catch {
      // Already unusable; nothing to salvage.
    }
    return { db: null, reason: null };
  }
  return { db, reason: null };
}

/**
 * Open a writable handle. Only the standalone store-provisioning path may call
 * this, and it is never reachable in `in-os` mode.
 *
 * @param {string} path
 * @param {{mode: string, readOnly: boolean}} config
 */
export function openWritableStandalone(path, config) {
  if (config.readOnly) {
    throw new ArfStoreError(
      `refusing a writable handle on ${path}: mode=${config.mode} is read-only `
      + '(a live reviews.db is single-writer and pipeline-owned)',
    );
  }
  const DatabaseSync = databaseSync();
  return new DatabaseSync(path);
}

/**
 * Open a writable handle on the GitHub mirror cache (ARF-02).
 *
 * The mirror is ARF-owned in **every** mode — it is ARF's cache of fields
 * `reviews.db` does not carry, not review state — so unlike
 * `openWritableStandalone` this is not gated on `config.readOnly`. What it IS
 * gated on is the path: the one way a mirror write could become a write to a
 * live, single-writer, pipeline-owned `reviews.db` is a config that resolves
 * both to the same file, so that is refused here as well as at config load. The
 * check is stated twice on purpose — the invariant must survive an edit to
 * either side.
 *
 * `busy_timeout` is set on the handle for the same reason `openReadOnly` sets it,
 * and it is not redundant with Node being single-threaded: nothing *inside* ARF
 * can contend for this file (`node:sqlite` is synchronous), but the mirror is a
 * plain SQLite file on disk, and an operator troubleshooting the dashboard with
 * the `sqlite3` CLI is a second process. Without a timeout, a write that lands
 * during that read throws `SQLITE_BUSY` immediately and fails the batch refresh;
 * with one, it waits out an inspection that lasts milliseconds.
 *
 * @param {string} path
 * @param {{reviewStorePath?: string|null, busyTimeoutMs?: number}} [options]
 */
export function openWritableMirror(path, { reviewStorePath = null, busyTimeoutMs = 2000 } = {}) {
  if (reviewStorePath && samePath(path, reviewStorePath)) {
    throw new ArfStoreError(
      `refusing a writable mirror handle on ${path}: it is also the review store, `
      + 'which ARF never writes',
    );
  }
  const DatabaseSync = databaseSync();
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`);
  } catch (err) {
    // A handle that cannot take the pragma is not a handle worth returning:
    // closing here keeps the failure at the open, rather than surfacing it as a
    // mystery SQLITE_BUSY inside a later write.
    closeQuietly(db);
    throw err;
  }
  return db;
}

/**
 * Whether two paths name the same file.
 *
 * `realpathSync` so a symlinked mirror path pointed at `reviews.db` is caught;
 * it throws for a path that does not exist yet (the normal case for a fresh
 * mirror), and then the literal comparison is the best available answer.
 */
function samePath(a, b) {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Close a handle without letting a close failure mask the caller's result. */
export function closeQuietly(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    // A read-only handle that cannot close cleanly has nothing pending to lose.
  }
}

/** Column names present on a table; empty when the table does not exist. */
export function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    return new Set(rows.map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * A SELECT list that tolerates schema drift: columns the live store lacks are
 * projected as NULL instead of failing the whole query. An older (or newer)
 * adversarial-review install must degrade field-by-field, not to a blank page.
 *
 * @param {string} alias table alias to qualify present columns with
 * @param {Set<string>} present columns the table actually has
 * @param {string[]} wanted columns the projection reads
 */
export function tolerantSelectList(alias, present, wanted) {
  return wanted
    .map((column) => (present.has(column)
      ? `${alias}.${quoteIdent(column)} AS ${quoteIdent(column)}`
      : `NULL AS ${quoteIdent(column)}`))
    .join(', ');
}

/** Run a query, degrading a schema/IO failure to a fallback instead of throwing. */
export function queryOrDegrade(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
