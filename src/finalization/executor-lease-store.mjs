// Merge Authority v2 executor lease store (ARC-17; docs/SPEC-merge-authority-v2.md
// §4). The single-executor-per-subject lease lives HERE — in the app store
// (`data/reviews.db`), NOT in GitHub labels (the standing "Don't" for ARC-17).
// This is the serialization seam that makes "one subject, one writer" (§2) true:
// exactly one executor may hold a subject's lease at a time, so two executors can
// never both fold-and-merge the same subject.
//
// The lease is FENCED by `lease_id`. Release and renewal only touch a row whose
// stored `lease_id` still matches the caller's token; a stale holder (whose lease
// was already stolen after expiry, or who crashed and restarted) can therefore
// never delete or extend a newer holder's lease. An expired lease is stolen by a
// compare-and-set UPDATE gated on the OLD `lease_id` AND `deadline < now`, so two
// concurrent stealers cannot both win the race.
//
// Time enters ONLY as caller-supplied data (`now`, `deadline`) — the store reads
// no clock, mirroring the ledger fold's discipline, so lease outcomes are
// deterministic and testable against an in-memory DB. Native better-sqlite3 and
// the cross-user ownership guard mirror the shadow store.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { resolveSubjectKey } from './ledger-events.mjs';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Idempotent schema convergence — mirrors the 20260719 migration exactly. */
export function ensureFinalizationExecutorLeaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalization_executor_lease (
      domain_id           TEXT NOT NULL,
      subject_external_id TEXT NOT NULL,
      lease_id            TEXT NOT NULL,
      holder              TEXT NOT NULL,
      revision_ref        TEXT,
      acquired_at         TEXT NOT NULL,
      deadline            TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      recorded_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (domain_id, subject_external_id)
    );
  `);
}

function openDb(rootDir, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  const dataDir = join(rootDir, 'data');
  const dbPath = join(dataDir, 'reviews.db');
  const callerUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!Number.isInteger(callerUid)) {
    throw new Error('cannot verify finalization executor lease store caller ownership');
  }
  const anchor = existsSync(dataDir) ? dataDir : rootDir;
  const ownerUid = statSync(anchor).uid;
  if (callerUid !== ownerUid) {
    throw new Error(
      `refusing cross-user finalization executor lease write: caller uid ${callerUid}, canonical owner uid ${ownerUid}`,
    );
  }
  if (existsSync(dbPath) && statSync(dbPath).uid !== ownerUid) {
    throw new Error('refusing write to non-canonical-owned reviews database');
  }
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)}`);
  return db;
}

function rowToLease(row) {
  if (!row) return null;
  return {
    subjectKey: { domainId: row.domain_id, subjectExternalId: row.subject_external_id },
    leaseId: row.lease_id,
    holder: row.holder,
    revisionRef: row.revision_ref ?? null,
    acquiredAt: row.acquired_at,
    deadline: row.deadline,
    updatedAt: row.updated_at,
  };
}

// Pure expiry check — the store never reads a clock; the caller supplies `now`.
function isExpired(deadline, now) {
  const due = Date.parse(deadline ?? '');
  const at = Date.parse(now ?? '');
  if (!Number.isFinite(due) || !Number.isFinite(at)) return false;
  return at >= due;
}

/**
 * Open the executor lease store. Pass `{ db }` (e.g. an in-memory database) for
 * tests, or `{ rootDir }` to open `data/reviews.db`. When it opens its own
 * handle, `close()` closes it; when the caller supplies `db`, the caller owns it.
 *
 * @param {{ rootDir?: string, db?: import('better-sqlite3').Database, busyTimeoutMs?: number }} options
 */
export function openFinalizationExecutorLeaseStore({ rootDir, db, busyTimeoutMs } = {}) {
  const ownDb = !db;
  const database = db ?? openDb(rootDir, { busyTimeoutMs });
  ensureFinalizationExecutorLeaseSchema(database);

  const selectByKey = database.prepare(
    'SELECT * FROM finalization_executor_lease WHERE domain_id = ? AND subject_external_id = ?',
  );

  const insert = database.prepare(`
    INSERT INTO finalization_executor_lease
      (domain_id, subject_external_id, lease_id, holder, revision_ref, acquired_at, deadline, updated_at)
    VALUES
      (@domain_id, @subject_external_id, @lease_id, @holder, @revision_ref, @acquired_at, @deadline, @updated_at)
    ON CONFLICT(domain_id, subject_external_id) DO NOTHING
  `);

  // Steal an EXPIRED lease, fenced on the observed holder's lease_id (CAS) and on
  // the deadline still being expired at write time. Losing the race changes 0 rows.
  const steal = database.prepare(`
    UPDATE finalization_executor_lease
    SET lease_id = @lease_id, holder = @holder, revision_ref = @revision_ref,
        acquired_at = @acquired_at, deadline = @deadline, updated_at = @updated_at
    WHERE domain_id = @domain_id AND subject_external_id = @subject_external_id
      AND lease_id = @prev_lease_id AND deadline <= @now
  `);

  const renew = database.prepare(`
    UPDATE finalization_executor_lease
    SET deadline = @deadline, updated_at = @updated_at, revision_ref = @revision_ref
    WHERE domain_id = @domain_id AND subject_external_id = @subject_external_id AND lease_id = @lease_id
  `);

  const release = database.prepare(`
    DELETE FROM finalization_executor_lease
    WHERE domain_id = @domain_id AND subject_external_id = @subject_external_id AND lease_id = @lease_id
  `);

  const acquireTxn = database.transaction((cols, prevLeaseId, now) => {
    // 1. Try to take a free subject atomically.
    if (insert.run(cols).changes === 1) return 'inserted';
    // 2. Occupied. Re-read under the transaction; steal only if expired, fenced
    //    on the exact holder we observed so a concurrent stealer can't be lost.
    const existing = selectByKey.get(cols.domain_id, cols.subject_external_id);
    if (existing && isExpired(existing.deadline, now)) {
      const stolen = steal.run({ ...cols, prev_lease_id: existing.lease_id, now });
      if (stolen.changes === 1) return 'stolen';
    }
    return 'contended';
  });

  return {
    db: database,

    /**
     * Acquire the subject's lease. Returns `{ acquired, lease, reason, existing }`.
     * `acquired:true` with `lease` when this caller now holds it (fresh insert or
     * an expired-lease steal); `acquired:false` with `reason:'held'` and the live
     * `existing` holder when another executor holds an unexpired lease.
     *
     * @param {{
     *   subject: import('../kernel/contracts.js').SubjectRef | import('../kernel/contracts.js').SubjectKey,
     *   holder: string, leaseId: string, revisionRef?: string | null,
     *   now: string, deadline: string,
     * }} args
     */
    acquire({ subject, holder, leaseId, revisionRef = null, now, deadline }) {
      const key = resolveSubjectKey(subject);
      if (!holder) throw new TypeError('lease acquire requires a holder identity');
      if (!leaseId) throw new TypeError('lease acquire requires a leaseId fence token');
      if (!now || !deadline) throw new TypeError('lease acquire requires now + deadline timestamps');
      const cols = {
        domain_id: key.domainId,
        subject_external_id: key.subjectExternalId,
        lease_id: leaseId,
        holder,
        revision_ref: revisionRef,
        acquired_at: now,
        deadline,
        updated_at: now,
      };
      const result = acquireTxn(cols, null, now);
      if (result === 'contended') {
        const existing = rowToLease(selectByKey.get(key.domainId, key.subjectExternalId));
        return { acquired: false, lease: null, reason: 'held', existing };
      }
      return {
        acquired: true,
        lease: rowToLease(selectByKey.get(key.domainId, key.subjectExternalId)),
        reason: result,
        existing: null,
      };
    },

    /**
     * Renew (extend the deadline of) a lease this caller holds, fenced on
     * `leaseId`. Returns true when the fence matched; false when a newer holder
     * has superseded it (a stale renewal never extends someone else's lease).
     */
    renew({ subject, leaseId, revisionRef = null, deadline, now }) {
      const key = resolveSubjectKey(subject);
      const changed = renew.run({
        domain_id: key.domainId,
        subject_external_id: key.subjectExternalId,
        lease_id: leaseId,
        revision_ref: revisionRef,
        deadline,
        updated_at: now ?? deadline,
      }).changes;
      return changed === 1;
    },

    /**
     * Release a lease this caller holds, fenced on `leaseId`. Returns true when
     * the fence matched; false when the row was already stolen/released (a stale
     * release never deletes a newer holder — the §4 fence invariant).
     */
    release({ subject, leaseId }) {
      const key = resolveSubjectKey(subject);
      const changed = release.run({
        domain_id: key.domainId,
        subject_external_id: key.subjectExternalId,
        lease_id: leaseId,
      }).changes;
      return changed === 1;
    },

    /** Read the current holder for a subject, or null when the subject is free. */
    read(subject) {
      const key = resolveSubjectKey(subject);
      return rowToLease(selectByKey.get(key.domainId, key.subjectExternalId));
    },

    close() {
      if (ownDb) database.close();
    },
  };
}
