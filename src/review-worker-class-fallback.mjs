import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  quotaAvailableFromFleetStatus,
  providerForQuotaHarness,
  isGroundedProviderState,
} from './fleet-quota-status.mjs';
import {
  REVIEWER_ROUTE_BY_MODEL as REVIEWER_ROUTE_TABLE_BY_MODEL,
  isCrossModelReviewWaived,
} from './adapters/subject/github-pr/routing.mjs';

const execFileAsync = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dirname, '..');
const AGENT_OS_ROOT = resolve(SUBMODULE_ROOT, '..', '..');
const FLEET_QUOTA_STATUS_TIMEOUT_MS = 20_000;
const FLEET_QUOTA_STATUS_RETRY_DELAYS_MS = Object.freeze([250, 1000]);
const FLEET_QUOTA_STATUS_CACHE_TTL_MS = 10_000;
const FLEET_QUOTA_STATUS_CACHE_BY_EXEC = new WeakMap();

const DEFAULT_REVIEWER_WORKER_CLASS_FALLBACK = Object.freeze(['codex']);
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

function resolveHqCwd(env = process.env) {
  return String(env?.AGENT_OS_ROOT || AGENT_OS_ROOT).trim() || AGENT_OS_ROOT;
}

function reviewerModelForWorkerClass(workerClass) {
  return REVIEWER_MODEL_BY_WORKER_CLASS[String(workerClass || '').trim().toLowerCase()] || null;
}

// WRITER DIVERSITY — a correctness constraint, not a preference.
//
// The raw `candidate !== authorClass` string compare this module used to rely on
// is NOT sufficient: builder tags and reviewer worker classes are different
// vocabularies, and several tags map onto a writer model whose name they do not
// share. `clio-agent` dispatches codex workers, so a clio-agent-authored PR
// handed to a `codex` reviewer is codex reviewing codex — string-unequal,
// diversity-dead. `routing.mjs` already owns that mapping
// (REVIEWER_FAMILY_BY_BUILDER_CLASS, read through `isCrossModelReviewWaived`),
// and the prior art here is real: a gemini-authored PR was once left with no
// diverse reviewer when codex was out. So route THROUGH the existing check
// rather than re-deriving one beside it, and keep the raw compare as a belt-and-
// braces guard for tags routing.mjs does not know.
//
// Depth pressure never relaxes this. Satisfying a deep queue by handing a
// class-X PR to a class-X reviewer would buy throughput by deleting the thing
// review exists to provide.
export function violatesWriterDiversity(authorClass, candidateWorkerClass) {
  const author = String(authorClass || '').trim().toLowerCase();
  const candidate = String(candidateWorkerClass || '').trim().toLowerCase();
  if (!candidate) return true;
  if (author && candidate === author) return true;
  const reviewerModel = reviewerModelForWorkerClass(candidate);
  if (!reviewerModel) return true;
  return isCrossModelReviewWaived(author, reviewerModel);
}

// ENTITLEMENT — "spilling onto a class that cannot boot converts a slow queue
// into a stalled one."
//
// A reviewer worker class can only deliver a review if its GitHub reviewer bot
// token is present: `postGitHubReview` throws `Missing env var: <botTokenEnv>`
// without it, so an unentitled class burns a spawn and posts nothing. That is
// tolerable when the primary is quota-grounded and there is no alternative — so
// the pre-existing quota-triggered path is left exactly as it was — but it is
// not tolerable for a discretionary, quota-spending depth spill.
export function reviewerWorkerClassEntitled(workerClass, env = process.env) {
  const reviewerModel = reviewerModelForWorkerClass(workerClass);
  const botTokenEnv = reviewerModel ? REVIEWER_ROUTE_TABLE_BY_MODEL[reviewerModel]?.botTokenEnv : null;
  if (!botTokenEnv) return false;
  return String(env?.[botTokenEnv] || '').trim() !== '';
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

function fleetQuotaStatusCacheKey({ hqPath, hqCwd }) {
  return JSON.stringify({ hqPath: String(hqPath || ''), hqCwd: String(hqCwd || '') });
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
    /service unavailable|bad gateway|gateway timeout|http\s*5\d\d/.test(text) ||
    /socket hang up|remote end hung up/.test(text)
  ) {
    return true;
  }
  return false;
}

async function executeFleetQuotaStatusWithRetry({
  env,
  hqPath,
  hqCwd,
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
        cwd: hqCwd,
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
  const hqCwd = resolveHqCwd(env);
  const cacheKey = fleetQuotaStatusCacheKey({ hqPath, hqCwd });
  const now = nowMs();
  const cached = cache?.get(cacheKey);
  if (cached && now - cached.readAtMs <= cacheTtlMs) {
    if (cached.promise) return cached.promise;
    if (typeof cached.stdout === 'string') return { stdout: cached.stdout, source: 'cache' };
  }

  const promise = executeFleetQuotaStatusWithRetry({
    env,
    hqPath,
    hqCwd,
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
  authorClass = null,
} = {}) {
  if (!decision?.fellBack) return { applied: false, route, reason: 'no-fallback' };
  const workerClass = String(decision.workerClass || '').trim().toLowerCase();
  const reviewerModel = reviewerModelForWorkerClass(workerClass);
  const target = reviewerModel ? reviewerRouteByModel?.[reviewerModel] : null;
  if (!target) {
    return { applied: false, route, reason: 'fallback-route-unavailable' };
  }
  // Diversity backstop at the point the route is actually mutated. The resolver
  // already filters same-writer candidates; this refuses one last time against
  // the author the CALLER believes in, so no future trigger can reach the route
  // swap with a class-X reviewer for a class-X PR.
  const author = authorClass ?? route?.builderClass ?? null;
  if (author && violatesWriterDiversity(author, workerClass) && decision.lastResort !== true) {
    return { applied: false, route, reason: 'writer-diversity-violation' };
  }

  return {
    applied: true,
    route: {
      ...route,
      ...target,
      workerClass: undefined,
      reviewerWorkerClass: workerClass,
      reviewWorkerClassFallback: {
        fromWorkerClass: decision.from,
        toWorkerClass: decision.to,
        reason: decision.reason,
        ...(decision.lastResort ? { lastResort: true } : {}),
        // Depth provenance rides along only for a depth-triggered spill, so the
        // quota-triggered shape stays exactly what it was.
        ...(decision.queueDepth === undefined
          ? {}
          : { queueDepth: decision.queueDepth, queueDepthThreshold: decision.queueDepthThreshold }),
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
 * @param {Object=} args.depthPressure — RSP-01 queue-depth snapshot
 *   `{ engaged, depth, threshold }` from the per-tick spillover controller.
 *   Absent / `engaged: false` (the default, and the case on any host that has
 *   not armed the lever) makes this function behave exactly as it did before
 *   RSP-01, down to the returned reason strings.
 * @returns {Promise<{ workerClass: string, fellBack: boolean, reason: string,
 *   from?: string, to?: string, primaryState?: string, error?: string,
 *   queueDepth?: number, queueDepthThreshold?: number }>}
 */
export async function resolveReviewerWorkerClassWithFallback({
  authorClass,
  primary,
  fallbackWorkerClasses,
  depthPressure = null,
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

  // RSP-01 — depth is an ADDITIONAL trigger beside quota, never a replacement.
  // `depthEngaged` only widens what this function is allowed to consider; every
  // pre-existing branch below is reached on exactly the conditions it was
  // before when the lever is disarmed.
  const depthEngaged = depthPressure?.engaged === true;
  const depthFields = depthEngaged
    ? { queueDepth: depthPressure.depth ?? null, queueDepthThreshold: depthPressure.threshold ?? null }
    : {};

  if (!primaryClass || fallbacks.length === 0) {
    return { ...base, reason: 'no-fallback-configured' };
  }
  // An untracked primary short-circuits the QUOTA trigger because there is no
  // provider state to ground it on — and `gemini`/`agy`, the class this whole
  // ticket is about, is exactly that (QUOTA_HARNESS_PROVIDER covers openai and
  // anthropic only). That is precisely why a saturated-but-healthy gemini never
  // yielded. Depth does not need a primary provider state to be meaningful, so
  // an armed+engaged lever is allowed past this gate; a disarmed one is not.
  if (!providerForQuotaHarness(primaryClass) && !depthEngaged) {
    return { ...base, reason: 'primary-provider-untracked' };
  }
  const quotaTrackedFallbacks = fallbacks.filter((candidate) => (
    candidate !== primaryClass &&
    providerForQuotaHarness(candidate)
  ));
  const viableFallbacks = quotaTrackedFallbacks.filter(
    (candidate) => !violatesWriterDiversity(author, candidate)
  );
  const sameWriterLastResorts = quotaTrackedFallbacks.filter(
    (candidate) => violatesWriterDiversity(author, candidate)
  );
  if (quotaTrackedFallbacks.length === 0) {
    return { ...base, ...depthFields, reason: 'no-available-fallback' };
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
  let primaryAvail;
  try {
    // A primary with no tracked provider can only be here under depth pressure
    // (the gate above). It has no quota verdict, so it is treated as ungrounded
    // and the quota trigger simply does not fire for it — depth does.
    primaryAvail = providerForQuotaHarness(primaryClass)
      ? quotaAvailableFromFleetStatus(stdout, { harness: primaryClass })
      : { available: true, state: 'untracked-quota-harness' };
    if (!isGroundedProviderState(primaryAvail.state)) {
      // ── RSP-01 depth trigger ──────────────────────────────────────────────
      // Reached ONLY when the lever is armed, the queue is at/above threshold,
      // and this tick still has spill budget. The primary is healthy; we are
      // choosing to spend build quota to drain a backlog.
      if (depthEngaged) {
        for (const candidate of viableFallbacks) {
          // Entitled AND quota-available, in that order — both are "can this
          // class actually boot and post", and failing either makes the spill a
          // stall rather than a drain.
          if (!reviewerWorkerClassEntitled(candidate, env)) continue;
          if (!quotaAvailableFromFleetStatus(stdout, { harness: candidate }).available) continue;
          return {
            workerClass: candidate,
            fellBack: true,
            from: primaryClass,
            to: candidate,
            reason: 'queue-depth-pressure',
            primaryState: primaryAvail.state,
            ...depthFields,
          };
        }
        return {
          ...base,
          reason: 'no-available-fallback',
          primaryState: primaryAvail.state,
          ...depthFields,
        };
      }
      return {
        ...base,
        reason: primaryAvail.available ? 'primary-available' : 'primary-not-grounded',
        primaryState: primaryAvail.state,
      };
    }

    // Quota trigger, unchanged: a grounded primary falls over regardless of
    // depth, and does NOT consume the depth budget — the two triggers compose.
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
    for (const candidate of sameWriterLastResorts) {
      const candidateAvail = quotaAvailableFromFleetStatus(stdout, { harness: candidate });
      if (candidateAvail.available) {
        return {
          workerClass: candidate,
          fellBack: true,
          from: primaryClass,
          to: candidate,
          reason: 'primary-grounded-last-resort',
          primaryState: primaryAvail.state,
          lastResort: true,
        };
      }
    }
  } catch (err) {
    const message = fleetQuotaStatusErrorMessage(err);
    logger?.error?.(
      `[watcher] review-worker-class-fallback quota-status parse failed; failing open: ${message}`
    );
    return { ...base, reason: 'fleet-quota-status-parse-error', error: message };
  }

  return { ...base, reason: 'no-available-fallback', primaryState: primaryAvail.state };
}
