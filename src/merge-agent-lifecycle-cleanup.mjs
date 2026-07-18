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

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_RETRY_MS = 60 * 1000;
const DEFAULT_MERGE_AGENT_LIFECYCLE_CLEANUP_PER_POLL = 5;

async function attemptMergeAgentLifecycleCleanup({
  rootDir = ROOT,
  repo,
  prNumber,
  transition = 'unknown',
  source = 'retry-loop',
  cancelImpl = cancelMergeAgentDispatchOnMerge,
} = {}) {
  try {
    const cancelResult = await cancelImpl({
      rootDir,
      repo,
      prNumber,
      hqPath: process.env.HQ_BIN || 'hq',
      ghExecFileImpl: execFileAsync,
    });
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: {
        ...cancelResult,
        transition,
        source,
      },
      attemptedAt: cancelResult.attemptedAt,
    });
    if (cancelResult.cleanupComplete) {
      clearMergeAgentLifecycleCleanup(rootDir, { repo, prNumber });
    }
    console.log(
      `[watcher] cancel-on-${transition} (${source}) for ${repo}#${prNumber}: `
      + `lrq=${cancelResult.launchRequestId || 'none'} `
      + `cancelled=${cancelResult.cancelled} `
      + `labelRemoved=${cancelResult.labelRemoved} `
      + `retryable=${cancelResult.retryable}`
      + (cancelResult.cancelError ? ` cancelError=${cancelResult.cancelError}` : '')
      + (cancelResult.labelRemovalError ? ` labelRemovalError=${cancelResult.labelRemovalError}` : '')
    );
    return cancelResult;
  } catch (err) {
    console.warn(
      `[watcher] cancel-on-${transition} (${source}) for ${repo}#${prNumber} raised:`,
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
        cancelled: false,
        labelRemoved: false,
        cleanupComplete: false,
        retryable: true,
        transition,
        source,
        cancelError: err?.message || String(err),
      },
    });
    return null;
  }
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

export async function queueAndAttemptMergeAgentLifecycleCleanup({
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
  const hasRecordedDispatch = listMergeAgentDispatches(rootDir, { repo, prNumber }).length > 0;
  if (!hasDispatchedLabel && !hasRecordedDispatch) return null;

  upsertMergeAgentLifecycleCleanup(rootDir, {
    repo,
    prNumber,
    transition,
    headSha: pr?.headRefOid || pr?.head?.sha || null,
  });
  return attemptMergeAgentLifecycleCleanup({
    rootDir,
    repo,
    prNumber,
    transition,
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
        cancelImpl,
      });
    }
  }
  return { attempted, skipped, pending: pending.length };
}
