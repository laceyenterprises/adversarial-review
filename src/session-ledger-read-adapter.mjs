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
    // psql's `-v name=value` variable substitution is NOT applied to SQL
    // passed via `-c` — `-c` sends the command directly to the server
    // without psql-side preprocessing. That means `:'lrq'` style
    // placeholders are forwarded literally, causing the server to raise
    // `syntax error at or near ":"`. To make `:'name'` substitution work,
    // either `-f /dev/stdin` (script mode) with `\set` prepended, or stdin
    // piping.
    //
    // Surfaced 2026-06-08T18:24Z when the adversarial-watcher's
    // merge-agent dispatcher began failing to look up worker-runs for
    // PR #1569 and PR #1570 with this exact syntax error
    // (`merge_agent.tear_down_skipped reason=worker-run-lookup-failed`).
    // The merge-agent dispatch was getting skipped, leaving Comment-only
    // verdicts stuck and operator-blocking the cutover-replay pack.
    //
    // Fix: when psqlVars are supplied, switch to stdin (`-f /dev/stdin`
    // shape via the spawnSyncImpl `input` option) and prepend a
    // `\set name 'value'` line per variable. Empty psqlVars keeps the
    // `-c` fast path (no behavioral change for callers that don't
    // declare variables).
    const args = ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1'];
    for (const [name, value] of psqlVars) {
      args.push('-v', `${name}=${value}`);
    }
    let result;
    if (psqlVars.length > 0) {
      const setStanzas = psqlVars
        .map(([name, value]) =>
          // Escape any single-quote in the value to keep the psql
          // string literal balanced. Values originate from validated
          // ledger identifiers so the surface area is small, but
          // doubling single quotes is the canonical SQL escape and
          // costs nothing.
          `\\set ${name} '${String(value).replace(/'/g, "''")}'`,
        )
        .join('\n');
      const script = `${setStanzas}\n${jsonSql}\n`;
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
