import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createEmptySqliteDb, createSessionLedgerDb } from './helpers/session-ledger-fixtures.mjs';
import {
  readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPr,
  readLatestWorkerRunStatusFromLedger,
  readReviewerSessionUsageFromLedger,
  readWorkerRunUsageFromLedger,
  resolveSessionLedgerReadTarget,
} from '../src/session-ledger-read-adapter.mjs';

const HERMETIC_CONFIG_ENV = { AGENT_OS_CONFIG_PATH: '/dev/null' };

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'session-ledger-adapter-'));
}

test('resolveSessionLedgerReadTarget accepts backend-neutral explicit sqlite and postgres targets', () => {
  const sqlite = resolveSessionLedgerReadTarget({
    ledgerTarget: { backend: 'sqlite', path: '/tmp/ledger.db' },
    env: HERMETIC_CONFIG_ENV,
  });
  const postgres = resolveSessionLedgerReadTarget({
    env: {
      ...HERMETIC_CONFIG_ENV,
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

test('resolveSessionLedgerReadTarget lets an explicit sqlite target override postgres configuration', () => {
  const result = resolveSessionLedgerReadTarget({
    ledgerTarget: { backend: 'sqlite', path: '/tmp/manual-ledger.db' },
    env: {
      ...HERMETIC_CONFIG_ENV,
      AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.backend, 'sqlite');
  assert.match(result.target.path, /manual-ledger\.db$/);
  assert.equal(result.target.source, 'explicit-ledger-target');
});

test('resolveSessionLedgerReadTarget keeps --ledger-db compatibility as a deprecated alias', () => {
  const result = resolveSessionLedgerReadTarget({
    ledgerDbPath: '/tmp/legacy-ledger.db',
    env: HERMETIC_CONFIG_ENV,
  });
  assert.equal(result.ok, true);
  assert.equal(result.target.backend, 'sqlite');
  assert.equal(result.target.deprecatedAlias, true);
  assert.match(result.target.path, /legacy-ledger\.db$/);
});

test('resolveSessionLedgerReadTarget fails loud when postgres config would resolve a sqlite alias', () => {
  const result = resolveSessionLedgerReadTarget({
    ledgerDbPath: '/tmp/legacy-ledger.db',
    env: {
      ...HERMETIC_CONFIG_ENV,
      AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'postgres-configured-but-sqlite-resolved');
  assert.equal(result.configuredBackend, 'postgres');
  assert.equal(result.target.backend, 'sqlite');
  assert.match(result.target.path, /legacy-ledger\.db$/);
  assert.match(result.detail, /session_ledger\.backend=postgres/);
  assert.match(result.detail, /legacy-ledger\.db/);
});

test('resolveSessionLedgerReadTarget preserves sqlite alias behavior when sqlite backend is configured', () => {
  const result = resolveSessionLedgerReadTarget({
    ledgerDbPath: '/tmp/legacy-ledger.db',
    env: {
      ...HERMETIC_CONFIG_ENV,
      AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.backend, 'sqlite');
  assert.equal(result.target.deprecatedAlias, true);
  assert.match(result.target.path, /legacy-ledger\.db$/);
});

test('resolveSessionLedgerReadTarget fails explicitly for missing or malformed targets', () => {
  const missing = resolveSessionLedgerReadTarget({
    env: {
      ...HERMETIC_CONFIG_ENV,
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

test('resolveSessionLedgerReadTarget skips earlier sqlite stub candidates that do not contain session-ledger tables', () => {
  const rootDir = tempRoot();
  const deployCheckout = tempRoot();
  const homeDir = tempRoot();
  const stubLedger = path.join(deployCheckout, '.agent-os', 'session-ledger', 'ledger.db');
  const runtimeLedger = path.join(homeDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.dirname(stubLedger), { recursive: true });
  createEmptySqliteDb(stubLedger);
  createSessionLedgerDb(runtimeLedger, { runtimeSessions: [], workerRuns: [] });

  const result = resolveSessionLedgerReadTarget({
    requiredTables: ['runtime_sessions'],
    env: {
      ...HERMETIC_CONFIG_ENV,
      AGENT_OS_DEPLOY_CHECKOUT: deployCheckout,
      HOME: homeDir,
    },
    rootDir,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.path, runtimeLedger);
  assert.equal(result.target.source, 'roots.runtime_home');
});

test('resolveSessionLedgerReadTarget keeps env sqlite overrides independent from config parse failures', () => {
  const invalidConfigPath = path.join(tempRoot(), 'config.local.yaml');
  writeFileSync(invalidConfigPath, 'session_ledger: [\n');

  const result = resolveSessionLedgerReadTarget({
    env: {
      AGENT_OS_CONFIG_PATH: invalidConfigPath,
      AGENT_OS_SESSION_LEDGER_DB_PATH: '/tmp/env-ledger.db',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.backend, 'sqlite');
  assert.match(result.target.path, /env-ledger\.db$/);
  assert.equal(result.target.source, 'env:AGENT_OS_SESSION_LEDGER_DB_PATH');
});

test('resolveSessionLedgerReadTarget falls through env sqlite stubs that lack required tables', () => {
  const rootDir = tempRoot();
  const homeDir = tempRoot();
  const stubLedger = path.join(rootDir, 'env-stub.db');
  const runtimeLedger = path.join(homeDir, '.agent-os', 'session-ledger', 'ledger.db');
  createEmptySqliteDb(stubLedger);
  createSessionLedgerDb(runtimeLedger, { runtimeSessions: [], workerRuns: [] });

  const result = resolveSessionLedgerReadTarget({
    requiredTables: ['worker_runs'],
    env: {
      ...HERMETIC_CONFIG_ENV,
      AGENT_OS_SESSION_LEDGER_DB_PATH: stubLedger,
      HOME: homeDir,
    },
    rootDir: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.path, runtimeLedger);
  assert.equal(result.target.source, 'roots.runtime_home');
});

test('resolveSessionLedgerReadTarget falls through stale legacy HQ ledgerDbPath values', () => {
  const rootDir = tempRoot();
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  const homeDir = path.join(rootDir, 'runtime-home');
  const staleLegacyLedger = path.join(rootDir, 'stale-legacy.db');
  const runtimeLedger = path.join(homeDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(
    path.join(hqRoot, '.hq', 'config.json'),
    JSON.stringify({ ledgerDbPath: staleLegacyLedger }),
    'utf8',
  );
  createEmptySqliteDb(staleLegacyLedger);
  createSessionLedgerDb(runtimeLedger, { runtimeSessions: [], workerRuns: [] });

  const result = resolveSessionLedgerReadTarget({
    requiredTables: ['worker_runs'],
    env: {
      ...HERMETIC_CONFIG_ENV,
      HQ_ROOT: hqRoot,
      HOME: homeDir,
    },
    rootDir: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.path, runtimeLedger);
  assert.equal(result.target.source, 'roots.runtime_home');
});

test('readLatestWorkerRunStatusFromLedger keeps sqlite reads bounded to the newest timestamped row', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  const db = new Database(ledgerDb);
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
       token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wr_old', 'lrq_1', 'rs_1', 'running', 1, 2, 0.1, 'session-ledger', '2026-06-04T00:00:00.000Z', null, '2026-06-04T00:03:00.000Z');
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
       token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wr_new', 'lrq_1', 'rs_2', 'cancelled', 3, 4, 0.2, 'session-ledger', '2026-06-04T00:04:00.000Z', null, null);
  db.close();

  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_1',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.run_id, 'wr_new');
  assert.equal(result.row.status, 'cancelled');
});

test('readLatestWorkerRunStatusFromLedger breaks timestamp ties deterministically without sqlite rowid ordering', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  const db = new Database(ledgerDb);
  for (const [runId, status] of [['wr_a', 'running'], ['wr_z', 'succeeded']]) {
    db.prepare(
      `INSERT INTO worker_runs (
         run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
         token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(runId, 'lrq_tie', 'rs_1', status, 1, 2, 0.1, 'session-ledger', '2026-06-04T00:00:00.000Z', null, null);
  }
  db.close();

  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_tie',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.run_id, 'wr_z');
  assert.equal(result.row.status, 'succeeded');
});

test('readLatestWorkerRunStatusFromLedger uses the canonical postgres reader path with deterministic ordering', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: (command, args, options) => {
      assert.equal(command, 'psql');
      assert.ok(args.includes('postgres://ledger.example/agent_os_ledger'));
      assert.ok(args.includes('-v'));
      assert.ok(args.includes('lrq=lrq_pg'));
      const sql = String(options.input);
      assert.match(sql, /\\set lrq 'lrq_pg'/);
      assert.match(sql, /FROM worker_runs/);
      assert.match(sql, /WHERE launch_request_id = :'lrq'/);
      assert.match(sql, /ORDER BY COALESCE\(updated_at::text, ended_at::text, started_at::text, ''\) DESC/);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.killSignal, 'SIGKILL');
      return {
        status: 0,
        stdout: '{"run_id":"wr_pg","launch_request_id":"lrq_pg","status":"cancelled","updated_at":"2026-06-04T00:04:00.000Z","ended_at":null,"started_at":"2026-06-04T00:00:00.000Z"}\n',
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.run_id, 'wr_pg');
  assert.equal(result.row.status, 'cancelled');
  assert.equal(result.target.backend, 'postgres');
});

test('readLatestWorkerRunStatusFromLedger strips a password-bearing postgres DSN out of argv', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger-user:s3cret@ledger.example/agent_os_ledger' },
    spawnSyncImpl: (_command, args, options) => {
      assert.ok(args.includes('postgres://ledger-user@ledger.example/agent_os_ledger'));
      assert.ok(!args.some((arg) => String(arg).includes('s3cret')));
      assert.equal(options.env.PGPASSWORD, 's3cret');
      return {
        status: 0,
        stdout: '{"run_id":"wr_pg","launch_request_id":"lrq_pg","status":"cancelled","updated_at":"2026-06-04T00:04:00.000Z","ended_at":null,"started_at":"2026-06-04T00:00:00.000Z"}\n',
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
});

test('readLatestWorkerRunStatusFromLedger strips a password-bearing libpq DSN out of argv', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: {
      backend: 'postgres',
      dsn: "host=ledger.example user=ledger-user password='s3 cret' dbname=agent_os_ledger",
    },
    spawnSyncImpl: (_command, args, options) => {
      assert.ok(args.includes('host=ledger.example user=ledger-user dbname=agent_os_ledger'));
      assert.ok(!args.some((arg) => String(arg).includes('s3 cret')));
      assert.equal(options.env.PGPASSWORD, 's3 cret');
      return {
        status: 0,
        stdout: '{"run_id":"wr_pg","launch_request_id":"lrq_pg","status":"cancelled","updated_at":"2026-06-04T00:04:00.000Z","ended_at":null,"started_at":"2026-06-04T00:00:00.000Z"}\n',
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
});

test('readLatestWorkerRunStatusFromLedger supports databaseName-only postgres targets', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: { backend: 'postgres', databaseName: 'agent_os_ledger' },
    spawnSyncImpl: (_command, args, options) => {
      assert.deepEqual(args.slice(0, 3), ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1']);
      assert.ok(args.includes('-d'));
      assert.ok(args.includes('agent_os_ledger'));
      assert.ok(!args.some((arg) => String(arg).startsWith('postgres://')));
      assert.notEqual(options.env, process.env);
      return {
        status: 0,
        stdout: '{"run_id":"wr_pg","launch_request_id":"lrq_pg","status":"succeeded","updated_at":"2026-06-04T00:04:00.000Z","ended_at":null,"started_at":"2026-06-04T00:00:00.000Z"}\n',
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.status, 'succeeded');
});

test('readLatestWorkerRunStatusFromLedger reports unparseable psql stdout with context', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: () => ({
      status: 0,
      stdout: 'NOTICE: extension already exists\n{"run_id":"wr_pg"}\n',
      stderr: '',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ledger-read-failed');
  assert.match(result.detail, /unparseable psql stdout/);
  assert.match(result.detail, /NOTICE: extension already exists/);
});

test('readLatestWorkerRunStatusFromLedger fails closed when psql is terminated by signal', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: () => ({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ledger-read-failed');
  assert.match(result.detail, /SIGKILL/);
});

test('readLatestWorkerRunStatusFromLedger returns a timeout failure when psql exceeds the spawn timeout', () => {
  const result = readLatestWorkerRunStatusFromLedger({
    launchRequestId: 'lrq_pg',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: () => ({
      status: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ledger-read-failed');
  assert.match(result.detail, /timed out after 30000ms/);
});

test('readBuildCompletionSignalForPr reads the newest merged signal for a PR', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  const db = new Database(ledgerDb);
  db.exec(`
    CREATE TABLE build_completions (
      completion_id TEXT PRIMARY KEY,
      ticket_id TEXT,
      launch_request_id TEXT,
      dagrun_id TEXT,
      dagrun_step_ticket_id TEXT,
      repo TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      head_sha TEXT,
      branch TEXT,
      worker_class TEXT,
      signal_kind TEXT NOT NULL,
      spec_ref TEXT,
      source TEXT,
      recorded_at TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT INTO build_completions (
       completion_id, ticket_id, launch_request_id, dagrun_id, dagrun_step_ticket_id,
       repo, pr_number, pr_url, head_sha, branch, worker_class, signal_kind,
       spec_ref, source, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'bcmp_old', 'SSG-06', 'lrq_old', 'dagrun_1', 'SSG-06',
    'acme/myrepo', 1234, 'https://github.com/acme/myrepo/pull/1234',
    'a'.repeat(40), null, 'merge-agent', 'merged', 'spec@old', 'live',
    '2026-06-20T10:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO build_completions (
       completion_id, ticket_id, launch_request_id, dagrun_id, dagrun_step_ticket_id,
       repo, pr_number, pr_url, head_sha, branch, worker_class, signal_kind,
       spec_ref, source, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'bcmp_new', 'SSG-06', 'lrq_new', 'dagrun_2', 'SSG-06',
    'acme/myrepo', 1234, 'https://github.com/acme/myrepo/pull/1234',
    'b'.repeat(40), null, 'hammer', 'merged', 'spec@new', 'live',
    '2026-06-20T11:00:00.000Z',
  );
  db.close();

  const result = readBuildCompletionSignalForPr({
    repo: 'acme/myrepo',
    prNumber: 1234,
    signalKind: 'merged',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.completion_id, 'bcmp_new');
  assert.equal(result.row.signal_kind, 'merged');

  const headScoped = readBuildCompletionSignalForPr({
    repo: 'acme/myrepo',
    prNumber: 1234,
    headSha: 'a'.repeat(40),
    signalKind: 'merged',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(headScoped.ok, true);
  assert.equal(headScoped.row.completion_id, 'bcmp_old');

  const missingHead = readBuildCompletionSignalForPr({
    repo: 'acme/myrepo',
    prNumber: 1234,
    headSha: 'c'.repeat(40),
    signalKind: 'merged',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(missingHead.ok, false);
  assert.equal(missingHead.reason, 'missing-build-completion-signal');
});

test('readBuildCompletionProducerEvidence proves repo-level merged-signal producer presence', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  const db = new Database(ledgerDb);
  db.exec(`
    CREATE TABLE build_completions (
      completion_id TEXT PRIMARY KEY,
      ticket_id TEXT,
      launch_request_id TEXT,
      dagrun_id TEXT,
      dagrun_step_ticket_id TEXT,
      repo TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      head_sha TEXT,
      branch TEXT,
      worker_class TEXT,
      signal_kind TEXT NOT NULL,
      spec_ref TEXT,
      source TEXT,
      recorded_at TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT INTO build_completions (
       completion_id, ticket_id, launch_request_id, dagrun_id, dagrun_step_ticket_id,
       repo, pr_number, pr_url, head_sha, branch, worker_class, signal_kind,
       spec_ref, source, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'bcmp_repo', 'SSG-06', 'lrq_repo', 'dagrun_1', 'SSG-06',
    'acme/myrepo', 1200, 'https://github.com/acme/myrepo/pull/1200',
    'd'.repeat(40), null, 'ama', 'merged', 'spec@repo', 'live',
    '2026-06-20T09:00:00.000Z',
  );
  db.close();

  const present = readBuildCompletionProducerEvidence({
    repo: 'acme/myrepo',
    signalKind: 'merged',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });
  assert.equal(present.ok, true);
  assert.equal(present.row.completion_id, 'bcmp_repo');

  const absent = readBuildCompletionProducerEvidence({
    repo: 'acme/otherrepo',
    signalKind: 'merged',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.reason, 'missing-build-completion-producer-evidence');
});

test('readBuildCompletionSignalForPr uses the canonical postgres reader path', () => {
  const result = readBuildCompletionSignalForPr({
    repo: 'acme/myrepo',
    prNumber: 1234,
    signalKind: 'merged',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: (command, args, options) => {
      assert.equal(command, 'psql');
      assert.ok(args.includes('postgres://ledger.example/agent_os_ledger'));
      const sql = String(options.input);
      assert.match(sql, /\\set repo 'acme\/myrepo'/);
      assert.match(sql, /\\set pr_number '1234'/);
      assert.match(sql, /\\set head_sha ''/);
      assert.match(sql, /\\set signal_kind 'merged'/);
      assert.match(sql, /FROM build_completions/);
      assert.match(sql, /WHERE repo = :'repo'/);
      assert.match(sql, /AND pr_number = :'pr_number'::integer/);
      assert.match(sql, /AND \(:'head_sha' = '' OR head_sha = :'head_sha'\)/);
      return {
        status: 0,
        stdout: '{"completion_id":"bcmp_pg","repo":"acme/myrepo","pr_number":1234,"signal_kind":"merged","recorded_at":"2026-06-20T11:00:00.000Z"}\n',
        stderr: '',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.completion_id, 'bcmp_pg');
});

test('readReviewerSessionUsageFromLedger keeps runtime_sessions lookups bounded to the newest row', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  const db = new Database(ledgerDb);
  db.prepare(
    `INSERT INTO runtime_sessions (
       session_id, adapter_session_key, total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
       source_path, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('rs_old', 'session-1', 10, 11, 1, 2, 0.1, '/tmp/review-workspace', '2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z');
  db.prepare(
    `INSERT INTO runtime_sessions (
       session_id, adapter_session_key, total_input_tokens, total_output_tokens,
       total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
       source_path, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('rs_new', 'session-1', 20, 21, 3, 4, 0.2, '/tmp/review-workspace', '2026-06-04T00:00:00.000Z', '2026-06-04T00:02:00.000Z');
  db.close();

  const result = readReviewerSessionUsageFromLedger({
    adapterSessionKey: 'session-1',
    workspacePath: '/tmp/review-workspace',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.session_id, 'rs_new');
  assert.equal(result.row.total_input_tokens, 20);
});

test('adapter exposes the same ledger target contract to worker-run and runtime-session readers', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
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
  const workerUsage = readWorkerRunUsageFromLedger({
    workerRunId: 'wr_1',
    ledgerTarget,
    env: HERMETIC_CONFIG_ENV,
  });
  const sessionUsage = readReviewerSessionUsageFromLedger({
    adapterSessionKey: 'session-1',
    workspacePath: '/tmp/review-workspace',
    startedAt: '2026-06-04T00:00:00.000Z',
    endedAt: '2026-06-04T00:02:00.000Z',
    ledgerTarget,
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(workerUsage.ok, true);
  assert.equal(workerUsage.target.path, ledgerDb);
  assert.equal(workerUsage.row.token_usage_guardrail, null);
  assert.equal(sessionUsage.ok, true);
  assert.equal(sessionUsage.target.path, ledgerDb);
});

test('readWorkerRunUsageFromLedger treats historical sqlite ledgers without guardrail column as null guardrail usage', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  mkdirSync(path.dirname(ledgerDb), { recursive: true });
  const db = new Database(ledgerDb);
  db.exec(`
    CREATE TABLE runtime_sessions (
      session_id TEXT PRIMARY KEY,
      total_cache_read_tokens INTEGER,
      total_cache_write_tokens INTEGER
    );
    CREATE TABLE worker_runs (
      run_id TEXT PRIMARY KEY,
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
  db.prepare(
    `INSERT INTO runtime_sessions (
       session_id, total_cache_read_tokens, total_cache_write_tokens
     ) VALUES (?, ?, ?)`
  ).run('rs_old', 3, 2);
  db.prepare(
    `INSERT INTO worker_runs (
       run_id, launch_request_id, session_id, status, token_usage_input, token_usage_output,
       token_usage_cost_usd, token_usage_source, started_at, ended_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('wr_old', 'lrq_old', 'rs_old', 'succeeded', 10, 4, 0.05, 'session-ledger', '2026-06-04T00:00:00.000Z', '2026-06-04T00:01:00.000Z', '2026-06-04T00:01:00.000Z');
  db.close();

  const result = readWorkerRunUsageFromLedger({
    workerRunId: 'wr_old',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(result.ok, true);
  assert.equal(result.row.run_id, 'wr_old');
  assert.equal(result.row.token_usage_input, 10);
  assert.equal(result.row.token_usage_output, 4);
  assert.equal(result.row.token_usage_guardrail, null);
  assert.equal(result.row.total_cache_read_tokens, 3);
  assert.equal(result.row.total_cache_write_tokens, 2);
});
