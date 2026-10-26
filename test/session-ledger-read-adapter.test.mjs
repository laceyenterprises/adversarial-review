import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEmptySqliteDb, createSessionLedgerDb } from './helpers/session-ledger-fixtures.mjs';
import {
  LIVE_DAG_RUN_STATES,
  readActiveDagRunsForPlan,
  readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPr,
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

test('resolveSessionLedgerReadTarget lets the canonical target env override postgres configuration', () => {
  const result = resolveSessionLedgerReadTarget({
    env: {
      ...HERMETIC_CONFIG_ENV,
      AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres',
      AGENT_OS_SESSION_LEDGER_TARGET: 'sqlite:///tmp/manual-ledger.db',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.backend, 'sqlite');
  assert.match(result.target.path, /manual-ledger\.db$/);
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

// LAC-2091 (agent-os#9186): a deployed HQ root kept a SQLite-era
// `.hq/config.json` ledgerDbPath pointing at a real but stale ledger.db while
// the host was configured for Postgres. The pointer outranked the configured
// backend, so every implicit read refused `postgres-configured-but-sqlite-resolved`.
const LAC2091_POSTGRES_ENV = {
  ...HERMETIC_CONFIG_ENV,
  AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres',
  AGENT_OS_SESSION_LEDGER_DSN: 'postgres://ledger.example/agent_os_ledger',
};

function staleLegacyHqFixture() {
  const rootDir = tempRoot();
  const hqRoot = path.join(rootDir, 'agent-os-hq');
  const staleLedger = path.join(rootDir, 'stale-legacy.db');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ledgerDbPath: staleLedger }), 'utf8');
  const db = new Database(staleLedger);
  db.exec('CREATE TABLE launch_requests (launch_request_id TEXT, status TEXT, updated_at TEXT, terminal_at TEXT, failure_class TEXT)');
  db.close();
  return { rootDir, hqRoot, staleLedger };
}

test('LAC-2091: configured postgres outranks a stale legacy HQ ledgerDbPath', () => {
  const { hqRoot } = staleLegacyHqFixture();
  for (const env of [
    { ...LAC2091_POSTGRES_ENV, HQ_ROOT: hqRoot },
    { ...HERMETIC_CONFIG_ENV, AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on',
      AGENT_OS_SESSION_LEDGER_DSN: 'postgres://ledger.example/agent_os_ledger', HQ_ROOT: hqRoot },
  ]) {
    const result = resolveSessionLedgerReadTarget({ requiredTables: ['launch_requests'], env });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.target.backend, 'postgres');
    assert.equal(result.target.source, 'config:session_ledger.dsn');
  }
  const viaParam = resolveSessionLedgerReadTarget({ requiredTables: ['launch_requests'], env: LAC2091_POSTGRES_ENV, hqRoot });
  assert.equal(viaParam.ok, true);
  assert.equal(viaParam.target.backend, 'postgres');
});

test('LAC-2091: postgres resolution never reads the legacy HQ config', (t) => {
  const { rootDir, hqRoot } = staleLegacyHqFixture();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const legacyConfigPath = path.join(hqRoot, '.hq', 'config.json');
  const read = fs.readFileSync;
  const legacyReads = [];
  const spy = t.mock.method(fs, 'readFileSync', (...args) => {
    if (String(args[0]) === legacyConfigPath) legacyReads.push(args[0]);
    return read(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const options of [
      { env: { ...LAC2091_POSTGRES_ENV, HQ_ROOT: hqRoot } },
      { env: { ...HERMETIC_CONFIG_ENV, AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'on',
        AGENT_OS_SESSION_LEDGER_DSN: LAC2091_POSTGRES_ENV.AGENT_OS_SESSION_LEDGER_DSN,
        HQ_ROOT: hqRoot } },
      { env: LAC2091_POSTGRES_ENV, hqRoot },
    ]) {
      const result = resolveSessionLedgerReadTarget(options);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.target.backend, 'postgres');
    }
    assert.deepEqual(legacyReads, []);
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('LAC-2091: postgres without a DSN binds the canonical database name, never the legacy sqlite', () => {
  const { hqRoot } = staleLegacyHqFixture();
  const result = resolveSessionLedgerReadTarget({
    requiredTables: ['launch_requests'],
    env: { ...HERMETIC_CONFIG_ENV, AGENT_OS_SESSION_LEDGER_BACKEND: 'postgres', HQ_ROOT: hqRoot },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.target.backend, 'postgres');
  assert.equal(result.target.dsn, null);
  assert.equal(result.target.source, 'config:session_ledger.database_name');
});

test('LAC-2091: the legacy HQ ledgerDbPath is still honored on sqlite deploys', () => {
  const { hqRoot, staleLedger } = staleLegacyHqFixture();
  for (const env of [
    { ...HERMETIC_CONFIG_ENV, HQ_ROOT: hqRoot },
    { ...HERMETIC_CONFIG_ENV, AGENT_OS_SESSION_LEDGER_BACKEND: 'sqlite', HQ_ROOT: hqRoot },
  ]) {
    const result = resolveSessionLedgerReadTarget({ requiredTables: ['launch_requests'], env, rootDir: null });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.target.backend, 'sqlite');
    assert.equal(result.target.path, staleLedger);
    assert.equal(result.target.source, 'legacy-hq-config');
  }
});

test('LAC-2091: explicit targets keep their policy beside a stale legacy HQ ledger under postgres', () => {
  const { hqRoot, staleLedger } = staleLegacyHqFixture();
  const env = { ...LAC2091_POSTGRES_ENV, HQ_ROOT: hqRoot };
  const explicit = resolveSessionLedgerReadTarget({ ledgerTarget: { backend: 'sqlite', path: staleLedger }, env });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.target.backend, 'sqlite');
  assert.equal(explicit.target.source, 'explicit-ledger-target');

  for (const [label, args] of [
    ['deprecated alias', { ledgerDbPath: staleLedger, env }],
    ['env db path', { env: { ...env, AGENT_OS_SESSION_LEDGER_DB_PATH: staleLedger } }],
    ['legacy env db path', { env: { ...env, SESSION_LEDGER_DB_PATH: staleLedger } }],
  ]) {
    const result = resolveSessionLedgerReadTarget({ requiredTables: ['launch_requests'], ...args });
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, 'postgres-configured-but-sqlite-resolved', label);
    assert.equal(result.target.path, staleLedger, label);
  }

  for (const ledgerTarget of [{ backend: 'postgres' }, { backend: 'mysql', path: staleLedger }, '   ']) {
    const result = resolveSessionLedgerReadTarget({ ledgerTarget, env });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed-ledger-target');
  }
  const malformedEnv = resolveSessionLedgerReadTarget({ env: { ...env, AGENT_OS_SESSION_LEDGER_TARGET: '   ' } });
  assert.equal(malformedEnv.ok, false);
  assert.equal(malformedEnv.reason, 'malformed-ledger-target');
});

test('readBuildCompletionSignalForPr reads merge-commit signals without a reviewed-head filter', () => {
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

  // Agent OS writes merge commits into merged.head_sha. The reviewed PR head
  // is a different SHA, so a head-scoped merged lookup must not be used by AMA.
  const reviewedPrHeadLookup = readBuildCompletionSignalForPr({
    repo: 'acme/myrepo',
    prNumber: 1234,
    headSha: 'c'.repeat(40),
    signalKind: 'merged',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });

  assert.equal(reviewedPrHeadLookup.ok, false);
  assert.equal(reviewedPrHeadLookup.reason, 'missing-build-completion-signal');
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
      assert.ok(args.includes('repo=acme/myrepo'));
      assert.doesNotMatch(sql, /\\set/);
      assert.ok(args.includes('pr_number=1234'));
      assert.ok(args.includes('head_sha='));
      assert.ok(args.includes('signal_kind=merged'));
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

test('queryPostgresRows enforces readOnly without variables and preserves the unguarded fast path', async () => {
  // Expose the private helper in a temporary module, without expanding the
  // production adapter's public interface just for this regression test.
  const root = tempRoot();
  try {
    const sourceUrl = new URL('../src/session-ledger-read-adapter.mjs', import.meta.url);
    const source = readFileSync(sourceUrl, 'utf8').replace(
      "'./config-loader.mjs'",
      JSON.stringify(new URL('./config-loader.mjs', sourceUrl).href),
    ).replace("'./watcher-latency.mjs'", JSON.stringify(new URL('./watcher-latency.mjs', sourceUrl).href))
      .replace("'./load-aware-timeout.mjs'", JSON.stringify(new URL('./load-aware-timeout.mjs', sourceUrl).href))
      .replace("'./ama/launch-request-status.mjs'", JSON.stringify(new URL('./ama/launch-request-status.mjs', sourceUrl).href))
      .replace("'./producer-contracts/launch-status.mjs'", JSON.stringify(new URL('./producer-contracts/launch-status.mjs', sourceUrl).href))
      .replace("'./dispatch-read-client.mjs'", JSON.stringify(new URL('./dispatch-read-client.mjs', sourceUrl).href));
    const modulePath = path.join(root, 'adapter.mjs');
    writeFileSync(modulePath, `${source}\nexport { queryPostgresRows, spawnLedgerChild };\n`);
    const { queryPostgresRows, spawnLedgerChild } = await import(pathToFileURL(modulePath).href);
    for (const readOnly of [true, false]) {
      let calls = 0;
      const result = queryPostgresRows(
        { backend: 'postgres', databaseName: 'agent_os_ledger' },
        'SELECT row_to_json(t) FROM dag_runs t;',
        {
          readOnly,
          spawnSyncImpl: (command, args, options) => {
            calls += 1;
            assert.equal(command, 'psql');
            assert.ok(args.includes('ON_ERROR_STOP=1'));
            if (readOnly) {
              assert.ok(args.includes('-q'));
              assert.ok(!args.includes('-c'));
              assert.match(options.input, /^BEGIN READ ONLY;$/m);
              assert.match(options.input, /^COMMIT;$/m);
              assert.match(options.input, /^SELECT row_to_json\(t\) FROM dag_runs t;$/m);
              assert.doesNotMatch(options.input, /\\set/);
            } else {
              assert.ok(!args.includes('-q'));
              assert.equal(args[args.indexOf('-c') + 1], 'SELECT row_to_json(t) FROM dag_runs t;');
              assert.equal(options.input, undefined);
            }
            return { status: 0, stdout: '{"state":"running"}\n', stderr: '' };
          },
        },
      );
      assert.equal(calls, 1);
      assert.equal(result.ok, true);
      assert.deepEqual(result.rows, [{ state: 'running' }]);
    }
    const overflow = await spawnLedgerChild(process.execPath, ['-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024))"], { maxBuffer: 1024 });
    assert.equal(overflow.error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readActiveDagRunsForPlan runs one bounded SELECT inside a read-only transaction on postgres', () => {
  let calls = 0;
  const result = readActiveDagRunsForPlan({
    planId: 'model-efficiency-gym-v1',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: (command, args, options) => {
      calls += 1;
      assert.equal(command, 'psql');
      assert.ok(args.includes('-q'), 'quiet mode keeps BEGIN/COMMIT tags out of the JSON rows');
      const sql = String(options.input);
      assert.ok(args.includes('plan_id=model-efficiency-gym-v1'));
      assert.doesNotMatch(sql, /\\set/);
      assert.match(sql, /^BEGIN READ ONLY;$/m);
      assert.match(sql, /^COMMIT;$/m);
      assert.doesNotMatch(sql, /\bSET\s+(SESSION|default_transaction)/i);
      assert.match(sql, /FROM dag_runs/);
      assert.match(sql, /WHERE plan_id = :'plan_id'/);
      assert.match(sql, /state IN \('pending', 'running', 'parked', 'awaiting-merge'\)/);
      assert.match(sql, /LIMIT 20/);
      return {
        status: 0,
        stdout: '{"run_id":"dagrun_01M3QXE49Z7RNR5K11ABGVD6ZG","plan_id":"model-efficiency-gym-v1","state":"running","started_at":"2026-09-29T18:04:04-07:00"}\n',
        stderr: '',
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.runs.map((run) => [run.run_id, run.state]), [['dagrun_01M3QXE49Z7RNR5K11ABGVD6ZG', 'running']]);
  assert.deepEqual([...LIVE_DAG_RUN_STATES], ['pending', 'running', 'parked', 'awaiting-merge']);
});

test('postgres query values stay in argv for quotes, backslashes and control characters', () => {
  const values = [
    'safe-plan',
    "p\\' \\! id #",
    "p'quoted",
    'p\\backslash',
    'p\n\\! id\r\n\t\x01end',
  ];
  for (const [readImpl, variable] of [
    [(value, spawnSyncImpl) => readActiveDagRunsForPlan({
      planId: value,
      ledgerTarget: { backend: 'postgres', databaseName: 'agent_os_ledger' },
      spawnSyncImpl,
    }), 'plan_id'],
  ]) {
    let baselineScript;
    for (const value of values) {
      let calls = 0;
      const result = readImpl(value, (command, args, options) => {
        calls += 1;
        assert.equal(command, 'psql');
        const valueIndex = args.indexOf(`${variable}=${value}`);
        assert.ok(valueIndex > 0);
        assert.equal(args[valueIndex - 1], '-v');
        assert.ok(!args.includes('-c'));
        assert.ok(options.input.includes(`:'${variable}'`));
        assert.doesNotMatch(options.input, /^\s*\\/m, 'no executable meta-command lines');
        baselineScript ??= options.input;
        assert.equal(options.input, baselineScript, 'script is independent of repository values');
        return { status: 0, stdout: '{}\n', stderr: '' };
      });
      assert.equal(calls, 1);
      assert.equal(result.ok, true);
    }
  }
});

test('readActiveDagRunsForPlan surfaces psql failure as not-ok and rejects unsafe states', () => {
  const failed = readActiveDagRunsForPlan({
    planId: 'p',
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: () => ({ status: 2, stdout: '', stderr: 'connection refused' }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'ledger-read-failed');
  assert.equal(readActiveDagRunsForPlan({ planId: '' }).reason, 'missing-plan-id');
  const unsafe = readActiveDagRunsForPlan({
    planId: 'p',
    states: ["running') OR ('1'='1"],
    ledgerTarget: { backend: 'postgres', dsn: 'postgres://ledger.example/agent_os_ledger' },
    spawnSyncImpl: () => { throw new Error('must not query'); },
  });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.reason, 'invalid-dag-run-states');
});

test('readActiveDagRunsForPlan filters sqlite rows to the plan and live states', () => {
  const rootDir = tempRoot();
  const ledgerDb = path.join(rootDir, 'ledger.db');
  const db = new Database(ledgerDb);
  db.exec('CREATE TABLE dag_runs (run_id TEXT PRIMARY KEY, plan_id TEXT, state TEXT, started_at TEXT)');
  const insert = db.prepare('INSERT INTO dag_runs (run_id, plan_id, state, started_at) VALUES (?, ?, ?, ?)');
  insert.run('dagrun_live', 'plan-a', 'running', '2026-09-29T02:00:00Z');
  insert.run('dagrun_parked', 'plan-a', 'parked', '2026-09-29T01:00:00Z');
  insert.run('dagrun_done', 'plan-a', 'succeeded', '2026-09-29T03:00:00Z');
  insert.run('dagrun_other', 'plan-b', 'running', '2026-09-29T04:00:00Z');
  db.close();

  const result = readActiveDagRunsForPlan({
    planId: 'plan-a',
    ledgerTarget: { backend: 'sqlite', path: ledgerDb },
    env: HERMETIC_CONFIG_ENV,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.runs.map((run) => run.run_id), ['dagrun_live', 'dagrun_parked']);
});

test('active DAG reads retry transient failures, stop on permanent errors, and fail closed at cap', () => {
  for (const failure of [
    { status: null, error: { code: 'ETIMEDOUT' } },
    { status: null, error: { code: 'EAGAIN', message: 'spawnSync psql EAGAIN' } },
    { status: 2, stderr: 'connection refused' },
  ]) {
    for (const recover of [true, false]) {
      let calls = 0;
      const result = readActiveDagRunsForPlan({ planId: 'p',
        ledgerTarget: { backend: 'postgres', databaseName: 'ledger' },
        spawnSyncImpl: () => ++calls === 3 && recover
          ? { status: 0, stdout: '', stderr: '' } : failure,
      });
      assert.equal(calls, 3);
      assert.equal(result.ok, recover);
    }
  }
  for (const failure of [
    { status: 1, stderr: 'permission denied for table dag_runs' },
    { status: null, error: { code: 'ENOENT' } },
    { status: 0, stdout: 'invalid JSON' },
  ]) {
    let calls = 0;
    const result = readActiveDagRunsForPlan({ planId: 'p',
      ledgerTarget: { backend: 'postgres', databaseName: 'ledger' },
      spawnSyncImpl: () => { calls++; return failure; },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
  }
});


// Launch identity, retry ordering, scope and backend regressions now live at
// the producer and dispatch-read-client boundary; this file retains the other
// ledger readers until their separate migrations.
test('RETRYCHAIN-02: an empty capacity census never requests an unfiltered launch snapshot', async () => {
  const { readLaunchRequestSnapshotFromLedgerAsync } = await import('../src/session-ledger-read-adapter.mjs');
  const result = await readLaunchRequestSnapshotFromLedgerAsync({
    ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' },
    spawnSyncImpl: () => assert.fail('empty census must not spawn psql'),
  });
  assert.deepEqual(result.rows, []);
});

import { readExecutionVerdictsFromLedger, readExecutionVerdictsFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import { noWorkVerdict } from './fixtures/execution-verdict.mjs';

test('RCV-08 reads the RCV-07 versioned export from canonical SQLite without writes', async t => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dbPath = path.join(rootDir, 'synthetic.db');
  const db = new Database(dbPath);
  const verdict = noWorkVerdict('lrq_synthetic');
  db.exec(`CREATE TABLE execution_verdicts (launch_request_id TEXT, attempt INTEGER, verdict_id TEXT,
    verdict TEXT, reason TEXT, evidence_refs_json TEXT, producer TEXT, schema_version INTEGER, observed_at TEXT)`);
  db.prepare('INSERT INTO execution_verdicts VALUES (?,?,?,?,?,?,?,?,?)').run(verdict.launchRequestId,
    verdict.attempt, verdict.verdictId, verdict.verdict, verdict.reason, JSON.stringify(verdict.evidenceRefs),
    verdict.producer, verdict.schemaVersion, verdict.observedAt);
  db.close();
  const before = readFileSync(dbPath);
  const args = { ledgerTarget: { backend: 'sqlite', path: dbPath }, rootDir, env: HERMETIC_CONFIG_ENV,
    launchRequestId: verdict.launchRequestId };
  assert.deepEqual(readExecutionVerdictsFromLedger(args).verdicts, [verdict]);
  assert.deepEqual((await readExecutionVerdictsFromLedgerAsync(args)).verdicts, [verdict]);
  assert.deepEqual(readFileSync(dbPath), before);
  assert.deepEqual(readExecutionVerdictsFromLedger({ ...args, launchRequestId: 'missing' }).verdicts, []);
});

test('RCV-08 PostgreSQL verdict export uses bounded read-only canonical adapter and redacts failures', () => {
  let input;
  const verdict = noWorkVerdict('lrq_pg');
  const row = { launch_request_id: verdict.launchRequestId, attempt: 1, verdict_id: verdict.verdictId,
    verdict: verdict.verdict, reason: verdict.reason, evidence_refs_json: verdict.evidenceRefs,
    producer: verdict.producer, schema_version: 1, observed_at: verdict.observedAt };
  const args = { ledgerTarget: { backend: 'postgres', databaseName: 'synthetic' }, env: HERMETIC_CONFIG_ENV,
    launchRequestId: verdict.launchRequestId,
    spawnSyncImpl: (_cmd, _args, options) => {
      input = options.input;
      assert.ok(options.timeout > 0 && options.timeout <= 2 ** 31 - 1);
      return { status: 0, stdout: JSON.stringify(row) + '\n' };
    } };
  const result = readExecutionVerdictsFromLedger(args);
  assert.deepEqual(result.verdicts, [verdict]);
  assert.match(input, /BEGIN READ ONLY/);
  assert.match(input, /launch_request_id = :'lrq'/);
  const failed = readExecutionVerdictsFromLedger({ ...args,
    spawnSyncImpl: () => ({ status: 1, stderr: 'synthetic-secret-driver-error' }) });
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes('synthetic-secret'), false);
});

test('readActiveDagRunsForPlan strips a password-bearing postgres DSN out of argv', () => {
  const result = readActiveDagRunsForPlan({
    planId: 'synthetic-plan',
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

test('readActiveDagRunsForPlan strips a password-bearing libpq DSN out of argv', () => {
  const result = readActiveDagRunsForPlan({
    planId: 'synthetic-plan',
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

test('readActiveDagRunsForPlan supports databaseName-only postgres targets', () => {
  const result = readActiveDagRunsForPlan({
    planId: 'synthetic-plan',
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
  assert.equal(result.runs[0].run_id, 'wr_pg');
});

test('readActiveDagRunsForPlan reports unparseable psql stdout with context', () => {
  const result = readActiveDagRunsForPlan({
    planId: 'synthetic-plan',
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

test('readActiveDagRunsForPlan fails closed when psql is terminated by signal', () => {
  const result = readActiveDagRunsForPlan({
    planId: 'synthetic-plan',
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

test('readActiveDagRunsForPlan returns a timeout failure when psql exceeds the spawn timeout', () => {
  const result = readActiveDagRunsForPlan({
    planId: 'synthetic-plan',
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
