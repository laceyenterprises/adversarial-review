import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigCached } from './config-loader.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_DAG_AUTOWALK_ON_MERGE_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_PER_POLL = 2;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS = 5;
const DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS = 2 * 60 * 1000;

function sanitizeDagAutowalkPathSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 180) || 'unknown';
}

function dagAutowalkOnMergeDir(rootDir = ROOT) {
  return join(rootDir, 'data', 'follow-up-jobs', 'dag-autowalk-on-merge');
}

function dagAutowalkOnMergePath(rootDir, { repo, prNumber }) {
  const repoKey = sanitizeDagAutowalkPathSegment(repo);
  const prKey = sanitizeDagAutowalkPathSegment(prNumber);
  return join(dagAutowalkOnMergeDir(rootDir), `${repoKey}-pr-${prKey}.json`);
}

function readDagAutowalkOnMergeRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeDagAutowalkOnMergeRecord(rootDir, record) {
  writeFileAtomic(
    dagAutowalkOnMergePath(rootDir, record),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

function writeDagAutowalkOnMergeRecordPath(recordPath, record) {
  writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function listDagAutowalkOnMergeRecords(rootDir = ROOT) {
  const dir = dagAutowalkOnMergeDir(rootDir);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(dir, name);
        const record = readDagAutowalkOnMergeRecord(path);
        return record ? { path, record } : null;
      })
      .filter(Boolean)
      .sort((a, b) => String(a.record.createdAt || '').localeCompare(String(b.record.createdAt || '')));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function resolveDagAutowalkOnMergeRetryMs(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_RETRY_MS || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_RETRY_MS}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_RETRY_MS;
}

function resolveDagAutowalkOnMergePerPoll(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_PER_POLL || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_PER_POLL}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_PER_POLL;
}

function resolveDagAutowalkOnMergeMaxAttempts(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS}`,
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_MAX_ATTEMPTS;
}

function resolveDagAutowalkOnMergeTimeoutMs(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS || `${DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS}`,
    10
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAG_AUTOWALK_ON_MERGE_TIMEOUT_MS;
}

function normalizeNonEmptyText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function resolveDagAutowalkOnMergeRepoRoot({
  env = process.env,
  loadConfigImpl = loadConfigCached,
  logger = console,
} = {}) {
  const envRoot = normalizeNonEmptyText(env.AGENT_OS_DEPLOY_CHECKOUT);
  if (envRoot) {
    if (isAbsolute(envRoot)) return envRoot;
    logger.error?.(
      '[watcher] dag autowalk-on-merge requires AGENT_OS_DEPLOY_CHECKOUT to be absolute; ' +
      'continuing without --repo-root'
    );
    return null;
  }

  try {
    const cfg = loadConfigImpl({ env });
    const configRoot = normalizeNonEmptyText(cfg?.get?.('roots.deploy'));
    if (!configRoot) return null;
    if (isAbsolute(configRoot)) return configRoot;
    logger.error?.(
      '[watcher] dag autowalk-on-merge requires roots.deploy to be absolute; ' +
      'continuing without --repo-root'
    );
    return null;
  } catch (err) {
    logger.error?.(
      `[watcher] dag autowalk-on-merge could not resolve roots.deploy; ` +
      `continuing without --repo-root: ${err?.message || err}`
    );
    return null;
  }
}

function isMalformedDagAutowalkOnMergeRecord(record) {
  return !record?.repo || !record?.prNumber;
}

function failMalformedDagAutowalkOnMergeRecord(recordPath, record, {
  logger = console,
  now = new Date(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  const updatedAt = now.toISOString();
  const failed = {
    ...record,
    status: 'failed',
    attempts: Math.max(Number(record?.attempts || 0), maxAttempts),
    updatedAt,
    lastError: {
      message: 'Malformed dag autowalk-on-merge record: missing repo or prNumber',
      code: 'malformed-record',
      signal: null,
      exitCode: null,
      stdout: '',
      stderr: '',
    },
  };
  writeDagAutowalkOnMergeRecordPath(recordPath, failed);
  logger.error?.(
    `[watcher] dag autowalk-on-merge malformed owed record marked failed at ${recordPath}: ` +
    'missing repo or prNumber'
  );
  return failed;
}

function shouldRetryDagAutowalkOnMerge(record, {
  nowMs = Date.now(),
  retryMs = resolveDagAutowalkOnMergeRetryMs(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  if (!record || record.status === 'succeeded') return false;
  if (record.status === 'failed' && Number(record.attempts || 0) >= maxAttempts) return false;
  if (!record.lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(record.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return true;
  return nowMs - lastAttemptMs >= retryMs;
}

/**
 * Persist owed `hq dag autowalk-on-merge` work for a just-merged PR.
 *
 * On AMA-enabled hosts PRs merge via this pipeline (AMA closer / merge-agent)
 * using `gh pr merge`, not `hq adjudicate merge`, so the legacy D5 dag_on_merge
 * step-advance is dead and the periodic `hq dag autowalk --all` sweep can window
 * out a specific failed-but-merged step for many ticks. The watcher records a
 * durable owed-work file before marking the PR merged, then attempts the
 * targeted autowalk through the bounded retry path below. The record is removed
 * only after the command exits successfully; failures retain stdout/stderr and
 * exit details for operator diagnosis and retry on later watcher ticks.
 */
export function fireDagAutowalkOnMerge({
  repo,
  prNumber,
  rootDir = ROOT,
  now = new Date(),
  logger = console,
} = {}) {
  const recordPath = dagAutowalkOnMergePath(rootDir, { repo, prNumber });
  const existing = readDagAutowalkOnMergeRecord(recordPath);
  if (existing?.status && existing.status !== 'succeeded') {
    logger.log?.(`[watcher] dag autowalk-on-merge already owed for ${repo}#${prNumber}`);
    return existing;
  }
  const record = {
    schemaVersion: 1,
    repo,
    prNumber: Number(prNumber),
    status: 'pending',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
  };
  writeDagAutowalkOnMergeRecord(rootDir, record);
  logger.log?.(`[watcher] dag autowalk-on-merge owed for ${repo}#${prNumber}`);
  return record;
}

export async function attemptDagAutowalkOnMerge({
  rootDir = ROOT,
  record,
  execFileImpl = execFileAsync,
  env = process.env,
  hqPath = env.HQ_BIN || 'hq',
  loadConfigImpl = loadConfigCached,
  logger = console,
  now = new Date(),
  timeoutMs = resolveDagAutowalkOnMergeTimeoutMs(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  const repo = record?.repo;
  const prNumber = record?.prNumber;
  if (!repo || !prNumber) return { ok: false, skipped: true, reason: 'malformed-record' };

  const attempts = Number(record.attempts || 0) + 1;
  const startedAt = now.toISOString();
  const base = {
    ...record,
    status: 'running',
    attempts,
    lastAttemptAt: startedAt,
    updatedAt: startedAt,
  };
  writeDagAutowalkOnMergeRecord(rootDir, base);

  const repoRoot = resolveDagAutowalkOnMergeRepoRoot({ env, loadConfigImpl, logger });
  const args = ['dag', 'autowalk-on-merge'];
  if (repoRoot) args.push('--repo-root', repoRoot);
  args.push('--repo', String(repo), '--pr', String(prNumber));
  try {
    const result = await execFileImpl(hqPath, args, {
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    rmSync(dagAutowalkOnMergePath(rootDir, record), { force: true });
    logger.log?.(`[watcher] dag autowalk-on-merge succeeded for ${repo}#${prNumber}`);
    return { ok: true, stdout: result?.stdout || '', stderr: result?.stderr || '' };
  } catch (err) {
    const failedAt = new Date().toISOString();
    const terminal = attempts >= maxAttempts;
    const failed = {
      ...base,
      status: terminal ? 'failed' : 'pending',
      updatedAt: failedAt,
      lastError: {
        message: err?.message || String(err),
        code: err?.code ?? null,
        signal: err?.signal ?? null,
        exitCode: err?.exitCode ?? err?.code ?? null,
        stdout: err?.stdout || '',
        stderr: err?.stderr || '',
      },
    };
    writeDagAutowalkOnMergeRecord(rootDir, failed);
    logger.error?.(
      `[watcher] dag autowalk-on-merge failed for ${repo}#${prNumber} ` +
      `(attempt ${attempts}/${maxAttempts}): ${err?.message || err}`
    );
    return { ok: false, terminal, error: err };
  }
}

export async function retryPendingDagAutowalkOnMerge({
  rootDir = ROOT,
  execFileImpl = execFileAsync,
  env = process.env,
  loadConfigImpl = loadConfigCached,
  logger = console,
  nowMs = Date.now(),
  retryMs = resolveDagAutowalkOnMergeRetryMs(),
  maxPerPoll = resolveDagAutowalkOnMergePerPoll(),
  maxAttempts = resolveDagAutowalkOnMergeMaxAttempts(),
} = {}) {
  if (maxPerPoll <= 0) return { attempted: 0, skipped: 0, pending: 0 };
  const pending = listDagAutowalkOnMergeRecords(rootDir);
  let attempted = 0;
  let skipped = 0;
  for (const item of pending) {
    if (isMalformedDagAutowalkOnMergeRecord(item.record)) {
      skipped += 1;
      failMalformedDagAutowalkOnMergeRecord(item.path, item.record, { logger, maxAttempts });
      continue;
    }
    if (
      attempted >= maxPerPoll
      || !shouldRetryDagAutowalkOnMerge(item.record, { nowMs, retryMs, maxAttempts })
    ) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    await attemptDagAutowalkOnMerge({
      rootDir,
      record: item.record,
      execFileImpl,
      env,
      loadConfigImpl,
      logger,
      maxAttempts,
    });
  }
  return { attempted, skipped, pending: pending.length };
}
