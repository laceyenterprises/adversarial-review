// QWV-04: archive-before-delete for the reviews.db hand-repair residue.
//
// Dry-run plans and writes nothing. Export writes each residue table to CSV
// under <archive>/<table>.csv, copies the fossil directory under
// <archive>/files/, writes manifest.json (row counts, sha256, CREATE sql) and
// verifies the export by re-reading it. Drop re-verifies that export against
// the live database and files, then drops the tables and removes the listed
// zero-byte DB files and the fossil directory. Every refusal happens before
// the first mutation.
//
// Only `operator_*` tables whose name carries a hand-repair stamp token
// (`<YYYYMMDD>T<HHMM>[SS][Z]`, anywhere between underscores, as in
// `operator_20260727T0902_review_flow_rearm_reviewed_prs` or
// `operator_reviewer_pass_reset_20260727T062342Z`) are residue.
// `operator_hold_releases` is live (operator-hold-release.mjs) and is refused
// like any unstamped name.

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import Database from 'better-sqlite3';

const OPERATOR_TABLE_RE = /^operator_[A-Za-z0-9_]+$/;
const REPAIR_STAMP_RE = /(?:^|_)\d{8}T\d{4}(?:\d{2})?Z?(?:_|$)/;
export const FOSSIL_DIR_NAMES = Object.freeze(['follow-export HAM_RUN_DIR=']);
const LEGACY_DB_RE = /\.(db|sqlite|sqlite3)$/;
const MANIFEST = 'manifest.json';

export class ResidueRefusal extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

/** Why a table name is not droppable residue, or null when it is. */
export function residueTableRefusal(name) {
  if (typeof name !== 'string' || !name.startsWith('operator_')) return 'not-an-operator-table';
  if (!OPERATOR_TABLE_RE.test(name) || !REPAIR_STAMP_RE.test(name.slice('operator_'.length))) {
    return 'operator-table-without-repair-stamp';
  }
  return null;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function reviewsDbPath(arRoot) {
  return join(arRoot, 'data', 'reviews.db');
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  const text = String(value);
  return text === '' || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 record count (header included), honouring quoted newlines. */
export function countCsvRecords(text) {
  let records = 0;
  let inQuotes = false;
  let fieldStarted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') i += 1;
      else if (ch === '"') inQuotes = false;
    } else if (ch === '"') {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === '\n') {
      records += 1;
      fieldStarted = false;
    } else if (ch !== '\r') {
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new ResidueRefusal('export-csv-unterminated-quote');
  return records + (fieldStarted ? 1 : 0);
}

function tableCsv(db, name) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map(c => c.name);
  const lines = [columns.map(csvField).join(',')];
  for (const row of db.prepare(`SELECT * FROM ${quoteIdent(name)} ORDER BY rowid`).raw().iterate()) {
    lines.push(row.map(csvField).join(','));
  }
  return { columns, csv: `${lines.join('\n')}\n`, rowCount: lines.length - 1 };
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new ResidueRefusal('fossil-directory-has-non-regular-entry', { path });
    }
  };
  visit(root);
  return files;
}

function listZeroByteDbFiles(arRoot) {
  const live = reviewsDbPath(arRoot);
  const found = [];
  for (const dir of [arRoot, join(arRoot, 'data')]) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (!entry.isFile() || !LEGACY_DB_RE.test(entry.name) || path === live) continue;
      if (lstatSync(path).size === 0) found.push(path);
    }
  }
  return found.sort();
}

function selectTables(db, tables) {
  const operatorTables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'operator\\_%' ESCAPE '\\' ORDER BY name`,
  ).all().map(row => row.name);
  const requested = tables?.length ? tables : operatorTables.filter(name => !residueTableRefusal(name));
  for (const name of requested) {
    const reason = residueTableRefusal(name);
    if (reason) throw new ResidueRefusal(reason, { table: name });
    if (!operatorTables.includes(name)) throw new ResidueRefusal('table-not-found', { table: name });
  }
  return {
    tables: requested,
    keptOperatorTables: operatorTables.filter(name => !requested.includes(name)),
  };
}

/** What would be exported and removed. Opens reviews.db read-only; writes nothing. */
export function planResidue({ arRoot, tables = null }) {
  const db = new Database(reviewsDbPath(arRoot), { readonly: true, fileMustExist: true });
  try {
    const selected = selectTables(db, tables);
    return {
      dbPath: reviewsDbPath(arRoot),
      tables: selected.tables.map(name => ({
        name,
        rowCount: db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get().n,
      })),
      keptOperatorTables: selected.keptOperatorTables,
      zeroByteDbFiles: listZeroByteDbFiles(arRoot),
      fossilDirs: FOSSIL_DIR_NAMES.map(name => join(arRoot, 'data', name)).filter(path => existsSync(path))
        .map(path => ({ path, files: walkFiles(path).map(file => ({
          path: relative(path, file), bytes: lstatSync(file).size }) ) })),
    };
  } finally {
    db.close();
  }
}

/** Export the plan into archiveDir, then verify it by re-reading. */
export function exportResidue({ arRoot, archiveDir, tables = null, now = new Date() }) {
  if (existsSync(archiveDir) && readdirSync(archiveDir).length) {
    throw new ResidueRefusal('export-directory-not-empty', { archiveDir });
  }
  const db = new Database(reviewsDbPath(arRoot), { readonly: true, fileMustExist: true });
  const manifest = {
    schemaVersion: 1, createdAt: now.toISOString(), dbPath: reviewsDbPath(arRoot),
    tables: [], zeroByteDbFiles: listZeroByteDbFiles(arRoot), fossilDirs: [],
  };
  try {
    const selected = selectTables(db, tables);
    mkdirSync(archiveDir, { recursive: true, mode: 0o750 });
    // One read transaction: every CSV is the same snapshot.
    db.transaction(() => {
      for (const name of selected.tables) {
        const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
        const { columns, csv, rowCount } = tableCsv(db, name);
        const csvPath = join(archiveDir, `${name}.csv`);
        writeFileSync(csvPath, csv, { mode: 0o640, flag: 'wx' });
        manifest.tables.push({ name, sql, columns, rowCount, csv: `${name}.csv`, sha256: sha256File(csvPath),
          bytes: Buffer.byteLength(csv) });
      }
    })();
  } finally {
    db.close();
  }
  for (const name of FOSSIL_DIR_NAMES) {
    const source = join(arRoot, 'data', name);
    if (!existsSync(source)) continue;
    const files = [];
    for (const file of walkFiles(source)) {
      const rel = relative(source, file);
      const target = join(archiveDir, 'files', name, rel);
      mkdirSync(dirname(target), { recursive: true, mode: 0o750 });
      copyFileSync(file, target);
      files.push({ path: rel, sha256: sha256File(file), bytes: lstatSync(file).size });
    }
    manifest.fossilDirs.push({ path: source, archive: join('files', name), files });
  }
  writeFileSync(join(archiveDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
  return { manifest, verification: verifyExport({ archiveDir }) };
}

/**
 * Re-read an export. Without `arRoot` it checks the archive against its own
 * manifest; with `arRoot` it also checks the live tables and fossil files
 * still match what was exported, which is what drop requires.
 */
export function verifyExport({ archiveDir, arRoot = null }) {
  const manifestPath = join(archiveDir, MANIFEST);
  if (!existsSync(manifestPath)) throw new ResidueRefusal('no-export-manifest', { archiveDir });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const table of manifest.tables) {
    const reason = residueTableRefusal(table.name);
    if (reason) throw new ResidueRefusal(reason, { table: table.name });
    const csvPath = join(archiveDir, table.csv);
    if (!existsSync(csvPath)) throw new ResidueRefusal('export-csv-missing', { table: table.name });
    if (sha256File(csvPath) !== table.sha256) throw new ResidueRefusal('export-sha256-mismatch', { table: table.name });
    if (countCsvRecords(readFileSync(csvPath, 'utf8')) - 1 !== table.rowCount) {
      throw new ResidueRefusal('export-row-count-mismatch', { table: table.name });
    }
  }
  for (const dir of manifest.fossilDirs) {
    for (const file of dir.files) {
      const copy = join(archiveDir, dir.archive, file.path);
      if (!existsSync(copy) || sha256File(copy) !== file.sha256) {
        throw new ResidueRefusal('export-file-copy-mismatch', { path: join(dir.path, file.path) });
      }
    }
  }
  if (arRoot) {
    const db = new Database(reviewsDbPath(arRoot), { readonly: true, fileMustExist: true });
    try {
      for (const table of manifest.tables) {
        const live = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table.name);
        if (!live) throw new ResidueRefusal('table-not-found', { table: table.name });
        if (tableCsv(db, table.name).csv !== readFileSync(join(archiveDir, table.csv), 'utf8')) {
          throw new ResidueRefusal('table-changed-since-export', { table: table.name });
        }
      }
    } finally {
      db.close();
    }
    for (const dir of manifest.fossilDirs) {
      const live = existsSync(dir.path) ? walkFiles(dir.path).map(file => relative(dir.path, file)) : [];
      const exported = dir.files.map(file => file.path);
      if (JSON.stringify(live.sort()) !== JSON.stringify([...exported].sort())
        || dir.files.some(file => sha256File(join(dir.path, file.path)) !== file.sha256)) {
        throw new ResidueRefusal('fossil-directory-changed-since-export', { path: dir.path });
      }
    }
  }
  return { verified: true, archiveDir, tables: manifest.tables.map(t => ({ name: t.name, rowCount: t.rowCount })) };
}

/** Drop only what a verified export covers; refuse everything before mutating. */
export function dropResidue({ arRoot, archiveDir }) {
  const verification = verifyExport({ archiveDir, arRoot });
  const manifest = JSON.parse(readFileSync(join(archiveDir, MANIFEST), 'utf8'));
  for (const path of manifest.zeroByteDbFiles) {
    if (path === reviewsDbPath(arRoot)) throw new ResidueRefusal('refusing-live-reviews-db', { path });
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== 0) throw new ResidueRefusal('refusing-non-empty-db', { path, bytes: stat.size });
  }
  const db = new Database(reviewsDbPath(arRoot), { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    db.transaction(() => {
      for (const table of manifest.tables) db.exec(`DROP TABLE ${quoteIdent(table.name)}`);
    })();
  } finally {
    db.close();
  }
  const removedFiles = [];
  const skippedFiles = [];
  for (const path of manifest.zeroByteDbFiles) {
    if (!existsSync(path)) continue;
    // Re-checked at removal: a file written since the pre-check is kept.
    if (lstatSync(path).size !== 0) { skippedFiles.push(path); continue; }
    unlinkSync(path);
    removedFiles.push(path);
  }
  const removedDirs = [];
  for (const dir of manifest.fossilDirs) {
    if (!existsSync(dir.path)) continue;
    rmSync(dir.path, { recursive: true });
    removedDirs.push(dir.path);
  }
  return { ...verification, droppedTables: manifest.tables.map(t => t.name), removedFiles, skippedFiles, removedDirs };
}
