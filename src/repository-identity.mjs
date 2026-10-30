import Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { withFollowUpJobLock } from './follow-up-job-write.mjs';
import {
  inRepositoryStateCycle, repositoryObservationPath, repositoryRenamePendingPath, repositoryStateBusy,
  withRepositoryStateMigration, withRepositoryStateRead,
} from './repository-state-lock.mjs';
import {
  applyRepositoryStateFiles, canonicalRepositoryJson, collectRepositoryIdentityHashes, planRepositoryStateFiles,
  rekeyRepositoryDigests, rekeyRepositoryValue, repositoryStateDigest,
} from './repository-state-files.mjs';

export function ensureRepositoryIdentitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository_identities (
      repository_id TEXT PRIMARY KEY, node_id TEXT, full_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repository_name_history (
      repository_id TEXT NOT NULL, full_name TEXT NOT NULL COLLATE NOCASE,
      observed_at TEXT NOT NULL, PRIMARY KEY(repository_id, full_name)
    );
    CREATE TABLE IF NOT EXISTS repository_rename_audit (
      operation_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, old_name TEXT NOT NULL,
      new_name TEXT NOT NULL, at TEXT NOT NULL, rows_json TEXT NOT NULL
    );
  `);
}

function identityFrom(value) {
  const rawId = value?.id ?? value?.repository_id;
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0
    ? String(rawId) : typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId) ? rawId : null;
  const fullName = value?.full_name;
  if (!id || typeof fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    throw new TypeError('Repository identity requires a positive numeric id and full_name');
  }
  return { id, fullName, nodeId: value.node_id || null };
}

const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
const repoColumns = new Set(['repo', 'repository', 'target_repo', 'legacy_repo']);
const subjectColumns = new Set(['subject_external_id', 'subject_key', 'family_key', 'idempotency_key', 'event_key', 'pr_url']);

// Enumerate the actual installed schema, including lazily bootstrapped tables,
// rather than maintaining a second list that can silently omit a new store.
export function rekeyRepositoryDatabase(db, { oldName, newName }) {
  const counts = {};
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const snapshots = [], hashes = new Map(), structured = [];
  for (const { name } of tables) {
    if (name.startsWith('repository_')) continue;
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const relevant = columns.filter(c => repoColumns.has(c.name) || subjectColumns.has(c.name) || c.name.endsWith('_json'));
    if (!relevant.length) continue;
    const rows = db.prepare(`SELECT rowid AS __rename_rowid__, * FROM ${quote(name)}`).all();
    counts[name] = 0;
    for (const row of rows) {
      for (const { name: column } of relevant) {
        if ((repoColumns.has(column) && row[column]?.toLowerCase() === newName.toLowerCase()
          || subjectColumns.has(column) && typeof row[column] === 'string'
            && rekeyRepositoryValue(row[column], newName, oldName) !== row[column])
          && oldName.toLowerCase() !== newName.toLowerCase()) {
          throw new Error(`Repository rename destination has unowned state in ${name}`);
        }
        if (column.endsWith('_json') && row[column]) {
          try { structured.push(JSON.parse(row[column])); } catch {}
        }
      }
    }
    snapshots.push({ name, relevant, rows });
  }
  collectRepositoryIdentityHashes(hashes, structured, oldName, newName);
  for (const { name, relevant, rows } of snapshots) {
    for (const row of rows) {
      if (row.domain_id && row.domain_id !== 'code-pr') continue;
      const changed = [];
      for (const { name: column } of relevant) {
        const prior = row[column];
        let next = prior;
        if (column.endsWith('_json') && prior) {
          let parsed;
          try { parsed = JSON.parse(prior); } catch { continue; }
          const rewritten = rekeyRepositoryDigests(rekeyRepositoryValue(parsed, oldName, newName), hashes);
          if (JSON.stringify(parsed) !== JSON.stringify(rewritten)) {
            next = canonicalRepositoryJson(rewritten);
          }
        } else if (repoColumns.has(column)) {
          if (prior?.toLowerCase() === oldName.toLowerCase()) next = newName;
        } else if (typeof prior === 'string') next = rekeyRepositoryValue(prior, oldName, newName);
        if (next !== prior) changed.push([column, next]);
      }
      // payload_digest is a checksum of the service-owned handoff, not a
      // signature. Keep it and acknowledgement references consistent.
      for (const column of ['payload_digest', 'receipt_digest']) {
        if (hashes.has(row[column])) changed.push([column, hashes.get(row[column])]);
      }
      if (!changed.length) continue;
      db.prepare(`UPDATE ${quote(name)} SET ${changed.map(([column]) => `${quote(column)}=?`).join(',')} WHERE rowid=?`)
        .run(...changed.map(([, value]) => value), row.__rename_rowid__);
      counts[name]++;
    }
  }
  return counts;
}

function publishNames(db, rootDir) {
  const names = db.prepare(`SELECT h.full_name AS name,h.repository_id,i.full_name AS current
    FROM repository_name_history h JOIN repository_identities i USING(repository_id)`).all();
  writeFileAtomic(join(rootDir, 'data', 'repository-names.json'), JSON.stringify(names), { mode: 0o600 });
}

function auditText(audit) {
  return `[repository-rename] ${JSON.stringify(audit)}`;
}

function finishRename({ db, rootDir, journal, logger, afterFile, afterDatabase }) {
  // Files and independent databases form a recoverable transaction. The durable
  // pending marker fences cycles until every participant has committed.
  applyRepositoryStateFiles(rootDir, journal.files, afterFile);
  const databases = {};
  for (const path of journal.databases) {
    const store = new Database(join(rootDir, path), { fileMustExist: true });
    try {
      ensureRepositoryIdentitySchema(store);
      store.transaction(() => {
        if (store.prepare('SELECT 1 FROM repository_rename_audit WHERE operation_id=?').get(journal.operationId)) return;
        const counts = rekeyRepositoryDatabase(store, journal);
        store.prepare('INSERT INTO repository_rename_audit VALUES (?,?,?,?,?,?)')
          .run(journal.operationId, journal.repositoryId, journal.oldName, journal.newName, journal.at, JSON.stringify(counts));
      }).immediate();
      databases[path] = JSON.parse(store.prepare('SELECT rows_json FROM repository_rename_audit WHERE operation_id=?')
        .get(journal.operationId).rows_json);
    } finally { store.close(); }
    afterDatabase?.(path);
  }
  const audit = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM repository_rename_audit WHERE operation_id=?').get(journal.operationId);
    if (existing) return null;
    const counts = rekeyRepositoryDatabase(db, journal);
    db.prepare('UPDATE repository_identities SET full_name=?, node_id=COALESCE(?,node_id), observed_at=? WHERE repository_id=? AND full_name=?')
      .run(journal.newName, journal.nodeId, journal.at, journal.repositoryId, journal.oldName);
    db.prepare('INSERT OR IGNORE INTO repository_name_history VALUES (?,?,?)')
      .run(journal.repositoryId, journal.newName, journal.at);
    db.prepare('INSERT INTO repository_rename_audit VALUES (?,?,?,?,?,?)')
      .run(journal.operationId, journal.repositoryId, journal.oldName, journal.newName, journal.at, JSON.stringify(counts));
    return { oldName: journal.oldName, newName: journal.newName, repositoryId: journal.repositoryId,
      rows: counts, databases, files: journal.files.length, at: journal.at };
  }).immediate();
  // The durable audit is authoritative. Console delivery can be lost at a
  // process crash; never replay a committed migration merely to print a line.
  if (audit) logger?.log?.(auditText(audit));
  publishNames(db, rootDir);
  unlinkSync(repositoryRenamePendingPath(rootDir));
  return audit;
}

export function recoverRepositoryRename({ db, rootDir, logger = console, afterFile, afterDatabase } = {}) {
  if (!existsSync(repositoryRenamePendingPath(rootDir))) return null;
  return withRepositoryStateMigration(rootDir, () => withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    const journal = JSON.parse(readFileSync(repositoryRenamePendingPath(rootDir), 'utf8'));
    return finishRename({ db, rootDir, journal, logger, afterFile, afterDatabase });
  }));
}

export function observeRepositoryIdentity(options = {}) {
  try { return observeIdentity(options); }
  catch (error) {
    if (error.code !== 'REPOSITORY_STATE_BUSY') error.code = 'REPOSITORY_IDENTITY_CONFLICT';
    throw error;
  }
}

function observeIdentity({ db, rootDir, repository, additionalStateDir, logger = console,
  now = () => new Date().toISOString(), afterFile, afterDatabase } = {}) {
  const identity = identityFrom(repository);
  ensureRepositoryIdentitySchema(db);
  recoverRepositoryRename({ db, rootDir, logger, afterFile, afterDatabase });
  const known = db.prepare('SELECT * FROM repository_identities WHERE repository_id=?').get(identity.id);
  const occupant = db.prepare('SELECT * FROM repository_identities WHERE full_name=?').get(identity.fullName);
  if (occupant && occupant.repository_id !== identity.id) {
    throw new Error(`Repository name ${identity.fullName} is still owned by a different recorded id`);
  }
  const at = now();
  if (known && known.full_name !== identity.fullName && inRepositoryStateCycle(rootDir)) {
    // An authoritative payload may reveal a redirect midway through a cycle.
    // Persist that observation and abort intake. The next poll migrates before
    // any cached or retained work can execute.
    writeFileAtomic(repositoryObservationPath(rootDir), JSON.stringify(repository), { mode: 0o600 });
    throw repositoryStateBusy('Authoritative repository identity changed; discovery must retry after rekey');
  }
  if (!known || known.full_name === identity.fullName) {
    return withRepositoryStateRead(rootDir, () => {
      db.transaction(() => {
      const history = db.prepare('SELECT repository_id FROM repository_name_history WHERE full_name=? AND repository_id<>?')
        .get(identity.fullName, identity.id);
      if (!known && history) logger?.warn?.(`[repository-rename] reused name ${identity.fullName}; distinct repository id ${identity.id}`);
      db.prepare(`INSERT INTO repository_identities VALUES (?,?,?,?)
        ON CONFLICT(repository_id) DO UPDATE SET node_id=COALESCE(excluded.node_id,node_id), observed_at=excluded.observed_at`)
        .run(identity.id, identity.nodeId, identity.fullName, at);
      db.prepare('INSERT OR IGNORE INTO repository_name_history VALUES (?,?,?)').run(identity.id, identity.fullName, at);
      }).immediate();
      publishNames(db, rootDir);
      return { renamed: false, fullName: identity.fullName };
    });
  }
  return withRepositoryStateMigration(rootDir, () => withFollowUpJobLock(join(rootDir, 'data', 'follow-up-jobs'), () => {
    // Read again under the migration lock. Another watcher may have completed
    // the same observation while this process was waiting for discovery.
    const current = db.prepare('SELECT * FROM repository_identities WHERE repository_id=?').get(identity.id);
    if (current.full_name === identity.fullName) return { renamed: false, fullName: identity.fullName };
    const oldName = current.full_name, newName = identity.fullName;
    // Fail before touching files if a destination collision or unsupported
    // schema prevents the SQL participant from committing.
    db.exec('SAVEPOINT repository_rename_preflight');
    try { rekeyRepositoryDatabase(db, { oldName, newName }); }
    finally { db.exec('ROLLBACK TO repository_rename_preflight; RELEASE repository_rename_preflight'); }
    const databases = ['data/ham-primary-change-refusals.db'].filter(path => existsSync(join(rootDir, path)));
    for (const path of databases) {
      const store = new Database(join(rootDir, path), { fileMustExist: true });
      try {
        store.exec('SAVEPOINT repository_rename_preflight');
        try { rekeyRepositoryDatabase(store, { oldName, newName }); }
        finally { store.exec('ROLLBACK TO repository_rename_preflight; RELEASE repository_rename_preflight'); }
      } finally { store.close(); }
    }
    const subjects = db.prepare('SELECT *, reviewer_head_sha AS headSha FROM reviewed_prs WHERE repo=?').all(oldName);
    const deliveryRows = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='comment_deliveries'").get()
      ? db.prepare("SELECT * FROM comment_deliveries WHERE domain_id='code-pr' AND subject_external_id LIKE ?").all(`${oldName}#%`) : [];
    for (const row of deliveryRows) {
      subjects.push({ domainId: row.domain_id, subjectExternalId: row.subject_external_id,
        revisionRef: row.revision_ref, round: row.round, kind: row.delivery_kind,
        ...(row.notice_ref ? { noticeRef: row.notice_ref } : {}) });
    }
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='finalization_queue_lane'").get()) {
      subjects.push(...db.prepare('SELECT repository,base FROM finalization_queue_lane WHERE repository=?').all(oldName));
    }
    const journal = {
      operationId: repositoryStateDigest(JSON.stringify([identity.id, oldName, newName, at])),
      repositoryId: identity.id, oldName, newName, nodeId: identity.nodeId, at,
      files: planRepositoryStateFiles(rootDir, { oldName, newName, subjects, additionalStateDir }),
      databases,
    };
    writeFileAtomic(repositoryRenamePendingPath(rootDir), JSON.stringify(journal), { mode: 0o600, overwrite: false });
    const audit = finishRename({ db, rootDir, journal, logger, afterFile, afterDatabase });
    return { renamed: true, fullName: newName, audit };
  }));
}

export function canonicalRepositoryName(db, name) {
  const current = db.prepare('SELECT full_name FROM repository_identities WHERE full_name=?').get(name);
  if (current) return current.full_name;
  const candidates = db.prepare(`SELECT DISTINCT i.full_name FROM repository_name_history h
    JOIN repository_identities i USING(repository_id) WHERE h.full_name=?`).all(name);
  if (candidates.length > 1) throw new Error(`Ambiguous historical repository name: ${name}`);
  return candidates[0]?.full_name || name;
}

export function observeRepositoryListing({ db, rootDir, repositories, ...options }) {
  ensureRepositoryIdentitySchema(db);
  // Known ids move first, so a newly created repo may reuse the vacated name.
  const ordered = [...repositories].sort((a, b) => Number(Boolean(db.prepare('SELECT 1 FROM repository_identities WHERE repository_id=?').get(String(b.id))))
    - Number(Boolean(db.prepare('SELECT 1 FROM repository_identities WHERE repository_id=?').get(String(a.id)))));
  return ordered.map(repository => observeRepositoryIdentity({ db, rootDir, repository, ...options }));
}

export function recoverRepositoryObservations({ db, rootDir, ...options }) {
  recoverRepositoryRename({ db, rootDir, ...options });
  const path = repositoryObservationPath(rootDir);
  if (!existsSync(path)) return;
  return withRepositoryStateMigration(rootDir, () => {
    if (!existsSync(path)) return;
    const repository = JSON.parse(readFileSync(path, 'utf8'));
    observeRepositoryIdentity({ db, rootDir, repository, ...options });
    unlinkSync(path);
  });
}

export { rekeyRepositoryValue };
