// Merge Authority v2 ledger store (ARC-15; docs/SPEC-merge-authority-v2.md §2).
// The append-only persistence for the finalization event ledger, in the app
// store (`data/reviews.db`, alongside review-state). This is the ONE writer's
// storage seam: `append` is the only mutation, and it never updates or deletes.
// Reading a subject's ledger yields its events in append (`seq`) order, ready
// for the pure `fold` in `ledger-fold.mjs`.
//
// This module does I/O; it is deliberately NOT wired into any live actor here.
// The shadow executor (ARC-16) and the finalization executor (ARC-17) compose
// it. Kept isolated from review-state's schema so the ledger can be exercised
// against an in-memory DB in tests. Native better-sqlite3 mirrors review-state.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  FINALIZATION_EVENT_TYPES,
  makeFinalizationEvent,
  resolveSubjectKey,
} from './ledger-events.mjs';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const FINALIZATION_EVENT_TYPE_SET = new Set(FINALIZATION_EVENT_TYPES);

// The columns that live in dedicated table fields; everything else in an event
// is carried in `payload_json`. Kept in sync with the migration.
const COLUMN_FIELDS = new Set(['type', 'subjectKey', 'revisionRef', 'at', 'sourceRef', 'idempotencyKey']);

/** Idempotent schema convergence — mirrors the 20260717 migration exactly. */
export function ensureFinalizationLedgerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalization_ledger (
      seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id           TEXT NOT NULL,
      subject_external_id TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      revision_ref        TEXT,
      at                  TEXT NOT NULL,
      source_ref          TEXT,
      idempotency_key     TEXT,
      payload_json        TEXT NOT NULL DEFAULT '{}',
      recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_finalization_ledger_subject
      ON finalization_ledger(domain_id, subject_external_id, seq);

    CREATE UNIQUE INDEX IF NOT EXISTS finalization_ledger_idempotency_unique
      ON finalization_ledger(domain_id, subject_external_id, event_type, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
}

function openDb(rootDir, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  db.pragma(`busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)}`);
  return db;
}

// Split an event into its column fields + the JSON payload of everything else.
function eventToColumns(event) {
  const payload = {};
  for (const [key, value] of Object.entries(event)) {
    if (COLUMN_FIELDS.has(key)) continue;
    if (value !== undefined) payload[key] = value;
  }
  return {
    domain_id: event.subjectKey.domainId,
    subject_external_id: event.subjectKey.subjectExternalId,
    event_type: event.type,
    revision_ref: event.revisionRef ?? null,
    at: event.at,
    source_ref: event.sourceRef ?? null,
    idempotency_key: event.idempotencyKey ?? null,
    payload_json: JSON.stringify(payload),
  };
}

/** Reconstruct a `FinalizationEvent` (+ `seq`) from a ledger row. */
export function rowToEvent(row) {
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  const fields = {
    ...payload,
    at: row.at,
  };
  if (row.revision_ref != null) fields.revisionRef = row.revision_ref;
  if (row.source_ref != null) fields.sourceRef = row.source_ref;
  if (row.idempotency_key != null) fields.idempotencyKey = row.idempotency_key;
  const subjectKey = { domainId: row.domain_id, subjectExternalId: row.subject_external_id };
  // Writes remain strict, but an older reader must preserve event types written
  // by a newer producer so the fold can safely ignore their unknown semantics.
  const event = FINALIZATION_EVENT_TYPE_SET.has(row.event_type)
    ? makeFinalizationEvent(row.event_type, subjectKey, fields)
    : { type: row.event_type, subjectKey, ...fields };
  event.seq = row.seq;
  return event;
}

/**
 * Open a finalization ledger store. Pass `{ db }` (e.g. an in-memory database)
 * for tests, or `{ rootDir }` to open `data/reviews.db`. The caller owns the
 * lifecycle when it supplies `db`; otherwise `close()` closes the opened handle.
 *
 * @param {{ rootDir?: string, db?: import('better-sqlite3').Database, busyTimeoutMs?: number }} options
 */
export function openFinalizationLedgerStore({ rootDir, db, busyTimeoutMs } = {}) {
  const ownDb = !db;
  const database = db ?? openDb(rootDir, { busyTimeoutMs });
  ensureFinalizationLedgerSchema(database);

  const insert = database.prepare(`
    INSERT INTO finalization_ledger
      (domain_id, subject_external_id, event_type, revision_ref, at, source_ref, idempotency_key, payload_json)
    VALUES
      (@domain_id, @subject_external_id, @event_type, @revision_ref, @at, @source_ref, @idempotency_key, @payload_json)
    ON CONFLICT(domain_id, subject_external_id, event_type, idempotency_key)
      WHERE idempotency_key IS NOT NULL DO NOTHING
  `);

  const selectByKey = database.prepare(`
    SELECT * FROM finalization_ledger
    WHERE domain_id = ? AND subject_external_id = ?
    ORDER BY seq ASC
  `);

  const selectExisting = database.prepare(`
    SELECT * FROM finalization_ledger
    WHERE domain_id = ? AND subject_external_id = ? AND event_type = ? AND idempotency_key = ?
    ORDER BY seq ASC LIMIT 1
  `);

  return {
    db: database,

    /**
     * Append one event. Idempotent on `idempotencyKey`: a replayed dispatch with
     * the same key returns the already-stored row rather than double-appending.
     * @param {import('../kernel/contracts.js').FinalizationEvent} event
     */
    append(event) {
      // Re-validate at the write boundary so a malformed event can never land.
      const validated = makeFinalizationEvent(event.type, event.subjectKey, event);
      const columns = eventToColumns(validated);
      const result = insert.run(columns);
      if (result.changes === 1) {
        return { ...validated, seq: Number(result.lastInsertRowid) };
      }
      // Conflict path: an event with this idempotency key already exists.
      const existing = selectExisting.get(
        columns.domain_id, columns.subject_external_id, columns.event_type, columns.idempotency_key,
      );
      return existing ? rowToEvent(existing) : { ...validated };
    },

    /**
     * Read a subject's whole ledger in append order.
     * @param {import('../kernel/contracts.js').SubjectKey | import('../kernel/contracts.js').SubjectRef} subject
     * @returns {import('../kernel/contracts.js').FinalizationEvent[]}
     */
    read(subject) {
      const key = resolveSubjectKey(subject);
      return selectByKey.all(key.domainId, key.subjectExternalId).map(rowToEvent);
    },

    close() {
      if (ownDb) database.close();
    },
  };
}

export { FINALIZATION_EVENT_TYPES };
