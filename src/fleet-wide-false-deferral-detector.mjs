// Fleet-wide false-deferral detector, extracted from watcher.mjs (ARC-18).
//
// Defense-in-depth alerting for the 2026-05-18 session-ledger DB-path bug class:
// when N distinct LRQs hit the
// 'original-worker-run-row-missing-but-worktree-present' merge-agent guard
// within a rolling window, fire a single debounced fleet-wide alert. The
// detector is fully dependency-injected (deliverAlertFn, fsImpl,
// writeStateFileFn) and keeps a durable, file-locked observation store; if that
// store is not writable it fails closed with a debounced degraded alert rather
// than silently dropping observations.
//
// Moved out of the watcher body so watcher.mjs can shrink toward a scheduler
// loop. Behavior is preserved exactly; parity is verified by
// test/watcher-fleet-wide-false-deferral-alert.test.mjs, which imports
// maybeFireFleetWideFalseDeferralAlert (re-exported from watcher.mjs).

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic-write.mjs';

// Repo root, computed from this module's location (src/<module> -> repo root),
// resolving to the same absolute path as watcher.mjs's ROOT.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const FLEET_WIDE_FALSE_DEFERRAL_REASON =
  'original-worker-run-row-missing-but-worktree-present';
export const FLEET_WIDE_FALSE_DEFERRAL_WINDOW_MS = 30 * 60 * 1000;
export const FLEET_WIDE_FALSE_DEFERRAL_DISTINCT_LRQ_THRESHOLD = 3;
export const FLEET_WIDE_FALSE_DEFERRAL_ALERT_DEBOUNCE_MS = 60 * 60 * 1000;
export const FLEET_WIDE_FALSE_DEFERRAL_STATE_DIR = join(
  ROOT, 'data', 'follow-up-jobs', 'fleet-wide-false-deferral-alerts',
);
const FLEET_WIDE_FALSE_DEFERRAL_STATE_FILE = 'fleet-state.json';
const FLEET_WIDE_FALSE_DEFERRAL_LOCK_FILE = 'fleet-state.lock';
const FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_ALERT_DEBOUNCE_MS = 60 * 60 * 1000;
const FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_STATE_FILE = 'degraded-alert-state.json';
const FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_LOCK_FILE = 'degraded-alert-state.lock';
const FLEET_WIDE_FALSE_DEFERRAL_LOCK_RETRY_MS = 10;
const FLEET_WIDE_FALSE_DEFERRAL_LOCK_TIMEOUT_MS = 5_000;
const FLEET_WIDE_FALSE_DEFERRAL_STALE_LOCK_MS = 2 * 60 * 1000;

function readFleetWideFalseDeferralLock(lockPath) {
  let raw = '';
  try {
    raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: parsed?.pid || null,
      acquiredAt: typeof parsed?.acquiredAt === 'string' ? parsed.acquiredAt : null,
    };
  } catch {
    try {
      const stat = statSync(lockPath);
      return { pid: null, acquiredAtMs: stat.mtimeMs };
    } catch {
      return { pid: null, acquiredAtMs: null };
    }
  }
}

function isFleetWideFalseDeferralLockStale(lockPath, nowMs, staleLockMs) {
  const lock = readFleetWideFalseDeferralLock(lockPath);
  const acquiredAtMs = Number.isFinite(lock.acquiredAtMs)
    ? lock.acquiredAtMs
    : Date.parse(lock.acquiredAt || '');
  return Number.isFinite(acquiredAtMs) && (nowMs - acquiredAtMs) >= staleLockMs;
}

async function acquireFleetWideFalseDeferralLock(lockPath, {
  retryMs = FLEET_WIDE_FALSE_DEFERRAL_LOCK_RETRY_MS,
  timeoutMs = FLEET_WIDE_FALSE_DEFERRAL_LOCK_TIMEOUT_MS,
  staleLockMs = FLEET_WIDE_FALSE_DEFERRAL_STALE_LOCK_MS,
  nowFn = Date.now,
} = {}) {
  const startedAt = nowFn();
  while (true) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date(nowFn()).toISOString() }) + '\n',
        { flag: 'wx' },
      );
      return;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const nowMs = nowFn();
      if (isFleetWideFalseDeferralLockStale(lockPath, nowMs, staleLockMs)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if ((nowMs - startedAt) >= timeoutMs) {
        throw new Error(`Timed out waiting for fleet-wide false-deferral lock: ${lockPath}`);
      }
      await sleepMs(retryMs);
    }
  }
}

async function withFleetWideFalseDeferralLock(
  alertStateDir,
  callback,
  { lockFile = FLEET_WIDE_FALSE_DEFERRAL_LOCK_FILE } = {},
) {
  mkdirSync(alertStateDir, { recursive: true });
  const lockPath = join(alertStateDir, lockFile);
  await acquireFleetWideFalseDeferralLock(lockPath);
  try {
    return await callback();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function readFleetWideFalseDeferralDegradedState({
  degradedStatePath,
  fsImpl,
}) {
  if (!fsImpl.existsSync(degradedStatePath)) return {};
  let doc;
  try {
    doc = JSON.parse(fsImpl.readFileSync(degradedStatePath, 'utf8'));
  } catch {
    return {};
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  return doc;
}

function buildFleetWideFalseDeferralDetectorDegradedText({
  operation,
  statePath,
  repoPath,
  prNumber,
  lrq,
  errorMessage,
}) {
  return [
    'Adversarial-watcher: merge_agent.fleet_wide_false_deferral_detector_degraded',
    `Operation: ${operation}`,
    `State file: ${statePath}`,
    `Repo/PR: ${repoPath}#${prNumber}`,
    `LRQ: ${lrq}`,
    `Error: ${errorMessage}`,
    'The detector depends on durable cross-observation state and is failing closed until this state path is valid and writable again.',
  ].join('\n');
}

async function reportFleetWideFalseDeferralDetectorDegraded({
  deliverAlertFn,
  logger,
  operation,
  statePath,
  repoPath,
  prNumber,
  lrq,
  err,
  now = Date.now(),
  degradedAlertDebounceMs = FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_ALERT_DEBOUNCE_MS,
  fsImpl = { readFileSync, existsSync },
  writeDegradedStateFileFn = (filePath, content) => writeFileAtomic(filePath, content),
}) {
  const errorMessage = err?.message || String(err);
  const alertStateDir = dirname(statePath);
  const degradedStatePath = join(alertStateDir, FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_STATE_FILE);

  let shouldDeliver = false;
  try {
    shouldDeliver = await withFleetWideFalseDeferralLock(alertStateDir, async () => {
      const degradedState = readFleetWideFalseDeferralDegradedState({ degradedStatePath, fsImpl });
      const lastAlertedMs = Date.parse(degradedState[statePath] || '');
      if (Number.isFinite(lastAlertedMs) && (now - lastAlertedMs) < degradedAlertDebounceMs) {
        return false;
      }
      degradedState[statePath] = new Date(now).toISOString();
      writeDegradedStateFileFn(degradedStatePath, JSON.stringify(degradedState, null, 2) + '\n');
      return true;
    }, { lockFile: FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_LOCK_FILE });
  } catch (stateErr) {
    logger?.error?.(
      `[watcher] fleet-wide false-deferral degraded alert debounce persistence failed: ${stateErr?.message || stateErr}`
    );
    shouldDeliver = true;
  }
  if (!shouldDeliver) return;

  try {
    await deliverAlertFn(
      buildFleetWideFalseDeferralDetectorDegradedText({
        operation,
        statePath,
        repoPath,
        prNumber,
        lrq,
        errorMessage,
      }),
      {
        event: 'merge_agent.fleet_wide_false_deferral_detector_degraded',
        payload: {
          operation,
          statePath,
          repoPath,
          prNumber,
          launchRequestId: lrq,
          error: errorMessage,
        },
      }
    );
  } catch (alertErr) {
    logger?.error?.(
      `[watcher] fleet-wide false-deferral degraded alert delivery failed: ${alertErr?.message || alertErr}`
    );
  }
}

async function failClosedFleetWideFalseDeferralDetector({
  deliverAlertFn,
  logger,
  operation,
  statePath,
  repoPath,
  prNumber,
  lrq,
  err,
  now,
  degradedAlertDebounceMs,
}) {
  await reportFleetWideFalseDeferralDetectorDegraded({
    deliverAlertFn,
    logger,
    operation,
    statePath,
    repoPath,
    prNumber,
    lrq,
    err,
    now,
    degradedAlertDebounceMs,
  });
  const failure = new Error(
    `[watcher] fleet-wide false-deferral detector state ${operation} failed at ${statePath}: ${err?.message || err}`
  );
  failure.cause = err;
  throw failure;
}

export async function maybeFireFleetWideFalseDeferralAlert({
  dispatched,
  repoPath,
  prNumber,
  deliverAlertFn,
  logger,
  now = Date.now(),
  alertStateDir = FLEET_WIDE_FALSE_DEFERRAL_STATE_DIR,
  windowMs = FLEET_WIDE_FALSE_DEFERRAL_WINDOW_MS,
  threshold = FLEET_WIDE_FALSE_DEFERRAL_DISTINCT_LRQ_THRESHOLD,
  debounceMs = FLEET_WIDE_FALSE_DEFERRAL_ALERT_DEBOUNCE_MS,
  degradedAlertDebounceMs = FLEET_WIDE_FALSE_DEFERRAL_DEGRADED_ALERT_DEBOUNCE_MS,
  fsImpl = { readFileSync, existsSync },
  writeStateFileFn = (filePath, content) => writeFileAtomic(filePath, content),
}) {
  if (dispatched?.decision !== 'dispatch-deferred') return false;
  if (dispatched?.reason !== FLEET_WIDE_FALSE_DEFERRAL_REASON) return false;
  const lrq = dispatched?.launchRequestId || null;
  if (!lrq) return false;

  const statePath = join(alertStateDir, FLEET_WIDE_FALSE_DEFERRAL_STATE_FILE);
  let alertToDeliver = null;
  try {
    alertToDeliver = await withFleetWideFalseDeferralLock(alertStateDir, async () => {
      let state = { observations: [], lastAlertedAt: null };
      try {
        if (fsImpl.existsSync(statePath)) {
          const doc = JSON.parse(fsImpl.readFileSync(statePath, 'utf8'));
          if (Array.isArray(doc?.observations)) state.observations = doc.observations;
          if (typeof doc?.lastAlertedAt === 'string') state.lastAlertedAt = doc.lastAlertedAt;
        }
      } catch (readErr) {
        logger?.warn?.(
          `[watcher] fleet-wide false-deferral detector state read failed at ${statePath}; ` +
          `rebuilding empty state: ${readErr?.message || readErr}`
        );
        state = { observations: [], lastAlertedAt: null };
      }

      // Serialize the entire read-modify-write cycle so concurrent
      // watcher variants cannot overwrite each other's observations.
      const cutoff = now - windowMs;
      const byLrq = new Map();
      for (const obs of state.observations) {
        const observedAtMs = Date.parse(obs?.observedAt || '');
        if (!Number.isFinite(observedAtMs) || observedAtMs < cutoff) continue;
        if (typeof obs?.lrq !== 'string' || !obs.lrq) continue;
        byLrq.set(obs.lrq, {
          lrq: obs.lrq,
          observedAt: obs.observedAt,
          repo: typeof obs?.repo === 'string' ? obs.repo : null,
          prNumber: Number.isFinite(obs?.prNumber) ? obs.prNumber : null,
        });
      }
      byLrq.set(lrq, {
        lrq,
        observedAt: new Date(now).toISOString(),
        repo: repoPath,
        prNumber,
      });
      state.observations = Array.from(byLrq.values());

      try {
        writeStateFileFn(statePath, JSON.stringify(state, null, 2) + '\n');
      } catch (writeErr) {
        await failClosedFleetWideFalseDeferralDetector({
          deliverAlertFn,
          logger,
          operation: 'write-observations',
          statePath,
          repoPath,
          prNumber,
          lrq,
          err: writeErr,
          now,
          degradedAlertDebounceMs,
        });
      }

      if (state.observations.length < threshold) return null;

      const lastAlertedMs = Date.parse(state.lastAlertedAt || '');
      if (Number.isFinite(lastAlertedMs) && (now - lastAlertedMs) < debounceMs) {
        return null;
      }

      const observedTargets = [...new Set(state.observations
        .filter((o) => o.repo && Number.isFinite(o.prNumber))
        .map((o) => `${o.repo}#${o.prNumber}`))];
      const windowMinutes = Math.round(windowMs / 60_000);
      const text = (
        `Adversarial-watcher: ${state.observations.length} distinct LRQs hit `
        + `the '${FLEET_WIDE_FALSE_DEFERRAL_REASON}' merge-agent guard in the `
        + `last ${windowMinutes}min across ${observedTargets.length} PR(s): `
        + `${observedTargets.slice(0, 5).join(', ')}`
        + `${observedTargets.length > 5 ? ` (+${observedTargets.length - 5} more)` : ''}. `
        + `This is the signature of a session-ledger DB resolution bug — see `
        + `adversarial-review#129 + agent-os#669/#670 (2026-05-18 incident). `
        + `Check that consumers are reading the deploy-checkout DB, not the `
        + `managed-service-root DB.`
      );
      const structuredAlert = {
        event: 'merge_agent.fleet_wide_false_deferral',
        payload: {
          reason: FLEET_WIDE_FALSE_DEFERRAL_REASON,
          distinctLrqCount: state.observations.length,
          threshold,
          windowMinutes,
          observedTargets,
          observations: state.observations,
        },
      };

      state.lastAlertedAt = new Date(now).toISOString();
      try {
        writeStateFileFn(statePath, JSON.stringify(state, null, 2) + '\n');
      } catch (writeErr) {
        await failClosedFleetWideFalseDeferralDetector({
          deliverAlertFn,
          logger,
          operation: 'write-lastAlertedAt',
          statePath,
          repoPath,
          prNumber,
          lrq,
          err: writeErr,
          now,
          degradedAlertDebounceMs,
        });
      }
      return { text, structuredAlert };
    });
  } catch (lockErr) {
    if (typeof lockErr?.message === 'string'
      && lockErr.message.startsWith('[watcher] fleet-wide false-deferral detector state ')) {
      throw lockErr;
    }
    await failClosedFleetWideFalseDeferralDetector({
      deliverAlertFn,
      logger,
      operation: 'lock',
      statePath,
      repoPath,
      prNumber,
      lrq,
      err: lockErr,
      now,
      degradedAlertDebounceMs,
    });
  }
  if (!alertToDeliver) return false;
  await deliverAlertFn(alertToDeliver.text, alertToDeliver.structuredAlert);
  return true;
}
