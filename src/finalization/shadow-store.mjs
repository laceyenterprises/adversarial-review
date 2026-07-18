// Merge Authority v2 shadow mode — the observation store (ARC-16;
// docs/SPEC-merge-authority-v2.md §5). Append-only persistence for the shadow
// `(v1 action, v2 decision)` pairs the recorder produces, in the app store
// (`data/reviews.db`, alongside the finalization ledger). Shadow mode NEVER
// acts, so this is pure telemetry: `append` records one observation, `read`
// returns them windowed by tick time for the report, and `annotate` records a
// human's overriding triage disposition (the bidirectional discipline of §5.2 —
// the classifier proposes, a human may override).
//
// Mirrors the ledger-store seam: in-memory DB for tests, native better-sqlite3
// in production, schema convergence that matches the 20260718 migration exactly.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Idempotent schema convergence — mirrors the 20260718 migration exactly. */
export function ensureFinalizationShadowSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS finalization_shadow (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id                 TEXT NOT NULL,
      subject_external_id       TEXT NOT NULL,
      revision_ref              TEXT,
      observed_at               TEXT NOT NULL,
      relation                  TEXT NOT NULL,
      direction                 TEXT NOT NULL,
      divergence_class          TEXT,
      disposition               TEXT NOT NULL,
      v1_action_kind            TEXT NOT NULL,
      v2_decision_kind          TEXT NOT NULL,
      fold_error                INTEGER NOT NULL DEFAULT 0,
      saw_head_move             INTEGER NOT NULL DEFAULT 0,
      saw_exhaustion            INTEGER NOT NULL DEFAULT 0,
      payload_json              TEXT NOT NULL DEFAULT '{}',
      disposition_override_json TEXT,
      recorded_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_finalization_shadow_observed_at
      ON finalization_shadow(observed_at);

    CREATE INDEX IF NOT EXISTS idx_finalization_shadow_subject
      ON finalization_shadow(domain_id, subject_external_id, id);
  `);
}

function openDb(rootDir, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  const db = new Database(join(rootDir, 'data', 'reviews.db'));
  db.pragma(`busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)}`);
  return db;
}

function openReadOnlyDb(rootDir, { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  const db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true });
  db.pragma(`busy_timeout = ${Math.max(0, Number(busyTimeoutMs) || 0)}`);
  db.pragma('query_only = 1');
  return db;
}

function observationToColumns(obs) {
  return {
    domain_id: obs.subjectKey.domainId,
    subject_external_id: obs.subjectKey.subjectExternalId,
    revision_ref: obs.revisionRef ?? null,
    observed_at: obs.observedAt,
    relation: obs.classification.relation,
    direction: obs.classification.direction,
    divergence_class: obs.classification.class ?? null,
    disposition: obs.classification.disposition,
    v1_action_kind: obs.v1Action.kind,
    v2_decision_kind: obs.v2Decision.kind,
    fold_error: obs.foldError ? 1 : 0,
    saw_head_move: obs.sawHeadMove ? 1 : 0,
    saw_exhaustion: obs.sawExhaustion ? 1 : 0,
    payload_json: JSON.stringify({
      v1Action: obs.v1Action,
      v2Decision: obs.v2Decision,
      classification: obs.classification,
    }),
  };
}

/** Reconstruct a shadow observation (+ id + any override) from a raw row. */
export function rowToObservation(row) {
  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  let override = null;
  if (row.disposition_override_json) {
    try {
      override = JSON.parse(row.disposition_override_json);
    } catch {
      override = null;
    }
  }
  return {
    id: row.id,
    subjectKey: { domainId: row.domain_id, subjectExternalId: row.subject_external_id },
    revisionRef: row.revision_ref ?? '',
    observedAt: row.observed_at,
    v1Action: payload.v1Action ?? { kind: row.v1_action_kind },
    v2Decision: payload.v2Decision ?? { kind: row.v2_decision_kind },
    classification: payload.classification ?? {
      relation: row.relation,
      direction: row.direction,
      class: row.divergence_class,
      disposition: row.disposition,
    },
    foldError: row.fold_error === 1,
    sawHeadMove: row.saw_head_move === 1,
    sawExhaustion: row.saw_exhaustion === 1,
    dispositionOverride: override,
  };
}

/**
 * Open a shadow observation store. Pass `{ db }` (e.g. an in-memory database)
 * for tests, or `{ rootDir }` to open `data/reviews.db`. When it opens its own
 * handle, `close()` closes it; when the caller supplies `db`, the caller owns it.
 *
 * @param {{ rootDir?: string, db?: import('better-sqlite3').Database, busyTimeoutMs?: number }} options
 */
export function openFinalizationShadowStore({ rootDir, db, busyTimeoutMs } = {}) {
  const ownDb = !db;
  const database = db ?? openDb(rootDir, { busyTimeoutMs });
  ensureFinalizationShadowSchema(database);

  const insert = database.prepare(`
    INSERT INTO finalization_shadow
      (domain_id, subject_external_id, revision_ref, observed_at, relation, direction,
       divergence_class, disposition, v1_action_kind, v2_decision_kind, fold_error,
       saw_head_move, saw_exhaustion, payload_json)
    VALUES
      (@domain_id, @subject_external_id, @revision_ref, @observed_at, @relation, @direction,
       @divergence_class, @disposition, @v1_action_kind, @v2_decision_kind, @fold_error,
       @saw_head_move, @saw_exhaustion, @payload_json)
  `);

  const selectWindow = database.prepare(`
    SELECT * FROM finalization_shadow
    WHERE observed_at >= ? AND observed_at <= ?
    ORDER BY observed_at ASC, id ASC
  `);

  const selectAll = database.prepare(`
    SELECT * FROM finalization_shadow ORDER BY observed_at ASC, id ASC
  `);

  const updateOverride = database.prepare(`
    UPDATE finalization_shadow SET disposition_override_json = @override WHERE id = @id
  `);

  const selectById = database.prepare('SELECT * FROM finalization_shadow WHERE id = ?');

  return {
    db: database,

    /**
     * Append one shadow observation. Returns the stored record with its `id`.
     * @param {import('../kernel/contracts.js').ShadowObservation} observation
     */
    append(observation) {
      const result = insert.run(observationToColumns(observation));
      return { ...observation, id: Number(result.lastInsertRowid) };
    },

    /**
     * Read observations whose tick time falls in `[from, to]` (inclusive ISO
     * bounds). Omit both for the whole table.
     * @param {{ from?: string, to?: string }} [window]
     */
    read({ from, to } = {}) {
      const rows = (from != null || to != null)
        ? selectWindow.all(from ?? '', to ?? '￿')
        : selectAll.all();
      return rows.map(rowToObservation);
    },

    /**
     * Record a human's overriding triage disposition on an observation (§5.2 —
     * the classifier proposes, a human disposes). `disposition` is 'resolved' or
     * 'open'; `note`/`principal` document the call.
     * @param {number} id
     * @param {{ disposition: string, note?: string, principal?: string, at: string }} override
     */
    annotate(id, override) {
      if (!override || (override.disposition !== 'resolved' && override.disposition !== 'open')) {
        throw new TypeError("shadow annotate requires disposition 'resolved' or 'open'");
      }
      if (!override.at) throw new TypeError('shadow annotate requires an `at` timestamp');
      updateOverride.run({ id, override: JSON.stringify(override) });
      const row = selectById.get(id);
      return row ? rowToObservation(row) : null;
    },

    close() {
      if (ownDb) database.close();
    },
  };
}

/**
 * Open the existing shadow table for operator reporting without creating
 * directories, opening a writable SQLite handle, or converging the schema.
 * The daemon-owned writable store/migration must create the table first.
 *
 * @param {{ rootDir: string, busyTimeoutMs?: number }} options
 */
export function openReadOnlyFinalizationShadowStore({ rootDir, busyTimeoutMs } = {}) {
  const database = openReadOnlyDb(rootDir, { busyTimeoutMs });
  let selectAll;
  try {
    selectAll = database.prepare(`
      SELECT * FROM finalization_shadow ORDER BY observed_at ASC, id ASC
    `);
  } catch (err) {
    database.close();
    throw err;
  }

  return {
    db: database,
    read() {
      return selectAll.all().map(rowToObservation);
    },
    close() {
      database.close();
    },
  };
}
