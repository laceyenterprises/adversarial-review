// Merge-agent stuck-pre-spawn alert, extracted from watcher.mjs (ARC-18).
//
// Fires a debounced alert when a merge-agent dispatch for a PR is stuck
// pre-spawn (repeated admit refusals before the worker ever spawns). The alert
// is dependency-injected (deliverAlertFn, fsImpl); debounce state is a durable
// per-repo/PR/LRQ file so the same stuck dispatch does not re-alert every tick.
//
// Moved out of the watcher body so watcher.mjs can shrink toward a scheduler
// loop. Behavior is preserved exactly; parity is verified by
// test/watcher-stuck-alert-debounce.test.mjs, which imports
// maybeFireMergeAgentStuckAlert (re-exported from watcher.mjs).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoleConfig } from './role-config.mjs';

// Repo root, computed from this module's location (src/<module> -> repo root),
// resolving to the same absolute path as watcher.mjs's ROOT.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const STUCK_DISPATCH_ALERT_DEBOUNCE_MS = 60 * 60 * 1000;
export const STUCK_DISPATCH_ALERT_STATE_DIR = join(
  ROOT, 'data', 'follow-up-jobs', 'merge-agent-stuck-alerts',
);

export function resolveStuckDispatchAlertDebounceMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'watcher.stuck_dispatch_alert_debounce_ms',
  }).get('watcher.stuck_dispatch_alert_debounce_ms', STUCK_DISPATCH_ALERT_DEBOUNCE_MS);
  const parsed = Number(cfgValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : STUCK_DISPATCH_ALERT_DEBOUNCE_MS;
}

export async function maybeFireMergeAgentStuckAlert({
  rootDir,
  repoPath,
  prNumber,
  dispatched,
  deliverAlertFn,
  logger,
  now = Date.now(),
  alertStateDir = STUCK_DISPATCH_ALERT_STATE_DIR,
  debounceMs = resolveStuckDispatchAlertDebounceMs(),
  fsImpl = { readFileSync, mkdirSync, writeFileSync, existsSync },
}) {
  // The recorded dispatch object is on `dispatched` (via stuckDetail
  // surfacing in follow-up-merge-agent.mjs); fall back to a derivable
  // key when not present.
  const stuck = dispatched?.stuckDetail;
  if (!stuck) return false;
  // ROUND-2 review fix: stuckDetail now carries `launchRequestId`
  // directly (set by describeStaleDispatch from the validated `lrq`
  // local). The previous chain — `stuck?.lastRefusedAt && (dispatched.
  // recordedDispatch.launchRequestId || dispatched.launchRequestId)` —
  // collapsed to `null` because dispatchMergeAgentForPR's return shape
  // doesn't include either `recordedDispatch` or a top-level
  // `launchRequestId`. The alert payload then went out with
  // `launchRequestId: null` and the debounce key collapsed to
  // `repo-pr-no-lrq` — a single shared slot across every stuck
  // dispatch on the same PR. The fallback chain is retained for any
  // legacy caller that pre-dates the stuckDetail change.
  const lrq = (typeof stuck.launchRequestId === 'string' && stuck.launchRequestId)
    || dispatched?.recordedDispatch?.launchRequestId
    || dispatched?.launchRequestId
    || null;
  // Key the debounce file on a stable identifier — repo + PR + LRQ
  // if available, otherwise repo + PR + age bucket. Sanitize slashes.
  const safeRepo = String(repoPath).replace(/[^A-Za-z0-9._-]/g, '_');
  const dedupeKey = lrq
    ? `${safeRepo}-pr-${prNumber}-${lrq}.json`
    : `${safeRepo}-pr-${prNumber}-no-lrq.json`;
  const statePath = join(alertStateDir, dedupeKey);
  // Read prior alert state (if any) — fail closed on read errors
  // (alert fires; better to over-alert once than to silently swallow).
  let priorAlertAt = null;
  try {
    if (fsImpl.existsSync(statePath)) {
      const doc = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
      const at = Date.parse(String(doc?.alertedAt || ''));
      if (Number.isFinite(at)) priorAlertAt = at;
    }
  } catch { /* fall through — over-alert is safer than under-alert */ }
  if (priorAlertAt && (now - priorAlertAt) < debounceMs) {
    return false;
  }
  // Fire the alert. Wrapped by caller try/catch; this layer formats.
  const text = (
    `Adversarial-watcher: merge-agent dispatch for ${repoPath}#${prNumber} `
    + `is stuck pre-spawn ${stuck.stuckForMinutes}min. `
    + `${stuck.refusalCount} admit refusals; primary reason: ${stuck.primaryReason || 'unknown'}. `
    + `Last refused at ${stuck.lastRefusedAt}. `
    + `Run \`scripts/hq-merge-agent-why.sh ${prNumber}\` for details.`
  );
  await deliverAlertFn(text, {
    event: 'merge_agent.stuck_pre_spawn',
    payload: {
      repo: repoPath,
      prNumber,
      launchRequestId: lrq,
      stuckForMinutes: stuck.stuckForMinutes,
      refusalCount: stuck.refusalCount,
      primaryReason: stuck.primaryReason,
      lastRefusedAt: stuck.lastRefusedAt,
    },
  });
  // Persist debounce state. Failure to persist isn't fatal — we may
  // alert again on the next tick which is at worst noisy.
  try {
    fsImpl.mkdirSync(alertStateDir, { recursive: true });
    fsImpl.writeFileSync(statePath, JSON.stringify({
      repo: repoPath,
      prNumber,
      launchRequestId: lrq,
      alertedAt: new Date(now).toISOString(),
      stuckForMinutes: stuck.stuckForMinutes,
    }, null, 2) + '\n');
  } catch (writeErr) {
    logger?.warn?.(
      `[watcher] failed to persist stuck-dispatch alert debounce state: ${writeErr?.message || writeErr}`
    );
  }
  return true;
}
