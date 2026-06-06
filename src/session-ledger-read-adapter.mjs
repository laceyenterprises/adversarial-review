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

function sqliteTargetCandidates({ cfg, env, rootDir }) {
  const deployRoot = normalizeText(cfg.get('roots.deploy') || env.AGENT_OS_DEPLOY_CHECKOUT);
  const runtimeHome = normalizeText(cfg.get('roots.runtime_home') || env.HOME || homedir());
  const adminHome = normalizeText(cfg.get('roots.admin_home'));
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
  return candidates;
}

export function resolveSessionLedgerReadTarget({
  ledgerTarget = null,
  ledgerDbPath = null,
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
    return normalizeExplicitLedgerTarget(env.AGENT_OS_SESSION_LEDGER_TARGET);
  }
  try {
    const cfg = loadConfig({ env });
    const backend = normalizeText(cfg.get('session_ledger.backend'))?.toLowerCase();
    if (backend === 'postgres') {
      return postgresTargetFromConfig({ cfg, env });
    }
    if (env.AGENT_OS_SESSION_LEDGER_DB_PATH) {
      return sqliteTargetFromPath(env.AGENT_OS_SESSION_LEDGER_DB_PATH, 'env:AGENT_OS_SESSION_LEDGER_DB_PATH');
    }
    if (env.SESSION_LEDGER_DB_PATH) {
      return sqliteTargetFromPath(env.SESSION_LEDGER_DB_PATH, 'env:SESSION_LEDGER_DB_PATH');
    }
    const legacyHqLedgerDbPath = readLegacyHqLedgerDbPath(hqRoot || env.HQ_ROOT);
    if (legacyHqLedgerDbPath) {
      return sqliteTargetFromPath(legacyHqLedgerDbPath, 'legacy-hq-config');
    }
    for (const candidate of sqliteTargetCandidates({ cfg, env, rootDir })) {
      if (existsSync(candidate.path)) {
        return sqliteTargetFromPath(candidate.path, candidate.source);
      }
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

function compareIsoDesc(left, right) {
  const a = normalizeText(left) || '';
  const b = normalizeText(right) || '';
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function compareTextDesc(left, right) {
  const a = normalizeText(left) || '';
  const b = normalizeText(right) || '';
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

function sortLedgerRows(rows, identityKeys = []) {
  return [...rows].sort((left, right) => {
    const timeCmp = compareIsoDesc(
      left.updated_at || left.ended_at || left.started_at,
      right.updated_at || right.ended_at || right.started_at,
    );
    if (timeCmp !== 0) return timeCmp;
    for (const key of identityKeys) {
      const cmp = compareTextDesc(left[key], right[key]);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

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
} = {}) {
  const normalizedLaunchRequestId = normalizeText(launchRequestId);
  if (!normalizedLaunchRequestId) {
    return { ok: false, reason: 'missing-launch-request-id' };
  }
  const resolution = resolveSessionLedgerReadTarget({ ledgerTarget, ledgerDbPath, env, rootDir, hqRoot });
  if (!resolution.ok) return resolution;
  if (resolution.target.backend !== 'sqlite') return unsupportedBackend(resolution.target);
  const queried = querySqliteRows(
    resolution.target,
    `SELECT run_id, launch_request_id, status, updated_at, ended_at, started_at
       FROM worker_runs
      WHERE launch_request_id = @launchRequestId`,
    { launchRequestId: normalizedLaunchRequestId },
  );
  if (!queried.ok) return queried;
  const [row] = sortLedgerRows(queried.rows, ['run_id', 'launch_request_id']);
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
  const resolution = resolveSessionLedgerReadTarget({ ledgerTarget, ledgerDbPath, env, rootDir, hqRoot });
  if (!resolution.ok) return resolution;
  if (resolution.target.backend !== 'sqlite') return unsupportedBackend(resolution.target);
  const chooseLatest = (rows) => sortLedgerRows(rows, ['run_id', 'launch_request_id', 'session_id'])[0] || null;
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
        WHERE wr.run_id = @workerRunId`,
      { workerRunId },
    );
    if (!queried.ok) return queried;
    const row = chooseLatest(queried.rows);
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
      WHERE wr.launch_request_id = @launchRequestId`,
    { launchRequestId: normalizedLaunchRequestId },
  );
  if (!queried.ok) return queried;
  const row = chooseLatest(queried.rows);
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
  const resolution = resolveSessionLedgerReadTarget({ ledgerTarget, ledgerDbPath, env, rootDir, hqRoot });
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
  const chooseLatest = (rows) => sortLedgerRows(rows, ['session_id', 'adapter_session_key', 'source_path'])[0] || null;

  if (keys.length > 0) {
    keys.forEach((key, idx) => { params[`key${idx}`] = key; });
    const queried = querySqliteRows(
      resolution.target,
      `SELECT session_id, adapter_session_key, total_input_tokens, total_output_tokens,
              total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
              source_path, started_at, ended_at, ended_at AS updated_at
         FROM runtime_sessions
        WHERE adapter_session_key IN (${keys.map((_, idx) => `@key${idx}`).join(', ')})
          ${window.length ? `AND ${window.join(' AND ')}` : ''}`,
      params,
    );
    if (!queried.ok) return queried;
    const row = chooseLatest(queried.rows);
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
        ${window.length ? `AND ${window.join(' AND ')}` : ''}`,
    { workspacePath: normalizedWorkspacePath, ...params },
  );
  if (!queried.ok) return queried;
  const row = chooseLatest(queried.rows);
  return row ? { ok: true, row, target: queried.target } : { ok: false, reason: 'missing-runtime-session-row', target: queried.target };
}
