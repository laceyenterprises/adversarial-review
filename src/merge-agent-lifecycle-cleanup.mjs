import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addMergeAgentDispatchedLabel,
  cancelMergeAgentDispatchOnMerge,
  clearMergeAgentLifecycleCleanup,
  listMergeAgentDispatches,
  listMergeAgentLifecycleCleanups,
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  updateMergeAgentLifecycleCleanup,
  upsertMergeAgentLifecycleCleanup,
} from './follow-up-merge-agent.mjs';
import { MERGE_AGENT_DISPATCHED_LABEL } from './adapters/operator/github-pr-label-controls/index.mjs';
import { clearNoProgressLane } from './watcher-no-progress-lane.mjs';

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS = 60 * 1000;
const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL = 5;
export const CLOSED_PR_LABEL_REMOVAL_MAX_FAILURES = 5;
const MAX_LABEL_REMOVAL_BACKOFF_MS = 60 * 60_000;
const UNKNOWN_RATE_LIMIT_RETRY_MS = 60_000;

export async function attemptMergeAgentLifecycleCleanup({
  rootDir = ROOT,
  repo,
  prNumber,
  transition = 'unknown',
  source = 'retry-loop',
  cancelImpl = cancelMergeAgentDispatchOnMerge,
  nowMs = Date.now(),
  retryMs = resolveMergeAgentLifecycleCleanupRetryMs(),
} = {}) {
  const previous = upsertMergeAgentLifecycleCleanup(rootDir, { repo, prNumber, transition });
  if (previous.completedAt) return previous.lastResult;
  if (!shouldRetryMergeAgentLifecycleCleanup(previous, { nowMs, retryMs })) return null;
  const attemptedAt = new Date(nowMs).toISOString();
  let cancelResult;
  try {
    cancelResult = await cancelImpl({
      rootDir, repo, prNumber,
      hqPath: process.env.HQ_BIN || 'hq',
      ghExecFileImpl: execFileAsync,
      labelAbsent: previous.labelAbsent === true,
      now: attemptedAt,
    });
  } catch (err) {
    // Cancellation failures are separate from the best-effort label cap: a
    // worker whose cancellation is still unknown must retain its retry owner.
    cancelResult = { attempted: true, repo, prNumber, attemptedAt,
      cancelled: false, labelRemoved: false, cleanupComplete: false, retryable: true,
      cancelError: err?.message || String(err) };
  }
  const labelFailed = !cancelResult.labelRemoved && Boolean(cancelResult.labelRemovalError);
  const failures = (previous.labelRemovalFailures || 0)
    + (labelFailed && !cancelResult.rateLimited ? 1 : 0);
  const abandoned = labelFailed && !cancelResult.rateLimited && failures >= CLOSED_PR_LABEL_REMOVAL_MAX_FAILURES;
  const resetMs = Date.parse(cancelResult.retryAfter || '');
  const delayMs = labelFailed
    ? Math.min(MAX_LABEL_REMOVAL_BACKOFF_MS, Math.max(1000, retryMs) * 2 ** Math.max(0, failures - 1))
    : retryMs;
  const nextAttemptAt = cancelResult.rateLimited
    ? new Date(Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : nowMs + UNKNOWN_RATE_LIMIT_RETRY_MS).toISOString()
    : new Date(nowMs + delayMs).toISOString();
  cancelResult = { ...cancelResult, transition, source, labelRemovalFailures: failures,
    ...(abandoned ? { labelRemovalAbandoned: true, retryable: false } : {}),
    nextAttemptAt: cancelResult.cleanupComplete || abandoned ? null : nextAttemptAt };
  updateMergeAgentLifecycleCleanup(rootDir, { repo, prNumber, result: cancelResult, attemptedAt });
  if (cancelResult.cleanupComplete) clearNoProgressLane(rootDir, { repo, prNumber });
  // Identical pending failures are already logged by the mutation helper. The
  // terminal record survives restart/requeue, so exhaustion is logged once.
  if (abandoned) {
    console.log(`[watcher] label cleanup exhausted for ${repo}#${prNumber} after ${failures} failures: ${cancelResult.labelRemovalError}`);
  } else if (cancelResult.cleanupComplete || !labelFailed) {
    console.log(
      `[watcher] cancel-on-${transition} (${source}) for ${repo}#${prNumber}: `
      + `lrq=${cancelResult.launchRequestId || 'none'} cancelled=${cancelResult.cancelled} `
      + `labelRemoved=${cancelResult.labelRemoved} retryable=${cancelResult.retryable}`
      + (cancelResult.cancelError ? ` cancelError=${cancelResult.cancelError}` : '')
    );
  }
  return cancelResult;
}

async function attemptMergeAgentDispatchedLabelAddCleanup({
  rootDir = ROOT,
  repo,
  prNumber,
  transition = MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  source = 'retry-loop',
  labelAddImpl = addMergeAgentDispatchedLabel,
} = {}) {
  try {
    const labelResult = await labelAddImpl({
      repo,
      prNumber,
      ghExecFileImpl: execFileAsync,
    });
    const cleanupResult = {
      attempted: true,
      repo,
      prNumber,
      attemptedAt: labelResult.attemptedAt,
      transition,
      source,
      labelAdded: labelResult.added,
      labelAddError: labelResult.error,
      cleanupComplete: Boolean(labelResult.added),
      retryable: !labelResult.added,
    };
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: cleanupResult,
      attemptedAt: cleanupResult.attemptedAt,
    });
    if (cleanupResult.cleanupComplete) {
      clearNoProgressLane(rootDir, { repo, prNumber });
      clearMergeAgentLifecycleCleanup(rootDir, { repo, prNumber });
    }
    console.log(
      `[watcher] add-${MERGE_AGENT_DISPATCHED_LABEL} (${source}) for ${repo}#${prNumber}: `
      + `added=${cleanupResult.labelAdded} retryable=${cleanupResult.retryable}`
      + (cleanupResult.labelAddError ? ` labelAddError=${cleanupResult.labelAddError}` : '')
    );
    return cleanupResult;
  } catch (err) {
    console.warn(
      `[watcher] add-${MERGE_AGENT_DISPATCHED_LABEL} (${source}) for ${repo}#${prNumber} raised:`,
      err?.message || err
    );
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: {
        attempted: true,
        repo,
        prNumber,
        attemptedAt: new Date().toISOString(),
        transition,
        source,
        labelAdded: false,
        labelAddError: err?.message || String(err),
        cleanupComplete: false,
        retryable: true,
      },
    });
    return null;
  }
}

export function queueMergeAgentLifecycleCleanup({
  rootDir = ROOT,
  pr,
  repo,
  prNumber,
  transition,
} = {}) {
  const labelNames = Array.isArray(pr?.labels)
    ? pr.labels
      .map((l) => (typeof l === 'string' ? l : l?.name || ''))
      .filter(Boolean)
    : [];
  const hasDispatchedLabel = labelNames.includes(MERGE_AGENT_DISPATCHED_LABEL);
  const dispatches = listMergeAgentDispatches(rootDir, { repo, prNumber });
  const hasRecordedDispatch = dispatches.length > 0;
  const latestDispatch = dispatches.filter(record => record.launchRequestId)
    .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')))[0];
  if (!hasDispatchedLabel && !hasRecordedDispatch) return null;

  const cleanup = upsertMergeAgentLifecycleCleanup(rootDir, {
    repo, prNumber, transition,
    headSha: pr?.headRefOid || pr?.head?.sha || null,
    labelAbsent: Array.isArray(pr?.labels) ? !hasDispatchedLabel : null,
    dispatchLaunchRequestId: latestDispatch?.launchRequestId || null,
  });
  if (cleanup.completedAt) return null;
  return { repo, prNumber, transition };
}

export async function queueAndAttemptMergeAgentLifecycleCleanup({
  rootDir = ROOT,
  pr,
  repo,
  prNumber,
  transition,
} = {}) {
  const queued = queueMergeAgentLifecycleCleanup({
    rootDir,
    pr,
    repo,
    prNumber,
    transition,
  });
  if (!queued) return null;
  return attemptMergeAgentLifecycleCleanup({
    rootDir,
    repo: queued.repo,
    prNumber: queued.prNumber,
    transition: queued.transition,
    source: 'lifecycle-sync',
  });
}

export function resolveMergeAgentLifecycleCleanupRetryMs(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS || `${DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS;
}

export function resolveMergeAgentLifecycleCleanupPerPoll(env = process.env) {
  const raw = Number.parseInt(
    env.ADVERSARIAL_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL || `${DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL}`,
    10
  );
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL;
}

export function shouldRetryMergeAgentLifecycleCleanup(cleanup, {
  nowMs = Date.now(),
  retryMs = resolveMergeAgentLifecycleCleanupRetryMs(),
} = {}) {
  if (cleanup?.completedAt || cleanup?.lastResult?.labelRemovalAbandoned || cleanup?.lastResult?.cleanupComplete) return false;
  const nextAttemptMs = Date.parse(cleanup?.nextAttemptAt || '');
  if (Number.isFinite(nextAttemptMs) && nowMs < nextAttemptMs) return false;
  if (!cleanup?.lastAttemptAt) return true;
  const lastAttemptMs = Date.parse(cleanup.lastAttemptAt);
  if (!Number.isFinite(lastAttemptMs)) return true;
  return nowMs - lastAttemptMs >= retryMs;
}

export async function retryPendingMergeAgentLifecycleCleanups({
  rootDir = ROOT,
  cancelImpl = cancelMergeAgentDispatchOnMerge,
  labelAddImpl = addMergeAgentDispatchedLabel,
  nowMs = Date.now(),
  retryMs = resolveMergeAgentLifecycleCleanupRetryMs(),
  maxPerPoll = resolveMergeAgentLifecycleCleanupPerPoll(),
} = {}) {
  if (maxPerPoll <= 0) return { attempted: 0, skipped: 0, pending: 0 };
  const pending = listMergeAgentLifecycleCleanups(rootDir);
  let attempted = 0;
  let skipped = 0;
  for (const cleanup of pending) {
    if (attempted >= maxPerPoll || !shouldRetryMergeAgentLifecycleCleanup(cleanup, { nowMs, retryMs })) {
      skipped += 1;
      continue;
    }
    attempted += 1;
    if (cleanup.transition === MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION) {
      await attemptMergeAgentDispatchedLabelAddCleanup({
        rootDir,
        repo: cleanup.repo,
        prNumber: cleanup.prNumber,
        transition: cleanup.transition,
        source: 'retry-loop',
        labelAddImpl,
      });
    } else {
      await attemptMergeAgentLifecycleCleanup({
        rootDir,
        repo: cleanup.repo,
        prNumber: cleanup.prNumber,
        transition: cleanup.transition || 'unknown',
        source: 'retry-loop',
        cancelImpl, nowMs, retryMs,
      });
    }
  }
  return { attempted, skipped, pending: pending.length };
}
