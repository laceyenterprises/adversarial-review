import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import {
  quotaAvailableFromFleetStatus,
  providerForQuotaHarness,
  isGroundedProviderState,
} from './fleet-quota-status.mjs';

const execFileAsync = promisify(execFileCb);
const FLEET_QUOTA_STATUS_TIMEOUT_MS = 20_000;
const FLEET_QUOTA_STATUS_RETRY_DELAYS_MS = Object.freeze([250, 1000]);
const FLEET_QUOTA_STATUS_CACHE_TTL_MS = 10_000;
const FLEET_QUOTA_STATUS_CACHE_BY_EXEC = new WeakMap();

const DEFAULT_REVIEWER_WORKER_CLASS_FALLBACK = Object.freeze(['claude-code']);
const REVIEWER_MODEL_BY_WORKER_CLASS = Object.freeze({
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
});

export function reviewWorkerClassFallback(env = process.env) {
  const raw = env?.ADVERSARIAL_REVIEW_REVIEWER_WORKER_CLASS_FALLBACK;
  if (raw === undefined || raw === null) return [...DEFAULT_REVIEWER_WORKER_CLASS_FALLBACK];
  return String(raw)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function resolveHqPath(env = process.env) {
  return String(env?.AGENT_OS_HQ_BIN || env?.HQ_BIN || 'hq').trim() || 'hq';
}

function reviewerModelForWorkerClass(workerClass) {
  return REVIEWER_MODEL_BY_WORKER_CLASS[String(workerClass || '').trim().toLowerCase()] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fleetQuotaStatusCacheFor(execFileImpl) {
  if (typeof execFileImpl !== 'function') return new Map();
  let cache = FLEET_QUOTA_STATUS_CACHE_BY_EXEC.get(execFileImpl);
  if (!cache) {
    cache = new Map();
    FLEET_QUOTA_STATUS_CACHE_BY_EXEC.set(execFileImpl, cache);
  }
  return cache;
}

function fleetQuotaStatusCacheKey({ hqPath }) {
  return JSON.stringify({ hqPath: String(hqPath || '') });
}

function fleetQuotaStatusErrorMessage(error) {
  const code = error?.code ? ` code=${error.code}` : '';
  const signal = error?.signal ? ` signal=${error.signal}` : '';
  const killed = error?.killed === true ? ' killed=true' : '';
  const message = String(error?.message || error || 'unknown error');
  const streamText = fleetQuotaStatusErrorText(error)
    .replace(message, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const streamPreview = streamText ? ` detail=${streamText.slice(0, 500)}` : '';
  return `${message}${code}${signal}${killed}${streamPreview}`;
}

function errorTextPart(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function fleetQuotaStatusErrorText(error, seen = new Set()) {
  if (!error) return '';
  if (typeof error !== 'object') return errorTextPart(error);
  if (seen.has(error)) return '';
  seen.add(error);
  const parts = [
    errorTextPart(error.message),
    errorTextPart(error.stderr),
    errorTextPart(error.stdout),
    errorTextPart(error.code),
    errorTextPart(error.errno),
    errorTextPart(error.syscall),
    errorTextPart(error.signal),
    fleetQuotaStatusErrorText(error.cause, seen),
  ];
  return parts.filter(Boolean).join('\n');
}

function isTransientFleetQuotaStatusError(error) {
  const code = String(error?.code || '').toUpperCase();
  if (['EIO', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  if (error?.killed === true) return true;
  const text = fleetQuotaStatusErrorText(error).toLowerCase();
  if (
    /\b(eio|etimedout|econnreset|econnrefused|epipe|eagain|eai_again|enotfound)\b/u.test(text) ||
    /timed?\s*out|timeout|tls handshake|connection reset|connection refused/u.test(text) ||
    /resource temporarily unavailable|temporarily unavailable|try again/.test(text) ||
    /socket hang up|remote end hung up/.test(text)
  ) {
    return true;
  }
  return false;
}

async function executeFleetQuotaStatusWithRetry({
  env,
  hqPath,
  execFileImpl,
  logger,
  sleepImpl,
  retryDelaysMs,
}) {
  const attempts = retryDelaysMs.length + 1;
  let lastError = null;
  let attemptsMade = 0;
  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    try {
      const result = await execFileImpl(hqPath, ['fleet', 'quota', 'status', '--json'], {
        env,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        timeout: FLEET_QUOTA_STATUS_TIMEOUT_MS,
      });
      const stdout = typeof result === 'string' ? result : String(result?.stdout || '');
      return { stdout, source: attemptIndex === 0 ? 'exec' : 'exec-retry' };
    } catch (err) {
      lastError = err;
      attemptsMade = attemptIndex + 1;
      const message = fleetQuotaStatusErrorMessage(err);
      const retryDelayMs = retryDelaysMs[attemptIndex];
      if (isTransientFleetQuotaStatusError(err) && attemptIndex < attempts - 1) {
        logger?.warn?.(
          `[watcher] review-worker-class-fallback quota-status transient failure ` +
          `attempt=${attemptIndex + 1}/${attempts}; retrying in ${retryDelayMs}ms: ${message}`
        );
        if (retryDelayMs > 0) await sleepImpl(retryDelayMs);
        continue;
      }
      break;
    }
  }

  const message = fleetQuotaStatusErrorMessage(lastError);
  logger?.error?.(
    `[watcher] review-worker-class-fallback quota-status unavailable ` +
    `attempts=${attemptsMade}/${attempts}; failing open: ${message}`
  );
  return { error: lastError, errorMessage: message };
}

async function readFleetQuotaStatusWithRetry({
  env,
  hqPath,
  execFileImpl,
  logger,
  sleepImpl,
  retryDelaysMs,
  cache,
  cacheTtlMs,
  nowMs,
}) {
  const cacheKey = fleetQuotaStatusCacheKey({ hqPath });
  const now = nowMs();
  const cached = cache?.get(cacheKey);
  if (cached && now - cached.readAtMs <= cacheTtlMs) {
    if (cached.promise) return cached.promise;
    if (typeof cached.stdout === 'string') return { stdout: cached.stdout, source: 'cache' };
  }

  const promise = executeFleetQuotaStatusWithRetry({
    env,
    hqPath,
    execFileImpl,
    logger,
    sleepImpl,
    retryDelaysMs,
  });
  cache?.set(cacheKey, { promise, readAtMs: now });
  const result = await promise;
  if (!cache || cache.get(cacheKey)?.promise === promise) {
    if (result.error) {
      cache?.delete(cacheKey);
    } else {
      cache?.set(cacheKey, { stdout: result.stdout, readAtMs: nowMs() });
    }
  }
  return result;
}

export function applyReviewerWorkerClassFallbackToRoute({
  route,
  decision,
  reviewerRouteByModel,
} = {}) {
  if (!decision?.fellBack) return { applied: false, route, reason: 'no-fallback' };
  const workerClass = String(decision.workerClass || '').trim().toLowerCase();
  const reviewerModel = reviewerModelForWorkerClass(workerClass);
  const target = reviewerModel ? reviewerRouteByModel?.[reviewerModel] : null;
  if (!target) {
    return { applied: false, route, reason: 'fallback-route-unavailable' };
  }

  return {
    applied: true,
    route: {
      ...route,
      workerClass: undefined,
      reviewerWorkerClass: workerClass,
      reviewerModel: target.reviewerModel,
      botTokenEnv: target.botTokenEnv,
      reviewWorkerClassFallback: {
        fromWorkerClass: decision.from,
        toWorkerClass: decision.to,
        reason: decision.reason,
      },
    },
  };
}

/**
 * @param {Object} args
 * @param {string} args.authorClass — the PR author worker class.
 * @param {string} args.primary — the routed reviewer worker_class.
 * @param {string[]=} args.fallbackWorkerClasses — ordered fallback harnesses.
 * @param {Object=} args.env
 * @param {string=} args.hqPath
 * @param {Function=} args.execFileImpl — DI for `hq fleet quota status --json`.
 * @param {Object=} args.logger — warning/error sink for fail-open degradation.
 * @param {Function=} args.sleepImpl — DI for bounded retry sleeps.
 * @param {number[]=} args.retryDelaysMs — transient retry delays.
 * @param {Map=} args.fleetQuotaStatusCache — short-lived stdout cache.
 * @param {number=} args.fleetQuotaStatusCacheTtlMs — cache TTL.
 * @param {Function=} args.nowMs — DI for cache timestamps.
 * @returns {Promise<{ workerClass: string, fellBack: boolean, reason: string,
 *   from?: string, to?: string, primaryState?: string, error?: string }>}
 */
export async function resolveReviewerWorkerClassWithFallback({
  authorClass,
  primary,
  fallbackWorkerClasses,
  env = process.env,
  hqPath = resolveHqPath(env),
  execFileImpl = execFileAsync,
  logger = console,
  sleepImpl = sleep,
  retryDelaysMs = FLEET_QUOTA_STATUS_RETRY_DELAYS_MS,
  fleetQuotaStatusCache = fleetQuotaStatusCacheFor(execFileImpl),
  fleetQuotaStatusCacheTtlMs = FLEET_QUOTA_STATUS_CACHE_TTL_MS,
  nowMs = () => Date.now(),
} = {}) {
  const author = String(authorClass || '').trim().toLowerCase();
  const primaryClass = String(primary || '').trim().toLowerCase();
  const fallbacks = (Array.isArray(fallbackWorkerClasses) ? fallbackWorkerClasses : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const base = { workerClass: primaryClass, fellBack: false };

  if (!primaryClass || fallbacks.length === 0) {
    return { ...base, reason: 'no-fallback-configured' };
  }
  if (!providerForQuotaHarness(primaryClass)) {
    return { ...base, reason: 'primary-provider-untracked' };
  }
  const viableFallbacks = fallbacks.filter((candidate) => (
    candidate !== primaryClass &&
    candidate !== author &&
    providerForQuotaHarness(candidate)
  ));
  if (viableFallbacks.length === 0) {
    return { ...base, reason: 'no-available-fallback' };
  }

  const quotaStatus = await readFleetQuotaStatusWithRetry({
    env,
    hqPath,
    execFileImpl,
    logger,
    sleepImpl,
    retryDelaysMs: Array.isArray(retryDelaysMs) ? retryDelaysMs : [],
    cache: fleetQuotaStatusCache,
    cacheTtlMs: Number.isFinite(fleetQuotaStatusCacheTtlMs) ? fleetQuotaStatusCacheTtlMs : 0,
    nowMs,
  });
  if (quotaStatus.error) {
    return { ...base, reason: 'fleet-quota-status-unavailable', error: quotaStatus.errorMessage };
  }

  const stdout = quotaStatus.stdout;
  const primaryAvail = quotaAvailableFromFleetStatus(stdout, { harness: primaryClass });
  if (!isGroundedProviderState(primaryAvail.state)) {
    return {
      ...base,
      reason: primaryAvail.available ? 'primary-available' : 'primary-not-grounded',
      primaryState: primaryAvail.state,
    };
  }

  for (const candidate of viableFallbacks) {
    const candidateAvail = quotaAvailableFromFleetStatus(stdout, { harness: candidate });
    if (candidateAvail.available) {
      return {
        workerClass: candidate,
        fellBack: true,
        from: primaryClass,
        to: candidate,
        reason: 'primary-grounded-fallback',
        primaryState: primaryAvail.state,
      };
    }
  }

  return { ...base, reason: 'no-available-fallback', primaryState: primaryAvail.state };
}
