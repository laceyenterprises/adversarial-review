import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { loadConfig } from './config-loader.mjs';

const require = createRequire(import.meta.url);

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function deriveHqOwnerHome(hqRoot) {
  const resolvedHqRoot = normalizeText(hqRoot);
  const match = resolvedHqRoot?.match(/^\/Users\/([^/]+)(?:\/|$)/);
  return match ? join('/Users', match[1]) : null;
}

function readLegacyHqLedgerDbPath(hqRoot) {
  const resolvedHqRoot = normalizeText(hqRoot);
  if (!resolvedHqRoot) return null;
  try {
    const raw = readFileSync(join(resolvedHqRoot, '.hq', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeText(parsed?.ledgerDbPath);
  } catch {
    return null;
  }
}

function sqliteTargetFromPath(path, source, extra = {}) {
  const normalizedPath = normalizeText(path);
  if (!normalizedPath) {
    return { ok: false, reason: 'malformed-ledger-target', detail: 'sqlite target path is required' };
  }
  return {
    ok: true,
    target: {
      backend: 'sqlite',
      path: isAbsolute(normalizedPath) ? normalizedPath : resolve(normalizedPath),
      source,
      ...extra,
    },
  };
}

function sqliteTargetIsUsable(path, requiredTables = []) {
  if (!existsSync(path)) return false;
  return sessionLedgerDbHasTables(path, requiredTables);
}

function usableSqliteTargetFromPath(
  path,
  source,
  { requiredTables = [], requireExisting = false, extra = {} } = {},
) {
  const result = sqliteTargetFromPath(path, source, extra);
  if (!result.ok) return result;
  if (requiredTables.length === 0 && !requireExisting) return result;
  if (!existsSync(result.target.path)) {
    return {
      ok: false,
      reason: 'missing-ledger-target',
      detail: `sqlite ledger target does not exist: ${result.target.path}`,
      target: result.target,
    };
  }
  if (requiredTables.length === 0) return result;
  if (!sqliteTargetIsUsable(result.target.path, requiredTables)) {
    return {
      ok: false,
      reason: 'missing-ledger-target',
      detail: `sqlite ledger target is missing required tables: ${result.target.path}`,
      target: result.target,
    };
  }
  return result;
}

function postgresTargetFromConfig({ cfg, env }) {
  const dsn = normalizeText(env.AGENT_OS_SESSION_LEDGER_DSN || cfg.get('session_ledger.dsn'));
  const databaseName = normalizeText(cfg.get('session_ledger.database_name'));
  if (!dsn && !databaseName) {
    return {
      ok: false,
      reason: 'malformed-ledger-target',
      detail: 'postgres ledger target requires session_ledger.dsn or session_ledger.database_name',
    };
  }
  return {
    ok: true,
    target: {
      backend: 'postgres',
      dsn,
      databaseName,
      source: dsn ? 'config:session_ledger.dsn' : 'config:session_ledger.database_name',
    },
  };
}

function normalizeExplicitLedgerTarget(ledgerTarget) {
  if (ledgerTarget && typeof ledgerTarget === 'object' && !Array.isArray(ledgerTarget)) {
    const backend = normalizeText(ledgerTarget.backend)?.toLowerCase();
    if (backend === 'sqlite') {
      return sqliteTargetFromPath(ledgerTarget.path, ledgerTarget.source || 'explicit-ledger-target');
    }
    if (backend === 'postgres') {
      const dsn = normalizeText(ledgerTarget.dsn);
      const databaseName = normalizeText(ledgerTarget.databaseName);
      if (!dsn && !databaseName) {
        return {
          ok: false,
          reason: 'malformed-ledger-target',
          detail: 'postgres ledger target requires dsn or databaseName',
        };
      }
      return {
        ok: true,
        target: {
          backend: 'postgres',
          dsn,
          databaseName,
          source: ledgerTarget.source || 'explicit-ledger-target',
        },
      };
    }
    return {
      ok: false,
      reason: 'malformed-ledger-target',
      detail: `unsupported ledger target backend: ${backend || '(missing)'}`,
    };
  }

  const text = normalizeText(ledgerTarget);
  if (!text) {
    return { ok: false, reason: 'malformed-ledger-target', detail: 'ledgerTarget must not be empty' };
  }
  if (text.startsWith('postgres://') || text.startsWith('postgresql://')) {
    return {
      ok: true,
      target: { backend: 'postgres', dsn: text, databaseName: null, source: 'explicit-ledger-target' },
    };
  }
  if (text.startsWith('sqlite://')) {
    return sqliteTargetFromPath(text.slice('sqlite://'.length), 'explicit-ledger-target');
  }
  return sqliteTargetFromPath(text, 'explicit-ledger-target');
}

function usableLedgerTargetFromEnvValue(value, source, requiredTables) {
  const result = normalizeExplicitLedgerTarget(value);
  if (!result.ok) return result;
  if (result.target.backend !== 'sqlite' || requiredTables.length === 0) return result;
  return usableSqliteTargetFromPath(result.target.path, source, { requiredTables });
}

function sqliteTargetCandidates({ cfg, env, rootDir }) {
  const deployRoot = normalizeText(env.AGENT_OS_DEPLOY_CHECKOUT || cfg.get('roots.deploy'));
  const runtimeHome = normalizeText(env.HOME || cfg.get('roots.runtime_home') || homedir());
  const adminHome = normalizeText(cfg.get('roots.admin_home'));
  const hqOwnerHome = deriveHqOwnerHome(env.HQ_ROOT);
  const candidates = [];
  if (deployRoot) {
    candidates.push({
      path: join(deployRoot, '.agent-os', 'session-ledger', 'ledger.db'),
      source: 'roots.deploy',
    });
  }
  if (rootDir) {
    candidates.push({
      path: join(resolve(String(rootDir)), '.agent-os', 'session-ledger', 'ledger.db'),
      source: 'rootDir',
    });
  }
  if (runtimeHome) {
    candidates.push({
      path: join(runtimeHome, '.agent-os', 'session-ledger', 'ledger.db'),
      source: 'roots.runtime_home',
    });
  }
  if (adminHome) {
    candidates.push({
      path: join(adminHome, 'agent-os', '.agent-os', 'session-ledger', 'ledger.db'),
      source: 'roots.admin_home',
    });
  }
  if (hqOwnerHome) {
    candidates.push({
      path: join(hqOwnerHome, 'agent-os', '.agent-os', 'session-ledger', 'ledger.db'),
      source: 'hq-root-owner-home-deploy',
    });
    candidates.push({
      path: join(hqOwnerHome, '.agent-os', 'session-ledger', 'ledger.db'),
      source: 'hq-root-owner-home-runtime',
    });
  }
  return candidates;
}

function sessionLedgerDbHasTables(dbPath, tableNames = []) {
  const required = [...new Set((tableNames || []).filter(Boolean).map(String))];
  if (required.length === 0) return true;
  const loaded = loadBetterSqlite3();
  if (!loaded.ok) return false;
  let db = null;
  try {
    db = new loaded.Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (${required.map((_, idx) => `@table${idx}`).join(', ')})`
    ).all(Object.fromEntries(required.map((name, idx) => [`table${idx}`, name])));
    const found = new Set(rows.map((row) => row.name));
    return required.every((name) => found.has(name));
  } catch {
    return false;
  } finally {
    if (db) db.close();
  }
}

export function resolveSessionLedgerReadTarget({
  ledgerTarget = null,
  ledgerDbPath = null,
  requiredTables = [],
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
} = {}) {
  if (ledgerTarget !== null && ledgerTarget !== undefined) {
    return normalizeExplicitLedgerTarget(ledgerTarget);
  }
  if (ledgerDbPath) {
    return sqliteTargetFromPath(ledgerDbPath, 'deprecated-ledger-db-path', { deprecatedAlias: true });
  }
  if (env.AGENT_OS_SESSION_LEDGER_TARGET) {
    const result = usableLedgerTargetFromEnvValue(
      env.AGENT_OS_SESSION_LEDGER_TARGET,
      'env:AGENT_OS_SESSION_LEDGER_TARGET',
      requiredTables,
    );
    if (result.ok || result.reason === 'malformed-ledger-target') return result;
  }
  if (env.AGENT_OS_SESSION_LEDGER_DB_PATH) {
    const result = usableSqliteTargetFromPath(
      env.AGENT_OS_SESSION_LEDGER_DB_PATH,
      'env:AGENT_OS_SESSION_LEDGER_DB_PATH',
      { requiredTables },
    );
    if (result.ok || result.reason === 'malformed-ledger-target') return result;
  }
  if (env.SESSION_LEDGER_DB_PATH) {
    const result = usableSqliteTargetFromPath(
      env.SESSION_LEDGER_DB_PATH,
      'env:SESSION_LEDGER_DB_PATH',
      { requiredTables },
    );
    if (result.ok || result.reason === 'malformed-ledger-target') return result;
  }
  const legacyHqLedgerDbPath = readLegacyHqLedgerDbPath(hqRoot || env.HQ_ROOT);
  if (legacyHqLedgerDbPath) {
    const result = usableSqliteTargetFromPath(legacyHqLedgerDbPath, 'legacy-hq-config', {
      requiredTables,
    });
    if (result.ok || result.reason === 'malformed-ledger-target') return result;
  }
  try {
    const cfg = loadConfig({ env });
    const backend = normalizeText(cfg.get('session_ledger.backend'))?.toLowerCase();
    if (backend === 'postgres') {
      return postgresTargetFromConfig({ cfg, env });
    }
    for (const candidate of sqliteTargetCandidates({ cfg, env, rootDir })) {
      const result = usableSqliteTargetFromPath(candidate.path, candidate.source, {
        requiredTables,
        requireExisting: true,
      });
      if (result.ok) return result;
    }
    return {
      ok: false,
      reason: 'missing-ledger-target',
      detail: 'no readable session-ledger target could be resolved',
      backend: backend || 'sqlite',
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed-ledger-target',
      detail: err?.message || String(err),
    };
  }
}

function loadBetterSqlite3() {
  try {
    return { ok: true, Database: require('better-sqlite3') };
  } catch (err) {
    return {
      ok: false,
      reason: 'better-sqlite3-unavailable',
      detail: err?.message || String(err),
    };
  }
}

const PSQL_TIMEOUT_MS = 30_000;
const PSQL_TIMEOUT_SIGNAL = 'SIGKILL';

function querySqliteRows(target, sql, params) {
  if (!existsSync(target.path)) {
    return {
      ok: false,
      reason: 'missing-ledger-target',
      detail: `sqlite ledger path does not exist: ${target.path}`,
      target,
    };
  }
  const loaded = loadBetterSqlite3();
  if (!loaded.ok) return loaded;
  let db = null;
  try {
    db = new loaded.Database(target.path, { readonly: true, fileMustExist: true });
    return {
      ok: true,
      rows: db.prepare(sql).all(params),
      target,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: err?.message || String(err),
      target,
    };
  } finally {
    if (db) db.close();
  }
}

function parsePostgresJsonRows(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildPostgresSpawnConfig(target) {
  if (!target.dsn) {
    return {
      ok: true,
      args: ['-d', target.databaseName],
      env: process.env,
    };
  }
  if (!/^postgres(?:ql)?:\/\//.test(target.dsn)) {
    return {
      ok: true,
      args: [target.dsn],
      env: process.env,
    };
  }
  let parsed;
  try {
    parsed = new URL(target.dsn);
  } catch (err) {
    return {
      ok: false,
      reason: 'malformed-ledger-target',
      detail: err?.message || String(err),
      target,
    };
  }
  const env = { ...process.env };
  if (parsed.password) {
    env.PGPASSWORD = decodeURIComponent(parsed.password);
    parsed.password = '';
  }
  return {
    ok: true,
    args: [parsed.toString()],
    env,
  };
}

function describePostgresSpawnFailure(result) {
  if (result.error?.code === 'ENOENT') {
    return {
      ok: false,
      reason: 'psql-not-installed',
      detail: 'psql is not installed or not on PATH',
    };
  }
  if (result.error?.code === 'ETIMEDOUT') {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: `psql timed out after ${PSQL_TIMEOUT_MS}ms`,
    };
  }
  if (result.signal || result.status === null) {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: `psql terminated by signal ${result.signal || 'unknown'}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: String(result.stderr || result.stdout || `psql exited with status ${result.status}`),
    };
  }
  return null;
}

function queryPostgresRows(target, jsonSql, { spawnSyncImpl = spawnSync, psqlVars = [] } = {}) {
  const locator = normalizeText(target.dsn) || normalizeText(target.databaseName);
  if (!locator) {
    return {
      ok: false,
      reason: 'malformed-ledger-target',
      detail: 'postgres ledger target requires dsn or databaseName',
      target,
    };
  }
  const spawnConfig = buildPostgresSpawnConfig(target);
  if (!spawnConfig.ok) return spawnConfig;
  try {
    const args = ['-X', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1'];
    for (const [name, value] of psqlVars) {
      args.push('-v', `${name}=${value}`);
    }
    args.push('-t', '-A');
    args.splice(args.length - 2, 0, ...spawnConfig.args);
    args.push('-c', jsonSql);
    const result = spawnSyncImpl('psql', args, {
      encoding: 'utf8',
      env: spawnConfig.env,
      timeout: PSQL_TIMEOUT_MS,
      killSignal: PSQL_TIMEOUT_SIGNAL,
    });
    const failure = describePostgresSpawnFailure(result);
    if (failure) return { ...failure, target };
    return {
      ok: true,
      rows: parsePostgresJsonRows(result.stdout),
      target,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: err?.message || String(err),
      target,
    };
  }
}

function unsupportedBackend(target) {
  return {
    ok: false,
    reason: 'unsupported-ledger-backend',
    detail: `session-ledger backend ${target.backend} is not readable in this adapter yet`,
    target,
  };
}

export function readLatestWorkerRunStatusFromLedger({
  launchRequestId,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedLaunchRequestId = normalizeText(launchRequestId);
  if (!normalizedLaunchRequestId) {
    return { ok: false, reason: 'missing-launch-request-id' };
  }
  const resolution = resolveSessionLedgerReadTarget({
    ledgerTarget,
    ledgerDbPath,
    requiredTables: ['worker_runs'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;
  let queried;
  if (resolution.target.backend === 'sqlite') {
    queried = querySqliteRows(
      resolution.target,
      `SELECT run_id, launch_request_id, status, updated_at, ended_at, started_at
         FROM worker_runs
        WHERE launch_request_id = @launchRequestId
        ORDER BY COALESCE(updated_at, ended_at, started_at, '') DESC,
                 COALESCE(ended_at, started_at, '') DESC,
                 COALESCE(started_at, '') DESC,
                 run_id DESC,
                 launch_request_id DESC
        LIMIT 1`,
      { launchRequestId: normalizedLaunchRequestId },
    );
  } else if (resolution.target.backend === 'postgres') {
    queried = queryPostgresRows(
      resolution.target,
      `SELECT json_build_object(
          'run_id', run_id,
          'launch_request_id', launch_request_id,
          'status', status,
          'updated_at', updated_at,
          'ended_at', ended_at,
          'started_at', started_at
        )
         FROM (
           SELECT run_id, launch_request_id, status, updated_at, ended_at, started_at
             FROM worker_runs
            WHERE launch_request_id = :'lrq'
            ORDER BY COALESCE(updated_at::text, ended_at::text, started_at::text, '') DESC,
                     COALESCE(ended_at::text, started_at::text, '') DESC,
                     COALESCE(started_at::text, '') DESC,
                     run_id DESC,
                     launch_request_id DESC
            LIMIT 1
         ) latest_worker_run`,
      {
        spawnSyncImpl,
        psqlVars: [['lrq', normalizedLaunchRequestId]],
      },
    );
  } else {
    return unsupportedBackend(resolution.target);
  }
  if (!queried.ok) return queried;
  const [row] = queried.rows;
  if (!row) {
    return {
      ok: false,
      reason: 'missing-worker-run-row',
      launchRequestId: normalizedLaunchRequestId,
      target: queried.target,
    };
  }
  return { ok: true, row, target: queried.target };
}

export function readWorkerRunUsageFromLedger({
  workerRunId = null,
  launchRequestId = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
} = {}) {
  const resolution = resolveSessionLedgerReadTarget({
    ledgerTarget,
    ledgerDbPath,
    requiredTables: ['worker_runs'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;
  if (resolution.target.backend !== 'sqlite') return unsupportedBackend(resolution.target);
  if (workerRunId) {
    const queried = querySqliteRows(
      resolution.target,
      `SELECT wr.run_id, wr.launch_request_id, wr.session_id,
              wr.token_usage_input, wr.token_usage_output,
              wr.token_usage_cost_usd, wr.token_usage_source,
              wr.started_at, wr.ended_at, wr.updated_at,
              rs.total_cache_read_tokens, rs.total_cache_write_tokens
         FROM worker_runs wr
         LEFT JOIN runtime_sessions rs ON rs.session_id = wr.session_id
        WHERE wr.run_id = @workerRunId
        ORDER BY COALESCE(wr.updated_at, wr.ended_at, wr.started_at, '') DESC, wr.rowid DESC
        LIMIT 1`,
      { workerRunId },
    );
    if (!queried.ok) return queried;
    const [row] = queried.rows;
    if (row) return { ok: true, row, target: queried.target };
  }
  const normalizedLaunchRequestId = normalizeText(launchRequestId);
  if (!normalizedLaunchRequestId) return { ok: false, reason: 'missing-worker-run-selector', target: resolution.target };
  const queried = querySqliteRows(
    resolution.target,
    `SELECT wr.run_id, wr.launch_request_id, wr.session_id,
            wr.token_usage_input, wr.token_usage_output,
            wr.token_usage_cost_usd, wr.token_usage_source,
            wr.started_at, wr.ended_at, wr.updated_at,
            rs.total_cache_read_tokens, rs.total_cache_write_tokens
       FROM worker_runs wr
       LEFT JOIN runtime_sessions rs ON rs.session_id = wr.session_id
      WHERE wr.launch_request_id = @launchRequestId
      ORDER BY COALESCE(wr.updated_at, wr.ended_at, wr.started_at, '') DESC, wr.rowid DESC
      LIMIT 1`,
    { launchRequestId: normalizedLaunchRequestId },
  );
  if (!queried.ok) return queried;
  const [row] = queried.rows;
  return row ? { ok: true, row, target: queried.target } : { ok: false, reason: 'missing-worker-run-row', target: queried.target };
}

export function readReviewerSessionUsageFromLedger({
  adapterSessionKey = null,
  sessionKeys = [],
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
} = {}) {
  const resolution = resolveSessionLedgerReadTarget({
    ledgerTarget,
    ledgerDbPath,
    requiredTables: ['runtime_sessions'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;
  if (resolution.target.backend !== 'sqlite') return unsupportedBackend(resolution.target);

  const params = {};
  const window = [];
  if (endedAt) {
    params.windowEnd = endedAt;
    window.push(`COALESCE(started_at, '') <= @windowEnd`);
  }
  if (startedAt) {
    params.windowStart = startedAt;
    window.push(`COALESCE(ended_at, started_at, '') >= @windowStart`);
  }
  const keys = [...new Set([adapterSessionKey, ...sessionKeys].filter(Boolean).map(String))];

  if (keys.length > 0) {
    keys.forEach((key, idx) => { params[`key${idx}`] = key; });
    const queried = querySqliteRows(
      resolution.target,
      `SELECT session_id, adapter_session_key, total_input_tokens, total_output_tokens,
              total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
              source_path, started_at, ended_at, ended_at AS updated_at
         FROM runtime_sessions
        WHERE adapter_session_key IN (${keys.map((_, idx) => `@key${idx}`).join(', ')})
          ${window.length ? `AND ${window.join(' AND ')}` : ''}
        ORDER BY COALESCE(ended_at, started_at, '') DESC, rowid DESC
        LIMIT 1`,
      params,
    );
    if (!queried.ok) return queried;
    const [row] = queried.rows;
    if (row) return { ok: true, row, target: queried.target };
  }

  const normalizedWorkspacePath = normalizeText(workspacePath);
  if (!normalizedWorkspacePath) return { ok: false, reason: 'missing-runtime-session-selector', target: resolution.target };
  const queried = querySqliteRows(
    resolution.target,
    `SELECT session_id, adapter_session_key, total_input_tokens, total_output_tokens,
            total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
            source_path, started_at, ended_at, ended_at AS updated_at
       FROM runtime_sessions
      WHERE source_path = @workspacePath
        ${window.length ? `AND ${window.join(' AND ')}` : ''}
      ORDER BY COALESCE(ended_at, started_at, '') DESC, rowid DESC
      LIMIT 1`,
    { workspacePath: normalizedWorkspacePath, ...params },
  );
  if (!queried.ok) return queried;
  const [row] = queried.rows;
  return row ? { ok: true, row, target: queried.target } : { ok: false, reason: 'missing-runtime-session-row', target: queried.target };
}
