import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  readLatestWorkerRunStatusFromLedger,
  readReviewerSessionUsageFromLedger,
  readWorkerRunUsageFromLedger,
  resolveSessionLedgerReadTarget,
} from '../src/session-ledger-read-adapter.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'session-ledger-adapter-'));
}

function createLedgerDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runtime_sessions (
      session_id TEXT PRIMARY KEY,
      adapter_session_key TEXT,
      total_input_tokens INTEGER,
      total_output_tokens INTEGER,
      total_cache_read_tokens INTEGER,
      total_cache_write_tokens INTEGER,
      total_cost_usd REAL,
      source_path TEXT,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE TABLE worker_runs (
      run_id TEXT,
      launch_request_id TEXT,
      session_id TEXT,
      status TEXT,
      token_usage_input INTEGER,
      token_usage_output INTEGER,
      token_usage_cost_usd REAL,
      token_usage_source TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT
    );
  `);
  db.close();
}

test('resolveSessionLedgerReadTarget accepts backend-neutral explicit sqlite and postgres targets', () => {
  const sqlite = resolveSessionLedgerReadTarget({
    ledgerTarget: { backend: 'sqlite', path: '/tmp/ledger.db' },
  });
  const postgres = resolveSessionLedgerReadTarget({
    env: {
      AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on',
      AGENT_OS_SESSION_LEDGER_DSN: 'postgres://ledger.example/agent_os_ledger',
    },
  });

  assert.equal(sqlite.ok, true);
  assert.equal(sqlite.target.backend, 'sqlite');
  assert.match(sqlite.target.path, /\/tmp\/ledger\.db$/);
  assert.equal(postgres.ok, true);
  assert.equal(postgres.target.backend, 'postgres');
  assert.equal(postgres.target.dsn, 'postgres://ledger.example/agent_os_ledger');
});

test('resolveSessionLedgerReadTarget keeps --ledger-db compatibility as a deprecated alias', () => {
  const result = resolveSessionLedgerReadTarget({ ledgerDbPath: '/tmp/legacy-ledger.db' });
  assert.equal(result.ok, true);
  assert.equal(result.target.backend, 'sqlite');
  assert.equal(result.target.deprecatedAlias, true);
  assert.match(result.target.path, /legacy-ledger\.db$/);
});

test('resolveSessionLedgerReadTarget fails explicitly for missing or malformed targets', () => {
  const missing = resolveSessionLedgerReadTarget({
    env: {
      AGENT_OS_CONFIG_PATH: '/dev/null',
      HOME: tempRoot(),
    },
    rootDir: tempRoot(),
  });
  const malformed = resolveSessionLedgerReadTarget({
    ledgerTarget: { backend: 'postgres' },
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-ledger-target');
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'malformed-ledger-target');
});

test('readLatestWorkerRunStatusFromLedger uses deterministic ordering without rowid', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createLedgerDb(ledgerDb);
  const db = new Database(ledgerDb);
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
       token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wr_old', 'lrq_1', 'rs_1', 'running', 1, 2, 0.1, 'session-ledger', '2026-06-04T00:00:00.000Z', null, '2026-06-04T00:01:00.000Z');
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
       token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wr_new', 'lrq_1', 'rs_2', 'cancelled', 3, 4, 0.2, 'session-ledger', '2026-06-04T00:00:00.000Z', null, '2026-06-04T00:02:00.000Z');
  db.close();

  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_1',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.run_id, 'wr_new');
  assert.equal(result.row.status, 'cancelled');
});

test('adapter exposes the same ledger target contract to worker-run and runtime-session readers', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createLedgerDb(ledgerDb);
  const db = new Database(ledgerDb);
  db.prepare(
    `INSERT INTO runtime_sessions (
       session_id, adapter_session_key, total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
       source_path, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('rs_1', 'session-1', 120, 45, 11, 7, 0.35, '/tmp/review-workspace', '2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z');
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
       token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wr_1', 'lrq_1', 'rs_1', 'succeeded', 120, 45, 0.35, 'session-ledger', '2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z', '2026-06-04T00:01:00.000Z');
  db.close();

  const ledgerTarget = { backend: 'sqlite', path: ledgerDb };
  const workerUsage = readWorkerRunUsageFromLedger({ workerRunId: 'wr_1', ledgerTarget });
  const sessionUsage = readReviewerSessionUsageFromLedger({
    adapterSessionKey: 'session-1',
    workspacePath: '/tmp/review-workspace',
    startedAt: '2026-06-04T00:00:00.000Z',
    endedAt: '2026-06-04T00:02:00.000Z',
    ledgerTarget,
  });

  assert.equal(workerUsage.ok, true);
  assert.equal(workerUsage.target.path, ledgerDb);
  assert.equal(sessionUsage.ok, true);
  assert.equal(sessionUsage.target.path, ledgerDb);
});
