import Database from 'better-sqlite3';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getFollowUpJobDir, readFollowUpJob } from './follow-up-jobs.mjs';

const VALID_REVIEWER_CLASSES = new Set(['claude', 'codex']);
const VALID_PASS_KINDS = new Set(['first-pass', 'remediation', 'rereview']);
const VALID_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const SESSION_LEDGER_SOURCES = new Set(['session-ledger', 'litellm', 'mixed']);

function ensureReviewerPassesSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviewer_passes (
      pass_id              INTEGER PRIMARY KEY AUTOINCREMENT,
      repo                 TEXT NOT NULL,
      pr_number            INTEGER NOT NULL,
      attempt_number       INTEGER NOT NULL,
      reviewer_class       TEXT NOT NULL,
      pass_kind            TEXT NOT NULL,
      worker_run_id        TEXT,
      workspace_path       TEXT,
      started_at           TEXT NOT NULL,
      ended_at             TEXT,
      status               TEXT NOT NULL,
      token_input          INTEGER,
      token_output         INTEGER,
      token_cache_read     INTEGER,
      token_cache_write    INTEGER,
      token_cost_usd       REAL,
      token_source         TEXT,
      metadata_json        TEXT NOT NULL DEFAULT '{}',
      UNIQUE(repo, pr_number, attempt_number, pass_kind)
    );

    CREATE INDEX IF NOT EXISTS idx_reviewer_passes_pr
      ON reviewer_passes(repo, pr_number);
    CREATE INDEX IF NOT EXISTS idx_reviewer_passes_started
      ON reviewer_passes(started_at);
  `);
}

function normalizeReviewerClass(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.includes('codex') || raw.includes('gpt')) return 'codex';
  if (raw.includes('claude') || raw.includes('anthropic')) return 'claude';
  if (VALID_REVIEWER_CLASSES.has(raw)) return raw;
  return 'codex';
}

function normalizePassKind(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!VALID_PASS_KINDS.has(normalized)) {
    throw new TypeError(`Invalid reviewer pass kind: ${value}`);
  }
  return normalized;
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!VALID_STATUSES.has(normalized)) {
    throw new TypeError(`Invalid reviewer pass status: ${value}`);
  }
  return normalized;
}

function normalizeAttemptNumber(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new TypeError(`Invalid reviewer pass attempt number: ${value}`);
  }
  return numeric;
}

function metadataString(metadata) {
  if (metadata == null) return '{}';
  if (typeof metadata === 'string') {
    const trimmed = metadata.trim();
    if (!trimmed) return '{}';
    JSON.parse(trimmed);
    return trimmed;
  }
  return JSON.stringify(metadata);
}

function insertReviewerPassStarted(db, {
  repo,
  prNumber,
  attemptNumber,
  reviewerClass,
  passKind,
  workerRunId = null,
  workspacePath = null,
  startedAt = new Date().toISOString(),
  metadata = {},
}) {
  ensureReviewerPassesSchema(db);
  const normalized = {
    repo: String(repo || '').trim(),
    prNumber: Number(prNumber),
    attemptNumber: normalizeAttemptNumber(attemptNumber),
    reviewerClass: normalizeReviewerClass(reviewerClass),
    passKind: normalizePassKind(passKind),
    workerRunId: workerRunId ? String(workerRunId) : null,
    workspacePath: workspacePath ? String(workspacePath) : null,
    startedAt: String(startedAt || new Date().toISOString()),
    metadataJson: metadataString(metadata),
  };
  if (!normalized.repo || !Number.isInteger(normalized.prNumber)) {
    throw new TypeError('repo and prNumber are required for reviewer pass tracking');
  }

  db.prepare(
    `INSERT OR IGNORE INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, pass_kind,
        worker_run_id, workspace_path, started_at, status, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
  ).run(
    normalized.repo,
    normalized.prNumber,
    normalized.attemptNumber,
    normalized.reviewerClass,
    normalized.passKind,
    normalized.workerRunId,
    normalized.workspacePath,
    normalized.startedAt,
    normalized.metadataJson,
  );

  return getReviewerPass(db, normalized);
}

function getReviewerPass(db, { repo, prNumber, attemptNumber, passKind }) {
  return db.prepare(
    `SELECT *
       FROM reviewer_passes
      WHERE repo = ?
        AND pr_number = ?
        AND attempt_number = ?
        AND pass_kind = ?`
  ).get(String(repo), Number(prNumber), normalizeAttemptNumber(attemptNumber), normalizePassKind(passKind)) || null;
}

function updateReviewerPassCompleted(db, {
  repo,
  prNumber,
  attemptNumber,
  passKind,
  endedAt = new Date().toISOString(),
  status = 'completed',
  tokenUsage = null,
  metadataPatch = null,
}) {
  ensureReviewerPassesSchema(db);
  const current = getReviewerPass(db, { repo, prNumber, attemptNumber, passKind });
  const nextMetadata = mergeMetadataJson(current?.metadata_json, metadataPatch);
  const usage = normalizeTokenUsage(tokenUsage);
  db.prepare(
    `UPDATE reviewer_passes
        SET ended_at = ?,
            status = ?,
            token_input = COALESCE(?, token_input),
            token_output = COALESCE(?, token_output),
            token_cache_read = COALESCE(?, token_cache_read),
            token_cache_write = COALESCE(?, token_cache_write),
            token_cost_usd = COALESCE(?, token_cost_usd),
            token_source = COALESCE(?, token_source),
            metadata_json = ?
      WHERE repo = ?
        AND pr_number = ?
        AND attempt_number = ?
        AND pass_kind = ?`
  ).run(
    String(endedAt || new Date().toISOString()),
    normalizeStatus(status),
    usage?.input ?? null,
    usage?.output ?? null,
    usage?.cacheRead ?? null,
    usage?.cacheWrite ?? null,
    usage?.costUSD ?? null,
    usage?.source ?? null,
    nextMetadata,
    String(repo),
    Number(prNumber),
    normalizeAttemptNumber(attemptNumber),
    normalizePassKind(passKind),
  );
  return getReviewerPass(db, { repo, prNumber, attemptNumber, passKind });
}

function upsertReviewerPass(db, pass) {
  ensureReviewerPassesSchema(db);
  const usage = normalizeTokenUsage(pass.tokenUsage || pass);
  const metadataJson = metadataString(pass.metadata || pass.metadataJson || {});
  db.prepare(
    `INSERT INTO reviewer_passes
       (repo, pr_number, attempt_number, reviewer_class, pass_kind,
        worker_run_id, workspace_path, started_at, ended_at, status,
        token_input, token_output, token_cache_read, token_cache_write,
        token_cost_usd, token_source, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr_number, attempt_number, pass_kind) DO UPDATE SET
       reviewer_class = excluded.reviewer_class,
       worker_run_id = COALESCE(excluded.worker_run_id, reviewer_passes.worker_run_id),
       workspace_path = COALESCE(excluded.workspace_path, reviewer_passes.workspace_path),
       started_at = COALESCE(reviewer_passes.started_at, excluded.started_at),
       ended_at = COALESCE(excluded.ended_at, reviewer_passes.ended_at),
       status = excluded.status,
       token_input = COALESCE(excluded.token_input, reviewer_passes.token_input),
       token_output = COALESCE(excluded.token_output, reviewer_passes.token_output),
       token_cache_read = COALESCE(excluded.token_cache_read, reviewer_passes.token_cache_read),
       token_cache_write = COALESCE(excluded.token_cache_write, reviewer_passes.token_cache_write),
       token_cost_usd = COALESCE(excluded.token_cost_usd, reviewer_passes.token_cost_usd),
       token_source = COALESCE(excluded.token_source, reviewer_passes.token_source),
       metadata_json = excluded.metadata_json`
  ).run(
    String(pass.repo || '').trim(),
    Number(pass.prNumber ?? pass.pr_number),
    normalizeAttemptNumber(pass.attemptNumber ?? pass.attempt_number),
    normalizeReviewerClass(pass.reviewerClass ?? pass.reviewer_class),
    normalizePassKind(pass.passKind ?? pass.pass_kind),
    pass.workerRunId ?? pass.worker_run_id ?? null,
    pass.workspacePath ?? pass.workspace_path ?? null,
    String(pass.startedAt ?? pass.started_at ?? new Date().toISOString()),
    pass.endedAt ?? pass.ended_at ?? null,
    normalizeStatus(pass.status || 'completed'),
    usage?.input ?? null,
    usage?.output ?? null,
    usage?.cacheRead ?? null,
    usage?.cacheWrite ?? null,
    usage?.costUSD ?? null,
    usage?.source ?? null,
    metadataJson,
  );
}

function mergeMetadataJson(currentJson, patch) {
  if (!patch) return currentJson || '{}';
  let current = {};
  try {
    current = currentJson ? JSON.parse(currentJson) : {};
  } catch {}
  return metadataString({ ...current, ...patch });
}

function normalizeTokenUsage(usage) {
  if (!usage) return null;
  const source = String(usage.source || usage.token_source || '').trim() || null;
  return {
    input: coerceInteger(usage.input ?? usage.inputTokens ?? usage.token_input ?? usage.tokenUsageInput),
    output: coerceInteger(usage.output ?? usage.outputTokens ?? usage.token_output ?? usage.tokenUsageOutput),
    cacheRead: coerceInteger(
      usage.cacheRead
      ?? usage.cache_read
      ?? usage.cached_input_tokens
      ?? usage.cache_read_tokens
      ?? usage.token_cache_read
    ),
    cacheWrite: coerceInteger(
      usage.cacheWrite
      ?? usage.cache_write
      ?? usage.cache_creation_input_tokens
      ?? usage.cache_write_tokens
      ?? usage.token_cache_write
    ),
    costUSD: coerceFloat(usage.costUSD ?? usage.cost_usd ?? usage.token_cost_usd),
    source: source && (SESSION_LEDGER_SOURCES.has(source) || source === 'unknown') ? source : source,
  };
}

function coerceInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function coerceFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function resolveSessionLedgerDbPath({ rootDir = process.cwd(), env = process.env } = {}) {
  const candidates = [
    env.AGENT_OS_SESSION_LEDGER_DB_PATH,
    env.SESSION_LEDGER_DB_PATH,
    env.AGENT_OS_SESSION_LEDGER_SERVICE_ROOT
      ? join(env.AGENT_OS_SESSION_LEDGER_SERVICE_ROOT, 'ledger.db')
      : null,
    join(homedir(), '.agent-os', 'session-ledger', 'ledger.db'),
    join(rootDir, '.agent-os', 'session-ledger', 'ledger.db'),
    '/Users/airlock/.agent-os/session-ledger/ledger.db',
    '/Users/placey/.agent-os/session-ledger/ledger.db',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function readTokenUsageFromSessionLedger({
  rootDir = process.cwd(),
  dbPath = null,
  adapterSessionKeys = [],
  workerRunId = null,
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  env = process.env,
} = {}) {
  const resolvedDbPath = dbPath || resolveSessionLedgerDbPath({ rootDir, env });
  if (!resolvedDbPath || !existsSync(resolvedDbPath)) {
    return { tokenUsage: null, reason: 'ledger-db-missing', dbPath: resolvedDbPath || null };
  }

  const ledger = new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
  try {
    const runUsage = workerRunId
      ? readWorkerRunUsage(ledger, { workerRunId })
      : null;
    const sessionIds = new Set();
    if (runUsage?.sessionId) sessionIds.add(runUsage.sessionId);

    for (const session of findRuntimeSessions(ledger, {
      adapterSessionKeys,
      workspacePath,
    })) {
      sessionIds.add(session.session_id);
    }

    const transcriptUsage = sessionIds.size > 0
      ? aggregateTranscriptUsage(ledger, {
          sessionIds: [...sessionIds],
          startedAt: startedAt || runUsage?.startedAt || null,
          endedAt: endedAt || runUsage?.endedAt || null,
        })
      : null;

    const tokenUsage = mergeLedgerUsage(runUsage, transcriptUsage);
    return {
      tokenUsage,
      reason: tokenUsage ? null : 'no-token-usage',
      dbPath: resolvedDbPath,
      sessionIds: [...sessionIds],
    };
  } catch (err) {
    return {
      tokenUsage: null,
      reason: `ledger-read-error:${err?.message || err}`,
      dbPath: resolvedDbPath,
    };
  } finally {
    ledger.close();
  }
}

function readWorkerRunUsage(ledger, { workerRunId }) {
  if (!tableExists(ledger, 'worker_runs')) return null;
  const row = ledger.prepare(
    `SELECT run_id, session_id, session_name, started_at, ended_at,
            token_usage_input, token_usage_output, token_usage_cost_usd,
            token_usage_source
       FROM worker_runs
      WHERE run_id = ?
         OR launch_request_id = ?
      ORDER BY CASE WHEN run_id = ? THEN 0 ELSE 1 END
      LIMIT 1`
  ).get(workerRunId, workerRunId, workerRunId);
  if (!row) return null;
  const hasUsage = row.token_usage_input != null || row.token_usage_output != null || row.token_usage_cost_usd != null;
  return {
    input: coerceInteger(row.token_usage_input),
    output: coerceInteger(row.token_usage_output),
    cacheRead: null,
    cacheWrite: null,
    costUSD: coerceFloat(row.token_usage_cost_usd),
    source: row.token_usage_source || (hasUsage ? 'session-ledger' : null),
    sessionId: row.session_id || null,
    sessionName: row.session_name || null,
    startedAt: row.started_at || null,
    endedAt: row.ended_at || null,
  };
}

function findRuntimeSessions(ledger, { adapterSessionKeys = [], workspacePath = null }) {
  if (!tableExists(ledger, 'runtime_sessions')) return [];
  const rows = [];
  const normalizedKeys = [...new Set(adapterSessionKeys.map((key) => String(key || '').trim()).filter(Boolean))];
  if (normalizedKeys.length > 0) {
    const placeholders = normalizedKeys.map(() => '?').join(',');
    rows.push(...ledger.prepare(
      `SELECT session_id, adapter_session_key, source_path, transcript_ref
         FROM runtime_sessions
        WHERE adapter_session_key IN (${placeholders})`
    ).all(...normalizedKeys));
  }
  if (workspacePath) {
    const target = resolve(String(workspacePath));
    rows.push(...ledger.prepare(
      `SELECT session_id, adapter_session_key, source_path, transcript_ref
         FROM runtime_sessions
        WHERE source_path = ?
           OR transcript_ref = ?
           OR metadata_json LIKE ?`
    ).all(target, target, `%${target}%`));
  }
  const byId = new Map();
  for (const row of rows) byId.set(row.session_id, row);
  return [...byId.values()];
}

function aggregateTranscriptUsage(ledger, { sessionIds, startedAt = null, endedAt = null }) {
  if (!tableExists(ledger, 'transcript_entries') || sessionIds.length === 0) return null;
  const placeholders = sessionIds.map(() => '?').join(',');
  const clauses = [`runtime_session_id IN (${placeholders})`];
  const params = [...sessionIds];
  if (startedAt) {
    clauses.push('event_timestamp >= ?');
    params.push(startedAt);
  }
  if (endedAt) {
    clauses.push('event_timestamp <= ?');
    params.push(endedAt);
  }
  const rows = ledger.prepare(
    `SELECT event_timestamp, content_json, tool_metadata_json
       FROM transcript_entries
      WHERE ${clauses.join(' AND ')}
      ORDER BY event_timestamp`
  ).all(...params);
  return aggregateUsageRows(rows);
}

function aggregateUsageRows(rows) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUSD = null;
  let seen = false;

  for (const row of rows) {
    const usage = extractUsageFromRow(row);
    if (!usage) continue;
    seen = true;
    input += usage.input || 0;
    output += usage.output || 0;
    cacheRead += usage.cacheRead || 0;
    cacheWrite += usage.cacheWrite || 0;
    if (usage.costUSD != null) costUSD = (costUSD || 0) + usage.costUSD;
  }

  if (!seen) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    costUSD,
    source: 'session-ledger',
  };
}

function extractUsageFromRow(row) {
  const candidates = [];
  for (const key of ['tool_metadata_json', 'content_json']) {
    const raw = row?.[key];
    if (!raw) continue;
    try {
      candidates.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {}
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const usage = candidate.usage && typeof candidate.usage === 'object'
      ? candidate.usage
      : candidate;
    if (!hasUsageSignal(usage)) continue;
    return {
      input: coerceInteger(usage.input ?? usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens) || 0,
      output: coerceInteger(usage.output ?? usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens) || 0,
      cacheRead: coerceInteger(usage.cacheRead ?? usage.cache_read ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens) || 0,
      cacheWrite: coerceInteger(usage.cacheWrite ?? usage.cache_write ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) || 0,
      costUSD: coerceFloat(usage.costUSD ?? usage.cost_usd ?? usage.totalCostUSD),
    };
  }
  return null;
}

function hasUsageSignal(usage) {
  return usage && typeof usage === 'object' && [
    'input',
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'output',
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
    'cache_read_tokens',
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cache_creation_input_tokens',
    'costUSD',
    'cost_usd',
  ].some((key) => Object.prototype.hasOwnProperty.call(usage, key));
}

function mergeLedgerUsage(runUsage, transcriptUsage) {
  if (!runUsage && !transcriptUsage) return null;
  if (!runUsage) return transcriptUsage;
  if (!transcriptUsage) {
    return runUsage.input != null || runUsage.output != null || runUsage.costUSD != null
      ? runUsage
      : null;
  }
  return {
    input: transcriptUsage.input ?? runUsage.input,
    output: transcriptUsage.output ?? runUsage.output,
    cacheRead: transcriptUsage.cacheRead ?? runUsage.cacheRead,
    cacheWrite: transcriptUsage.cacheWrite ?? runUsage.cacheWrite,
    costUSD: runUsage.costUSD ?? transcriptUsage.costUSD,
    source: runUsage.source && runUsage.source !== transcriptUsage.source
      ? 'mixed'
      : (transcriptUsage.source || runUsage.source || 'session-ledger'),
  };
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName));
}

function queryReviewerPassRollup(db, { since = null, byPr = false, byReviewer = false } = {}) {
  ensureReviewerPassesSchema(db);
  const where = [];
  const params = [];
  if (since) {
    where.push('started_at >= ?');
    params.push(resolveSinceTimestamp(since));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  if (byPr) {
    return db.prepare(
      `SELECT repo, pr_number,
              COUNT(*) AS round_count,
              SUM(COALESCE(token_input, 0) + COALESCE(token_output, 0) + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)) AS total_tokens,
              SUM(token_cost_usd) AS token_cost_usd,
              GROUP_CONCAT(reviewer_class || ':' || pass_count, ',') AS reviewer_breakdown
         FROM (
           SELECT repo, pr_number, reviewer_class, COUNT(*) AS pass_count,
                  SUM(COALESCE(token_input, 0)) AS token_input,
                  SUM(COALESCE(token_output, 0)) AS token_output,
                  SUM(COALESCE(token_cache_read, 0)) AS token_cache_read,
                  SUM(COALESCE(token_cache_write, 0)) AS token_cache_write,
                  SUM(token_cost_usd) AS token_cost_usd
             FROM reviewer_passes
             ${whereSql}
            GROUP BY repo, pr_number, reviewer_class
         )
        GROUP BY repo, pr_number
        ORDER BY MAX(pr_number) DESC`
    ).all(...params);
  }

  if (byReviewer) {
    return db.prepare(
      `SELECT reviewer_class,
              COUNT(*) AS round_count,
              SUM(COALESCE(token_input, 0) + COALESCE(token_output, 0) + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0)) AS total_tokens,
              SUM(token_cost_usd) AS token_cost_usd
         FROM reviewer_passes
         ${whereSql}
        GROUP BY reviewer_class
        ORDER BY total_tokens DESC, reviewer_class`
    ).all(...params);
  }

  return db.prepare(
    `SELECT repo, pr_number, attempt_number, pass_kind, reviewer_class,
            status, started_at, ended_at,
            COALESCE(token_input, 0) + COALESCE(token_output, 0) + COALESCE(token_cache_read, 0) + COALESCE(token_cache_write, 0) AS total_tokens,
            token_cost_usd, token_source
       FROM reviewer_passes
       ${whereSql}
      ORDER BY started_at DESC, pass_id DESC`
  ).all(...params);
}

function resolveSinceTimestamp(value, { now = Date.now() } = {}) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+)([dhm])$/i);
  if (!match) return raw;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
  return new Date(now - amount * multiplier).toISOString();
}

function formatReviewerPassRollup(rows, { byPr = false, byReviewer = false } = {}) {
  const header = byPr
    ? ['PR', 'rounds', 'tokens', 'cost_usd', 'reviewers']
    : byReviewer
      ? ['reviewer', 'rounds', 'tokens', 'cost_usd']
      : ['PR', 'attempt', 'kind', 'reviewer', 'status', 'tokens', 'cost_usd', 'source'];
  const body = rows.map((row) => {
    if (byPr) {
      return [
        `${row.repo}#${row.pr_number}`,
        row.round_count,
        row.total_tokens || 0,
        formatCost(row.token_cost_usd),
        row.reviewer_breakdown || '',
      ];
    }
    if (byReviewer) {
      return [
        row.reviewer_class,
        row.round_count,
        row.total_tokens || 0,
        formatCost(row.token_cost_usd),
      ];
    }
    return [
      `${row.repo}#${row.pr_number}`,
      row.attempt_number,
      row.pass_kind,
      row.reviewer_class,
      row.status,
      row.total_tokens || 0,
      formatCost(row.token_cost_usd),
      row.token_source || 'unknown',
    ];
  });
  return renderTable([header, ...body]);
}

function formatCost(value) {
  return value == null ? '-' : Number(value).toFixed(4);
}

function renderTable(rows) {
  if (rows.length === 0) return '';
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => String(row[index] ?? '').length)));
  return `${rows.map((row) => row.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ').trimEnd()).join('\n')}\n`;
}

function backfillReviewerPassesFromWorkspaces(db, {
  rootDir = process.cwd(),
  workspaceRoot = null,
  transcriptRoots = [],
  dryRun = false,
  now = () => new Date().toISOString(),
} = {}) {
  ensureReviewerPassesSchema(db);
  const workspacesDir = workspaceRoot || getFollowUpJobDir(rootDir, 'workspaces');
  const workspaces = listDirectories(workspacesDir);
  const jobs = listTerminalFollowUpJobs(rootDir);
  const transcriptRows = listJsonlFiles(transcriptRoots).flatMap(readUsageRowsFromJsonl);
  let inspected = 0;
  let upserted = 0;

  const txn = db.transaction(() => {
    for (const workspacePath of workspaces) {
      inspected += 1;
      const job = findJobForWorkspace(jobs, rootDir, workspacePath);
      if (!job) continue;
      const usage = aggregateJsonlUsageForWorkspace(transcriptRows, workspacePath);
      const worker = job.remediationWorker || {};
      const startedAt = worker.spawnedAt || job.claimedAt || job.createdAt || now();
      const endedAt = job.completedAt || job.failedAt || job.stoppedAt || null;
      const currentRound = Number(job?.remediationPlan?.currentRound || 0);
      const attemptNumber = Number.isInteger(currentRound) && currentRound > 0 ? currentRound : 1;
      if (!dryRun) {
        upsertReviewerPass(db, {
          repo: job.repo,
          prNumber: job.prNumber,
          attemptNumber,
          reviewerClass: normalizeReviewerClass(worker.model || worker.workerClass || 'codex'),
          passKind: 'remediation',
          workerRunId: worker.workerRunId || worker.runId || worker.launchRequestId || job.launchRequestId || null,
          workspacePath,
          startedAt,
          endedAt,
          status: terminalJobStatusToPassStatus(job.status),
          tokenUsage: usage ? { ...usage, source: 'session-ledger' } : null,
          metadata: {
            backfilled: true,
            backfilledAt: now(),
            jobId: job.jobId || null,
            jobStatus: job.status || null,
          },
        });
      }
      upserted += 1;
    }
  });

  txn();
  return { inspectedWorkspaces: inspected, populatedRows: upserted, dryRun };
}

function terminalJobStatusToPassStatus(status) {
  if (status === 'completed') return 'completed';
  if (status === 'stopped') return 'cancelled';
  return 'failed';
}

function listDirectories(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .map((name) => join(dirPath, name))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function listTerminalFollowUpJobs(rootDir) {
  const jobs = [];
  for (const key of ['completed', 'failed', 'stopped']) {
    const dir = getFollowUpJobDir(rootDir, key);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const jobPath = join(dir, name);
      try {
        jobs.push({ job: readFollowUpJob(jobPath), jobPath });
      } catch {}
    }
  }
  return jobs;
}

function findJobForWorkspace(jobs, rootDir, workspacePath) {
  const absolute = resolve(workspacePath);
  const relativePath = relativeToRoot(rootDir, workspacePath);
  return jobs.find(({ job }) => {
    const candidates = [
      job?.workspaceDir,
      job?.remediationWorker?.workspaceDir,
      job?.remediationPlan?.rounds?.at?.(-1)?.worker?.workspaceDir,
    ].filter(Boolean);
    return candidates.some((candidate) => {
      const asString = String(candidate);
      return asString === relativePath || resolve(rootDir, asString) === absolute || resolve(asString) === absolute;
    });
  })?.job || null;
}

function relativeToRoot(rootDir, targetPath) {
  const root = resolve(rootDir);
  const target = resolve(targetPath);
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target;
}

function listJsonlFiles(roots) {
  const files = [];
  for (const root of roots || []) {
    if (!root || !existsSync(root)) continue;
    const stat = statSync(root);
    if (stat.isFile() && String(root).endsWith('.jsonl')) {
      files.push(root);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const name of readdirSync(root)) {
      const entry = join(root, name);
      try {
        if (statSync(entry).isDirectory()) files.push(...listJsonlFiles([entry]));
        else if (entry.endsWith('.jsonl')) files.push(entry);
      } catch {}
    }
  }
  return files;
}

function readUsageRowsFromJsonl(filePath) {
  const rows = [];
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/u);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const cwd = parsed.cwd || parsed.message?.cwd || parsed.payload?.cwd || null;
      const usage = extractUsageFromRawJson(parsed);
      if (cwd && usage) rows.push({ cwd: resolve(cwd), usage });
    } catch {}
  }
  return rows;
}

function extractUsageFromRawJson(parsed) {
  const usage = parsed?.message?.usage
    || parsed?.payload?.info?.last_token_usage
    || parsed?.usage
    || null;
  if (!usage) return null;
  return extractUsageFromRow({ content_json: JSON.stringify({ usage }) });
}

function aggregateJsonlUsageForWorkspace(rows, workspacePath) {
  const target = resolve(workspacePath);
  const matching = rows
    .filter((row) => row.cwd === target)
    .map((row) => ({ content_json: JSON.stringify({ usage: row.usage }) }));
  return aggregateUsageRows(matching);
}

export {
  aggregateJsonlUsageForWorkspace,
  backfillReviewerPassesFromWorkspaces,
  ensureReviewerPassesSchema,
  formatReviewerPassRollup,
  getReviewerPass,
  insertReviewerPassStarted,
  normalizeReviewerClass,
  queryReviewerPassRollup,
  readTokenUsageFromSessionLedger,
  resolveSessionLedgerDbPath,
  resolveSinceTimestamp,
  updateReviewerPassCompleted,
  upsertReviewerPass,
};
