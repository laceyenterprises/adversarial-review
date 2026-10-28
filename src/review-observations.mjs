/** Owner-defined, read-only Sentinel evidence. No daemon imports or reconciliation. */
import { openReviewStateReadOnlyDb } from './pipeline-health-db.mjs';

const FIELDS = {
  passes: ['pass_id', 'repo', 'pr_number', 'attempt_number', 'reviewer_class', 'reviewer_model',
    'pass_kind', 'started_at', 'ended_at', 'status', 'metadata_json'],
  reviews: ['repo', 'pr_number', 'pr_state', 'review_status', 'failure_message',
    'reviewer_head_sha', 'revision_ref', 'reviewed_at', 'posted_at'],
};
const tables = { passes: 'reviewer_passes', reviews: 'reviewed_prs' };
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));

export function readReviewObservations({ rootDir, selector, repositories }) {
  const { kind, since, ended_since: endedSince, limit = 100, offset = 0 } = selector;
  if (!Object.hasOwn(FIELDS, kind) || Object.keys(selector).some(key => !['kind', 'since', 'ended_since', 'limit', 'offset'].includes(key)) ||
      !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000 ||
      (since !== undefined && (typeof since !== 'string' || !Number.isFinite(Date.parse(since))))) throw new Error('invalid review selector');
  if (!Array.isArray(repositories) || !repositories.length || repositories.length > 100 ||
      repositories.some(repo => typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw new Error('review repository grant required');
  const { db, status } = openReviewStateReadOnlyDb(rootDir);
  if (!db) {
    if (!status.exists) return { schema_version: 1, kind, items: [], complete: true, next_offset: null,
      missing_fields: ['review_store'], observed_at: new Date().toISOString(), scope_complete: false, mutation_authority: false };
    throw new Error(`review evidence unavailable: ${status.error}`);
  }
  try {
    db.exec('BEGIN');
    const table = tables[kind];
    const cols = columns(db, table);
    if (!cols.has('repo') || !cols.has('pr_number')) {
      if (cols.size === 0) return { schema_version: 1, kind, items: [], complete: true, next_offset: null,
        missing_fields: FIELDS[kind], observed_at: new Date().toISOString(), scope_complete: false, mutation_authority: false };
      throw new Error('review identity schema unavailable');
    }
    const missing = FIELDS[kind].filter(field => !cols.has(field));
    const selected = FIELDS[kind].map(field => cols.has(field) ? field : `NULL AS ${field}`).join(',');
    const args = repositories.map(repo => repo.toLowerCase());
    let where = `lower(repo) IN (${args.map(() => '?').join(',')})`;
    if (since !== undefined) {
      if (kind !== 'passes' || !cols.has('started_at')) throw new Error('review time schema unavailable');
      // Date arithmetic accepts both producer Z timestamps and old offset timestamps.
      where += ' AND julianday(started_at) >= julianday(?)';
      args.push(since);
    }
    if (endedSince !== undefined) {
      if (kind !== 'passes' || !cols.has('ended_at') || typeof endedSince !== 'string' || !Number.isFinite(Date.parse(endedSince))) throw new Error('review end time unavailable');
      where += ' AND julianday(ended_at) >= julianday(?)';
      args.push(endedSince);
    }
    const order = kind === 'passes' && cols.has('pass_id') ? 'pass_id' : 'rowid';
    const rows = db.prepare(`SELECT ${selected} FROM ${table} WHERE ${where} ORDER BY ${order} DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset);
    const complete = rows.length <= limit;
    const items = rows.slice(0, limit);
    if (kind === 'reviews') {
      const passCols = columns(db, 'reviewer_passes');
      const closeCols = columns(db, 'pr_merge_closeouts');
      const passFields = { body_md: 'review_body', verdict: 'verdict', ended_at: 'review_ended_at', attempt_number: 'attempt_number' };
      const closeFields = { closeout_body_md: 'closeout_body', closeout_posted_at: 'closeout_posted_at' };
      for (const item of items) {
        let pass = null;
        if (['repo', 'pr_number', 'pass_id', 'status'].every(field => passCols.has(field))) {
          const fields = Object.entries(passFields).map(([field, alias]) => `${passCols.has(field) ? field : 'NULL'} AS ${alias}`);
          pass = db.prepare(`SELECT ${fields.join(',')} FROM reviewer_passes WHERE repo = ? AND pr_number = ? AND status = 'completed' ORDER BY pass_id DESC LIMIT 1`).get(item.repo, item.pr_number);
        }
        for (const alias of Object.values(passFields)) item[alias] = pass?.[alias] ?? null;
        let closeout = null;
        if (['repo', 'pr_number'].every(field => closeCols.has(field))) {
          const fields = Object.entries(closeFields).map(([field, alias]) => `${closeCols.has(field) ? field : 'NULL'} AS ${alias}`);
          closeout = db.prepare(`SELECT ${fields.join(',')} FROM pr_merge_closeouts WHERE repo = ? AND pr_number = ? LIMIT 1`).get(item.repo, item.pr_number);
        }
        for (const alias of Object.values(closeFields)) item[alias] = closeout?.[alias] ?? null;
      }
      for (const field of ['pass_id', 'status', ...Object.keys(passFields)]) if (!passCols.has(field)) missing.push(`reviewer_passes.${field}`);
      for (const field of ['repo', 'pr_number', ...Object.keys(closeFields)]) if (!closeCols.has(field)) missing.push(`pr_merge_closeouts.${field}`);
    }
    return { schema_version: 1, kind, items, complete, next_offset: complete ? null : offset + limit,
      missing_fields: missing, observed_at: new Date().toISOString(), scope_complete: false, mutation_authority: false };
  } finally {
    db.close();
  }
}
