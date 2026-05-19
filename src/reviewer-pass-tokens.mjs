import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

const PASS_KINDS = new Set(['first-pass', 'remediation', 'rereview']);
const PASS_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);

function normalizeReviewerClass(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('codex') || text.includes('gpt')) return 'codex';
  return 'claude';
}

function normalizePassKind(value) {
  const normalized = String(value || '').trim();
  if (!PASS_KINDS.has(normalized)) {
    throw new TypeError(`Invalid reviewer pass_kind: ${value}`);
  }
  return normalized;
}

function normalizePassStatus(value) {
  const normalized = String(value || '').trim();
  if (!PASS_STATUSES.has(normalized)) {
    throw new TypeError(`Invalid reviewer pass status: ${value}`);
  }
  return normalized;
}

function normalizeAttemptNumber(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`Invalid reviewer pass attempt_number: ${value}`);
  }
  return parsed;
}

function metadataJson(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '{}';
  return JSON.stringify(metadata);
}

function parseMetadataJson(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function closeOwnedReviewDb(db) {
  // Most call sites get a fresh file-backed connection from
  // openReviewStateDb. A few watcher tests intentionally mock that
  // opener with a shared in-memory singleton; closing it here would
  // invalidate the watcher's prepared statements mid-poll.
  if (db?.name === ':memory:') return;
  db.close();
}

function passKey({ repo, prNumber, attemptNumber, passKind }) {
  return {
    repo: String(repo || ''),
    prNumber: Number(prNumber),
    attemptNumber: normalizeAttemptNumber(attemptNumber),
    passKind: normalizePassKind(passKind),
  };
}

function beginReviewerPass(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  reviewerClass,
  passKind,
  workerRunId = null,
  workspacePath = null,
  startedAt = new Date().toISOString(),
  metadata = {},
} = {}) {
  const key = passKey({ repo, prNumber, attemptNumber, passKind });
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT OR IGNORE INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, pass_kind,
         worker_run_id, workspace_path, started_at, status, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
    ).run(
      key.repo,
      key.prNumber,
      key.attemptNumber,
      normalizeReviewerClass(reviewerClass),
      key.passKind,
      workerRunId || null,
      workspacePath || null,
      startedAt,
      metadataJson(metadata)
    );
    const existing = db.prepare(
      `SELECT metadata_json FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).get(key.repo, key.prNumber, key.attemptNumber, key.passKind);
    const mergedMetadata = {
      ...parseMetadataJson(existing?.metadata_json),
      ...metadata,
    };
    db.prepare(
      `UPDATE reviewer_passes
          SET reviewer_class = COALESCE(?, reviewer_class),
              worker_run_id = COALESCE(?, worker_run_id),
              workspace_path = COALESCE(?, workspace_path),
              metadata_json = ?
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).run(
      normalizeReviewerClass(reviewerClass),
      workerRunId || null,
      workspacePath || null,
      metadataJson(mergedMetadata),
      key.repo,
      key.prNumber,
      key.attemptNumber,
      key.passKind
    );
    return db.prepare(
      `SELECT * FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).get(key.repo, key.prNumber, key.attemptNumber, key.passKind);
  } finally {
    closeOwnedReviewDb(db);
  }
}

function completeReviewerPass(rootDir, {
  repo,
  prNumber,
  attemptNumber,
  passKind,
  status,
  endedAt = new Date().toISOString(),
  workerRunId = null,
  tokenUsage = null,
  tokenSource = null,
  metadata = {},
} = {}) {
  const key = passKey({ repo, prNumber, attemptNumber, passKind });
  const usage = normalizeTokenUsage(tokenUsage);
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const existing = db.prepare(
      `SELECT metadata_json FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).get(key.repo, key.prNumber, key.attemptNumber, key.passKind);
    const mergedMetadata = {
      ...parseMetadataJson(existing?.metadata_json),
      ...metadata,
    };
    db.prepare(
      `UPDATE reviewer_passes
          SET ended_at = ?,
              status = ?,
              worker_run_id = COALESCE(?, worker_run_id),
              token_input = COALESCE(?, token_input),
              token_output = COALESCE(?, token_output),
              token_cache_read = COALESCE(?, token_cache_read),
              token_cache_write = COALESCE(?, token_cache_write),
              token_cost_usd = COALESCE(?, token_cost_usd),
              token_source = COALESCE(?, token_source),
              metadata_json = ?
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).run(
      endedAt,
      normalizePassStatus(status),
      workerRunId || null,
      usage?.input ?? null,
      usage?.output ?? null,
      usage?.cacheRead ?? null,
      usage?.cacheWrite ?? null,
      usage?.costUSD ?? null,
      tokenSource || usage?.source || null,
      metadataJson(mergedMetadata),
      key.repo,
      key.prNumber,
      key.attemptNumber,
      key.passKind
    );
    return db.prepare(
      `SELECT * FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).get(key.repo, key.prNumber, key.attemptNumber, key.passKind);
  } finally {
    closeOwnedReviewDb(db);
  }
}

function normalizeTokenUsage(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const input = coerceNonNegativeInt(tokenUsage.input ?? tokenUsage.inputTokens ?? tokenUsage.token_input);
  const output = coerceNonNegativeInt(tokenUsage.output ?? tokenUsage.outputTokens ?? tokenUsage.token_output);
  const cacheRead = coerceNonNegativeInt(tokenUsage.cacheRead ?? tokenUsage.cache_read ?? tokenUsage.token_cache_read);
  const cacheWrite = coerceNonNegativeInt(tokenUsage.cacheWrite ?? tokenUsage.cache_write ?? tokenUsage.token_cache_write);
  const costUSD = coerceNonNegativeFloat(tokenUsage.costUSD ?? tokenUsage.cost_usd ?? tokenUsage.token_cost_usd);
  if (input === null && output === null && cacheRead === null && cacheWrite === null && costUSD === null) {
    return null;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    costUSD,
    source: tokenUsage.source || null,
  };
}

function coerceNonNegativeInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function coerceNonNegativeFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function resolveSessionLedgerDbPath({ env = process.env, hqRoot = null, rootDir = process.cwd(), explicitPath = null } = {}) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (env.AGENT_OS_SESSION_LEDGER_DB_PATH) candidates.push(env.AGENT_OS_SESSION_LEDGER_DB_PATH);
  if (env.SESSION_LEDGER_DB_PATH) candidates.push(env.SESSION_LEDGER_DB_PATH);
  if (env.AGENT_OS_DEPLOY_CHECKOUT) {
    candidates.push(join(env.AGENT_OS_DEPLOY_CHECKOUT, '.agent-os', 'session-ledger', 'ledger.db'));
  }
  if (hqRoot || env.HQ_ROOT) {
    const resolvedHqRoot = hqRoot || env.HQ_ROOT;
    candidates.push(join(resolvedHqRoot, 'session-ledger', 'ledger.db'));
  }
  candidates.push(join(rootDir, '.agent-os', 'session-ledger', 'ledger.db'));
  candidates.push(join('/Users/airlock/agent-os', '.agent-os', 'session-ledger', 'ledger.db'));
  candidates.push(join(homedir(), '.agent-os', 'session-ledger', 'ledger.db'));
  candidates.push(join(homedir(), 'agent-os', '.agent-os', 'session-ledger', 'ledger.db'));

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolve(String(candidate));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

function readReviewerSessionTokenUsage({
  adapterSessionKey,
  sessionKeys = [],
  workspacePath = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
} = {}) {
  const dbPath = resolveSessionLedgerDbPath({ explicitPath: ledgerDbPath, env, rootDir });
  if (!dbPath) return null;
  const keys = [...new Set([adapterSessionKey, ...sessionKeys].filter(Boolean).map(String))];
  const where = [];
  const params = {};
  if (keys.length > 0) {
    where.push(`adapter_session_key IN (${keys.map((_, idx) => `@key${idx}`).join(', ')})`);
    keys.forEach((key, idx) => { params[`key${idx}`] = key; });
  }
  if (workspacePath) {
    where.push(`source_path = @workspacePath`);
    params.workspacePath = workspacePath;
  }
  if (where.length === 0) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(
      `SELECT adapter_session_key, total_input_tokens, total_output_tokens,
              total_cache_read_tokens, total_cache_write_tokens, total_cost_usd,
              source_path, started_at, ended_at
         FROM runtime_sessions
        WHERE ${where.map((clause) => `(${clause})`).join(' OR ')}
        ORDER BY COALESCE(ended_at, started_at, '') DESC
        LIMIT 1`
    ).get(params);
    return tokenUsageFromRuntimeSession(row);
  } finally {
    closeOwnedReviewDb(db);
  }
}

function readWorkerRunTokenUsage({
  workerRunId,
  launchRequestId = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
} = {}) {
  const dbPath = resolveSessionLedgerDbPath({ explicitPath: ledgerDbPath, env, rootDir });
  if (!dbPath || (!workerRunId && !launchRequestId)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const clauses = [];
    const params = {};
    if (workerRunId) {
      clauses.push('wr.run_id = @workerRunId');
      params.workerRunId = workerRunId;
    }
    if (launchRequestId) {
      clauses.push('wr.launch_request_id = @launchRequestId');
      params.launchRequestId = launchRequestId;
    }
    const row = db.prepare(
      `SELECT wr.run_id, wr.launch_request_id,
              wr.token_usage_input, wr.token_usage_output,
              wr.token_usage_cost_usd, wr.token_usage_source,
              rs.total_cache_read_tokens, rs.total_cache_write_tokens
         FROM worker_runs wr
         LEFT JOIN runtime_sessions rs ON rs.session_id = wr.session_id
        WHERE ${clauses.map((clause) => `(${clause})`).join(' OR ')}
        ORDER BY COALESCE(wr.ended_at, wr.updated_at, wr.started_at, '') DESC
        LIMIT 1`
    ).get(params);
    if (!row) return null;
    return {
      workerRunId: row.run_id || workerRunId || null,
      launchRequestId: row.launch_request_id || launchRequestId || null,
      input: coerceNonNegativeInt(row.token_usage_input),
      output: coerceNonNegativeInt(row.token_usage_output),
      cacheRead: coerceNonNegativeInt(row.total_cache_read_tokens),
      cacheWrite: coerceNonNegativeInt(row.total_cache_write_tokens),
      costUSD: coerceNonNegativeFloat(row.token_usage_cost_usd),
      source: row.token_usage_source || 'session-ledger',
    };
  } finally {
    db.close();
  }
}

function tokenUsageFromRuntimeSession(row) {
  if (!row) return null;
  const cost = coerceNonNegativeFloat(row.total_cost_usd);
  return {
    adapterSessionKey: row.adapter_session_key || null,
    input: coerceNonNegativeInt(row.total_input_tokens),
    output: coerceNonNegativeInt(row.total_output_tokens),
    cacheRead: coerceNonNegativeInt(row.total_cache_read_tokens),
    cacheWrite: coerceNonNegativeInt(row.total_cache_write_tokens),
    costUSD: cost && cost > 0 ? cost : null,
    source: 'session-ledger',
  };
}

function reviewerPassRows(rootDir, { since = null } = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const params = {};
    const where = [];
    if (since) {
      where.push('started_at >= @since');
      params.since = since;
    }
    return db.prepare(
      `SELECT *
         FROM reviewer_passes
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC, pass_id DESC`
    ).all(params);
  } finally {
    db.close();
  }
}

function parseSince(value, { now = new Date() } = {}) {
  if (!value) return null;
  const text = String(value).trim();
  const rel = text.match(/^(\d+)([dhmw])$/i);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const multipliers = { d: 86_400_000, h: 3_600_000, m: 60_000, w: 7 * 86_400_000 };
    return new Date(now.getTime() - amount * multipliers[unit]).toISOString();
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Invalid --since value: ${value}`);
  }
  return parsed.toISOString();
}

function readHistoricalFollowUpJobs(rootDir) {
  const base = join(rootDir, 'data', 'follow-up-jobs');
  const states = ['completed', 'failed', 'stopped', 'stopped-archived'];
  const jobs = [];
  const seen = new Set();
  function addJob(jobPath) {
    if (seen.has(jobPath)) return;
    seen.add(jobPath);
    try {
      jobs.push({ jobPath, job: JSON.parse(readFileSync(jobPath, 'utf8')) });
    } catch {
      // Ignore malformed historical artifacts; backfill is best-effort.
    }
  }
  for (const state of states) {
    const dir = join(base, state);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      addJob(join(dir, name));
    }
  }

  const workspaceRoot = join(base, 'workspaces');
  if (existsSync(workspaceRoot)) {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const state of states) {
        const jobPath = join(base, state, `${entry.name}.json`);
        if (existsSync(jobPath)) addJob(jobPath);
      }
    }
  }
  return jobs;
}

function backfillReviewerPasses(rootDir, {
  ledgerDbPath = null,
  now = () => new Date().toISOString(),
} = {}) {
  const jobs = readHistoricalFollowUpJobs(rootDir);
  let considered = 0;
  let insertedOrUpdated = 0;
  for (const { job, jobPath } of jobs) {
    const worker = job?.remediationWorker || {};
    const repo = job?.repo;
    const prNumber = Number(job?.prNumber);
    const workspacePath = job?.workspaceDir || worker.workspaceDir || null;
    if (!repo || !Number.isInteger(prNumber) || !workspacePath) continue;
    considered += 1;
    const attemptNumber = normalizeAttemptNumber(
      job?.remediationPlan?.currentRound
      || job?.currentRound
      || 1
    );
    const startedAt = worker.spawnedAt || job.claimedAt || job.createdAt || now();
    const endedAt = job.completedAt || job.failedAt || job.stoppedAt || worker.reconciledAt || null;
    const status = job.status === 'completed'
      ? 'completed'
      : (job.status === 'failed' ? 'failed' : 'cancelled');
    const launchRequestId = worker.launchRequestId || worker.launchRequestID || job.replyStorageKey || null;
    const usage = readWorkerRunTokenUsage({
      workerRunId: worker.workerRunId || worker.runId || null,
      launchRequestId,
      ledgerDbPath,
      rootDir,
    }) || readReviewerSessionTokenUsage({
      workspacePath,
      ledgerDbPath,
      rootDir,
    });

    beginReviewerPass(rootDir, {
      repo,
      prNumber,
      attemptNumber,
      reviewerClass: worker.workerClass || worker.model || 'codex',
      passKind: 'remediation',
      workerRunId: usage?.workerRunId || worker.workerRunId || worker.runId || null,
      workspacePath,
      startedAt,
      metadata: {
        backfill: true,
        jobPath,
        jobId: job.jobId || null,
        launchRequestId,
      },
    });
    completeReviewerPass(rootDir, {
      repo,
      prNumber,
      attemptNumber,
      passKind: 'remediation',
      status,
      endedAt: endedAt || startedAt,
      workerRunId: usage?.workerRunId || worker.workerRunId || worker.runId || null,
      tokenUsage: usage,
      tokenSource: usage?.source || (usage ? 'session-ledger' : 'unknown'),
      metadata: {
        backfill: true,
        jobPath,
      },
    });
    insertedOrUpdated += 1;
  }
  return { considered, insertedOrUpdated };
}

export {
  backfillReviewerPasses,
  beginReviewerPass,
  completeReviewerPass,
  normalizeReviewerClass,
  normalizeTokenUsage,
  parseSince,
  readReviewerSessionTokenUsage,
  readWorkerRunTokenUsage,
  reviewerPassRows,
  resolveSessionLedgerDbPath,
};
