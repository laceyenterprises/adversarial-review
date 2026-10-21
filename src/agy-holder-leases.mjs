// Host-side execution slots, separate from Keychain/refresh ownership. Lock by
// holder, not account alias. Never unlink lock inodes and never reclaim by TTL.
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fsExt from 'fs-ext';
import { writeFileAtomic } from './atomic-write.mjs';

export function createAgyHolderLeaseStore(stateDir) {
  const dir = join(stateDir, 'agy-holder-leases');
  function paths(user) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)) throw new Error('invalid agy holder');
    return { record: join(dir, `${user}.json`), lock: join(dir, `${user}.lock`) };
  }
  function read(user) {
    try {
      const row = JSON.parse(readFileSync(paths(user).record, 'utf8'));
      if (row.version !== 1 || row.user !== user || !Object.hasOwn(row, 'lease')) throw new Error('invalid agy holder record');
      if (row.lease !== null && (!row.lease || row.lease.identity !== 'gemini-reviewer'
        || row.lease.user !== user || !Number.isInteger(row.lease.ownerPid) || row.lease.ownerPid <= 0
        || typeof row.lease.generation !== 'string' || !row.lease.generation
        || typeof row.lease.reviewId !== 'string' || !row.lease.reviewId)) throw new Error('invalid agy holder lease');
      if (row.auth != null && (row.auth.needsProbe !== true
        || !Number.isSafeInteger(row.auth.failures) || row.auth.failures < 0
        || !Number.isFinite(row.auth.retryAt) || row.auth.retryAt < 0)) throw new Error('invalid agy holder cooldown');
      return row;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, user, lease: null, auth: null };
      throw error; // Corrupt/unreadable occupancy is unknown, never free.
    }
  }
  async function update(user, fn) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = paths(user);
    const fd = openSync(path.lock, 'a', 0o600);
    let locked = false;
    try {
      try { fsExt.flockSync(fd, 'exnb'); locked = true; }
      catch (error) {
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null;
        throw error;
      }
      const row = read(user);
      const result = await fn(row);
      writeFileAtomic(path.record, JSON.stringify(row), { mode: 0o600 });
      return result;
    } finally {
      if (locked) fsExt.flockSync(fd, 'un');
      closeSync(fd);
    }
  }
  return { read, update };
}

export function agyLeaseOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
