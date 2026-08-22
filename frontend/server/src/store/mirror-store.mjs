/**
 * The GitHub mirror cache (ARF-02), keyed by `(repo, pr_number)`.
 *
 * `reviews.db` carries review state and nothing else — no PR title, no builder,
 * no labels, no check rollup, no mergeable state, no review bodies. This table
 * is where ARF keeps those, so the dashboard can join them onto the store's PR
 * rows on PR number instead of rendering the `PR #<n>` / `builder = —`
 * placeholders the operator-console Review space is forced to render today
 * (SPEC §1).
 *
 * Three properties this module holds:
 *
 * 1. **It is ARF's file, in every mode.** SPEC §9 puts the mirror's write target
 *    at "own store cache". It is never `reviews.db`: that store is pipeline-owned
 *    and single-writer, and ARF's handle on it is read-only forever. `config.mjs`
 *    and `sqlite.openWritableMirror` both refuse a config where the two paths
 *    resolve to one file.
 * 2. **An absent cache is an empty cache, not an error.** A fresh install has no
 *    mirror rows; that reads as "no mirror row yet" — the one case where the
 *    dashboard legitimately has nothing to show for a PR.
 * 3. **A cached row records when it was fetched.** Without `fetched_at_ms` there
 *    is no cache-hit/miss decision to make and no way to tell a current mirror
 *    from one captured before the last three pushes.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { closeQuietly, openWritableMirror, queryOrDegrade } from './sqlite.mjs';

export const MIRROR_SCHEMA_VERSION = 1;

export const MIRROR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS github_pr_mirror (
    -- COLLATE NOCASE on the column, so the primary key and every lookup agree.
    -- GitHub repo names are case-insensitive, and a store row that spells the
    -- repo differently from the mirror row must still join. Putting the
    -- collation only on the lookups would leave the PK case-sensitive: two rows
    -- for one PR, and which one a read returned would be arbitrary.
    repo             TEXT    NOT NULL COLLATE NOCASE,
    pr_number        INTEGER NOT NULL,
    title            TEXT,
    author_login     TEXT,
    author_type      TEXT,
    builder          TEXT,
    builder_source   TEXT,
    pr_state         TEXT,
    draft            INTEGER,
    merged           INTEGER,
    mergeable        INTEGER,
    mergeable_state  TEXT,
    head_sha         TEXT,
    base_ref         TEXT,
    html_url         TEXT,
    labels_json      TEXT,
    checks_json      TEXT,
    reviews_json     TEXT,
    fetched_at       TEXT    NOT NULL,
    fetched_at_ms    INTEGER NOT NULL,
    PRIMARY KEY (repo, pr_number)
  );

  CREATE INDEX IF NOT EXISTS idx_github_pr_mirror_pr ON github_pr_mirror(pr_number);

  CREATE TABLE IF NOT EXISTS arf_mirror_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const COLUMNS = [
  'repo', 'pr_number', 'title', 'author_login', 'author_type', 'builder', 'builder_source',
  'pr_state', 'draft', 'merged', 'mergeable', 'mergeable_state', 'head_sha', 'base_ref',
  'html_url', 'labels_json', 'checks_json', 'reviews_json', 'fetched_at', 'fetched_at_ms',
];

function text(value) {
  if (value === null || value === undefined) return null;
  const str = String(value);
  return str.trim() ? str : null;
}

/**
 * SQLite has no boolean type and `node:sqlite` rejects a JS boolean as a bind
 * parameter, so tri-state fields are stored 1 / 0 / NULL. NULL genuinely means
 * unknown here — GitHub reports `mergeable: null` while it is still computing a
 * merge commit, and flattening that to `false` would report a perfectly
 * mergeable PR as conflicted.
 */
function boolToInt(value) {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

function intToBool(value) {
  if (value === null || value === undefined) return null;
  return Number(value) !== 0;
}

function json(value, fallback) {
  const raw = text(value);
  if (!raw) return fallback;
  return queryOrDegrade(() => JSON.parse(raw), fallback);
}

/** Normalized cache key. GitHub repo names are case-insensitive. */
export function mirrorKey(repo, prNumber) {
  return `${String(repo ?? '').toLowerCase()}#${Number(prNumber)}`;
}

export class MirrorStore {
  /**
   * @param {{path: string, reviewStorePath?: string|null, busyTimeoutMs?: number}} options
   */
  constructor({ path, reviewStorePath = null, busyTimeoutMs = 2000 }) {
    this.path = path;
    this.reviewStorePath = reviewStorePath;
    // Same knob the review store reads (`busyTimeoutMs`), applied to every mirror
    // handle: the cache is a standalone file an operator can open with the
    // `sqlite3` CLI, and a write racing that read must wait rather than throw.
    this.busyTimeoutMs = busyTimeoutMs;
    this.provisioned = false;
  }

  /**
   * Open the cache, creating the file and schema on first use.
   *
   * Provisioning is lazy rather than at boot so an ARF that never talks to
   * GitHub never creates the file — and so a `node:sqlite`-less Node fails at
   * the first mirror call with that module's actionable message rather than
   * turning every boot into a crash.
   */
  #open() {
    if (!this.provisioned) mkdirSync(dirname(this.path), { recursive: true });
    const db = openWritableMirror(this.path, {
      reviewStorePath: this.reviewStorePath,
      busyTimeoutMs: this.busyTimeoutMs,
    });
    if (!this.provisioned) {
      try {
        db.exec(MIRROR_SCHEMA_SQL);
        db.prepare('INSERT OR REPLACE INTO arf_mirror_meta (key, value) VALUES (?, ?)')
          .run('schema_version', String(MIRROR_SCHEMA_VERSION));
        this.provisioned = true;
      } catch (err) {
        closeQuietly(db);
        throw err;
      }
    }
    return db;
  }

  /** Cache descriptor: path, row count, and why it is empty when it is. */
  describe() {
    let db;
    try {
      db = this.#open();
    } catch (err) {
      return {
        path: this.path,
        available: false,
        rows: 0,
        reason: `mirror cache is unusable: ${err.message}`,
      };
    }
    try {
      const row = queryOrDegrade(
        () => db.prepare('SELECT COUNT(*) AS n FROM github_pr_mirror').get(),
        { n: 0 },
      );
      return { path: this.path, available: true, rows: Number(row?.n ?? 0), reason: null };
    } finally {
      closeQuietly(db);
    }
  }

  /** One cached record, or null when this PR has no mirror row yet. */
  get(repo, prNumber) {
    const db = this.#open();
    try {
      const row = queryOrDegrade(() => db.prepare(
        'SELECT * FROM github_pr_mirror WHERE repo = ? AND pr_number = ?',
      ).get(String(repo), Number(prNumber)), null);
      return row ? decodeRow(row) : null;
    } finally {
      closeQuietly(db);
    }
  }

  /**
   * Cached records for a set of `{repo, pr}` refs, as a Map keyed by
   * `mirrorKey`. One open and one statement per call rather than per ref, so a
   * dashboard page load does not open the cache once per row.
   */
  getMany(refs) {
    const found = new Map();
    if (refs.length === 0) return found;
    const db = this.#open();
    try {
      const stmt = queryOrDegrade(() => db.prepare(
        'SELECT * FROM github_pr_mirror WHERE repo = ? AND pr_number = ?',
      ), null);
      if (!stmt) return found;
      for (const ref of refs) {
        const row = queryOrDegrade(() => stmt.get(String(ref.repo), Number(ref.pr)), null);
        if (row) found.set(mirrorKey(row.repo, row.pr_number), decodeRow(row));
      }
      return found;
    } finally {
      closeQuietly(db);
    }
  }

  /** Every cached record, newest fetch first. Bounded so a caller cannot ask for the world. */
  all({ limit = 500 } = {}) {
    const db = this.#open();
    try {
      const rows = queryOrDegrade(() => db.prepare(
        'SELECT * FROM github_pr_mirror ORDER BY fetched_at_ms DESC LIMIT ?',
      ).all(Math.max(1, Math.floor(Number(limit) || 500))), []);
      return rows.map(decodeRow);
    } finally {
      closeQuietly(db);
    }
  }

  /**
   * Write one fetched record. Full replace, not a merge: a mirror row is a
   * snapshot of one GitHub read, and merging a fresh read over stale fields
   * would produce a row that never existed on GitHub at any instant — a label
   * removed in the same push that added a check would stay visible forever.
   */
  upsert(record) {
    const db = this.#open();
    try {
      db.prepare(`
        INSERT INTO github_pr_mirror (${COLUMNS.join(', ')})
        VALUES (${COLUMNS.map(() => '?').join(', ')})
        ON CONFLICT(repo, pr_number) DO UPDATE SET
          ${COLUMNS.filter((c) => c !== 'repo' && c !== 'pr_number')
            .map((c) => `${c} = excluded.${c}`).join(',\n          ')}
      `).run(...encodeRow(record));
      return true;
    } finally {
      closeQuietly(db);
    }
  }

  /** Drop one cached row. Used by tests and by a future cache-invalidate path. */
  delete(repo, prNumber) {
    const db = this.#open();
    try {
      const result = db.prepare(
        'DELETE FROM github_pr_mirror WHERE repo = ? AND pr_number = ?',
      ).run(String(repo), Number(prNumber));
      return Number(result?.changes ?? 0) > 0;
    } finally {
      closeQuietly(db);
    }
  }
}

function encodeRow(record) {
  const values = {
    repo: String(record.repo),
    pr_number: Number(record.pr),
    title: text(record.title),
    author_login: text(record.author),
    author_type: text(record.authorType),
    builder: text(record.builder),
    builder_source: text(record.builderSource),
    pr_state: text(record.state),
    draft: boolToInt(record.draft),
    merged: boolToInt(record.merged),
    mergeable: boolToInt(record.mergeable),
    mergeable_state: text(record.mergeableState),
    head_sha: text(record.headSha),
    base_ref: text(record.baseRef),
    html_url: text(record.url),
    labels_json: JSON.stringify(record.labels ?? []),
    checks_json: JSON.stringify(record.checks ?? null),
    reviews_json: JSON.stringify(record.reviews ?? []),
    fetched_at: String(record.fetchedAt),
    fetched_at_ms: Number(record.fetchedAtMs),
  };
  return COLUMNS.map((column) => values[column]);
}

/** A stored row back into the in-memory record shape the projection reads. */
export function decodeRow(row) {
  return {
    repo: text(row.repo),
    pr: Number(row.pr_number),
    title: text(row.title),
    author: text(row.author_login),
    authorType: text(row.author_type),
    builder: text(row.builder),
    builderSource: text(row.builder_source),
    state: text(row.pr_state),
    draft: intToBool(row.draft),
    merged: intToBool(row.merged),
    mergeable: intToBool(row.mergeable),
    mergeableState: text(row.mergeable_state),
    headSha: text(row.head_sha),
    baseRef: text(row.base_ref),
    url: text(row.html_url),
    labels: json(row.labels_json, []),
    checks: json(row.checks_json, null),
    reviews: json(row.reviews_json, []),
    fetchedAt: text(row.fetched_at),
    fetchedAtMs: Number(row.fetched_at_ms),
  };
}
