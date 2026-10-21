// Capacity recovery is independent of the delivery row and runtime run record.
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

const active = new Map();
function leasePath(rootDir, sessionUuid) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(sessionUuid) || sessionUuid === '.' || sessionUuid === '..') {
    throw new Error('invalid reviewer lease session');
  }
  return join(rootDir, 'data', 'reviewer-token-leases', `${sessionUuid}.json`);
}
export function markReviewerTokenLeaseActive(rootDir, sessionUuid, value) {
  const key = resolve(leasePath(rootDir, sessionUuid));
  const count = (active.get(key) || 0) + (value ? 1 : -1);
  if (count > 0) active.set(key, count); else active.delete(key);
}
export function journalReviewerTokenLease(rootDir, sessionUuid, identity, lease = undefined, pgid = null) {
  const path = leasePath(rootDir, sessionUuid);
  let previous;
  try { previous = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Persist only the broker fence, never unvalidated owner extension fields.
  const fence = lease && Object.fromEntries(['account_id', 'lease_id', 'generation'].map(key => [key, lease[key]]));
  const entry = { version: 1, sessionUuid, identity,
    createdAt: previous?.createdAt || new Date().toISOString(),
    lease: lease === undefined ? previous?.lease || null : fence, pgid: pgid || previous?.pgid || null };
  writeFileAtomic(path, JSON.stringify(entry));
  return entry;
}
export function forgetReviewerTokenLease(rootDir, sessionUuid) {
  rmSync(leasePath(rootDir, sessionUuid), { force: true });
}
export function readReviewerTokenLeases(rootDir, log = console) {
  let files;
  try { files = readdirSync(join(rootDir, 'data', 'reviewer-token-leases')); }
  catch (error) { if (error.code !== 'ENOENT') log.warn('[watcher] reviewer lease journal unavailable'); return []; }
  return files.filter(name => name.endsWith('.json')).flatMap(name => {
    try {
      const entry = JSON.parse(readFileSync(join(rootDir, 'data', 'reviewer-token-leases', name), 'utf8'));
      if (entry.version !== 1 || name !== `${entry.sessionUuid}.json`
        || !['claude-reviewer', 'codex-reviewer'].includes(entry.identity)
        || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('invalid journal');
      leasePath(rootDir, entry.sessionUuid);
      return [entry];
    } catch { log.warn('[watcher] reviewer lease journal entry unreadable; operator inspection required'); return []; }
  });
}

// Runs for every journal entry, even after delivery settlement and outside the
// stale-row cap. Four bounded transports at a time; no credentials are read.
export async function reconcileReviewerTokenLeases({ rootDir, rows, readRecord, probeAlive,
  findProcess, ownerImpl, updateLease, now = new Date(), log = console }) {
  const entries = readReviewerTokenLeases(rootDir, log);
  const bySession = new Map(rows.map(row => [row.reviewer_session_uuid, row]));
  let cursor = 0;
  const released = new Set();
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      const { sessionUuid, identity } = entry;
      if (active.has(resolve(leasePath(rootDir, sessionUuid)))) continue;
      try {
        const row = bySession.get(sessionUuid);
        const record = readRecord(sessionUuid);
        const pgid = row?.reviewer_pgid || record?.pgid || entry.pgid;
        // A readable launching record may precede the process and PGID write.
        if (!pgid && now.getTime() - Date.parse(entry.createdAt) < 60_000) continue;
        let alive = pgid ? probeAlive(pgid) : false;
        if (typeof alive !== 'boolean') throw new Error('unknown process evidence');
        if (!pgid || !alive) {
          const found = findProcess(sessionUuid);
          if (found?.found !== false && !found?.pgid) throw new Error('unknown process evidence');
          alive = found?.pgid ? probeAlive(found.pgid) : false;
          if (typeof alive !== 'boolean') throw new Error('unknown process evidence');
        }
        let lease = entry.lease;
        if (!lease) {
          // Covers a killed transport, including death inside acquire before
          // the broker response reached Node. Diagnostics retain expired slots.
          const recovered = await ownerImpl({ operation: 'recover', requestId: sessionUuid, identity });
          if (recovered?.ok !== true || !Object.hasOwn(recovered, 'lease')) throw new Error('unknown broker evidence');
          lease = recovered.lease;
          if (lease === null) {
            if (alive) throw new Error('live session has no broker receipt');
            forgetReviewerTokenLease(rootDir, sessionUuid); continue;
          }
          if (!lease || typeof lease !== 'object') throw new Error('unknown broker lease');
          journalReviewerTokenLease(rootDir, sessionUuid, identity, lease, pgid);
        }
        await updateLease({ identity, lease }, alive ? 'renew' : 'release', { rootDir });
        if (!alive) { forgetReviewerTokenLease(rootDir, sessionUuid); released.add(sessionUuid); }
      } catch {
        try { journalReviewerTokenLease(rootDir, sessionUuid, identity, null); } catch {}
        log.warn(`[watcher] reviewer account lease recovery unavailable session=${sessionUuid}; journal retained`);
      }
    }
  }));
  return released;
}
