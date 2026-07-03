import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_RUNTIME_SESSIONS = [
  {
    session_id: 'rs_1',
    adapter_session_key: 'session-1',
    total_input_tokens: 120,
    total_output_tokens: 45,
    total_cache_read_tokens: 11,
    total_cache_write_tokens: 7,
    total_cost_usd: 0.35,
    source_path: '/tmp/review-workspace',
    started_at: '2026-05-18T01:00:00.000Z',
    ended_at: '2026-05-18T01:02:00.000Z',
  },
  {
    session_id: 'rs_2',
    adapter_session_key: 'session-2',
    total_input_tokens: 999,
    total_output_tokens: 333,
    total_cache_read_tokens: 44,
    total_cache_write_tokens: 22,
    total_cost_usd: 1.11,
    source_path: '/tmp/review-workspace',
    started_at: '2026-05-18T03:00:00.000Z',
    ended_at: '2026-05-18T03:05:00.000Z',
  },
];

const DEFAULT_WORKER_RUNS = [
  {
    run_id: 'wr_1',
    launch_request_id: 'lrq_1',
    session_id: 'rs_1',
    status: 'succeeded',
    token_usage_input: 120,
    token_usage_output: 45,
    token_usage_guardrail: 165,
    token_usage_cost_usd: 0.35,
    token_usage_source: 'session-ledger',
    started_at: '2026-05-18T01:00:00.000Z',
    ended_at: '2026-05-18T01:02:00.000Z',
    updated_at: '2026-05-18T01:02:00.000Z',
  },
  {
    run_id: 'wr_2',
    launch_request_id: 'lrq_2',
    session_id: 'rs_2',
    status: 'failed',
    token_usage_input: 999,
    token_usage_output: 333,
    token_usage_guardrail: null,
    token_usage_cost_usd: 1.11,
    token_usage_source: 'session-ledger',
    started_at: '2026-05-18T03:00:00.000Z',
    ended_at: '2026-05-18T03:05:00.000Z',
    updated_at: '2026-05-18T03:05:00.000Z',
  },
  {
    run_id: 'wr_3',
    launch_request_id: 'shared-lrq',
    session_id: 'rs_2',
    status: 'succeeded',
    token_usage_input: 999,
    token_usage_output: 333,
    token_usage_guardrail: null,
    token_usage_cost_usd: 1.11,
    token_usage_source: 'session-ledger',
    started_at: '2026-05-18T03:00:00.000Z',
    ended_at: '2026-05-18T03:05:00.000Z',
    updated_at: '2026-05-18T03:05:00.000Z',
  },
  {
    run_id: 'wr_1_shared',
    launch_request_id: 'shared-lrq-old',
    session_id: 'rs_1',
    status: 'succeeded',
    token_usage_input: 120,
    token_usage_output: 45,
    token_usage_guardrail: 165,
    token_usage_cost_usd: 0.35,
    token_usage_source: 'session-ledger',
    started_at: '2026-05-18T01:00:00.000Z',
    ended_at: '2026-05-18T01:02:00.000Z',
    updated_at: '2026-05-18T01:02:00.000Z',
  },
];

export function createEmptySqliteDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.close();
}

export function createSessionLedgerDb(
  dbPath,
  {
    runtimeSessions = DEFAULT_RUNTIME_SESSIONS,
    workerRuns = DEFAULT_WORKER_RUNS,
    // Production rows are keyed by run_id. Tests that intentionally model
    // historical duplicate rows must opt into the looser fixture schema.
    allowDuplicateWorkerRunIds = false,
  } = {},
) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const runIdConstraint = allowDuplicateWorkerRunIds ? '' : ' PRIMARY KEY';
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
      run_id TEXT${runIdConstraint},
      launch_request_id TEXT,
      session_id TEXT,
      status TEXT,
      token_usage_input INTEGER,
      token_usage_output INTEGER,
      token_usage_guardrail INTEGER,
      token_usage_cost_usd REAL,
      token_usage_source TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT
    );
  `);

  const insertRuntimeSession = db.prepare(
    `INSERT INTO runtime_sessions (
       session_id, adapter_session_key, total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
       source_path, started_at, ended_at
     ) VALUES (
       @session_id, @adapter_session_key, @total_input_tokens, @total_output_tokens,
       @total_cache_read_tokens, @total_cache_write_tokens, @total_cost_usd,
       @source_path, @started_at, @ended_at
     )`
  );
  const insertWorkerRun = db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input,
       token_usage_output, token_usage_guardrail, token_usage_cost_usd, token_usage_source,
       started_at, ended_at, updated_at
     ) VALUES (
       @run_id, @launch_request_id, @session_id, @status, @token_usage_input,
       @token_usage_output, @token_usage_guardrail, @token_usage_cost_usd, @token_usage_source,
       @started_at, @ended_at, @updated_at
     )`
  );

  for (const row of runtimeSessions) insertRuntimeSession.run(row);
  for (const row of workerRuns) {
    insertWorkerRun.run({
      token_usage_guardrail: null,
      ...row,
    });
  }
  db.close();
}

export function reviewerPassTokenReaderFixtures(rootDir) {
  const ledgerDbPath = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDbPath);
  return [
    {
      name: 'explicit sqlite target object',
      apply() {
        return { ledgerTarget: { backend: 'sqlite', path: ledgerDbPath } };
      },
    },
    {
      name: 'explicit sqlite target URI',
      apply() {
        return { ledgerTarget: `sqlite://${ledgerDbPath}` };
      },
    },
    {
      name: 'deprecated --ledger-db alias path',
      apply() {
        return { ledgerDbPath: ledgerDbPath };
      },
    },
  ];
}
