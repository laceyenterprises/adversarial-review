// ARC-19 leaf module: local-admission subsystem extracted verbatim from
// follow-up-remediation.mjs. Owns quota-hold revalidation/backpressure, drain
// accounting log lines, and transient-retry ceiling resolution. This is a LEAF:
// it must never import from ./follow-up-remediation.mjs (that would be circular,
// since the monolith imports these symbols back). Collaborators that live in the
// monolith and are shared with unrelated call sites (resolveHqBin) are threaded
// in as injectable parameters rather than imported.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { DEFAULT_MAX_TRANSIENT_RETRIES, listPendingFollowUpJobs } from './follow-up-jobs.mjs';
import { quotaAvailableFromFleetStatus } from './fleet-quota-status.mjs';

const execFileAsync = promisify(execFile);

const REMEDIATION_MAX_TRANSIENT_RETRIES_ENV = 'ADVERSARIAL_REMEDIATION_MAX_TRANSIENT_RETRIES';
const QUOTA_HOLD_REVALIDATION_TTL_MS = 60 * 1000;
const QUOTA_HOLD_REVALIDATION_TIMEOUT_MS = 10_000;

function resolveMaxTransientRemediationRetries(env = process.env) {
  const raw = env?.[REMEDIATION_MAX_TRANSIENT_RETRIES_ENV];
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_TRANSIENT_RETRIES;
}

// Fleet-quota provider-state parsing + harness→provider mapping now live in the
// shared HHR classifier (src/fleet-quota-status.mjs) so the reviewer/remediator
// quota-hold path and the AMA closer/hammer harness-fallback path classify caps
// identically. `quotaAvailableFromFleetStatus` is imported above.

function latestRetryHistoryEntry(job) {
  const history = Array.isArray(job?.remediationPlan?.retryHistory)
    ? job.remediationPlan.retryHistory
    : [];
  return history.length ? history[history.length - 1] : null;
}

function isQuotaExhaustedRetryHold(job) {
  const latestRetry = latestRetryHistoryEntry(job);
  if (latestRetry) {
    return latestRetry?.retryMetadata?.code === 'quota-exhausted';
  }
  return job?.remediationPlan?.lastRetryMetadata?.code === 'quota-exhausted';
}

function quotaHoldHarness(job) {
  const latestRetry = latestRetryHistoryEntry(job);
  return String(
    latestRetry?.retryMetadata?.harness
    || job?.remediationPlan?.lastRetryMetadata?.harness
    || ''
  ).trim().toLowerCase() || 'unknown';
}

function quotaHoldHarnessesForPendingJobs(rootDir, { nowMs = Date.now() } = {}) {
  const harnesses = new Set();
  for (const { job } of listPendingFollowUpJobs(rootDir)) {
    const retryAfterMs = Date.parse(job?.remediationPlan?.retryAfter || '');
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= nowMs) continue;
    if (!isQuotaExhaustedRetryHold(job)) continue;
    harnesses.add(quotaHoldHarness(job));
  }
  return Array.from(harnesses);
}

function createQuotaHoldRevalidator({
  execFileImpl = execFileAsync,
  env = process.env,
  nowMs: defaultNowMs = () => Date.now(),
  ttlMs = QUOTA_HOLD_REVALIDATION_TTL_MS,
  timeoutMs = QUOTA_HOLD_REVALIDATION_TIMEOUT_MS,
  // Threaded from the monolith (which owns resolveHqBin for its other callers)
  // to keep this leaf non-circular. Faithful default mirrors resolveHqBin so
  // standalone/test callers that omit it behave identically.
  resolveHqBinImpl = (hqEnv = process.env) => String(hqEnv?.HQ_BIN || '').trim() || 'hq',
} = {}) {
  const cache = new Map();

  function buildCachedDecision(decision, { now, checkedAtMs }) {
    const checkedAt = typeof now === 'string' && now.trim() ? now : new Date(checkedAtMs).toISOString();
    return {
      ...decision,
      checkedAt: decision.checkedAt || checkedAt,
    };
  }

  function cachedDecisionFor(normalizedHarness, checkedAtMs) {
    const cached = cache.get(normalizedHarness);
    if (cached && checkedAtMs - cached.checkedAtMs < ttlMs) {
      return cached.decision;
    }
    return null;
  }

  async function refreshHarness(normalizedHarness, { now, nowMs } = {}) {
    const nowValueMs = Number(nowMs ?? defaultNowMs());
    const checkedAtMs = Number.isFinite(nowValueMs) ? nowValueMs : Date.now();
    const cached = cachedDecisionFor(normalizedHarness, checkedAtMs);
    if (cached) return cached;
    let decision;
    try {
      const hqBin = resolveHqBinImpl(env);
      const result = await execFileImpl(hqBin, ['fleet', 'quota', 'status', '--json'], {
        env,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        timeout: timeoutMs,
      });
      const stdout = typeof result === 'string' ? result : result?.stdout;
      decision = quotaAvailableFromFleetStatus(stdout || '', { harness: normalizedHarness });
    } catch (err) {
      decision = {
        available: false,
        state: 'error',
        source: 'hq-fleet-quota-status',
        error: err?.message || String(err),
      };
    }
    const cachedDecision = buildCachedDecision(decision, { now, checkedAtMs });
    cache.set(normalizedHarness, {
      checkedAtMs,
      decision: cachedDecision,
    });
    return cachedDecision;
  }

  const revalidator = ({ harness, now, nowMs } = {}) => {
    const normalizedHarness = String(harness || '').trim().toLowerCase() || 'unknown';
    const nowValueMs = Number(nowMs ?? defaultNowMs());
    const checkedAtMs = Number.isFinite(nowValueMs) ? nowValueMs : Date.now();
    const cached = cachedDecisionFor(normalizedHarness, checkedAtMs);
    if (cached) return cached;
    return buildCachedDecision({
      available: false,
      state: 'not-prefetched',
      source: 'hq-fleet-quota-status',
    }, { now, checkedAtMs });
  };

  revalidator.prefetch = async ({ harnesses = [], rootDir = null, now, nowMs } = {}) => {
    const nowValueMs = Number(nowMs ?? defaultNowMs());
    const checkedAtMs = Number.isFinite(nowValueMs) ? nowValueMs : Date.now();
    const pendingHarnesses = rootDir
      ? quotaHoldHarnessesForPendingJobs(rootDir, { nowMs: checkedAtMs })
      : [];
    const normalizedHarnesses = new Set();
    for (const harness of [...harnesses, ...pendingHarnesses]) {
      normalizedHarnesses.add(String(harness || '').trim().toLowerCase() || 'unknown');
    }
    return Promise.all(Array.from(normalizedHarnesses, (harness) => refreshHarness(harness, { now, nowMs: checkedAtMs })));
  };

  return revalidator;
}

const defaultQuotaHoldRevalidator = createQuotaHoldRevalidator({
  execFileImpl: execFileAsync,
  env: process.env,
});

// Best-effort read of a remediation worker's stderr log. The direct-CLI worker
// routes both stdout and stderr to this log (see spawnClaudeRemediationWorker /
// spawnCodexRemediationWorker), so a hard provider usage-cap banner lands here.
// Returns '' on any read failure — quota detection then simply does not fire.
function readWorkerStderrLogSafe(logPath) {
  if (!logPath || !existsSync(logPath)) return '';
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

function buildDrainSummaryLogLine(drain) {
  return `[follow-up-remediation] Drain summary: maxConcurrent=${drain.maxConcurrent} activeAtStart=${drain.activeAtStart} `
    + `availableAtStart=${drain.availableAtStart} spawned=${drain.spawned} stopped=${drain.stopped} `
    + `deferredSamePR=${drain.deferredSamePR} capacityRemaining=${drain.capacityRemaining} `
    + `pendingClaimable=${drain.pendingClaimable ?? 0} pendingRetryDelayed=${drain.pendingRetryDelayed ?? 0}`;
}

function buildBackpressureLogLine({ activeAtStart, pendingCount }) {
  return `[follow-up-remediation] Backpressure: activeAtStart=${activeAtStart} pendingClaimable=${pendingCount}`;
}

function countPendingFollowUpJobsByRetryWindow(rootDir, now = new Date().toISOString()) {
  const nowMs = Date.parse(String(now || ''));
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  let claimable = 0;
  let delayed = 0;
  for (const { job } of listPendingFollowUpJobs(rootDir)) {
    const retryAfterMs = Date.parse(String(job?.remediationPlan?.retryAfter || ''));
    if (Number.isFinite(retryAfterMs) && retryAfterMs > effectiveNowMs) {
      delayed += 1;
    } else {
      claimable += 1;
    }
  }
  return { claimable, delayed };
}

function isDrainQueueIdle(drain) {
  return drain.activeAtStart === 0
    && drain.spawned === 0
    && drain.stopped === 0
    && drain.deferredSamePR === 0
    && (drain.pendingClaimable ?? 0) === 0
    && drain.results.every((result) => result.reason === 'no-pending-jobs');
}

export {
  resolveMaxTransientRemediationRetries,
  createQuotaHoldRevalidator,
  defaultQuotaHoldRevalidator,
  readWorkerStderrLogSafe,
  buildDrainSummaryLogLine,
  buildBackpressureLogLine,
  countPendingFollowUpJobsByRetryWindow,
  isDrainQueueIdle,
};
