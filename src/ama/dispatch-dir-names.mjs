import { readdirSync, statSync } from 'node:fs';

// A directory's `.json` entry names, re-listed only when the directory changed.
//
// The AMA closer scans `ama-closer-dispatches/` once per PR per tick, and the
// directory holds one file per (PR, head) for the whole fleet history. Creating,
// renaming or unlinking an entry updates the directory's mtime, so one stat
// decides whether the last listing still holds.
//
// A listing is reused only when it was taken at least SETTLE_MS after the mtime
// it saw (git's "racy index" rule). A later change then lands in a later
// timestamp granule even on a coarse-mtime filesystem, so it cannot hide behind
// an unchanged mtime.
const SETTLE_MS = 2_000;
const MAX_CACHED_DIRS = 16;
const listings = new Map();

const defaultFs = { readdirSync, statSync };

export function listSettledJsonNames(dir, { fsImpl = defaultFs, nowMs = Date.now() } = {}) {
  let stat;
  try {
    stat = fsImpl.statSync(dir, { bigint: true });
  } catch {
    listings.delete(dir);
    return [];
  }
  const cached = listings.get(dir);
  if (cached && cached.ino === stat.ino && cached.mtimeNs === stat.mtimeNs) {
    return cached.names.slice();
  }

  let names;
  try {
    names = fsImpl.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    listings.delete(dir);
    return [];
  }
  listings.delete(dir);
  const mtimeMs = Number(stat.mtimeNs / 1_000_000n);
  if (nowMs - mtimeMs >= SETTLE_MS) {
    listings.set(dir, { ino: stat.ino, mtimeNs: stat.mtimeNs, names });
    if (listings.size > MAX_CACHED_DIRS) listings.delete(listings.keys().next().value);
  }
  return names.slice();
}

export function _resetSettledJsonNamesForTests() {
  listings.clear();
}
