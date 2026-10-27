import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workerObservationFixture} from './helpers/worker-observation-fixture.mjs';

test('equal-time fixture processes use descending integer IDs across digit lengths', t => {
  const root = mkdtempSync(join(tmpdir(), 'observation-order-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const path = join(root, 'fixture.db');
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE worker_runs (run_id TEXT,launch_request_id TEXT);
      INSERT INTO worker_runs VALUES ('run','launch');
      CREATE TABLE worker_processes (worker_process_id INTEGER PRIMARY KEY,launch_request_id TEXT,
        updated_at TEXT,pid INTEGER,process_status TEXT);
      INSERT INTO worker_processes VALUES (9,'launch','2026-01-01T00:00:00Z',109,'exited');
      INSERT INTO worker_processes VALUES (10,'launch','2026-01-01T00:00:00Z',110,'running');`);
  } finally { db.close(); }
  const result = workerObservationFixture({observation:'workers', worker_run_id:'run'}, {ledgerDbPath:path});
  assert.equal(result.items[0].pid, 110);
  assert.equal(result.items[0].process_status, 'running');
});
