import { readDispatchLaunches, readDispatchLaunchesSync, launchProbe, readWorkerObservation, readWorkerObservationSync } from './dispatch-read-client.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { observeSynchronousChild } from './watcher-latency.mjs';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { loadConfig } from './config-loader.mjs';
import { withLiveLaunchRetry, launchRequestInFlight, isTerminalLaunchRequestStatus, launchRequestMeaning } from './ama/launch-request-status.mjs';

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

export function configuredSessionLedgerBackend({ env }) {
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
  // LAC-2091: `.hq/config.json` ledgerDbPath is an implicit SQLite-era
  // default, not a caller choice. The canonical Python resolver
  // (session_ledger.db_path.resolve_ledger_target) consults it only once the
  // backend resolves to SQLite, so a stale pointer must not outrank a
  // configured Postgres backend. Explicit and env SQLite targets above still
  // fail closed under Postgres.
  if (configuredSessionLedgerBackend({ env }) !== 'postgres') {
    const legacyHqLedgerDbPath = readLegacyHqLedgerDbPath(hqRoot || env.HQ_ROOT);
    if (legacyHqLedgerDbPath) {
      const result = usableSqliteTargetFromPath(legacyHqLedgerDbPath, 'legacy-hq-config', {
        requiredTables,
      });
      if (result.ok || result.reason === 'malformed-ledger-target') return result;
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
const PSQL_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
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
  return /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EAGAIN|EIO)$/.test(String(error?.code || ''))
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
      detail: `psql timed out after ${result.error.timeoutMs ?? PSQL_TIMEOUT_MS}ms`,
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

function queryPostgresRows(...args) { return runLedgerStepsSync(queryPostgresRowsSteps(...args)); }

function* queryPostgresRowsSteps(target, jsonSql, { spawnSyncImpl = spawnSync, psqlVars = [], readOnly = false, timeoutMs = null } = {}) {
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
      const sql = String(jsonSql).trim();
      // Conditional scripts terminate SQL inside each branch. Keep the final
      // psql meta-command intact rather than appending a statement terminator.
      const terminatedSql = /(?:;|\\endif)$/.test(sql) ? sql : `${sql};`;
      const statement = readOnly
        ? `BEGIN READ ONLY;\n${terminatedSql}\nCOMMIT;`
        : jsonSql;
      const script = `${statement}\n`;
      args.push(...spawnConfig.args, '-t', '-A');
      result = yield { kind: 'child', command: 'psql', args, spawnSyncImpl, options: {
        encoding: 'utf8',
        env: spawnConfig.env,
        timeout: timeoutMs ?? loadAwareTimeoutMs(PSQL_TIMEOUT_MS),
        killSignal: PSQL_TIMEOUT_SIGNAL,
        maxBuffer: PSQL_MAX_BUFFER_BYTES,
        input: script,
      } };
    } else {
      args.push(...spawnConfig.args, '-t', '-A', '-c', jsonSql);
      result = yield { kind: 'child', command: 'psql', args, spawnSyncImpl, options: {
        encoding: 'utf8',
        env: spawnConfig.env,
        timeout: timeoutMs ?? loadAwareTimeoutMs(PSQL_TIMEOUT_MS),
        killSignal: PSQL_TIMEOUT_SIGNAL,
        maxBuffer: PSQL_MAX_BUFFER_BYTES,
      } };
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

function workerSelector(args) {
  return {observation:'workers', launch_request_id:args.launchRequestId,
    worker_run_id:args.workerRunId, limit:100};
}
export function readLatestWorkerRunStatusFromLedger(args = {}) {
  if (!normalizeText(args.launchRequestId)) return {ok:false,reason:'missing-launch-request-id'};
  return readWorkerObservationSync(workerSelector(args), args);
}
export async function readLatestWorkerRunStatusFromLedgerAsync(args = {}) {
  if (!normalizeText(args.launchRequestId)) return {ok:false,reason:'missing-launch-request-id'};
  return readWorkerObservation(workerSelector(args), args);
}

// The SDK transports producer-owned launch identity and retry evidence.
export async function readLaunchRequestSnapshotFromLedgerAsync(args = {}) {
  const ids = args.launchRequestIds ?? [];
  if (!ids.length) return { ok: true, rows: [], roots: [], retryEdges: [] };
  return readDispatchLaunches({ launch_request_ids: ids, include_retry_chain: true }, args);
}
export async function readLaunchRequestByIdempotencyKeyAsync(args = {}) {
  if (!normalizeText(args.idempotencyKey)) return { ok: false, reason: 'missing-idempotency-key' };
  return readDispatchLaunches({ idempotency_key: args.idempotencyKey }, args);
}
export async function readLaunchRequestsForTicketSinceAsync(args = {}) {
  if (!normalizeText(args.ticketRef) || typeof args.requestedAtOrAfter !== 'string'
    || !Number.isFinite(Date.parse(args.requestedAtOrAfter))) {
    return { ok: false, reason: 'invalid-ticket-attempt-query' };
  }
  return readDispatchLaunches({ ticket_ref: args.ticketRef,
    requested_at_or_after: new Date(args.requestedAtOrAfter).toISOString() }, args);
}

// With includeRetryChain, incomplete traversal makes the whole read unavailable.
// No base-row status or absence evidence escapes an incomplete SDK reply.
export function readLaunchRequestStatusFromLedger(args = {}) {
  if (!normalizeText(args.launchRequestId)) return { ok: false, reason: 'missing-launch-request-id' };
  const result = args.launchSnapshot ?? readDispatchLaunchesSync({
    launch_request_ids: [args.launchRequestId], include_retry_chain: !!args.includeRetryChain }, args);
  return launchProbe(result, args.launchRequestId, args.includeRetryChain);
}
export async function readLaunchRequestStatusFromLedgerAsync(args = {}) {
  if (!normalizeText(args.launchRequestId)) return { ok: false, reason: 'missing-launch-request-id' };
  const result = args.launchSnapshot ?? await readDispatchLaunches({
    launch_request_ids: [args.launchRequestId], include_retry_chain: !!args.includeRetryChain }, args);
  return launchProbe(result, args.launchRequestId, args.includeRetryChain);
}

// Collection seam only. Reuse the existing bounded ledger target/retry reader;
// terminal launch evidence outranks a stale worker projection. Neither process
// success nor a wake supplies evidence of a remote merge.
export async function readLaunchRequestObservationFromLedgerAsync({
  readLaunchRequestStatusImpl = readLaunchRequestStatusFromLedgerAsync,
  readWorkerStatusImpl = readLatestWorkerRunStatusFromLedgerAsync,
  ...args
} = {}) {
  const launch = await readLaunchRequestStatusImpl({ ...args, includeRetryChain: true });
  const effective = withLiveLaunchRetry(launch);
  const chainReadable = Array.isArray(launch?.retryChain) && launch.retryChainUnreadable !== true;
  const ownershipProbe = chainReadable ? effective : { ...effective, retryChainUnreadable: true };
  const statusKnown = Boolean(launchRequestMeaning(effective?.row).status)
    || typeof effective?.row?.terminal === 'boolean';
  let worker = null;
  if (effective?.ok && ['starting', 'running'].includes(effective.row?.status)) {
    worker = await readWorkerStatusImpl({ ...args,
      launchRequestId: effective.liveRetryLaunchRequestId || effective.row?.launch_request_id || args.launchRequestId });
  }
  return {
    state: !effective?.ok || !statusKnown || !chainReadable ? 'unknown' : 'complete',
    value: {
      launchRequestId: args.launchRequestId,
      launch: launch?.row ?? null,
      retryChain: launch?.retryChain ?? null,
      retryChainUnreadable: !chainReadable,
      effectiveLaunch: effective?.row ?? null,
      liveRetryLaunchRequestId: effective?.liveRetryLaunchRequestId ?? null,
      worker: worker?.ok ? worker.row : null,
      inFlight: statusKnown ? launchRequestInFlight(ownershipProbe) : null,
      terminal: statusKnown && launchRequestInFlight(ownershipProbe) === false
        && isTerminalLaunchRequestStatus(effective?.row),
      processSucceeded: launchRequestMeaning(effective?.row).succeeded,
      // The PR observation owns merged/closed receipts, independently.
      remoteMerge: null,
    },
    provenance: { sourceRef: 'launch-requests', backend: launch?.target?.backend ?? null,
      launchRead: launch?.ok === true, launchReadReason: launch?.reason ?? null,
      retryReadReason: launch?.retryChainFailure?.reason ?? null, workerRead: worker?.ok ?? null,
      workerReadReason: worker?.reason ?? null },
  };
}

// LIVEPACK-01: non-terminal dag_runs states. `parked` is non-terminal (a
// parked run resumes), so it counts as live. `awaiting-merge` is a step state
// in the current schema; it is listed so a future run-level state of that name
// is covered without a code change.
export const LIVE_DAG_RUN_STATES = Object.freeze(['pending', 'running', 'parked', 'awaiting-merge']);
const DAG_RUN_STATE_RE = /^[a-z][a-z0-9_-]*$/;
const MAX_ACTIVE_DAG_RUNS = 20;

function* queryPostgresRowsWithRetrySteps(target, sql, { sleepSyncImpl = sleepSync, ...options } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = yield* queryPostgresRowsSteps(target, sql, options);
    if (result.ok || !result.transient || attempt === 3) return result;
    yield { kind: 'delay', ms: 100 * attempt, sleepSyncImpl };
  }
}

// Read the non-terminal DAG runs of one plan. One indexed, LIMIT-bounded
// SELECT (idx_dag_runs_plan_state covers plan_id + state), with at most three
// attempts and 100/200ms backoff for transient Postgres failures, run inside a
// read-only transaction on Postgres and a readonly handle on SQLite. Returns
// `{ ok: true, runs }` or `{ ok: false, reason, detail }`; callers that gate
// on liveness must treat `ok: false` as inconclusive, never as "not live".
export function readActiveDagRunsForPlan(args) { return runLedgerStepsSync(readActiveDagRunsForPlanSteps(args)); }
export function readActiveDagRunsForPlanAsync(args = {}) { return runLedgerStepsAsync(readActiveDagRunsForPlanSteps(args), args); }

function* readActiveDagRunsForPlanSteps({
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
    queried = yield* queryPostgresRowsWithRetrySteps(
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

export function readBuildCompletionSignalForPr(args) { return runLedgerStepsSync(readBuildCompletionSignalForPrSteps(args)); }
export function readBuildCompletionSignalForPrAsync(args = {}) { return runLedgerStepsAsync(readBuildCompletionSignalForPrSteps(args), args); }

function* readBuildCompletionSignalForPrSteps({
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
    queried = yield* queryPostgresRowsSteps(
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

export function readBuildCompletionProducerEvidence(args) { return runLedgerStepsSync(readBuildCompletionProducerEvidenceSteps(args)); }
export function readBuildCompletionProducerEvidenceAsync(args = {}) { return runLedgerStepsAsync(readBuildCompletionProducerEvidenceSteps(args), args); }

function* readBuildCompletionProducerEvidenceSteps({
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
    queried = yield* queryPostgresRowsSteps(
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

export function readWorkerRunUsageFromLedger(args = {}) {
  if (!args.workerRunId && !normalizeText(args.launchRequestId)) return {ok:false,reason:'missing-worker-run-selector'};
  return readWorkerObservationSync(workerSelector(args), args);
}
export function readReviewerSessionUsageFromLedger(args = {}) {
  const keys = [...new Set([args.adapterSessionKey, ...(args.sessionKeys ?? [])].filter(Boolean))];
  if (!keys.length) return {ok:false,reason:'missing-runtime-session-selector'};
  const result = readWorkerObservationSync({observation:'sessions',session_keys:keys,limit:100}, args);
  if (!result.ok) return result;
  const rows = result.rows.filter(row => {
    const startedAt = normalizeText(row.started_at);
    const lastActiveAt = normalizeText(row.ended_at) || startedAt;
    // Preserve the ledger window semantics explicitly: unknown starts satisfy
    // the upper bound, but unknown activity cannot satisfy a lower bound.
    return (!args.endedAt || !startedAt || Date.parse(startedAt) <= Date.parse(args.endedAt))
      && (!args.startedAt || lastActiveAt !== null && Date.parse(lastActiveAt) >= Date.parse(args.startedAt));
  });
  return rows.length ? {...result,rows,row:rows[0]} : {ok:false,reason:'no-session-in-window'};
}

// ROUTEPROV-01: latest PR build completion -> LRQ -> actual launch identity.
// Builder identity survives follow-up commits; review/retrigger guards still
// bind to the current head independently.
// These reads never touch PgBouncer session settings or mutate the ledger.
function builderSelector(args) {
  return {observation:'provenance',repo:args.repo,pr_number:Number(args.prNumber),builder_identity:true,limit:100};
}
function builderResult(result) {
  // Review intake may retain a valid title route even when observations are
  // disabled, unsupported or inconclusive. This result is never merge identity
  // or an absence certificate; authority readers retain the original failure.
  return result.ok ? {ok:true,launchRequestId:result.row.launch_request_id,
    workerClass:result.row.worker_class,actualHarness:result.row.actual_harness}
    : {...result,reason:result.reason === 'worker-observation-inconclusive' ? 'missing-builder-provenance' : result.reason,
      deferClaim:false};
}
export function readPrBuilderProvenance(args = {}) {
  if (!normalizeText(args.repo) || !Number.isInteger(Number(args.prNumber)) || Number(args.prNumber)<=0) return {ok:false,reason:'missing-pr-identity'};
  return builderResult(readWorkerObservationSync(builderSelector(args), args));
}
export async function readPrBuilderProvenanceAsync(args = {}) {
  if (!normalizeText(args.repo) || !Number.isInteger(Number(args.prNumber)) || Number(args.prNumber)<=0) return {ok:false,reason:'missing-pr-identity'};
  return builderResult(await readWorkerObservation(builderSelector(args), args));
}

// One set of query/validation rules, two execution modes. CLI consumers keep
// their synchronous contract; watcher callers await children and retry delays.
function runLedgerStepsSync(iterator) {
  let step = iterator.next();
  while (!step.done) {
    try {
      const effect = step.value;
      const result = effect.kind === 'delay' ? effect.sleepSyncImpl(effect.ms)
        : observeSynchronousChild(effect.command, () => effect.spawnSyncImpl(effect.command, effect.args, effect.options));
      step = iterator.next(result);
    } catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}

async function runLedgerStepsAsync(iterator, { timeoutMs = null, signal = null, spawnAsyncImpl, spawnSyncImpl, delayAsyncImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Only adapt an explicitly injected sync executor: effects also carry the
  // real spawnSync default, which must never replace the async production path.
  const spawnImpl = spawnAsyncImpl || spawnSyncImpl || spawnLedgerChild;
  let step = iterator.next();
  while (!step.done) {
    try {
      const effect = step.value;
      const result = effect.kind === 'delay' ? await delayAsyncImpl(effect.ms)
        : await spawnImpl(effect.command, effect.args, { ...effect.options,
          ...(signal ? { signal } : {}),
          timeout: timeoutMs == null ? effect.options.timeout : Math.min(effect.options.timeout, Math.max(1, timeoutMs)) });
      step = iterator.next(result);
    } catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}

function spawnLedgerChild(command, args, options) {
  return new Promise(resolve => {
    // Retry traversal returns only chain status rows, never table snapshots or
    // metadata. Keep a hard memory bound; an unusually large chain still fails
    // explicitly as unreadable rather than returning truncated ownership proof.
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      const failure = error && typeof error.code !== 'number' ? error : null;
      if (failure?.killed && failure.signal === options.killSignal && (failure.code == null || failure.code === 'ETIMEDOUT')) {
        failure.code = 'ETIMEDOUT'; failure.timeoutMs = options.timeout;
      }
      resolve({ stdout, stderr, status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal || null, error: failure });
    });
    // psql variable substitution uses stdin script mode. End even an empty
    // input, so a child waiting on stdin cannot hold admission indefinitely.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}

// RCV-07 consumer export, using the same canonical target and bounded read
// paths as launch status. No classifier, migrations or writes run here.
export function readExecutionVerdictsFromLedger(args = {}) {
  return runLedgerStepsSync(readExecutionVerdictsSteps(args));
}
export function readExecutionVerdictsFromLedgerAsync(args = {}) {
  return runLedgerStepsAsync(readExecutionVerdictsSteps(args), args);
}
function* readExecutionVerdictsSteps({ launchRequestId = null, ledgerTarget = null,
  ledgerDbPath = null, env = process.env, rootDir = process.cwd(), hqRoot = null,
  spawnSyncImpl = spawnSync } = {}) {
  const resolution = resolveSessionLedgerReadTarget({ ledgerTarget, ledgerDbPath,
    requiredTables: ['execution_verdicts'], env, rootDir, hqRoot });
  if (!resolution.ok) return { ok: false, reason: 'execution-verdict-source-unavailable' };
  const columns = 'launch_request_id, attempt, verdict_id, verdict, reason, evidence_refs_json, producer, schema_version, observed_at';
  let result;
  if (resolution.target.backend === 'sqlite') {
    result = querySqliteRows(resolution.target, `SELECT ${columns} FROM execution_verdicts
      ${launchRequestId ? 'WHERE launch_request_id = @launchRequestId' : ''}
      ORDER BY observed_at DESC LIMIT 100`, launchRequestId ? { launchRequestId } : {});
  } else if (resolution.target.backend === 'postgres') {
    result = yield* queryPostgresRowsSteps(resolution.target,
      `SELECT row_to_json(v) FROM (SELECT ${columns} FROM execution_verdicts
      ${launchRequestId ? "WHERE launch_request_id = :'lrq'" : ''}
      ORDER BY observed_at DESC LIMIT 100) v`, {
        spawnSyncImpl, readOnly: true, psqlVars: launchRequestId ? [['lrq', launchRequestId]] : [],
      });
  } else return { ok: false, reason: 'execution-verdict-source-unavailable' };
  if (!result.ok) return { ok: false, reason: 'execution-verdict-source-unavailable' };
  try {
    return { ok: true, source: 'session_ledger.execution_verdicts.ExecutionVerdict.export',
      verdicts: result.rows.map(row => ({ launchRequestId: row.launch_request_id,
        attempt: row.attempt, verdictId: row.verdict_id, verdict: row.verdict,
        reason: row.reason, evidenceRefs: typeof row.evidence_refs_json === 'string'
          ? JSON.parse(row.evidence_refs_json) : row.evidence_refs_json,
        producer: row.producer, schemaVersion: row.schema_version, observedAt: row.observed_at })) };
  } catch { return { ok: false, reason: 'execution-verdict-source-invalid' }; }
}
