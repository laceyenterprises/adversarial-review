import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  readReviewerSessionUsageFromLedger,
  readWorkerRunUsageFromLedger,
  resolveSessionLedgerReadTarget,
} from './session-ledger-read-adapter.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';

const PASS_KINDS = new Set(['first-pass', 'remediation', 'rereview', 'closer']);
const PASS_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled']);
const REVIEWER_USAGE_ARTIFACT_SCHEMA = 'adversarial-reviewer-token-usage/v1';

function normalizeReviewerClass(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('codex') || text.includes('gpt')) return 'codex';
  if (text.includes('gemini') || text.includes('antigravity') || text.includes('agy')) return 'gemini';
  return 'claude';
}

function normalizeReviewerModel(value) {
  const text = String(value || '').trim();
  return text || null;
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
  reviewerModel = null,
  passKind,
  workerRunId = null,
  workspacePath = null,
  startedAt = new Date().toISOString(),
  headSha = null,
  metadata = {},
} = {}) {
  const key = passKey({ repo, prNumber, attemptNumber, passKind });
  const model = normalizeReviewerModel(reviewerModel || reviewerClass);
  // LAC-1559: the head SHA this pass reviewed, so the completed-rereview budget
  // counter can key per (repo, pr, head). `null` when the caller does not know
  // the head (legacy/backfill), which the counter treats as "unattributed".
  const normalizedHeadSha = typeof headSha === 'string' && headSha.trim() !== ''
    ? headSha.trim()
    : null;
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT OR IGNORE INTO reviewer_passes (
         repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
         worker_run_id, workspace_path, started_at, status, head_sha, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
    ).run(
      key.repo,
      key.prNumber,
      key.attemptNumber,
      normalizeReviewerClass(model || reviewerClass),
      model,
      key.passKind,
      workerRunId || null,
      workspacePath || null,
      startedAt,
      normalizedHeadSha,
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
              reviewer_model = COALESCE(?, reviewer_model),
              worker_run_id = COALESCE(?, worker_run_id),
              workspace_path = COALESCE(?, workspace_path),
              head_sha = COALESCE(?, head_sha),
              metadata_json = ?
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).run(
      normalizeReviewerClass(model || reviewerClass),
      model,
      workerRunId || null,
      workspacePath || null,
      normalizedHeadSha,
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
    const tokenMetadata = usage?.usageTag
      ? {
          tokenUsageTag: usage.usageTag,
          ...(usage.guardrail !== undefined
            ? { tokenUsageGuardrail: usage.guardrail }
            : {}),
        }
      : {};
    const mergedMetadata = {
      ...parseMetadataJson(existing?.metadata_json),
      ...tokenMetadata,
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
              token_reasoning = COALESCE(?, token_reasoning),
              token_tool_context = COALESCE(?, token_tool_context),
              token_total = COALESCE(?, token_total),
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
      usage?.reasoning ?? null,
      usage?.toolContext ?? null,
      usage?.total ?? null,
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
  // Full-fidelity parity with the session ledger: reasoning + tool-use tokens.
  const reasoning = coerceNonNegativeInt(
    tokenUsage.reasoning ?? tokenUsage.reasoningTokens ?? tokenUsage.reasoning_output_tokens ?? tokenUsage.token_reasoning
  );
  const toolContext = coerceNonNegativeInt(
    tokenUsage.toolContext ?? tokenUsage.tool ?? tokenUsage.toolTokens ?? tokenUsage.tool_context ?? tokenUsage.token_tool_context
  );
  const total = coerceNonNegativeInt(tokenUsage.total ?? tokenUsage.totalTokens ?? tokenUsage.token_total);
  const guardrailRaw = firstPresentValue(tokenUsage, ['guardrail', 'guardrailTokens', 'token_usage_guardrail']);
  const guardrail = guardrailRaw === undefined ? undefined : coerceNonNegativeInt(guardrailRaw);
  const costUSD = coerceNonNegativeFloat(tokenUsage.costUSD ?? tokenUsage.cost_usd ?? tokenUsage.token_cost_usd);
  const usageTag = normalizeUsageTag(
    tokenUsage.usageTag ?? tokenUsage.usage_tag ?? tokenUsage.usageCategory ?? tokenUsage.usage_category ?? tokenUsage.category ?? tokenUsage.tag
  );
  if (
    input === null && output === null && cacheRead === null && cacheWrite === null &&
    reasoning === null && toolContext === null && total === null && guardrail == null && costUSD === null
  ) {
    return null;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    toolContext,
    total,
    guardrail,
    costUSD,
    source: tokenUsage.source || null,
    usageTag,
  };
}

function normalizeUsageTag(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
}

function firstPresentValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function tagTokenUsage(tokenUsage, usageTag) {
  const normalized = normalizeTokenUsage(tokenUsage);
  if (!normalized) return null;
  const tag = normalizeUsageTag(usageTag) || normalized.usageTag;
  if (!tag) return normalized;
  const guardrail = normalized.guardrail !== undefined ? normalized.guardrail : (
    tag === 'guardrail'
      ? (normalized.total ?? ((normalized.input || 0) + (normalized.output || 0)))
      : null
  );
  return {
    ...normalized,
    guardrail,
    usageTag: tag,
  };
}

function reviewerTokenUsageArtifactPath({
  workspacePath,
  repo,
  prNumber,
  attemptNumber,
  passKind,
  artifactRoot = null,
  env = process.env,
} = {}) {
  const workspace = workspacePath ? resolve(String(workspacePath)) : process.cwd();
  const baseDir = resolveReviewerTokenUsageArtifactRoot({ workspacePath: workspace, artifactRoot, env });
  const repoSlug = String(repo || 'unknown').replace(/[^A-Za-z0-9_.-]+/g, '__');
  const pass = normalizePassKind(passKind || 'first-pass');
  const attempt = normalizeAttemptNumber(attemptNumber || 0);
  return join(
    baseDir,
    `${repoSlug}__pr-${Number(prNumber) || 0}__attempt-${attempt}__${pass}.json`
  );
}

function resolveReviewerTokenUsageArtifactRoot({
  workspacePath,
  artifactRoot = null,
  env = process.env,
} = {}) {
  if (artifactRoot) return resolve(String(artifactRoot));
  const hqRoot = env?.HQ_ROOT || env?.AGENT_OS_HQ_ROOT || null;
  if (hqRoot) return resolve(String(hqRoot), 'adversarial-review', 'token-usage');
  const workspace = workspacePath ? resolve(String(workspacePath)) : process.cwd();
  return join(workspace, '.adversarial-review', 'token-usage');
}

function nearestExistingPath(path) {
  let current = resolve(String(path));
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function writeReviewerTokenUsageArtifact({
  workspacePath,
  repo,
  prNumber,
  attemptNumber,
  passKind,
  reviewerClass,
  reviewerModel = null,
  status = 'completed',
  startedAt = null,
  endedAt = new Date().toISOString(),
  tokenUsage,
  source = null,
  metadata = {},
  artifactRoot = null,
  env = process.env,
  currentUidImpl = () => (typeof process.getuid === 'function' ? process.getuid() : null),
  statSyncImpl = statSync,
} = {}) {
  const usage = normalizeTokenUsage(tokenUsage);
  if (!usage) return null;
  const workspace = workspacePath ? resolve(String(workspacePath)) : process.cwd();
  const artifactBase = resolveReviewerTokenUsageArtifactRoot({ workspacePath: workspace, artifactRoot, env });
  const callerUid = currentUidImpl();
  if (callerUid === null) {
    throw new Error(`Cannot verify ownership of reviewer token usage artifact root: ${artifactBase}`);
  }
  const artifactOwnerUid = statSyncImpl(nearestExistingPath(artifactBase)).uid;
  if (artifactOwnerUid !== callerUid) {
    throw new Error(
      `Refusing to write reviewer token usage artifact under root owned by uid ${artifactOwnerUid} as uid ${callerUid}: ${artifactBase}`
    );
  }
  const artifactPath = reviewerTokenUsageArtifactPath({
    workspacePath: workspace,
    repo,
    prNumber,
    attemptNumber,
    passKind,
    artifactRoot,
    env,
  });
  mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
  const payload = {
    schemaVersion: REVIEWER_USAGE_ARTIFACT_SCHEMA,
    repo: String(repo || ''),
    prNumber: Number(prNumber),
    attemptNumber: normalizeAttemptNumber(attemptNumber || 0),
    passKind: normalizePassKind(passKind || 'first-pass'),
    reviewerClass: normalizeReviewerClass(reviewerClass || reviewerModel),
    reviewerModel: normalizeReviewerModel(reviewerModel || reviewerClass),
    status: normalizePassStatus(status),
    startedAt,
    endedAt,
    tokenUsage: {
      ...usage,
      source: source || usage.source || 'reviewer-local-artifact',
    },
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
  };
  const tmp = `${artifactPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, artifactPath);
  return artifactPath;
}

function readReviewerTokenUsageArtifact(artifactPath) {
  const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (parsed?.schemaVersion !== REVIEWER_USAGE_ARTIFACT_SCHEMA) {
    throw new TypeError(`Invalid reviewer token usage artifact schema: ${parsed?.schemaVersion}`);
  }
  return {
    ...parsed,
    attemptNumber: normalizeAttemptNumber(parsed.attemptNumber),
    passKind: normalizePassKind(parsed.passKind),
    status: normalizePassStatus(parsed.status || 'completed'),
    tokenUsage: normalizeTokenUsage(parsed.tokenUsage),
  };
}

function foldReviewerTokenUsageArtifact(rootDir, artifactPath, { metadata = {} } = {}) {
  const artifact = readReviewerTokenUsageArtifact(artifactPath);
  beginReviewerPass(rootDir, {
    repo: artifact.repo,
    prNumber: artifact.prNumber,
    attemptNumber: artifact.attemptNumber,
    reviewerClass: artifact.reviewerClass,
    reviewerModel: artifact.reviewerModel,
    passKind: artifact.passKind,
    workspacePath: artifact.metadata?.workspacePath || null,
    startedAt: artifact.startedAt || artifact.endedAt || new Date().toISOString(),
    metadata: {
      ...artifact.metadata,
      ...metadata,
      reviewerTokenUsageArtifact: artifactPath,
    },
  });
  return completeReviewerPass(rootDir, {
    repo: artifact.repo,
    prNumber: artifact.prNumber,
    attemptNumber: artifact.attemptNumber,
    passKind: artifact.passKind,
    status: artifact.status,
    endedAt: artifact.endedAt || new Date().toISOString(),
    tokenUsage: artifact.tokenUsage,
    tokenSource: artifact.tokenUsage?.source || null,
    metadata: {
      ...artifact.metadata,
      ...metadata,
      reviewerTokenUsageArtifact: artifactPath,
    },
  });
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

const tokenRollupWarnings = new Set();

function selectLedgerTargetSource({
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
} = {}) {
  if (ledgerTarget !== null && ledgerTarget !== undefined) return ledgerTarget;
  if (!ledgerDbPath) return null;
  const resolved = resolveSessionLedgerReadTarget({ ledgerDbPath, env });
  if (!resolved.ok) throw new Error(resolved.detail || resolved.reason);
  return resolved.target;
}

function warnTokenRollupDegraded(scope, result) {
  if (result?.reason !== 'unsupported-ledger-backend') return;
  const key = `${scope}:${result.target?.backend || 'unknown'}`;
  if (tokenRollupWarnings.has(key)) return;
  tokenRollupWarnings.add(key);
  console.warn(
    `[reviewer-pass-tokens] unsupported-ledger-backend for ${scope}; token rollup unavailable for backend=${result.target?.backend || 'unknown'}`
  );
}

function readReviewerSessionTokenUsage({
  adapterSessionKey,
  sessionKeys = [],
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
} = {}) {
  const selectedLedgerTarget = selectLedgerTargetSource({ ledgerTarget, ledgerDbPath, env });
  const result = readReviewerSessionUsageFromLedger({
    adapterSessionKey,
    sessionKeys,
    workspacePath,
    startedAt,
    endedAt,
    ledgerTarget: selectedLedgerTarget,
    env,
    rootDir,
  });
  warnTokenRollupDegraded('reviewer-session', result);
  return result.ok ? tokenUsageFromRuntimeSession(result.row) : null;
}

function readWorkerRunTokenUsage(options = {}) {
  const result = readWorkerRunTokenUsageResult(options);
  return result.ok ? result.usage : null;
}

function readWorkerRunTokenUsageResult({
  workerRunId,
  launchRequestId = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  hqRoot = null,
} = {}) {
  const selectedLedgerTarget = selectLedgerTargetSource({ ledgerTarget, ledgerDbPath, env });
  const result = readWorkerRunUsageFromLedger({
    workerRunId,
    launchRequestId,
    ledgerTarget: selectedLedgerTarget,
    env,
    rootDir,
    hqRoot,
  });
  warnTokenRollupDegraded('worker-run', result);
  return result.ok
    ? {
        ...result,
        usage: tokenUsageFromWorkerRun(result.row, { workerRunId, launchRequestId }),
      }
    : result;
}

function tokenUsageFromWorkerRun(row, { workerRunId = null, launchRequestId = null } = {}) {
  if (!row) return null;
  return {
    workerRunId: row.run_id || workerRunId || null,
    launchRequestId: row.launch_request_id || launchRequestId || null,
    input: coerceNonNegativeInt(row.token_usage_input),
    output: coerceNonNegativeInt(row.token_usage_output),
    cacheRead: coerceNonNegativeInt(row.total_cache_read_tokens),
    cacheWrite: coerceNonNegativeInt(row.total_cache_write_tokens),
    guardrail: coerceNonNegativeInt(row.token_usage_guardrail),
    costUSD: coerceNonNegativeFloat(row.token_usage_cost_usd),
    source: row.token_usage_source || 'session-ledger',
    usageTag: coerceNonNegativeInt(row.token_usage_guardrail) !== null ? 'guardrail' : null,
  };
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

function readCodexTranscriptTokenUsage({
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  sessionRoots = [],
  transcriptSummaryCache = null,
  transcriptPathCache = null,
  rootDir = process.cwd(),
} = {}) {
  const workspacePaths = normalizedWorkspacePaths(workspacePath, rootDir);
  if (workspacePaths.length === 0 || sessionRoots.length === 0) return null;
  const transcriptPaths = listCodexTranscriptPaths(sessionRoots, { startedAt, endedAt }, transcriptPathCache);
  const matches = [];
  for (const transcriptPath of transcriptPaths) {
    const summary = readCachedCodexTranscriptSummary(transcriptPath, transcriptSummaryCache);
    if (!summary?.cwd || !workspacePaths.includes(resolve(summary.cwd))) continue;
    if (!timestampOverlapsWindow(summary.startedAt, summary.endedAt, startedAt, endedAt)) continue;
    if (!summary.tokenUsage) continue;
    matches.push({
      transcriptPath,
      sessionId: summary.sessionId,
      usage: summary.tokenUsage,
    });
  }
  if (matches.length !== 1) return null;
  const match = matches[0];
  return {
    ...match.usage,
    source: 'codex-transcript',
    adapterSessionKey: match.sessionId || null,
    transcriptPath: match.transcriptPath,
  };
}

function readClaudeTranscriptTokenUsage({
  adapterSessionKey = null,
  sessionKeys = [],
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  sessionRoots = [],
  transcriptSummaryCache = null,
  transcriptPathCache = null,
  rootDir = process.cwd(),
} = {}) {
  const keys = new Set([adapterSessionKey, ...sessionKeys].filter(Boolean).map(String));
  const workspacePaths = normalizedWorkspacePaths(workspacePath, rootDir);
  if (keys.size === 0 && workspacePaths.length === 0) return null;
  if (sessionRoots.length === 0) return null;
  const transcriptPaths = listClaudeTranscriptPaths(sessionRoots, transcriptPathCache);
  const matches = [];
  for (const transcriptPath of transcriptPaths) {
    const summary = readCachedClaudeTranscriptSummary(transcriptPath, transcriptSummaryCache);
    if (!summary?.tokenUsage) continue;
    const sessionMatched = summary.sessionId && keys.has(String(summary.sessionId));
    const workspaceMatched = summary.cwd && workspacePaths.includes(resolve(summary.cwd));
    if (!sessionMatched && !workspaceMatched) continue;
    if (!timestampOverlapsWindow(summary.startedAt, summary.endedAt, startedAt, endedAt)) continue;
    matches.push({
      transcriptPath,
      sessionId: summary.sessionId,
      usage: summary.tokenUsage,
      startedAt: summary.startedAt || null,
      endedAt: summary.endedAt || null,
      workspaceMatched,
      sessionMatched,
    });
  }
  if (matches.length === 0) return null;
  const groupedMatches = groupClaudeTranscriptMatches(matches, {
    workspacePaths,
    startedAt,
    endedAt,
  });
  const sessionMatches = groupedMatches.filter((match) => match.sessionMatched);
  if (sessionMatches.length > 1) return null;
  if (sessionMatches.length === 0 && groupedMatches.length !== 1) return null;
  const chosen = sessionMatches[0] || groupedMatches[0];
  return {
    ...chosen.usage,
    source: 'claude-transcript',
    adapterSessionKey: chosen.sessionId || null,
    transcriptPath: chosen.transcriptPath,
  };
}

function groupClaudeTranscriptMatches(matches, {
  workspacePaths = [],
  startedAt = null,
  endedAt = null,
} = {}) {
  const grouped = new Map();
  const ungrouped = [];
  for (const match of matches) {
    if (!match.sessionId) {
      ungrouped.push(match);
      continue;
    }
    const key = String(match.sessionId);
    const group = grouped.get(key);
    if (group) {
      group.push(match);
      continue;
    }
    grouped.set(key, [match]);
  }
  const exactWindowKnown = Boolean(parseDate(startedAt) || parseDate(endedAt));
  const aggregated = [];
  for (const sessionMatches of grouped.values()) {
    if (sessionMatches.length === 1) {
      aggregated.push(sessionMatches[0]);
      continue;
    }
    const spansKnownWorkspace = workspacePaths.length === 0
      || sessionMatches.every((match) => match.workspaceMatched);
    const staysInsidePassWindow = exactWindowKnown
      && sessionMatches.every((match) => timestampWithinWindow(match.startedAt, match.endedAt, startedAt, endedAt));
    if (!spansKnownWorkspace || !staysInsidePassWindow) {
      aggregated.push(...sessionMatches);
      continue;
    }
    const [first, ...rest] = sessionMatches;
    const combined = {
      ...first,
      usage: { ...first.usage },
    };
    for (const match of rest) {
      combined.usage = normalizeTokenUsage({
        input: (combined.usage?.input || 0) + (match.usage?.input || 0),
        output: (combined.usage?.output || 0) + (match.usage?.output || 0),
        cacheRead: (combined.usage?.cacheRead || 0) + (match.usage?.cacheRead || 0),
        cacheWrite: (combined.usage?.cacheWrite || 0) + (match.usage?.cacheWrite || 0),
        total: (combined.usage?.total || 0) + (match.usage?.total || 0),
        costUSD: (combined.usage?.costUSD || 0) + (match.usage?.costUSD || 0),
        source: 'claude-transcript',
      });
      combined.startedAt = earlierTimestamp(combined.startedAt, match.startedAt);
      combined.endedAt = laterTimestamp(combined.endedAt, match.endedAt);
      combined.sessionMatched = combined.sessionMatched || match.sessionMatched;
      if ((Date.parse(match.endedAt || '') || 0) >= (Date.parse(combined.endedAt || '') || 0)) {
        combined.transcriptPath = match.transcriptPath;
      }
    }
    aggregated.push(combined);
  }
  return [...aggregated, ...ungrouped];
}

function earlierTimestamp(a, b) {
  const aTime = Date.parse(a || '');
  const bTime = Date.parse(b || '');
  if (!Number.isFinite(aTime)) return b || a || null;
  if (!Number.isFinite(bTime)) return a || b || null;
  return aTime <= bTime ? a : b;
}

function laterTimestamp(a, b) {
  const aTime = Date.parse(a || '');
  const bTime = Date.parse(b || '');
  if (!Number.isFinite(aTime)) return b || a || null;
  if (!Number.isFinite(bTime)) return a || b || null;
  return aTime >= bTime ? a : b;
}

function readCachedClaudeTranscriptSummary(transcriptPath, cache) {
  if (!cache) return readClaudeTranscriptSummary(transcriptPath);
  if (!cache.has(transcriptPath)) {
    cache.set(transcriptPath, readClaudeTranscriptSummary(transcriptPath));
  }
  return cache.get(transcriptPath);
}

function readCachedCodexTranscriptSummary(transcriptPath, cache) {
  if (!cache) return readCodexTranscriptSummary(transcriptPath);
  if (!cache.has(transcriptPath)) {
    cache.set(transcriptPath, readCodexTranscriptSummary(transcriptPath));
  }
  return cache.get(transcriptPath);
}

function normalizedWorkspacePaths(workspacePath, rootDir) {
  if (!workspacePath) return [];
  const raw = String(workspacePath);
  const candidates = [raw];
  if (!isAbsolute(raw)) candidates.push(join(rootDir, raw));
  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function listCodexTranscriptPaths(sessionRoots, { startedAt = null, endedAt = null } = {}, cache = null) {
  const cacheKey = cache
    ? JSON.stringify({
      roots: sessionRoots.map((root) => resolve(String(root))),
      startedAt: dayKey(startedAt),
      endedAt: dayKey(endedAt || startedAt),
    })
    : null;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const paths = [];
  const seen = new Set();
  for (const root of sessionRoots) {
    if (!root) continue;
    const resolvedRoot = resolve(String(root));
    const dateDirs = codexSessionDateDirs(resolvedRoot, { startedAt, endedAt });
    for (const dir of dateDirs.length > 0 ? dateDirs : [resolvedRoot]) {
      addJsonlFilesRecursively(dir, paths, seen);
    }
  }
  if (cacheKey) cache.set(cacheKey, paths);
  return paths;
}

function listClaudeTranscriptPaths(sessionRoots, cache = null) {
  const cacheKey = cache
    ? JSON.stringify({ roots: sessionRoots.map((root) => resolve(String(root))) })
    : null;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
  const paths = [];
  const seen = new Set();
  for (const root of sessionRoots) {
    if (!root) continue;
    addJsonlFilesRecursively(resolve(String(root)), paths, seen);
  }
  if (cacheKey) cache.set(cacheKey, paths);
  return paths;
}

function dayKey(value) {
  const parsed = parseDate(value);
  if (!parsed) return null;
  return parsed.toISOString().slice(0, 10);
}

function codexSessionDateDirs(root, { startedAt = null, endedAt = null } = {}) {
  const start = parseDate(startedAt);
  const end = parseDate(endedAt) || start;
  if (!start) return [];
  const days = [];
  const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  first.setUTCDate(first.getUTCDate() - 1);
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  last.setUTCDate(last.getUTCDate() + 1);
  for (const day = new Date(first); day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    const yyyy = String(day.getUTCFullYear());
    const mm = String(day.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(day.getUTCDate()).padStart(2, '0');
    const dir = join(root, yyyy, mm, dd);
    if (existsSync(dir)) days.push(dir);
  }
  return days;
}

function addJsonlFilesRecursively(dir, paths, seen) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      addJsonlFilesRecursively(entryPath, paths, seen);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !seen.has(entryPath)) {
      seen.add(entryPath);
      paths.push(entryPath);
    }
  }
}

function readCodexTranscriptSummary(transcriptPath) {
  let sessionId = null;
  let cwd = null;
  let startedAt = null;
  let endedAt = null;
  let tokenUsage = null;
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = item.timestamp || item.payload?.timestamp || null;
      if (timestamp) {
        startedAt ||= timestamp;
        endedAt = timestamp;
      }
      if (item.type === 'session_meta') {
        sessionId ||= item.payload?.id || null;
        cwd ||= item.payload?.cwd || null;
        if (item.payload?.timestamp) startedAt = item.payload.timestamp;
      } else if (item.type === 'turn.completed') {
        const usage = tokenUsageFromCodexTotal(item.usage || null);
        if (usage) tokenUsage = usage;
      } else if (item.type === 'event_msg' && item.payload?.type === 'token_count') {
        const total = item.payload?.info?.total_token_usage || null;
        const usage = tokenUsageFromCodexTotal(total);
        if (usage) tokenUsage = usage;
      }
    }
  } catch {
    return null;
  }
  return { sessionId, cwd, startedAt, endedAt, tokenUsage };
}

function readClaudeTranscriptSummary(transcriptPath) {
  let sessionId = null;
  let cwd = null;
  let startedAt = null;
  let endedAt = null;
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    toolContext: 0,
  };
  let sawUsage = false;
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = item.timestamp || item.message?.timestamp || null;
      if (timestamp) {
        startedAt ||= timestamp;
        endedAt = timestamp;
      }
      sessionId ||= item.sessionId || item.message?.sessionId || null;
      cwd ||= item.cwd || item.message?.cwd || null;
      const usage = item.message?.usage || item.usage || null;
      if (usage && typeof usage === 'object') {
        const normalized = tokenUsageFromClaudeUsage(usage);
        if (normalized) {
          sawUsage = true;
          totals.input += normalized.input || 0;
          totals.output += normalized.output || 0;
          totals.cacheRead += normalized.cacheRead || 0;
          totals.cacheWrite += normalized.cacheWrite || 0;
          totals.reasoning += normalized.reasoning || 0;
          totals.toolContext += normalized.toolContext || 0;
        }
      }
    }
  } catch {
    return null;
  }
  const tokenUsage = sawUsage
    ? normalizeTokenUsage({
      ...totals,
      total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
      source: 'claude-transcript',
    })
    : null;
  return { sessionId, cwd, startedAt, endedAt, tokenUsage };
}

function tokenUsageFromCodexTotal(total) {
  if (!total || typeof total !== 'object') return null;
  return normalizeTokenUsage({
    input: total.input_tokens,
    output: total.output_tokens,
    cacheRead: total.cached_input_tokens,
    cacheWrite: 0,
    total: total.total_tokens,
    source: 'codex-transcript',
  });
}

function tokenUsageFromClaudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return normalizeTokenUsage({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    total: usage.total_tokens,
    source: 'claude-transcript',
  });
}

function readCodexWorkerLogTokenUsage(logPath) {
  if (!logPath || !existsSync(logPath)) return null;
  let text;
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const jsonUsage = readCodexWorkerLogJsonTokenUsage(text);
  const tokenMatch = text.match(/(?:^|\n)[^\S\r\n]*tokens used(?:[^\S\r\n]+|\r?\n[^\S\r\n]*)([\d,]+)/i);
  if (!jsonUsage && !tokenMatch) return null;
  const usage = jsonUsage || normalizeTokenUsage({
    total: tokenMatch[1].replaceAll(',', ''),
    source: 'codex-worker-log',
  });
  if (!usage) return null;
  const sessionMatch = text.match(/^\s*session id:\s*(\S+)/mi);
  return {
    ...usage,
    adapterSessionKey: sessionMatch?.[1] || null,
    transcriptPath: logPath,
  };
}

function readCodexWorkerLogJsonTokenUsage(text) {
  let tokenUsage = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim() || (!line.includes('token_count') && !line.includes('turn.completed'))) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const total = item.type === 'turn.completed'
      ? item.usage
      : (
          item.type === 'event_msg' && item.payload?.type === 'token_count'
            ? item.payload?.info?.total_token_usage
            : null
        );
    const usage = tokenUsageFromCodexTotal(total || null);
    if (usage) {
      tokenUsage = {
        ...usage,
        source: 'codex-worker-log',
      };
    }
  }
  return tokenUsage;
}

function defaultCodexSessionRoots({ env = process.env } = {}) {
  return uniqueExistingPaths([
    ...(env.CODEX_SESSION_ROOTS ? env.CODEX_SESSION_ROOTS.split(':') : []),
    env.CODEX_SESSION_ROOT,
    join(homedir(), '.codex', 'sessions'),
  ]);
}

function defaultClaudeSessionRoots({ env = process.env } = {}) {
  return uniqueExistingPaths([
    ...(env.CLAUDE_SESSION_ROOTS ? env.CLAUDE_SESSION_ROOTS.split(':') : []),
    env.CLAUDE_SESSION_ROOT,
    env.CLAUDE_PROJECTS_ROOT,
    join(homedir(), '.claude', 'projects'),
  ]);
}

function uniqueExistingPaths(paths) {
  const result = [];
  const seen = new Set();
  for (const path of paths) {
    if (!path) continue;
    const resolved = resolve(String(path));
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function readBestReviewerEvidenceTokenUsage({
  workerRunId = null,
  launchRequestId = null,
  adapterSessionKey = null,
  sessionKeys = [],
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  rootDir = process.cwd(),
  reviewerModel = null,
  codexSessionRoots = null,
  claudeSessionRoots = null,
  transcriptFallback = true,
  workerLogPath = null,
} = {}) {
  const selectedLedgerTarget = selectLedgerTargetSource({ ledgerTarget, ledgerDbPath, env });
  const ledgerUsage = readWorkerRunTokenUsage({
    workerRunId,
    launchRequestId,
    ledgerTarget: selectedLedgerTarget,
    env,
    rootDir,
  }) || readReviewerSessionTokenUsage({
    adapterSessionKey,
    sessionKeys,
    workspacePath,
    startedAt,
    endedAt,
    ledgerTarget: selectedLedgerTarget,
    env,
    rootDir,
  });
  if (ledgerUsage) return ledgerUsage;
  if (transcriptFallback) {
    const shouldUseDefaults = shouldUseDefaultTranscriptRoots(rootDir);
    const resolvedCodexSessionRoots = codexSessionRoots || (shouldUseDefaults ? defaultCodexSessionRoots({ env }) : []);
    const resolvedClaudeSessionRoots = claudeSessionRoots || (shouldUseDefaults ? defaultClaudeSessionRoots({ env }) : []);
    const transcriptReaders = normalizeReviewerClass(reviewerModel) === 'claude'
      ? [readClaudeTranscriptTokenUsage, readCodexTranscriptTokenUsage]
      : [readCodexTranscriptTokenUsage, readClaudeTranscriptTokenUsage];
    for (const reader of transcriptReaders) {
      const usage = reader === readClaudeTranscriptTokenUsage
        ? reader({
          adapterSessionKey,
          sessionKeys,
          workspacePath,
          startedAt,
          endedAt,
          sessionRoots: resolvedClaudeSessionRoots,
          rootDir,
        })
        : reader({
          workspacePath,
          startedAt,
          endedAt,
          sessionRoots: resolvedCodexSessionRoots,
          rootDir,
        });
      if (usage) return usage;
    }
  }
  return readCodexWorkerLogTokenUsage(workerLogPath);
}

function shouldUseDefaultTranscriptRoots(rootDir) {
  if (process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK === '1') return true;
  if (process.env.ADV_REVIEW_TOKEN_TRANSCRIPT_FALLBACK === '0') return false;
  const resolved = resolve(String(rootDir || ''));
  return resolved === '/Users/airlock/agent-os/tools/adversarial-review'
    || resolved === '/Users/placey/agent-os-trees/codex/agent-os/tools/adversarial-review'
    || resolved === '/Users/placey/agent-os-trees/claude-code/agent-os/tools/adversarial-review';
}

function timestampOverlapsWindow(startedAt, endedAt, windowStart, windowEnd) {
  const start = parseDate(startedAt);
  const end = parseDate(endedAt) || start;
  if (!start) return false;
  const graceMs = 15 * 60 * 1000;
  const low = parseDate(windowStart);
  const high = parseDate(windowEnd) || low;
  if (low && end < new Date(low.getTime() - graceMs)) return false;
  if (high && start > new Date(high.getTime() + graceMs)) return false;
  return true;
}

function timestampWithinWindow(startedAt, endedAt, windowStart, windowEnd) {
  const start = parseDate(startedAt);
  const end = parseDate(endedAt) || start;
  if (!start) return false;
  const low = parseDate(windowStart);
  const high = parseDate(windowEnd) || low;
  if (low && start < low) return false;
  if (high && end > high) return false;
  return true;
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    closeOwnedReviewDb(db);
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
  function addJsonFilesRecursively(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        addJsonFilesRecursively(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        addJob(entryPath);
      }
    }
  }
  for (const state of states) {
    addJsonFilesRecursively(join(base, state));
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
  ledgerTarget = null,
  ledgerDbPath = null,
  codexSessionRoots = [],
  claudeSessionRoots = [],
  transcriptFallback = false,
  now = () => new Date().toISOString(),
  env = process.env,
  dryRun = false,
} = {}) {
  const selectedLedgerTarget = selectLedgerTargetSource({ ledgerTarget, ledgerDbPath, env });
  const jobs = readHistoricalFollowUpJobs(rootDir);
  let considered = 0;
  let insertedOrUpdated = 0;
  let wouldInsertOrUpdate = 0;
  let tokenMatched = 0;
  let workerLogMatched = 0;
  let transcriptMatched = 0;
  let claudeTranscriptMatched = 0;
  let skipped = 0;
  const uniquePassKeys = new Set();
  const codexTranscriptSummaryCache = new Map();
  const codexTranscriptPathCache = new Map();
  const claudeTranscriptSummaryCache = new Map();
  const claudeTranscriptPathCache = new Map();
  for (const { job, jobPath } of jobs) {
    const worker = historicalWorkerForJob(job);
    const repo = job?.repo;
    const prNumber = Number(job?.prNumber);
    const workspacePath = worker.workspaceDir || job?.workspaceDir || null;
    if (!repo || !Number.isInteger(prNumber) || !workspacePath) {
      skipped += 1;
      continue;
    }
    considered += 1;
    const round = latestRemediationRound(job);
    const attemptNumber = normalizeAttemptNumber(
      round?.round
      || round?.attemptNumber
      || job?.remediationPlan?.currentRound
      || job?.currentRound
      || 1
    );
    uniquePassKeys.add(`${repo}#${prNumber}#${attemptNumber}#remediation`);
    const startedAt = worker.spawnedAt || job.claimedAt || job.createdAt || now();
    const endedAt = job.completedAt || job.failedAt || job.stoppedAt || worker.reconciledAt || null;
    const status = job.status === 'completed'
      ? 'completed'
      : (job.status === 'failed' ? 'failed' : 'cancelled');
    const launchRequestId = worker.launchRequestId || worker.launchRequestID || job.replyStorageKey || null;
    const usage = readWorkerRunTokenUsage({
      workerRunId: worker.workerRunId || worker.runId || null,
      launchRequestId,
      ledgerTarget: selectedLedgerTarget,
      env,
      rootDir,
    }) || readReviewerSessionTokenUsage({
      workspacePath,
      startedAt,
      endedAt,
      ledgerTarget: selectedLedgerTarget,
      env,
      rootDir,
    }) || (transcriptFallback ? readTranscriptTokenUsageForModel({
      reviewerModel: worker.model || worker.workerClass,
      workspacePath,
      startedAt,
      endedAt,
      codexSessionRoots,
      claudeSessionRoots,
      codexTranscriptSummaryCache,
      codexTranscriptPathCache,
      claudeTranscriptSummaryCache,
      claudeTranscriptPathCache,
      rootDir,
    }) : null) || readCodexWorkerLogTokenUsage(worker.logPath);
    if (usage) {
      tokenMatched += 1;
      if (usage.source === 'codex-worker-log') workerLogMatched += 1;
      if (usage.source === 'codex-transcript') transcriptMatched += 1;
      if (usage.source === 'claude-transcript') claudeTranscriptMatched += 1;
    }
    wouldInsertOrUpdate += 1;
    if (dryRun) continue;

    beginReviewerPass(rootDir, {
      repo,
      prNumber,
      attemptNumber,
      reviewerClass: worker.workerClass || worker.model || 'codex',
      reviewerModel: worker.model || worker.workerClass || 'codex',
      passKind: 'remediation',
      workerRunId: usage?.workerRunId || worker.workerRunId || worker.runId || null,
      workspacePath,
      startedAt,
      metadata: {
        backfill: true,
        jobPath,
        jobId: job.jobId || null,
        launchRequestId,
        transcriptPath: usage?.transcriptPath || null,
        transcriptSessionId: usage?.adapterSessionKey || null,
        workerLogPath: usage?.source === 'codex-worker-log' ? usage.transcriptPath : null,
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
        transcriptPath: usage?.transcriptPath || null,
        transcriptSessionId: usage?.adapterSessionKey || null,
        workerLogPath: usage?.source === 'codex-worker-log' ? usage.transcriptPath : null,
      },
    });
    insertedOrUpdated += 1;
  }
  return {
    considered,
    insertedOrUpdated,
    wouldInsertOrUpdate,
    uniquePassKeys: uniquePassKeys.size,
    tokenMatched,
    workerLogMatched,
    transcriptMatched,
    claudeTranscriptMatched,
    skipped,
  };
}

function readTranscriptTokenUsageForModel({
  reviewerModel = null,
  adapterSessionKey = null,
  sessionKeys = [],
  workspacePath = null,
  startedAt = null,
  endedAt = null,
  codexSessionRoots = [],
  claudeSessionRoots = [],
  codexTranscriptSummaryCache = null,
  codexTranscriptPathCache = null,
  claudeTranscriptSummaryCache = null,
  claudeTranscriptPathCache = null,
  rootDir = process.cwd(),
} = {}) {
  const readers = normalizeReviewerClass(reviewerModel) === 'claude'
    ? ['claude', 'codex']
    : ['codex', 'claude'];
  for (const reader of readers) {
    const usage = reader === 'claude'
      ? readClaudeTranscriptTokenUsage({
        adapterSessionKey,
        sessionKeys,
        workspacePath,
        startedAt,
        endedAt,
        sessionRoots: claudeSessionRoots,
        transcriptSummaryCache: claudeTranscriptSummaryCache,
        transcriptPathCache: claudeTranscriptPathCache,
        rootDir,
      })
      : readCodexTranscriptTokenUsage({
        workspacePath,
        startedAt,
        endedAt,
        sessionRoots: codexSessionRoots,
        transcriptSummaryCache: codexTranscriptSummaryCache,
        transcriptPathCache: codexTranscriptPathCache,
        rootDir,
      });
    if (usage) return usage;
  }
  return null;
}

function latestRemediationRound(job) {
  const rounds = Array.isArray(job?.remediationPlan?.rounds) ? job.remediationPlan.rounds : [];
  return rounds.length > 0 ? rounds[rounds.length - 1] : null;
}

function historicalWorkerForJob(job) {
  const round = latestRemediationRound(job);
  const roundWorker = round?.worker || {};
  const topLevelWorker = job?.remediationWorker || {};
  return {
    ...topLevelWorker,
    ...roundWorker,
    model: roundWorker.model || topLevelWorker.model || job?.reviewerModel || 'codex',
    workerClass: roundWorker.workerClass || topLevelWorker.workerClass || roundWorker.model || topLevelWorker.model || 'codex',
    workerRunId: roundWorker.workerRunId || topLevelWorker.workerRunId || roundWorker.runId || topLevelWorker.runId || null,
    runId: roundWorker.runId || topLevelWorker.runId || null,
    launchRequestId: roundWorker.launchRequestId || topLevelWorker.launchRequestId || null,
    launchRequestID: roundWorker.launchRequestID || topLevelWorker.launchRequestID || null,
    workspaceDir: roundWorker.workspaceDir || topLevelWorker.workspaceDir || job?.workspaceDir || null,
    spawnedAt: roundWorker.spawnedAt || topLevelWorker.spawnedAt || round?.spawnedAt || job?.claimedAt || null,
    reconciledAt: roundWorker.reconciledAt || topLevelWorker.reconciledAt || round?.finishedAt || null,
  };
}

// The AMA closer records its pass POST-merge and polls the ledger for the hammer
// worker's token rollup for only ~8.5s (AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS).
// A slower rollup leaves the closer pass with null tokens, and the job-driven
// backfillReviewerPasses only heals `remediation` passes — so closer passes never
// self-healed (100% null in the live data). This re-reads the ledger for every
// null-token closer pass that still has its worker_run_id and fills it, so the
// closer converges once the worker-pool capture lands the hammer tokens.
function backfillCloserReviewerPasses(rootDir, {
  ledgerTarget = null,
  ledgerDbPath = null,
  hqRoot = null,
  env = process.env,
  dryRun = false,
} = {}) {
  const db = openReviewStateDb(rootDir);
  let candidates;
  try {
    ensureReviewStateSchema(db);
    candidates = db.prepare(
      `SELECT repo, pr_number AS prNumber, attempt_number AS attemptNumber,
              worker_run_id AS workerRunId, status, metadata_json AS metadataJson
         FROM reviewer_passes
        WHERE pass_kind = 'closer'
          AND token_input IS NULL
          AND worker_run_id IS NOT NULL`
    ).all();
  } finally {
    closeOwnedReviewDb(db);
  }
  let considered = 0;
  let filled = 0;
  let stillMissing = 0;
  for (const row of candidates) {
    considered += 1;
    const launchRequestId = parseMetadataJson(row.metadataJson).launchRequestId || null;
    const usage = readWorkerRunTokenUsage({
      workerRunId: row.workerRunId,
      launchRequestId,
      ledgerTarget,
      ledgerDbPath,
      env,
      rootDir,
      hqRoot,
    });
    if (!usage || (usage.input == null && usage.output == null && usage.cacheRead == null)) {
      stillMissing += 1;
      continue;
    }
    if (!dryRun) {
      completeReviewerPass(rootDir, {
        repo: row.repo,
        prNumber: row.prNumber,
        attemptNumber: row.attemptNumber,
        passKind: 'closer',
        status: PASS_STATUSES.has(row.status) ? row.status : 'completed',
        workerRunId: row.workerRunId,
        tokenUsage: usage,
        tokenSource: usage.source || null,
      });
    }
    filled += 1;
  }
  return { considered, filled, stillMissing };
}

export {
  backfillCloserReviewerPasses,
  backfillReviewerPasses,
  beginReviewerPass,
  completeReviewerPass,
  foldReviewerTokenUsageArtifact,
  tagTokenUsage,
  normalizeReviewerClass,
  normalizeTokenUsage,
  parseSince,
  readBestReviewerEvidenceTokenUsage,
  readClaudeTranscriptTokenUsage,
  readCodexTranscriptTokenUsage,
  readCodexWorkerLogTokenUsage,
  readReviewerTokenUsageArtifact,
  readReviewerSessionTokenUsage,
  readWorkerRunTokenUsage,
  readWorkerRunTokenUsageResult,
  reviewerTokenUsageArtifactPath,
  reviewerPassRows,
  writeReviewerTokenUsageArtifact,
};
