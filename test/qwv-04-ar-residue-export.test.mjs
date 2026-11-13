// QWV-04: the reviews.db residue export is dry-run by default, verifies by
// re-reading, and drops nothing without a verified export.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { main } from '../bin/ar-residue-export.mjs';
import { countCsvRecords, residueTableRefusal, verifyExport } from '../src/ar-residue.mjs';

const STAMPED = 'operator_reviewer_pass_reset_20260727T062342Z';
const STAMPED_2 = 'operator_20260727T0902_review_flow_rearm_reviewed_prs';
const LIVE_OPERATOR = 'operator_hold_releases';
const FOSSIL = 'follow-export HAM_RUN_DIR=';
const NOW = new Date('2026-11-13T01:02:03.000Z');

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'qwv04-residue-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const arRoot = join(base, 'ar');
  const hqRoot = join(base, 'hq');
  mkdirSync(join(arRoot, 'data', FOSSIL, 'nested'), { recursive: true });
  mkdirSync(hqRoot);
  const db = new Database(join(arRoot, 'data', 'reviews.db'));
  db.exec(`CREATE TABLE reviewer_passes (pass_id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE ${LIVE_OPERATOR} (id INTEGER PRIMARY KEY, note TEXT);
    CREATE TABLE ${STAMPED} (pass_id INTEGER, status TEXT, note TEXT, cost REAL);
    CREATE TABLE ${STAMPED_2} (id INTEGER, body TEXT);
    INSERT INTO reviewer_passes VALUES (1, 'failed');
    INSERT INTO ${LIVE_OPERATOR} VALUES (1, 'live');`);
  const insert = db.prepare(`INSERT INTO ${STAMPED} VALUES (?, ?, ?, ?)`);
  insert.run(1, 'failed', 'comma, "quote"\nnewline', 0.25);
  insert.run(2, 'running', null, null);
  insert.run(3, '', '', 1);
  db.prepare(`INSERT INTO ${STAMPED_2} VALUES (?, ?)`).run(7, 'x');
  db.close();
  for (const name of ['reviewer-passes.db', 'state.db', 'reviews.sqlite']) writeFileSync(join(arRoot, 'data', name), '');
  writeFileSync(join(arRoot, 'reviews.db'), '');
  writeFileSync(join(arRoot, 'data', 'not-a-db.txt'), '');
  writeFileSync(join(arRoot, 'data', FOSSIL, 'nested', 'controller.json'), '{"quiescent":true}\n');
  return { arRoot, hqRoot, archiveDir: join(hqRoot, 'archive', 'ar-residue', '2026-11-13') };
}

function run(fx, args) {
  return main(['--root-dir', fx.arRoot, '--hq-root', fx.hqRoot, ...args], { env: {}, now: NOW, print: () => {} });
}

function tables(arRoot) {
  const db = new Database(join(arRoot, 'data', 'reviews.db'), { readonly: true });
  try {
    return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
  } finally {
    db.close();
  }
}

function snapshot(dir) {
  return readdirSync(dir, { recursive: true }).sort()
    .map(name => [name, statSync(join(dir, name)).size, statSync(join(dir, name)).mtimeMs]);
}

test('table names: only stamped operator_* tables are residue', () => {
  // The stamp forms the 07-27 hand repairs used: leading, middle and trailing.
  for (const name of [STAMPED, STAMPED_2, 'operator_20260727T0902_review_flow_rearm_reviewed_prs',
    'operator_review_flow_repair_20260727T0713_reviewer_passes',
    'operator_reviewer_pass_stale_archive_20260727T0649_stale_4318']) {
    assert.equal(residueTableRefusal(name), null, name);
  }
  for (const name of ['operator_hold_releases', 'operator_pr_20260727', 'operator_x_20260727T09',
    'operator_a20260727T0902', 'operator_x-20260727T0902']) {
    assert.equal(residueTableRefusal(name), 'operator-table-without-repair-stamp', name);
  }
  assert.equal(residueTableRefusal('reviewer_passes'), 'not-an-operator-table');
  assert.equal(residueTableRefusal(LIVE_OPERATOR), 'operator-table-without-repair-stamp');
  assert.equal(countCsvRecords('a,b\n"x\ny",1\n'), 2);
});

test('dry-run lists tables, zero-byte DBs and the fossil directory and writes nothing', t => {
  const fx = fixture(t);
  const before = { ar: snapshot(fx.arRoot), hq: snapshot(fx.hqRoot) };
  const plan = run(fx, []);
  assert.equal(plan.mode, 'dry-run');
  assert.deepEqual(plan.tables, [{ name: STAMPED_2, rowCount: 1 }, { name: STAMPED, rowCount: 3 }]);
  assert.deepEqual(plan.keptOperatorTables, [LIVE_OPERATOR]);
  assert.deepEqual(plan.zeroByteDbFiles, [
    join(fx.arRoot, 'data', 'reviewer-passes.db'), join(fx.arRoot, 'data', 'reviews.sqlite'),
    join(fx.arRoot, 'data', 'state.db'), join(fx.arRoot, 'reviews.db'),
  ]);
  assert.deepEqual(plan.fossilDirs, [{ path: join(fx.arRoot, 'data', FOSSIL),
    files: [{ path: join('nested', 'controller.json'), bytes: 19 }] }]);
  assert.deepEqual({ ar: snapshot(fx.arRoot), hq: snapshot(fx.hqRoot) }, before);
});

test('export writes CSV + manifest, verifies by re-reading, and drop then removes only the verified residue', t => {
  const fx = fixture(t);
  const exported = run(fx, ['--execute']);
  assert.equal(exported.mode, 'export');
  assert.equal(exported.verification.verified, true);
  const manifest = JSON.parse(readFileSync(join(fx.archiveDir, 'manifest.json'), 'utf8'));
  const table = manifest.tables.find(entry => entry.name === STAMPED);
  assert.equal(table.rowCount, 3);
  assert.match(table.sha256, /^[0-9a-f]{64}$/);
  assert.match(table.sql, /^CREATE TABLE operator_reviewer_pass_reset_/);
  const csv = readFileSync(join(fx.archiveDir, `${STAMPED}.csv`), 'utf8');
  assert.equal(csv, 'pass_id,status,note,cost\n1,failed,"comma, ""quote""\nnewline",0.25\n2,running,,\n3,"","",1\n');
  assert.equal(readFileSync(join(fx.archiveDir, 'files', FOSSIL, 'nested', 'controller.json'), 'utf8'),
    '{"quiescent":true}\n');
  assert.deepEqual(tables(fx.arRoot), [STAMPED_2, LIVE_OPERATOR, STAMPED, 'reviewer_passes'].sort());

  assert.equal(run(fx, ['--execute']).refused, 'export-directory-not-empty');
  const dropped = run(fx, ['--execute', '--drop']);
  assert.equal(dropped.refused, undefined, JSON.stringify(dropped));
  assert.deepEqual(tables(fx.arRoot), [LIVE_OPERATOR, 'reviewer_passes'].sort());
  assert.equal(dropped.removedFiles.length, 4);
  assert.equal(existsSync(join(fx.arRoot, 'data', FOSSIL)), false);
  assert.equal(existsSync(join(fx.arRoot, 'data', 'not-a-db.txt')), true);
  assert.equal(existsSync(join(fx.arRoot, 'data', 'reviews.db')), true);
});

test('refuses non-operator and live operator tables, and any drop without a verified export', t => {
  const fx = fixture(t);
  assert.equal(run(fx, ['--table', 'reviewer_passes']).refused, 'not-an-operator-table');
  assert.equal(run(fx, ['--execute', '--table', LIVE_OPERATOR]).refused, 'operator-table-without-repair-stamp');
  assert.equal(run(fx, ['--table', 'operator_missing_20260101T000000Z']).refused, 'table-not-found');
  assert.equal(existsSync(fx.archiveDir), false, 'refused export writes nothing');
  assert.equal(run(fx, ['--execute', '--drop']).refused, 'no-export-manifest');
  assert.throws(() => run(fx, ['--drop']), /--drop requires --execute/);
  assert.throws(() => main(['--root-dir', fx.arRoot, '--execute'], { env: {}, now: NOW, print: () => {} }),
    /HQ_ROOT/);
  assert.equal(tables(fx.arRoot).length, 4);
});

test('drop resumes after an I/O failure following committed table drops and partial fossil removal', t => {
  const fx = fixture(t);
  const fossil = join(fx.arRoot, 'data', FOSSIL);
  const firstFile = join(fossil, 'nested', 'controller.json');
  writeFileSync(join(fossil, 'remaining.json'), '{"remaining":true}\n');
  assert.equal(run(fx, ['--execute']).verification.verified, true);
  const realRm = fs.rmSync;
  const removal = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path !== fossil) return realRm(path, options);
    realRm(firstFile);
    throw Object.assign(new Error('simulated partial removal failure'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => run(fx, ['--execute', '--drop']), /simulated partial removal failure/);
  } finally {
    removal.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(tables(fx.arRoot), [LIVE_OPERATOR, 'reviewer_passes'].sort());
  assert.equal(existsSync(firstFile), false);
  assert.equal(existsSync(join(fossil, 'remaining.json')), true);
  assert.equal(existsSync(join(fx.arRoot, 'data', 'state.db')), false);
  assert.throws(() => verifyExport({ archiveDir: fx.archiveDir, arRoot: fx.arRoot }), /table-not-found/);
  assert.equal(run(fx, ['--execute', '--drop']).verified, true);
  assert.equal(existsSync(fossil), false);
  assert.equal(run(fx, ['--execute', '--drop']).verified, true, 'completed cleanup is also safe to repeat');
});

test('resumed drop still rejects archive tampering and new or changed live fossil files', t => {
  for (const kind of ['archive', 'changed-file', 'new-file']) {
    const fx = fixture(t);
    assert.equal(run(fx, ['--execute']).verification.verified, true);
    const db = new Database(join(fx.arRoot, 'data', 'reviews.db'));
    db.exec(`DROP TABLE ${STAMPED}; DROP TABLE ${STAMPED_2}`);
    db.close();
    if (kind === 'archive') {
      writeFileSync(join(fx.archiveDir, `${STAMPED}.csv`), 'tampered\n');
    } else {
      const path = kind === 'new-file' ? 'new.json' : join('nested', 'controller.json');
      writeFileSync(join(fx.arRoot, 'data', FOSSIL, path), 'changed');
    }
    const reason = kind === 'archive' ? 'export-sha256-mismatch' : 'fossil-directory-changed-since-export';
    assert.equal(run(fx, ['--execute', '--drop']).refused, reason);
    assert.equal(existsSync(join(fx.arRoot, 'data', 'state.db')), true);
  }
});

test('drop refuses a tampered export, a changed table, a changed fossil and a non-empty DB', t => {
  const cases = [
    ['export-sha256-mismatch', fx => writeFileSync(join(fx.archiveDir, `${STAMPED}.csv`), 'pass_id\n')],
    ['table-changed-since-export', fx => {
      const db = new Database(join(fx.arRoot, 'data', 'reviews.db'));
      db.prepare(`INSERT INTO ${STAMPED} VALUES (4, 'late', NULL, NULL)`).run();
      db.close();
    }],
    ['fossil-directory-changed-since-export', fx => writeFileSync(join(fx.arRoot, 'data', FOSSIL, 'new.json'), '{}')],
    ['refusing-non-empty-db', fx => writeFileSync(join(fx.arRoot, 'data', 'state.db'), 'SQLite format 3\0')],
    ['export-row-count-mismatch', fx => {
      const path = join(fx.archiveDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.tables[0].rowCount += 1;
      writeFileSync(path, JSON.stringify(manifest));
    }],
    ['not-an-operator-table', fx => {
      const path = join(fx.archiveDir, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.tables[0].name = 'reviewer_passes';
      writeFileSync(path, JSON.stringify(manifest));
    }],
  ];
  for (const [reason, tamper] of cases) {
    const fx = fixture(t);
    assert.equal(run(fx, ['--execute']).verification.verified, true);
    tamper(fx);
    assert.equal(run(fx, ['--execute', '--drop']).refused, reason, reason);
    assert.equal(tables(fx.arRoot).length, 4, `${reason}: nothing dropped`);
    assert.equal(existsSync(join(fx.arRoot, 'data', 'reviewer-passes.db')), true, `${reason}: nothing removed`);
  }
});
