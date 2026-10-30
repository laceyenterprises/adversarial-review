import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { effectiveCloserCap, warnCloserFloor } from './ama/closure-capacity.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { repositoryObservationCache } from './repository-state-cache.mjs';
// HAMASYNC-01 — take AMA's hammer `hq dispatch` out of the serial posted-review
// phase.
//
// The posted-review phase runs a fixed number of handlers concurrently. When
// AMA decides a PR needs a hammer, `maybeDispatchAmaCloser` shells out to `hq dispatch`, which took
// 118-165 s per call on the reference host (2026-09-25, 16+ coexistence-deadline
// breaches across #6924/#6932/#6940/#6941/#6960/#6962/#6967/#6969). Every later
// PR in the phase — including merge-ready ones that need only the daemon's merge
// click — waited behind it, and the watcher poll cycle ran 16-23 min against a
// 300 s tick. See docs/postmortems/SEV1-the-merge-phase-waits-on-a-synchronous-
// hammer-dispatch-so-approved-prs-do-not-merge-2026-09-25.md in agent-os.
//
// In `background` mode the phase starts the dispatch here and returns
// `ama-pending` immediately. Safety rests on machinery that already exists:
// `maybeDispatchAmaCloser` writes its dispatch record (`state: dispatching`) and
// acquires the per-PR closer lease before it calls `hq dispatch`, and on the next
// tick `findActiveAmaCloserLaunch` / the lease check return
// `ama-closer-launch-in-progress` without re-dispatching. This module adds
// what the phase can no longer provide once it stops awaiting: one in-flight
// dispatch per PR, a global concurrency bound, durable retry intent, and settle logging.
//
// It also hands each run's outcome back to the phase. A run can end in a
// terminal rejection from the closer's own gates (retry cap, ineligibility) that
// the phase must act on — fall through to merge-agent, alert — exactly as it
// would inline. The queue keeps the settled outcome per PR@head, and the next
// tick for that PR@head consumes it through the unchanged inline result path
// instead of submitting again. Rejections therefore reach the phase one tick
// later, never silently.

export const AMA_HAMMER_DISPATCH_MODE_CFG_KEY = 'watcher.ama_hammer_dispatch_mode';
export const AMA_HAMMER_DISPATCH_MODES = Object.freeze(['inline', 'background']);
export const DEFAULT_AMA_HAMMER_DISPATCH_MODE = 'inline';
// Keep the background queue aligned with the closer's default capacity.
export const DEFAULT_AMA_HAMMER_BACKGROUND_MAX_CONCURRENT = 3;
export const AMA_HAMMER_BACKGROUND_PROCESS_CEILING = 32;
export const AMA_HAMMER_BACKGROUND_REASON = 'ama-closer-dispatch-backgrounded';
export const DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS = 15 * 60 * 1000;

export function isAmaCloserLaunching(result) {
  return (result?.reason === AMA_HAMMER_BACKGROUND_REASON
      && Number.isFinite(Date.parse(result?.closerProgressAt || '')))
    || (result?.reason?.startsWith('in-flight:')
      && Number.isFinite(Date.parse(result?.closerProgressAt || '')))
    || result?.reason?.startsWith('ama-closer-dispatch-overrun:');
}

// Only this process's running queue entry is evidence of a launch in progress.
// Durable retry intent and queued entries do not prove that dispatch has started.
export function amaHammerBackgroundProgress(entry, now) {
  if (!entry || !['running', 'started', 'in-flight'].includes(entry.state)
    || !Number.isFinite(entry.startedAtMs) || entry.startedAtMs > now) return {};
  const elapsedMs = now - entry.startedAtMs;
  return {
    closerProgressAt: new Date(entry.startedAtMs).toISOString(),
    closerLaunchBoundMs: entry.boundMs,
    ...(elapsedMs >= entry.boundMs
      ? { reason: `ama-closer-dispatch-overrun: elapsed_ms=${elapsedMs} bound_ms=${entry.boundMs}` } : {}),
  };
}
// A settled outcome is only meaningful to the next tick or two for that PR@head.
// Past this age the PR has moved on (new head, closed) and the outcome is dropped.
export const DEFAULT_AMA_HAMMER_SETTLED_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_AMA_HAMMER_SETTLED_MAX_ENTRIES = 256;

/**
 * Resolve the dispatch mode. Any config error, unknown value, or missing key
 * falls back to `inline` — today's behaviour — so a broken config can never
 * silently change how merges are dispatched.
 */
export function resolveAmaHammerDispatchMode({
  cfg,
  logger = null,
} = {}) {
  let raw;
  try {
    raw = cfg?.get?.(AMA_HAMMER_DISPATCH_MODE_CFG_KEY, DEFAULT_AMA_HAMMER_DISPATCH_MODE);
  } catch (err) {
    logger?.warn?.(
      `[watcher] ${AMA_HAMMER_DISPATCH_MODE_CFG_KEY} unreadable; using ` +
        `${DEFAULT_AMA_HAMMER_DISPATCH_MODE}: ${err?.message || err}`,
    );
    return DEFAULT_AMA_HAMMER_DISPATCH_MODE;
  }
  const mode = String(raw ?? '').trim().toLowerCase();
  return AMA_HAMMER_DISPATCH_MODES.includes(mode) ? mode : DEFAULT_AMA_HAMMER_DISPATCH_MODE;
}

export function amaHammerBackgroundKey({ repo, prNumber, headSha }) {
  return `${repo}#${prNumber}@${String(headSha || '').trim() || 'unknown-head'}`;
}

function pendingDispatchPath(rootDir, { repo, prNumber }) {
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  return join(rootDir, 'data', 'ama-hammer-background', `${key}.json`);
}

// This is a retry intent, never launch authority. The first adoption phase
// after a restart rebuilds the normal handler with fresh state and config.
export function readPendingAmaHammerDispatch(rootDir, identity, { logger = console } = {}) {
  try {
    const doc = JSON.parse(readFileSync(pendingDispatchPath(rootDir, identity), 'utf8'));
    if (doc.repo !== identity.repo || Number(doc.prNumber) !== Number(identity.prNumber)
      || doc.headSha !== identity.headSha) return null;
    if (!doc.attemptId || !Number.isFinite(Date.parse(doc.startedAt))) {
      throw new Error('invalid pending hammer dispatch');
    }
    return doc;
  } catch (error) {
    if (error.code !== 'ENOENT') logger?.warn?.(`[watcher] pending hammer dispatch read failed: ${error.message}`);
    return null;
  }
}

function persistPendingDispatch(identity, nowMs) {
  if (!identity) return null;
  const { rootDir, repo, prNumber, headSha } = identity;
  const doc = { repo, prNumber, headSha, startedAt: new Date(nowMs).toISOString(), attemptId: randomUUID() };
  writeFileAtomic(pendingDispatchPath(rootDir, identity), `${JSON.stringify(doc)}\n`);
  return { ...doc, rootDir };
}

function clearPendingDispatch(entry) {
  const intent = entry.pendingDispatch;
  if (!intent) return;
  // A late callback from a superseded process/run cannot erase its replacement.
  const current = readPendingAmaHammerDispatch(intent.rootDir, intent);
  if (current?.attemptId === intent.attemptId) rmSync(pendingDispatchPath(intent.rootDir, intent), { force: true });
}

// A normal handler can find an operator hold or an existing launch before it
// reaches the queue. Retire interrupted intent when that other owner takes
// over. This never changes the closer's launch/lease records.
export function clearPendingAmaHammerDispatch(rootDir, identity, { logger = console } = {}) {
  const current = readPendingAmaHammerDispatch(rootDir, identity, { logger });
  if (!current) return;
  rmSync(pendingDispatchPath(rootDir, identity), { force: true });
}

// Only confirmed PR termination retires intent regardless of its recorded head.
// Normal launch/hold cleanup above must stay head-bound; queue callbacks must
// additionally check attemptId before removing a potentially replaced intent.
export function clearPendingAmaHammerDispatchForTerminalPr(rootDir, identity) {
  rmSync(pendingDispatchPath(rootDir, identity), { force: true });
}

/**
 * A bounded background runner. One entry per key (PR@head), with at most one
 * running entry per PR; at most `maxConcurrent` runs overall. Eligible waiters
 * run FIFO. When a run settles its entry
 * leaves the map and its outcome is kept for `takeSettled(key)`, so the next
 * tick applies it instead of dispatching again.
 */
export function createAmaHammerBackgroundQueue({
  maxConcurrent = DEFAULT_AMA_HAMMER_BACKGROUND_MAX_CONCURRENT,
  ceiling = maxConcurrent,
  nowMs = () => Date.now(),
  settledTtlMs = DEFAULT_AMA_HAMMER_SETTLED_TTL_MS,
  settledMaxEntries = DEFAULT_AMA_HAMMER_SETTLED_MAX_ENTRIES,
  logger = console,
} = {}) {
  const limit = () => effectiveCloserCap(entries.size, maxConcurrent, ceiling);
  const entries = new Map();
  const settled = new Map();
  const waiting = [];
  let running = 0;
  let stopping = false;
  const runningPrKeys = new Set();
  repositoryObservationCache({ clear() {
    // Running dispatchers own a shared rename fence. Queued callbacks retain
    // old arguments, so let the renamed durable intent refill them next tick.
    for (const entry of entries.values()) if (entry.state === 'queued') abort(entry.key);
    settled.clear();
  } });

  function prKey(key) {
    const headSeparator = key.lastIndexOf('@');
    return headSeparator < 0 ? key : key.slice(0, headSeparator);
  }

  function launchWaiting() {
    while (!stopping && running < limit()) {
      const nextIndex = waiting.findIndex((entry) => !runningPrKeys.has(entry.prKey));
      if (nextIndex < 0) return;
      const [next] = waiting.splice(nextIndex, 1);
      launch(next);
    }
  }

  function recordSettled(key, outcome) {
    settled.delete(key);
    settled.set(key, { ...outcome, settledAtMs: nowMs() });
    // Map iteration is insertion order, so the first key is the oldest.
    while (settled.size > Math.max(1, settledMaxEntries)) {
      settled.delete(settled.keys().next().value);
    }
  }

  function abort(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entry.controller.abort();
    settled.delete(key);
    if (entry.state === 'queued') {
      try { clearPendingDispatch(entry); }
      catch (error) { logger?.warn?.(`[watcher] pending hammer dispatch cleanup failed: ${error.message}`); }
      waiting.splice(waiting.indexOf(entry), 1);
      entries.delete(key);
    }
    // Running entries retain their slot until they settle, preventing overlap
    // even when a runner cannot immediately honor cancellation.
    return true;
  }

  function discardOlderHeads(key) {
    for (const oldKey of entries.keys()) {
      if (prKey(oldKey) === prKey(key) && oldKey !== key) abort(oldKey);
    }
  }

  function launch(entry) {
    running += 1;
    runningPrKeys.add(entry.prKey);
    entry.state = 'running';
    entry.startedAtMs = nowMs();
    let settled;
    try {
      settled = Promise.resolve(entry.run(entry.controller.signal, shared => {
        if (!entry.controller.signal.aborted) entry.sharedNextAction = shared;
      }));
    } catch (err) {
      settled = Promise.reject(err);
    }
    entry.promise = settled
      .then(
        (result) => {
          if (!entry.controller.signal.aborted) recordSettled(entry.key, { ok: true,
            result: result?.dispatched === true
              ? { ...result, closerProgressAt: new Date(entry.startedAtMs).toISOString() } : result });
          entry.onSettled?.({ ok: true, result, elapsedMs: nowMs() - entry.startedAtMs });
          return result;
        },
        (error) => {
          if (!entry.controller.signal.aborted) recordSettled(entry.key, { ok: false, error });
          entry.onSettled?.({ ok: false, error, elapsedMs: nowMs() - entry.startedAtMs });
          return null;
        },
      )
      .finally(() => {
        running -= 1;
        runningPrKeys.delete(entry.prKey);
        entries.delete(entry.key);
        try { clearPendingDispatch(entry); }
        catch (error) { logger?.warn?.(`[watcher] pending hammer dispatch cleanup failed: ${error.message}`); }
        finally { launchWaiting(); }
      })
      // A settle logger is caller-supplied and can throw. The outcome was
      // already retained above; consume that final rejection so a background
      // callback cannot crash the watcher with an unhandled promise rejection.
      .catch(() => null);
  }

  return {
    /** Cancel waiting work or signal a running task without freeing its slot early. */
    abort,
    // Abort listeners persist interrupted closer intents synchronously before
    // watcher exit. Queued retry hints remain available for the next watcher.
    shutdown() {
      stopping = true;
      for (const entry of entries.values()) entry.controller.abort();
      waiting.length = 0;
      for (const [key, entry] of entries) if (entry.state === 'queued') entries.delete(key);
    },
    /**
     * @returns {{state: 'started'|'queued'|'in-flight', key: string, queuedAtMs: number, startedAtMs?: number, boundMs: number}}
     */
    submit({ key, run, onSettled = null, pendingDispatch = null, timeoutMs = null, sharedNextAction = null }) {
      if (stopping) return { state: 'stopped', key };
      discardOlderHeads(key);
      for (const oldKey of settled.keys()) {
        if (prKey(oldKey) === prKey(key) && oldKey !== key) settled.delete(oldKey);
      }
      const existing = entries.get(key);
      if (existing) {
        // Report what the existing entry is actually doing: still waiting for a
        // slot reads as `queued`, a started run as `in-flight`.
        return {
          state: existing.state === 'running' ? 'in-flight' : 'queued',
          key,
          queuedAtMs: existing.queuedAtMs,
          startedAtMs: existing.controller.signal.aborted ? undefined : existing.startedAtMs,
          boundMs: existing.boundMs,
        };
      }
      const entry = { key, prKey: prKey(key), run, onSettled, sharedNextAction,
        state: 'queued', queuedAtMs: nowMs(), promise: null, controller: new AbortController() };
      const dispatchTimeoutMs = Number(timeoutMs);
      entry.boundMs = Number.isFinite(dispatchTimeoutMs) && dispatchTimeoutMs > 0
        ? dispatchTimeoutMs : loadAwareTimeoutMs(DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS, { maxMs: Infinity });
      // Persist before invoking any run, including a synchronous launch. Failure
      // to save refuses submission rather than launching untracked work.
      entry.pendingDispatch = persistPendingDispatch(pendingDispatch, entry.queuedAtMs);
      entries.set(key, entry);
      if (running < limit() && !runningPrKeys.has(entry.prKey)) {
        launch(entry);
        return { state: 'started', key, queuedAtMs: entry.queuedAtMs,
          startedAtMs: entry.startedAtMs, boundMs: entry.boundMs };
      }
      waiting.push(entry);
      return { state: 'queued', key, queuedAtMs: entry.queuedAtMs, boundMs: entry.boundMs };
    },
    /** Read launch evidence without consuming the next tick's settled outcome. */
    get(key) {
      const entry = entries.get(key);
      if (entry && !entry.controller.signal.aborted) return {
        state: entry.state, startedAtMs: entry.startedAtMs, boundMs: entry.boundMs,
        ...(entry.sharedNextAction ? { nextAction: entry.sharedNextAction.decision } : {}),
      };
      const outcome = settled.get(key);
      return outcome && nowMs() - outcome.settledAtMs <= settledTtlMs ? { state: 'settled' } : null;
    },
    /**
     * Consume the settled outcome for `key` (`{ ok, result | error, settledAtMs }`),
     * or return null when there is none or it is older than `settledTtlMs`.
     * Refusals are consumed too, so subsequent ticks re-evaluate same-head gates.
     */
    takeSettled(key) {
      discardOlderHeads(key);
      for (const oldKey of settled.keys()) {
        if (prKey(oldKey) === prKey(key) && oldKey !== key) settled.delete(oldKey);
      }
      const outcome = settled.get(key);
      if (!outcome) return null;
      settled.delete(key);
      if (nowMs() - outcome.settledAtMs > settledTtlMs) return null;
      return outcome;
    },
    snapshot() {
      return {
        running,
        waiting: waiting.length,
        limit: limit(),
        keys: [...entries.keys()],
        settledKeys: [...settled.keys()],
      };
    },
    /** Test/shutdown helper: resolves once every submitted run has settled. */
    async drain() {
      while (entries.size > 0) {
        const pending = [...entries.values()].map((entry) => entry.promise).filter(Boolean);
        if (pending.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          continue;
        }
        await Promise.allSettled(pending);
      }
    },
  };
}

// One queue per watcher process. The watcher is a long-lived single process, so
// module scope is the natural lifetime; tests construct their own queues.
// The shared queue uses a process bound. Each run's maybeDispatchAmaCloser
// enforces its domain ceiling; the first domain must not configure this queue.
let processQueue = null;
export function amaHammerBackgroundQueue({ maxConcurrent } = {}) {
  if (!processQueue) warnCloserFloor(maxConcurrent ?? DEFAULT_AMA_HAMMER_BACKGROUND_MAX_CONCURRENT, AMA_HAMMER_BACKGROUND_PROCESS_CEILING);
  if (!processQueue) processQueue = createAmaHammerBackgroundQueue({
    maxConcurrent, ceiling: AMA_HAMMER_BACKGROUND_PROCESS_CEILING,
  });
  return processQueue;
}

export function resetAmaHammerBackgroundQueueForTests() {
  processQueue = null;
}

export function shutdownAmaHammerBackgroundQueue() {
  processQueue?.shutdown();
}
