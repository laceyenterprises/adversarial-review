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

function configuredSessionLedgerBackend({ env }) {
  try {
    const cfg = loadConfig({ env });
    return normalizeText(cfg.get('session_ledger.backend'))?.toLowerCase() || null;
  } catch {
    return null;
  }
}

function failIfPostgresConfiguredSqliteResolved(result, { env }) {
  if (!result.ok || result.target?.backend !== 'sqlite') return result;
  const backend = configuredSessionLedgerBackend({ env });
  if (backend !== 'postgres') return result;
  const path = result.target.path || '(missing sqlite path)';
  const source = result.target.source || '(unknown source)';
  return {
    ok: false,
    reason: 'postgres-configured-but-sqlite-resolved',
    detail: `session_ledger.backend=postgres is configured, but resolved sqlite session-ledger target ${path} from ${source}`,
    configuredBackend: 'postgres',
    target: result.target,
  };
}

function normalizeExplicitLedgerTarget(ledgerTarget) {
  if (ledgerTarget && typeof ledgerTarget === 'object' && !Array.isArray(ledgerTarget)) {
    const backend = normalizeText(ledgerTarget.backend)?.toLowerCase();
    if (backend === 'sqlite') {
      const extra = ledgerTarget.deprecatedAlias ? { deprecatedAlias: true } : {};
      return sqliteTargetFromPath(ledgerTarget.path, ledgerTarget.source || 'explicit-ledger-target', extra);
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
    return failIfPostgresConfiguredSqliteResolved(
      sqliteTargetFromPath(ledgerDbPath, 'deprecated-ledger-db-path', { deprecatedAlias: true }),
      { env },
    );
  }
  if (env.AGENT_OS_SESSION_LEDGER_TARGET) {
    const result = usableLedgerTargetFromEnvValue(
      env.AGENT_OS_SESSION_LEDGER_TARGET,
      'env:AGENT_OS_SESSION_LEDGER_TARGET',
      requiredTables,
    );
    if (result.ok || result.reason === 'malformed-ledger-target') {
      return result;
    }
  }
  if (env.AGENT_OS_SESSION_LEDGER_DB_PATH) {
    const result = usableSqliteTargetFromPath(
      env.AGENT_OS_SESSION_LEDGER_DB_PATH,
      'env:AGENT_OS_SESSION_LEDGER_DB_PATH',
      { requiredTables },
    );
    if (result.ok || result.reason === 'malformed-ledger-target') {
      return failIfPostgresConfiguredSqliteResolved(result, { env });
    }
  }
  if (env.SESSION_LEDGER_DB_PATH) {
    const result = usableSqliteTargetFromPath(
      env.SESSION_LEDGER_DB_PATH,
      'env:SESSION_LEDGER_DB_PATH',
      { requiredTables },
    );
    if (result.ok || result.reason === 'malformed-ledger-target') {
      return failIfPostgresConfiguredSqliteResolved(result, { env });
    }
  }
  const legacyHqLedgerDbPath = readLegacyHqLedgerDbPath(hqRoot || env.HQ_ROOT);
  if (legacyHqLedgerDbPath) {
    const result = usableSqliteTargetFromPath(legacyHqLedgerDbPath, 'legacy-hq-config', {
      requiredTables,
    });
    if (result.ok || result.reason === 'malformed-ledger-target') {
      return failIfPostgresConfiguredSqliteResolved(result, { env });
    }
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

const SQLITE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SQLITE_SCHEMA_PROBE_ATTEMPTS = 3;
const SQLITE_SCHEMA_PROBE_BASE_DELAY_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function isTransientSqliteError(err) {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || err || '').toLowerCase();
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || message.includes('database is locked')
    || message.includes('database is busy');
}

function sqliteTableHasColumn(target, tableName, columnName) {
  if (!SQLITE_IDENTIFIER_RE.test(tableName) || !SQLITE_IDENTIFIER_RE.test(columnName)) {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: `unsafe sqlite identifier in schema probe: ${tableName}.${columnName}`,
      target,
    };
  }
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
  let lastError = null;
  for (let attempt = 1; attempt <= SQLITE_SCHEMA_PROBE_ATTEMPTS; attempt += 1) {
    let db = null;
    try {
      db = new loaded.Database(target.path, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
      return {
        ok: true,
        exists: rows.some((column) => column.name === columnName),
        target,
      };
    } catch (err) {
      lastError = err;
      if (attempt < SQLITE_SCHEMA_PROBE_ATTEMPTS && isTransientSqliteError(err)) {
        sleepSync(SQLITE_SCHEMA_PROBE_BASE_DELAY_MS * attempt);
        continue;
      }
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
  return {
    ok: false,
    reason: 'ledger-read-failed',
    detail: lastError?.message || String(lastError || 'sqlite schema probe failed'),
    target,
  };
}

function truncateForDetail(value, limit = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function parsePostgresJsonRows(stdout) {
  const raw = String(stdout || '');
  const rows = [];
  for (const line of raw.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`unparseable psql stdout: ${truncateForDetail(raw)}`);
    }
  }
  return rows;
}

function parseLibpqKeyValueDsn(dsn) {
  const text = String(dsn || '');
  const tokens = [];
  let password = null;
  let idx = 0;

  function skipWhitespace() {
    while (idx < text.length && /\s/.test(text[idx])) idx += 1;
  }

  function parseValue() {
    if (text[idx] === "'") {
      idx += 1;
      let value = '';
      while (idx < text.length) {
        const char = text[idx];
        if (char === '\\') {
          idx += 1;
          if (idx >= text.length) return null;
          value += text[idx];
          idx += 1;
          continue;
        }
        if (char === "'") {
          idx += 1;
          return value;
        }
        value += char;
        idx += 1;
      }
      return null;
    }

    let value = '';
    while (idx < text.length && !/\s/.test(text[idx])) {
      if (text[idx] === '\\') {
        idx += 1;
        if (idx >= text.length) return null;
        value += text[idx];
        idx += 1;
        continue;
      }
      value += text[idx];
      idx += 1;
    }
    return value;
  }

  while (idx < text.length) {
    skipWhitespace();
    if (idx >= text.length) break;
    const tokenStart = idx;
    while (idx < text.length && text[idx] !== '=' && !/\s/.test(text[idx])) idx += 1;
    const key = text.slice(tokenStart, idx);
    if (!key) return null;
    skipWhitespace();
    if (text[idx] !== '=') return null;
    idx += 1;
    skipWhitespace();
    const value = parseValue();
    if (value === null) return null;
    const raw = text.slice(tokenStart, idx).trim();
    if (key.toLowerCase() === 'password') {
      password = value;
    } else {
      tokens.push(raw);
    }
  }

  return {
    password,
    dsn: tokens.join(' '),
  };
}

function buildPostgresSpawnConfig(target) {
  if (!target.dsn) {
    return {
      ok: true,
      args: ['-d', target.databaseName],
      env: { ...process.env },
    };
  }
  if (!/^postgres(?:ql)?:\/\//.test(target.dsn)) {
    if (/\bpassword\s*=/i.test(target.dsn)) {
      const parsed = parseLibpqKeyValueDsn(target.dsn);
      if (!parsed || parsed.password === null) {
        return {
          ok: false,
          reason: 'malformed-ledger-target',
          detail: 'postgres libpq DSN contains a password but could not be safely sanitized',
          target,
        };
      }
      return {
        ok: true,
        args: [parsed.dsn],
        env: { ...process.env, PGPASSWORD: parsed.password },
      };
    }
    return {
      ok: true,
      args: [target.dsn],
      env: { ...process.env },
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

function isTransientPostgresError(error) {
  return /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EIO)$/.test(String(error?.code || ''))
    || /connection (?:refused|reset|timed out)|timeout expired|TLS handshake timeout|SSL (?:SYSCALL error|connection has been closed unexpectedly)|server closed the connection unexpectedly|could not (?:connect|translate host name)|too many clients|database system is (?:starting up|shutting down|in recovery)/i.test(String(error?.message || ''));
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
      transient: true,
    };
  }
  if (result.error) {
    return {
      ok: false,
      reason: 'ledger-read-failed',
      detail: result.error.message || String(result.error),
      transient: isTransientPostgresError(result.error),
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
      transient: isTransientPostgresError({ message: result.stderr }),
    };
  }
  return null;
}

function queryPostgresRows(target, jsonSql, { spawnSyncImpl = spawnSync, psqlVars = [], readOnly = false } = {}) {
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
    // psql's `-v name=value` variable substitution is NOT applied to SQL
    // passed via `-c` — `-c` sends the command directly to the server
    // without psql-side preprocessing. That means `:'lrq'` style
    // placeholders are forwarded literally, causing the server to raise
    // `syntax error at or near ":"`. To make `:'name'` substitution work,
    // use stdin script mode with variables assigned by separate `-v` args.
    //
    // Surfaced 2026-06-08T18:24Z when the adversarial-watcher's
    // merge-agent dispatcher began failing to look up worker-runs for
    // PR #1569 and PR #1570 with this exact syntax error
    // (`merge_agent.tear_down_skipped reason=worker-run-lookup-failed`).
    // The merge-agent dispatch was getting skipped, leaving Comment-only
    // verdicts stuck and operator-blocking the cutover-replay pack.
    //
    // When psqlVars are supplied, switch to stdin via the spawnSyncImpl
    // `input` option. Never embed variable values in script text: psql
    // meta-command quoting can turn repository content into shell commands.
    // Empty psqlVars keeps the `-c` fast path unless readOnly is requested.
    //
    // `readOnly` wraps the statement in `BEGIN READ ONLY; ... COMMIT;` so
    // the server rejects any write, and adds `-q` so psql does not echo the
    // BEGIN/COMMIT command tags into the JSON-per-line stdout. It is a
    // transaction-scoped guard, never a session-level SET, so it is safe
    // through pgbouncer in transaction-pooling mode. It always selects the
    // stdin script path, including when no psql variables are supplied.
    const args = ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1'];
    if (readOnly) args.push('-q');
    for (const [name, value] of psqlVars) {
      args.push('-v', `${name}=${value}`);
    }
    let result;
    if (readOnly || psqlVars.length > 0) {
      const statement = readOnly
        ? `BEGIN READ ONLY;\n${String(jsonSql).trim().replace(/;$/, '')};\nCOMMIT;`
        : jsonSql;
      const script = `${statement}\n`;
      args.push(...spawnConfig.args, '-t', '-A');
      result = spawnSyncImpl('psql', args, {
        encoding: 'utf8',
        env: spawnConfig.env,
        timeout: PSQL_TIMEOUT_MS,
        killSignal: PSQL_TIMEOUT_SIGNAL,
        input: script,
      });
    } else {
      args.push(...spawnConfig.args, '-t', '-A', '-c', jsonSql);
      result = spawnSyncImpl('psql', args, {
        encoding: 'utf8',
        env: spawnConfig.env,
        timeout: PSQL_TIMEOUT_MS,
        killSignal: PSQL_TIMEOUT_SIGNAL,
      });
    }
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
      transient: isTransientPostgresError(err),
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
    const hasWorkerProcesses = sessionLedgerDbHasTables(resolution.target.path, ['worker_processes']);
    const processSelect = hasWorkerProcesses ? ', wp.pid AS pid, wp.process_status AS process_status' : '';
    const processJoin = hasWorkerProcesses
      ? `LEFT JOIN worker_processes wp
           ON wp.worker_process_id = (
             SELECT wp_latest.worker_process_id
               FROM worker_processes wp_latest
              WHERE wp_latest.launch_request_id = wr.launch_request_id
              ORDER BY COALESCE(wp_latest.updated_at, wp_latest.exited_at, wp_latest.started_at, wp_latest.created_at, '') DESC,
                       COALESCE(wp_latest.started_at, wp_latest.created_at, '') DESC,
                       wp_latest.worker_process_id DESC
              LIMIT 1
           )`
      : '';
    queried = querySqliteRows(
      resolution.target,
      `SELECT wr.run_id, wr.launch_request_id, wr.status, wr.updated_at, wr.ended_at, wr.started_at
              ${processSelect}
         FROM worker_runs wr
         ${processJoin}
        WHERE wr.launch_request_id = @launchRequestId
        ORDER BY COALESCE(wr.updated_at, wr.ended_at, wr.started_at, '') DESC,
                 COALESCE(wr.ended_at, wr.started_at, '') DESC,
                 COALESCE(wr.started_at, '') DESC,
                 wr.run_id DESC,
                 wr.launch_request_id DESC
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
          'started_at', started_at,
          'pid', pid,
          'process_status', process_status
        )
         FROM (
           SELECT wr.run_id, wr.launch_request_id, wr.status, wr.updated_at, wr.ended_at, wr.started_at,
                  wp.pid, wp.process_status
             FROM worker_runs wr
             LEFT JOIN LATERAL (
               SELECT wp_latest.pid, wp_latest.process_status
                 FROM worker_processes wp_latest
                WHERE wp_latest.launch_request_id = wr.launch_request_id
                ORDER BY COALESCE(wp_latest.updated_at::text, wp_latest.exited_at::text, wp_latest.started_at::text, wp_latest.created_at::text, '') DESC,
                         COALESCE(wp_latest.started_at::text, wp_latest.created_at::text, '') DESC,
                         wp_latest.worker_process_id DESC
                LIMIT 1
             ) wp ON true
            WHERE wr.launch_request_id = :'lrq'
            ORDER BY COALESCE(wr.updated_at::text, wr.ended_at::text, wr.started_at::text, '') DESC,
                     COALESCE(wr.ended_at::text, wr.started_at::text, '') DESC,
                     COALESCE(wr.started_at::text, '') DESC,
                     wr.run_id DESC,
                     wr.launch_request_id DESC
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

export function readLaunchRequestStatusFromLedger({
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
    requiredTables: ['launch_requests'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;
  let queried;
  if (resolution.target.backend === 'sqlite') {
    queried = querySqliteRows(
      resolution.target,
      `SELECT launch_request_id, status, updated_at, terminal_at, failure_class
         FROM launch_requests
        WHERE launch_request_id = @launchRequestId
        LIMIT 1`,
      { launchRequestId: normalizedLaunchRequestId },
    );
  } else if (resolution.target.backend === 'postgres') {
    queried = queryPostgresRows(
      resolution.target,
      `SELECT json_build_object(
          'launch_request_id', launch_request_id,
          'status', status,
          'updated_at', updated_at,
          'terminal_at', terminal_at,
          'failure_class', failure_class
        )
         FROM launch_requests
        WHERE launch_request_id = :'lrq'
        LIMIT 1`,
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
      reason: 'missing-launch-request-row',
      launchRequestId: normalizedLaunchRequestId,
      target: queried.target,
    };
  }
  return { ok: true, row, target: queried.target };
}

// LIVEPACK-01: non-terminal dag_runs states. `parked` is non-terminal (a
// parked run resumes), so it counts as live. `awaiting-merge` is a step state
// in the current schema; it is listed so a future run-level state of that name
// is covered without a code change.
export const LIVE_DAG_RUN_STATES = Object.freeze(['pending', 'running', 'parked', 'awaiting-merge']);
const DAG_RUN_STATE_RE = /^[a-z][a-z0-9_-]*$/;
const MAX_ACTIVE_DAG_RUNS = 20;

function queryPostgresRowsWithRetry(target, sql, { sleepSyncImpl = sleepSync, ...options } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = queryPostgresRows(target, sql, options);
    if (result.ok || !result.transient || attempt === 3) return result;
    sleepSyncImpl(100 * attempt);
  }
}

// Read the non-terminal DAG runs of one plan. One indexed, LIMIT-bounded
// SELECT (idx_dag_runs_plan_state covers plan_id + state), with at most three
// attempts and 100/200ms backoff for transient Postgres failures, run inside a
// read-only transaction on Postgres and a readonly handle on SQLite. Returns
// `{ ok: true, runs }` or `{ ok: false, reason, detail }`; callers that gate
// on liveness must treat `ok: false` as inconclusive, never as "not live".
export function readActiveDagRunsForPlan({
  planId,
  states = LIVE_DAG_RUN_STATES,
  limit = MAX_ACTIVE_DAG_RUNS,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedPlanId = normalizeText(planId);
  if (!normalizedPlanId) {
    return { ok: false, reason: 'missing-plan-id' };
  }
  const stateList = [...new Set((states || []).map((state) => normalizeText(state)).filter(Boolean))];
  if (stateList.length === 0 || stateList.some((state) => !DAG_RUN_STATE_RE.test(state))) {
    return { ok: false, reason: 'invalid-dag-run-states', detail: JSON.stringify(states) };
  }
  const boundedLimit = Math.max(1, Math.min(MAX_ACTIVE_DAG_RUNS, Number.parseInt(limit, 10) || MAX_ACTIVE_DAG_RUNS));
  const resolution = resolveSessionLedgerReadTarget({
    ledgerTarget,
    ledgerDbPath,
    requiredTables: ['dag_runs'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;
  let queried;
  if (resolution.target.backend === 'sqlite') {
    const params = { planId: normalizedPlanId };
    const placeholders = stateList.map((state, idx) => {
      params[`state${idx}`] = state;
      return `@state${idx}`;
    });
    queried = querySqliteRows(
      resolution.target,
      `SELECT run_id, plan_id, state, started_at
         FROM dag_runs
        WHERE plan_id = @planId
          AND state IN (${placeholders.join(', ')})
        ORDER BY started_at DESC
        LIMIT ${boundedLimit}`,
      params,
    );
  } else if (resolution.target.backend === 'postgres') {
    // States are validated against DAG_RUN_STATE_RE above, so inlining them
    // as literals cannot inject; plan_id rides as a psql variable.
    const stateLiterals = stateList.map((state) => `'${state}'`).join(', ');
    queried = queryPostgresRowsWithRetry(
      resolution.target,
      `SELECT json_build_object(
          'run_id', run_id,
          'plan_id', plan_id,
          'state', state,
          'started_at', started_at
        )
         FROM dag_runs
        WHERE plan_id = :'plan_id'
          AND state IN (${stateLiterals})
        ORDER BY started_at DESC
        LIMIT ${boundedLimit}`,
      {
        spawnSyncImpl,
        psqlVars: [['plan_id', normalizedPlanId]],
        readOnly: true,
      },
    );
  } else {
    return unsupportedBackend(resolution.target);
  }
  if (!queried.ok) return queried;
  const runs = queried.rows
    .map((row) => ({
      run_id: normalizeText(row?.run_id),
      plan_id: normalizeText(row?.plan_id) || normalizedPlanId,
      state: normalizeText(row?.state),
      started_at: row?.started_at ?? null,
    }))
    .filter((row) => row.run_id);
  return { ok: true, runs, target: queried.target };
}

export function readBuildCompletionSignalForPr({
  repo,
  prNumber,
  headSha = null,
  signalKind = 'merged',
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedRepo = normalizeText(repo);
  const normalizedHeadSha = normalizeText(headSha);
  const normalizedSignalKind = normalizeText(signalKind);
  const numericPrNumber = Number(prNumber);
  if (!normalizedRepo) return { ok: false, reason: 'missing-repo' };
  if (!Number.isInteger(numericPrNumber) || numericPrNumber <= 0) {
    return { ok: false, reason: 'missing-pr-number' };
  }
  if (!normalizedSignalKind) return { ok: false, reason: 'missing-signal-kind' };

  const resolution = resolveSessionLedgerReadTarget({
    ledgerTarget,
    ledgerDbPath,
    requiredTables: ['build_completions'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;

  let queried;
  if (resolution.target.backend === 'sqlite') {
    queried = querySqliteRows(
      resolution.target,
      `SELECT completion_id, ticket_id, launch_request_id, dagrun_id,
              dagrun_step_ticket_id, repo, pr_number, pr_url, head_sha,
              branch, worker_class, signal_kind, spec_ref, source, recorded_at
         FROM build_completions
        WHERE repo = @repo
          AND pr_number = @prNumber
          AND (@headSha IS NULL OR head_sha = @headSha)
          AND signal_kind = @signalKind
        ORDER BY COALESCE(recorded_at, '') DESC,
                 completion_id DESC
        LIMIT 1`,
      {
        repo: normalizedRepo,
        prNumber: numericPrNumber,
        headSha: normalizedHeadSha,
        signalKind: normalizedSignalKind,
      },
    );
  } else if (resolution.target.backend === 'postgres') {
    queried = queryPostgresRows(
      resolution.target,
      `SELECT json_build_object(
          'completion_id', completion_id,
          'ticket_id', ticket_id,
          'launch_request_id', launch_request_id,
          'dagrun_id', dagrun_id,
          'dagrun_step_ticket_id', dagrun_step_ticket_id,
          'repo', repo,
          'pr_number', pr_number,
          'pr_url', pr_url,
          'head_sha', head_sha,
          'branch', branch,
          'worker_class', worker_class,
          'signal_kind', signal_kind,
          'spec_ref', spec_ref,
          'source', source,
          'recorded_at', recorded_at
        )
         FROM (
           SELECT completion_id, ticket_id, launch_request_id, dagrun_id,
                  dagrun_step_ticket_id, repo, pr_number, pr_url, head_sha,
                  branch, worker_class, signal_kind, spec_ref, source, recorded_at
            FROM build_completions
            WHERE repo = :'repo'
              AND pr_number = :'pr_number'::integer
              AND (:'head_sha' = '' OR head_sha = :'head_sha')
              AND signal_kind = :'signal_kind'
            ORDER BY COALESCE(recorded_at::text, '') DESC,
                     completion_id DESC
            LIMIT 1
         ) latest_build_completion`,
      {
        spawnSyncImpl,
        psqlVars: [
          ['repo', normalizedRepo],
          ['pr_number', String(numericPrNumber)],
          ['head_sha', normalizedHeadSha || ''],
          ['signal_kind', normalizedSignalKind],
        ],
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
      reason: 'missing-build-completion-signal',
      repo: normalizedRepo,
      prNumber: numericPrNumber,
      signalKind: normalizedSignalKind,
      target: queried.target,
    };
  }
  return { ok: true, row, target: queried.target };
}

export function readBuildCompletionProducerEvidence({
  repo,
  signalKind = 'merged',
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  const normalizedRepo = normalizeText(repo);
  const normalizedSignalKind = normalizeText(signalKind);
  if (!normalizedRepo) return { ok: false, reason: 'missing-repo' };

  const resolution = resolveSessionLedgerReadTarget({
    ledgerTarget,
    ledgerDbPath,
    requiredTables: ['build_completions'],
    env,
    rootDir,
    hqRoot,
  });
  if (!resolution.ok) return resolution;

  let queried;
  if (resolution.target.backend === 'sqlite') {
    queried = querySqliteRows(
      resolution.target,
      `SELECT completion_id, ticket_id, launch_request_id, dagrun_id,
              dagrun_step_ticket_id, repo, pr_number, pr_url, head_sha,
              branch, worker_class, signal_kind, spec_ref, source, recorded_at
         FROM build_completions
        WHERE repo = @repo
          AND (@signalKind IS NULL OR signal_kind = @signalKind)
        ORDER BY COALESCE(recorded_at, '') DESC,
                 completion_id DESC
        LIMIT 1`,
      {
        repo: normalizedRepo,
        signalKind: normalizedSignalKind,
      },
    );
  } else if (resolution.target.backend === 'postgres') {
    queried = queryPostgresRows(
      resolution.target,
      `SELECT json_build_object(
          'completion_id', completion_id,
          'ticket_id', ticket_id,
          'launch_request_id', launch_request_id,
          'dagrun_id', dagrun_id,
          'dagrun_step_ticket_id', dagrun_step_ticket_id,
          'repo', repo,
          'pr_number', pr_number,
          'pr_url', pr_url,
          'head_sha', head_sha,
          'branch', branch,
          'worker_class', worker_class,
          'signal_kind', signal_kind,
          'spec_ref', spec_ref,
          'source', source,
          'recorded_at', recorded_at
        )
         FROM (
           SELECT completion_id, ticket_id, launch_request_id, dagrun_id,
                  dagrun_step_ticket_id, repo, pr_number, pr_url, head_sha,
                  branch, worker_class, signal_kind, spec_ref, source, recorded_at
            FROM build_completions
            WHERE repo = :'repo'
              AND (:'signal_kind' = '' OR signal_kind = :'signal_kind')
            ORDER BY COALESCE(recorded_at::text, '') DESC,
                     completion_id DESC
            LIMIT 1
         ) latest_build_completion`,
      {
        spawnSyncImpl,
        psqlVars: [
          ['repo', normalizedRepo],
          ['signal_kind', normalizedSignalKind || ''],
        ],
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
      reason: 'missing-build-completion-producer-evidence',
      repo: normalizedRepo,
      signalKind: normalizedSignalKind,
      target: queried.target,
    };
  }
  return { ok: true, row, target: queried.target };
}

function readWorkerRunUsageFromPostgres(target, {
  workerRunId = null,
  launchRequestId = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  // The live postgres ledger carries the current worker_runs schema, so the
  // guardrail column always exists here (unlike historical sqlite ledgers,
  // which the sqlite path probes for). Select the fixed column set, matching
  // the sibling postgres readers in this file.
  const jsonSelect = (whereClause, psqlVars) => queryPostgresRows(
    target,
    `SELECT json_build_object(
        'run_id', run_id,
        'launch_request_id', launch_request_id,
        'session_id', session_id,
        'token_usage_input', token_usage_input,
        'token_usage_output', token_usage_output,
        'token_usage_guardrail', token_usage_guardrail,
        'token_usage_cost_usd', token_usage_cost_usd,
        'token_usage_source', token_usage_source,
        'started_at', started_at,
        'ended_at', ended_at,
        'updated_at', updated_at,
        'total_cache_read_tokens', total_cache_read_tokens,
        'total_cache_write_tokens', total_cache_write_tokens
      )
       FROM (
         SELECT wr.run_id, wr.launch_request_id, wr.session_id,
                wr.token_usage_input, wr.token_usage_output, wr.token_usage_guardrail,
                wr.token_usage_cost_usd, wr.token_usage_source,
                wr.started_at, wr.ended_at, wr.updated_at,
                rs.total_cache_read_tokens, rs.total_cache_write_tokens
           FROM worker_runs wr
           LEFT JOIN runtime_sessions rs ON rs.session_id = wr.session_id
          WHERE ${whereClause}
          ORDER BY COALESCE(wr.updated_at::text, wr.ended_at::text, wr.started_at::text, '') DESC,
                   wr.run_id DESC
          LIMIT 1
       ) worker_run_usage`,
    { spawnSyncImpl, psqlVars },
  );
  if (workerRunId) {
    const queried = jsonSelect(`wr.run_id = :'worker_run_id'`, [['worker_run_id', String(workerRunId)]]);
    if (!queried.ok) return queried;
    const [row] = queried.rows;
    if (row) return { ok: true, row, target: queried.target };
  }
  const normalizedLaunchRequestId = normalizeText(launchRequestId);
  if (!normalizedLaunchRequestId) return { ok: false, reason: 'missing-worker-run-selector', target };
  const queried = jsonSelect(`wr.launch_request_id = :'launch_request_id'`, [['launch_request_id', normalizedLaunchRequestId]]);
  if (!queried.ok) return queried;
  const [row] = queried.rows;
  return row ? { ok: true, row, target: queried.target } : { ok: false, reason: 'missing-worker-run-row', target: queried.target };
}

export function readWorkerRunUsageFromLedger({
  workerRunId = null,
  launchRequestId = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
  spawnSyncImpl = spawnSync,
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
  if (resolution.target.backend === 'postgres') {
    return readWorkerRunUsageFromPostgres(resolution.target, { workerRunId, launchRequestId, spawnSyncImpl });
  }
  if (resolution.target.backend !== 'sqlite') return unsupportedBackend(resolution.target);
  const guardrailColumn = sqliteTableHasColumn(resolution.target, 'worker_runs', 'token_usage_guardrail');
  if (!guardrailColumn.ok) return guardrailColumn;
  const guardrailColumnSql = guardrailColumn.exists
    ? 'wr.token_usage_guardrail'
    : 'NULL AS token_usage_guardrail';
  if (workerRunId) {
    const queried = querySqliteRows(
      resolution.target,
      `SELECT wr.run_id, wr.launch_request_id, wr.session_id,
              wr.token_usage_input, wr.token_usage_output,
              ${guardrailColumnSql},
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
            ${guardrailColumnSql},
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

function readReviewerSessionUsageFromPostgres(target, {
  adapterSessionKey = null,
  sessionKeys = [],
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  spawnSyncImpl = spawnSync,
} = {}) {
  // started_at / ended_at are TIMESTAMPTZ on the postgres backend, so the
  // window bounds compare as timestamps (never `COALESCE(col, '')`, which is a
  // hard error against a TIMESTAMPTZ column). NULL handling mirrors the sqlite
  // COALESCE(..., '') sentinel: a NULL started_at still satisfies the upper
  // bound, and a row with both timestamps NULL fails the lower bound.
  const windowClauses = [];
  const windowVars = [];
  if (endedAt) {
    windowClauses.push(`(started_at IS NULL OR started_at <= :'window_end'::timestamptz)`);
    windowVars.push(['window_end', endedAt]);
  }
  if (startedAt) {
    windowClauses.push(`COALESCE(ended_at, started_at) >= :'window_start'::timestamptz`);
    windowVars.push(['window_start', startedAt]);
  }
  const windowSql = windowClauses.length ? `AND ${windowClauses.join(' AND ')}` : '';
  const jsonSelect = (whereClause, psqlVars) => queryPostgresRows(
    target,
    `SELECT json_build_object(
        'session_id', session_id,
        'adapter_session_key', adapter_session_key,
        'total_input_tokens', total_input_tokens,
        'total_output_tokens', total_output_tokens,
        'total_cache_read_tokens', total_cache_read_tokens,
        'total_cache_write_tokens', total_cache_write_tokens,
        'total_cost_usd', total_cost_usd,
        'source_path', source_path,
        'started_at', started_at,
        'ended_at', ended_at,
        'updated_at', updated_at
      )
       FROM (
         SELECT session_id, adapter_session_key, total_input_tokens, total_output_tokens,
                total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
                source_path, started_at, ended_at, ended_at AS updated_at
           FROM runtime_sessions
          WHERE ${whereClause}
            ${windowSql}
          ORDER BY COALESCE(ended_at::text, started_at::text, '') DESC,
                   session_id DESC
          LIMIT 1
       ) runtime_session_usage`,
    { spawnSyncImpl, psqlVars },
  );
  const keys = [...new Set([adapterSessionKey, ...sessionKeys].filter(Boolean).map(String))];
  if (keys.length > 0) {
    const keyPlaceholders = keys.map((_, idx) => `:'key${idx}'`).join(', ');
    const keyVars = keys.map((key, idx) => [`key${idx}`, key]);
    const queried = jsonSelect(`adapter_session_key IN (${keyPlaceholders})`, [...keyVars, ...windowVars]);
    if (!queried.ok) return queried;
    const [row] = queried.rows;
    if (row) return { ok: true, row, target: queried.target };
  }
  const normalizedWorkspacePath = normalizeText(workspacePath);
  if (!normalizedWorkspacePath) return { ok: false, reason: 'missing-runtime-session-selector', target };
  const queried = jsonSelect(`source_path = :'workspace_path'`, [['workspace_path', normalizedWorkspacePath], ...windowVars]);
  if (!queried.ok) return queried;
  const [row] = queried.rows;
  return row ? { ok: true, row, target: queried.target } : { ok: false, reason: 'missing-runtime-session-row', target: queried.target };
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
  spawnSyncImpl = spawnSync,
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
  if (resolution.target.backend === 'postgres') {
    return readReviewerSessionUsageFromPostgres(resolution.target, {
      adapterSessionKey,
      sessionKeys,
      workspacePath,
      startedAt,
      endedAt,
      spawnSyncImpl,
    });
  }
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

// ROUTEPROV-01: latest PR build completion -> LRQ -> actual launch identity.
// Builder identity survives follow-up commits; review/retrigger guards still
// bind to the current head independently.
// These reads never touch PgBouncer session settings or mutate the ledger.
export function readPrBuilderProvenance({
  repo, prNumber, env = process.env, rootDir = null,
  ledgerTarget = null, spawnSyncImpl = spawnSync, sleepSyncImpl = sleepSync,
} = {}) {
  const normalizedRepo = normalizeText(repo);
  const numericPrNumber = Number(prNumber);
  if (!normalizedRepo || !Number.isInteger(numericPrNumber) || numericPrNumber <= 0) {
    return { ok: false, reason: 'missing-pr-identity' };
  }
  const resolution = resolveSessionLedgerReadTarget({ ledgerTarget, env, rootDir,
    requiredTables: ['build_completions', 'launch_requests', 'worker_runs'],
  });
  if (!resolution.ok) return resolution;
  if (resolution.target.backend === 'sqlite') {
    const queried = querySqliteRows(resolution.target, `
      SELECT lr.launch_request_id AS launchRequestId,
             lr.worker_class AS workerClass,
             COALESCE(
               NULLIF(json_extract(lr.request_payload_json, '$.actualHarness'), ''),
               NULLIF(json_extract(lr.request_payload_json, '$.workerSpec.harness'), ''),
               NULLIF((
                 SELECT json_extract(wr.metadata_json, '$.actualHarness')
                 FROM worker_runs wr
                 WHERE wr.launch_request_id = lr.launch_request_id
                 ORDER BY wr.created_at DESC, wr.run_id DESC LIMIT 1
               ), ''),
               NULLIF(lr.worker_class, '')
             ) AS actualHarness
      FROM build_completions bc
      JOIN launch_requests lr ON lr.launch_request_id = bc.launch_request_id
      WHERE bc.repo = @repo AND bc.pr_number = @prNumber
      ORDER BY bc.recorded_at DESC, bc.completion_id DESC LIMIT 1`,
    { repo: normalizedRepo, prNumber: numericPrNumber });
    if (!queried.ok) return queried;
    return queried.rows.length
      ? { ok: true, ...queried.rows[0] }
      : { ok: false, reason: 'missing-builder-provenance' };
  }
  if (resolution.target.backend !== 'postgres') return unsupportedBackend(resolution.target);
  const target = { ...resolution.target };
  try {
    const url = new URL(target.dsn);
    url.hostname = '127.0.0.1';
    url.port = '5432';
    target.dsn = url.toString();
  } catch {
    // databaseName-only and libpq keyword/value targets are valid too. The
    // transaction-scoped READ ONLY guard is safe through PgBouncer.
    console.warn('[builder-routing] direct ledger DSN unavailable; using configured Postgres target');
  }
  const queried = queryPostgresRowsWithRetry(target, `
    SELECT json_build_object(
      'launchRequestId', lr.launch_request_id,
      'workerClass', lr.worker_class,
      'actualHarness', COALESCE(
        NULLIF(lr.request_payload_json::jsonb->>'actualHarness', ''),
        NULLIF(lr.request_payload_json::jsonb->'workerSpec'->>'harness', ''),
        NULLIF(wr.metadata_json::jsonb->>'actualHarness', ''),
        NULLIF(lr.worker_class, '')
      )
    )
    FROM build_completions bc
    JOIN launch_requests lr ON lr.launch_request_id = bc.launch_request_id
    LEFT JOIN LATERAL (
      SELECT metadata_json FROM worker_runs
      WHERE launch_request_id = lr.launch_request_id
      ORDER BY created_at DESC, run_id DESC LIMIT 1
    ) wr ON true
    WHERE bc.repo = :'repo' AND bc.pr_number = :'pr_number'::integer
    ORDER BY bc.recorded_at DESC, bc.completion_id DESC LIMIT 1`, {
    spawnSyncImpl,
    sleepSyncImpl,
    readOnly: true,
    psqlVars: [['repo', normalizedRepo], ['pr_number', String(numericPrNumber)]],
  });
  // A failed query cannot establish that provenance is absent. Defer claims
  // until a later tick rather than permanently assigning the title route.
  if (!queried.ok) return { ...queried, deferClaim: true };
  return queried.rows.length
    ? { ok: true, ...queried.rows[0] }
    : { ok: false, reason: 'missing-builder-provenance' };
}
