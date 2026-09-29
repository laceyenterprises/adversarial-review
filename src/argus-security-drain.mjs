// ARGUSDRAIN-01 — the consumer the Argus security route shipped without.
//
// ASR built the classifier, the queue, the route, the rubric and the gate. The
// piece that turns a queued job into a verdict was never built:
// `claimNextArgusJob` / `completeArgusJob` / `failArgusJob` had no production
// caller, 1,519 jobs sat unclaimed, and every semver-major Dependabot bump the
// auto-adjudicator routed "for review" parked forever, because the review it
// was routed to did not exist (SEV3 2026-09-29, agent-os#7326).
//
// This is that consumer. It runs inside the watcher's tick, in the background
// pattern the AMA hammer uses (HAMASYNC-01): `tick()` claims up to the
// concurrency cap, starts each review WITHOUT awaiting it, and returns at once.
// The posted-review phase never waits on a security review.
//
// Each claimed job is reviewed by `runJob` (by default a child process running
// `argus-security-review-child.mjs`, so the model harness's signal handlers,
// token proxies and env stay out of the long-lived watcher). The review returns
// an outcome and ONLY this module moves the job between buckets:
//
//   complete → `completed` with the result (approved / blocked /
//              needs_verification / superseded) and the claim-to-verdict latency.
//   defer    → back to `pending` with a not-before time (CI still running, no
//              reviewer model available). Not an attempt.
//   retry    → back to `pending` with a backoff, counting an attempt; after
//              `maxAttempts` the job goes to `failed`, which the gate reports
//              red. Silence past the stall deadline still goes red on its own.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARGUS_BACKLOG_RETIREMENT_INTERVAL_MS,
  createGhOpenPullHeadsLister,
  retireArgusBacklog,
} from './argus-backlog-retirement.mjs';
import {
  claimNextArgusJob,
  completeArgusJob,
  failArgusJob,
  returnArgusJobToPending,
} from './argus-security-queue.mjs';
import { writeArgusDrainStatus } from './argus-security-health.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ARGUS_DRAIN_ENABLED_ENV = 'ADVERSARIAL_ARGUS_DRAIN';
export const ARGUS_DRAIN_MAX_CONCURRENT_ENV = 'ADVERSARIAL_ARGUS_DRAIN_MAX_CONCURRENT';
export const ARGUS_DRAIN_MAX_ATTEMPTS_ENV = 'ADVERSARIAL_ARGUS_DRAIN_MAX_ATTEMPTS';
export const DEFAULT_ARGUS_DRAIN_MAX_CONCURRENT = 2;
export const DEFAULT_ARGUS_DRAIN_MAX_ATTEMPTS = 3;
// Backoff before retry N (1-based). A retry is a failed review or post; these
// are spaced so a provider blip does not burn all attempts in one outage.
export const ARGUS_DRAIN_RETRY_BACKOFF_MS = Object.freeze([5 * 60 * 1000, 20 * 60 * 1000, 60 * 60 * 1000]);
// The child review is bounded by the harness's own reviewer timeouts; this is
// the outer backstop so a wedged child cannot hold a slot forever.
export const ARGUS_REVIEW_CHILD_TIMEOUT_MS = 45 * 60 * 1000;
export const ARGUS_REVIEW_OUTCOME_PREFIX = 'ARGUS_REVIEW_OUTCOME ';

/** Default ON; `ADVERSARIAL_ARGUS_DRAIN=off` is the kill switch. */
export function isArgusDrainEnabled(env = process.env) {
  return !/^(0|false|no|off)$/iu.test(String(env?.[ARGUS_DRAIN_ENABLED_ENV] ?? '').trim());
}

function positiveIntEnv(env, key, fallback) {
  const parsed = Number.parseInt(String(env?.[key] ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveArgusDrainMaxConcurrent(env = process.env) {
  return positiveIntEnv(env, ARGUS_DRAIN_MAX_CONCURRENT_ENV, DEFAULT_ARGUS_DRAIN_MAX_CONCURRENT);
}

export function resolveArgusDrainMaxAttempts(env = process.env) {
  return positiveIntEnv(env, ARGUS_DRAIN_MAX_ATTEMPTS_ENV, DEFAULT_ARGUS_DRAIN_MAX_ATTEMPTS);
}

// A fresh bot job belongs to the dependency-bot auto-adjudicator first: it
// approves and merges patch/minor bumps cheaply on the watcher's per-PR pass
// and routes the rest here. This grace keeps the drain from racing it to a
// model review; past it (merge authority off, say) the drain reviews anyway.
export const ARGUS_BOT_ADJUDICATION_GRACE_MS = 30 * 60 * 1000;

function isBotAuthorJob(job) {
  return (Array.isArray(job?.reasons) ? job.reasons : []).some((reason) => reason?.trigger === 'bot-author');
}

/**
 * May the drain claim this pending job now? Passed over (keeping its place):
 *   - a job inside its retry backoff or deferral window;
 *   - a job the auto-adjudicator's merge path is driving (it approved the bump
 *     and is waiting on CI to merge it);
 *   - a bot job still inside the adjudicator's grace, unless already routed.
 */
export function isArgusJobClaimable(job, { nowMs = Date.now() } = {}) {
  const notBeforeMs = Date.parse(String(job?.drain?.notBefore || ''));
  if (Number.isFinite(notBeforeMs) && notBeforeMs > nowMs) return false;
  if (job?.routedForReview) return true;
  if (job?.lastAutoadjudicationAttempt) return false;
  if (isBotAuthorJob(job)) {
    const enqueuedMs = Date.parse(String(job?.enqueuedAt || ''));
    if (Number.isFinite(enqueuedMs) && nowMs - enqueuedMs < ARGUS_BOT_ADJUDICATION_GRACE_MS) return false;
  }
  return true;
}

function parseChildOutcome(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith(ARGUS_REVIEW_OUTCOME_PREFIX)) {
      return JSON.parse(lines[index].slice(ARGUS_REVIEW_OUTCOME_PREFIX.length));
    }
  }
  throw new Error('argus review child printed no outcome line');
}

/**
 * Production `runJob`: review the job in a child process. The child reads the
 * claimed record, never writes the queue, and prints one outcome line.
 */
export function runArgusReviewChild({
  rootDir,
  jobPath,
  execFileImpl = execFile,
  env = process.env,
  timeoutMs = ARGUS_REVIEW_CHILD_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      process.execPath,
      [join(ROOT, 'src', 'argus-security-review-child.mjs'), '--root', rootDir, '--job', jobPath],
      { env, cwd: ROOT, timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          resolve(parseChildOutcome(stdout));
        } catch (parseErr) {
          const detail = String(stderr || '').trim().split('\n').slice(-3).join(' | ');
          reject(err
            ? new Error(`argus review child failed: ${err.message}${detail ? ` (${detail})` : ''}`)
            : new Error(`${parseErr.message}${detail ? ` (${detail})` : ''}`));
        }
      },
    );
  });
}

function retryBackoffMs(attempt) {
  const index = Math.max(0, Math.min(ARGUS_DRAIN_RETRY_BACKOFF_MS.length - 1, attempt - 1));
  return ARGUS_DRAIN_RETRY_BACKOFF_MS[index];
}

/**
 * Apply one review outcome to the queue. Exported for the tests, which drive
 * each outcome kind without a child process.
 */
export function applyArgusReviewOutcome({
  rootDir,
  job,
  jobPath,
  outcome,
  nowMs = Date.now(),
  maxAttempts = DEFAULT_ARGUS_DRAIN_MAX_ATTEMPTS,
  logger = console,
} = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const drain = job?.drain && typeof job.drain === 'object' ? job.drain : {};
  const label = `${job.repo}#${job.prNumber}@${String(job.headSha).slice(0, 12)}`;

  if (outcome?.kind === 'complete' && outcome.result) {
    const claimedMs = Date.parse(String(job.claimedAt || ''));
    const latencyMs = Number.isFinite(claimedMs) ? Math.max(0, nowMs - claimedMs) : null;
    const result = {
      ...outcome.result,
      drain: { claimedAt: job.claimedAt || null, completedAt: nowIso, latencyMs, attempts: (drain.attempts || 0) + 1 },
    };
    const completed = completeArgusJob({
      rootDir,
      jobPath,
      completedAt: nowIso,
      result,
      job: { ...job, drain: { ...drain, cachedReview: null } },
    });
    logger?.log?.(
      `[argus-drain] ${label} → ${result.verdict}`
        + (latencyMs === null ? '' : ` claim_to_verdict_ms=${latencyMs}`)
        + (result.reviewer?.model ? ` reviewer=${result.reviewer.model}` : ''),
    );
    return { applied: 'completed', ...completed };
  }

  if (outcome?.kind === 'defer') {
    const retryAfterMs = Math.max(60_000, Number(outcome.retryAfterMs) || 10 * 60 * 1000);
    const released = returnArgusJobToPending({
      rootDir,
      jobPath,
      job,
      patch: {
        drain: {
          ...drain,
          deferrals: (drain.deferrals || 0) + 1,
          lastDeferReason: outcome.reason || 'deferred',
          lastDeferredAt: nowIso,
          notBefore: new Date(nowMs + retryAfterMs).toISOString(),
          cachedReview: outcome.cachedReview ?? drain.cachedReview ?? null,
        },
      },
    });
    logger?.log?.(`[argus-drain] ${label} deferred (${outcome.reason || 'deferred'}); retry after ${Math.round(retryAfterMs / 60000)}m`);
    return { applied: 'deferred', ...released };
  }

  const error = String(outcome?.error || 'argus review returned no outcome');
  const attempts = (drain.attempts || 0) + 1;
  if (attempts >= maxAttempts) {
    const failed = failArgusJob({
      rootDir,
      jobPath,
      failedAt: nowIso,
      error: `argus review failed after ${attempts} attempt(s): ${error}`,
      job: { ...job, drain: { ...drain, attempts, lastError: error, cachedReview: null } },
    });
    logger?.error?.(`[argus-drain] ${label} failed after ${attempts} attempt(s): ${error}`);
    return { applied: 'failed', ...failed };
  }
  const backoffMs = retryBackoffMs(attempts);
  const released = returnArgusJobToPending({
    rootDir,
    jobPath,
    job,
    patch: {
      drain: {
        ...drain,
        attempts,
        lastError: error,
        lastAttemptAt: nowIso,
        notBefore: new Date(nowMs + backoffMs).toISOString(),
        cachedReview: outcome?.cachedReview ?? drain.cachedReview ?? null,
      },
    },
  });
  logger?.warn?.(`[argus-drain] ${label} attempt ${attempts}/${maxAttempts} failed; retry in ${Math.round(backoffMs / 60000)}m: ${error}`);
  return { applied: 'retry', ...released };
}

/**
 * A bounded background drain. `tick()` is synchronous: it claims up to the
 * free capacity, starts each review, and returns. Reviews settle on their own
 * and apply their outcome to the queue.
 *
 * `retireBacklog` (item 4) runs before the first claim and then on an
 * interval, in the background like everything else here. Until the first pass
 * has finished, successfully or not, the drain claims nothing: the backlog is
 * mostly dead heads, and reviewing it oldest-first would spend the first hours
 * on trees nobody will merge.
 */
export function createArgusSecurityDrain({
  rootDir,
  maxConcurrent = DEFAULT_ARGUS_DRAIN_MAX_CONCURRENT,
  maxAttempts = DEFAULT_ARGUS_DRAIN_MAX_ATTEMPTS,
  runJob = ({ jobPath }) => runArgusReviewChild({ rootDir, jobPath }),
  isClaimable = isArgusJobClaimable,
  retireBacklog = null,
  retirementIntervalMs = ARGUS_BACKLOG_RETIREMENT_INTERVAL_MS,
  nowMs = () => Date.now(),
  logger = console,
} = {}) {
  const limit = Math.max(1, Number.parseInt(String(maxConcurrent), 10) || 1);
  const running = new Map();
  let peakRunning = 0;
  const retirement = {
    firstPassDone: retireBacklog === null,
    running: false,
    lastStartedMs: null,
    lastFinishedAt: null,
    lastSummary: null,
    lastError: null,
    promise: null,
  };

  function maybeStartRetirement() {
    if (typeof retireBacklog !== 'function' || retirement.running) return;
    if (retirement.lastStartedMs !== null && nowMs() - retirement.lastStartedMs < retirementIntervalMs) return;
    retirement.running = true;
    retirement.lastStartedMs = nowMs();
    retirement.promise = Promise.resolve()
      .then(() => retireBacklog({ runningJobIds: [...running.keys()], nowMs: nowMs() }))
      .then((summary) => {
        retirement.lastSummary = summary || null;
        retirement.lastError = null;
      })
      .catch((err) => {
        retirement.lastError = String(err?.message || err);
        logger?.error?.(`[argus-drain] backlog retirement failed: ${retirement.lastError}`);
      })
      .finally(() => {
        retirement.running = false;
        retirement.firstPassDone = true;
        retirement.lastFinishedAt = new Date(nowMs()).toISOString();
      });
  }

  async function settle(claim) {
    let outcome;
    try {
      outcome = await runJob({ job: claim.job, jobPath: claim.jobPath, rootDir });
    } catch (err) {
      outcome = { kind: 'retry', error: String(err?.message || err) };
    }
    try {
      return applyArgusReviewOutcome({
        rootDir,
        job: claim.job,
        jobPath: claim.jobPath,
        outcome,
        nowMs: nowMs(),
        maxAttempts,
        logger,
      });
    } catch (err) {
      // The job stays in `in-progress`; the stale-claim recovery returns it.
      logger?.error?.(`[argus-drain] could not record the outcome for ${claim.job.jobId}: ${err?.message || err}`);
      return null;
    }
  }

  return {
    /**
     * @returns {{claimed: string[], running: number, limit: number, skipped: string|null}}
     */
    tick({ paused = false } = {}) {
      if (paused) return { claimed: [], running: running.size, limit, skipped: 'paused' };
      maybeStartRetirement();
      if (!retirement.firstPassDone) {
        return { claimed: [], running: running.size, limit, skipped: 'awaiting-backlog-retirement' };
      }
      const claimed = [];
      while (running.size < limit) {
        let claim;
        try {
          claim = claimNextArgusJob({
            rootDir,
            claimedAt: new Date(nowMs()).toISOString(),
            shouldClaim: (job) => !running.has(job?.jobId) && isClaimable(job, { nowMs: nowMs() }),
          });
        } catch (err) {
          logger?.error?.(`[argus-drain] claim failed: ${err?.message || err}`);
          break;
        }
        if (!claim) break;
        const jobId = claim.job.jobId;
        const promise = settle(claim)
          .finally(() => running.delete(jobId))
          .catch(() => null);
        running.set(jobId, { promise, startedAtMs: nowMs(), job: claim.job });
        peakRunning = Math.max(peakRunning, running.size);
        claimed.push(jobId);
      }
      return { claimed, running: running.size, limit, skipped: null };
    },
    runningJobIds() {
      return [...running.keys()];
    },
    snapshot() {
      return {
        running: running.size,
        limit,
        peakRunning,
        jobIds: [...running.keys()],
        retirement: {
          firstPassDone: retirement.firstPassDone,
          running: retirement.running,
          lastFinishedAt: retirement.lastFinishedAt,
          lastSummary: retirement.lastSummary,
          lastError: retirement.lastError,
        },
      };
    },
    /** Test/shutdown helper: resolves once retirement and every review settled. */
    async drain() {
      await retirement.promise;
      while (running.size > 0) {
        await Promise.allSettled([...running.values()].map((entry) => entry.promise));
      }
    },
  };
}

// One drain per watcher process, like the hammer queue: the watcher is a
// long-lived single process, so module scope is the natural lifetime.
let processDrain = null;

export function argusSecurityDrainForProcess({ rootDir = ROOT, env = process.env, logger = console } = {}) {
  if (!processDrain) {
    const listOpenPullHeads = createGhOpenPullHeadsLister({ env, logger });
    processDrain = createArgusSecurityDrain({
      rootDir,
      maxConcurrent: resolveArgusDrainMaxConcurrent(env),
      maxAttempts: resolveArgusDrainMaxAttempts(env),
      retireBacklog: ({ runningJobIds, nowMs }) => retireArgusBacklog({
        rootDir, listOpenPullHeads, runningJobIds, nowMs, logger,
      }),
      logger,
    });
  }
  return processDrain;
}

export function resetArgusSecurityDrainForTests() {
  processDrain = null;
}

function writeStatusSafe(writeStatus, rootDir, status, logger) {
  try {
    writeStatus(rootDir, status);
  } catch (err) {
    logger?.warn?.(`[argus-drain] status write failed: ${err?.message || err}`);
  }
}

/**
 * The watcher's one call per tick. Never throws and never awaits a review.
 * Each tick leaves a status record for the pipeline health surface, including
 * when the kill switch is on, so "disabled" and "dead" read differently.
 */
export function startArgusSecurityDrainForWatcherTick({
  rootDir = ROOT,
  watcherDrainActive = false,
  env = process.env,
  logger = console,
  drainFactory = argusSecurityDrainForProcess,
  writeStatus = writeArgusDrainStatus,
  nowMs = () => Date.now(),
} = {}) {
  const observedAt = new Date(nowMs()).toISOString();
  try {
    if (!isArgusDrainEnabled(env)) {
      writeStatusSafe(writeStatus, rootDir, { observedAt, enabled: false }, logger);
      return { started: false, reason: 'disabled' };
    }
    const drain = drainFactory({ rootDir, env, logger });
    const tick = drain.tick({ paused: watcherDrainActive });
    if (tick.claimed.length > 0) {
      logger?.log?.(
        `[argus-drain] claimed ${tick.claimed.length} job(s); running=${tick.running}/${tick.limit}; `
          + 'posted-review phase continues',
      );
    }
    const snapshot = typeof drain.snapshot === 'function' ? drain.snapshot() : {};
    writeStatusSafe(writeStatus, rootDir, {
      observedAt,
      enabled: true,
      paused: Boolean(watcherDrainActive),
      skipped: tick.skipped,
      claimedThisTick: tick.claimed.length,
      running: tick.running,
      limit: tick.limit,
      peakRunning: snapshot.peakRunning ?? null,
      retirement: snapshot.retirement ?? null,
    }, logger);
    return { started: true, ...tick };
  } catch (err) {
    logger?.error?.(`[argus-drain] tick failed: ${err?.message || err}`);
    writeStatusSafe(writeStatus, rootDir, { observedAt, enabled: true, error: String(err?.message || err) }, logger);
    return { started: false, reason: 'error', error: String(err?.message || err) };
  }
}
