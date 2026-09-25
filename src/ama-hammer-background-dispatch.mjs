// HAMASYNC-01 — take AMA's hammer `hq dispatch` out of the serial posted-review
// phase.
//
// The posted-review phase handles PRs one at a time. When AMA decides a PR needs
// a hammer, `maybeDispatchAmaCloser` shells out to `hq dispatch`, which took
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
// `ama-closer-launch-in-progress` without re-dispatching. This module adds only
// what the phase can no longer provide once it stops awaiting: one in-flight
// dispatch per PR@head, a global concurrency bound, and settle logging.

import { loadRoleConfig } from './role-config.mjs';

export const AMA_HAMMER_DISPATCH_MODE_CFG_KEY = 'watcher.ama_hammer_dispatch_mode';
export const AMA_HAMMER_DISPATCH_MODES = Object.freeze(['inline', 'background']);
export const DEFAULT_AMA_HAMMER_DISPATCH_MODE = 'inline';
// Two concurrent `hq dispatch` subprocesses is enough to keep a small hammer
// backlog moving without turning the watcher into a dispatch storm on a host
// whose admission is already the bottleneck.
export const DEFAULT_AMA_HAMMER_BACKGROUND_MAX_CONCURRENT = 2;
export const AMA_HAMMER_BACKGROUND_REASON = 'ama-closer-dispatch-backgrounded';

/**
 * Resolve the dispatch mode. Any config error, unknown value, or missing key
 * falls back to `inline` — today's behaviour — so a broken config can never
 * silently change how merges are dispatched.
 */
export function resolveAmaHammerDispatchMode({
  env = process.env,
  loadRoleConfigImpl = loadRoleConfig,
  logger = null,
} = {}) {
  let raw;
  try {
    const cfg = loadRoleConfigImpl({ env, contextKey: AMA_HAMMER_DISPATCH_MODE_CFG_KEY });
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

/**
 * A bounded background runner. One entry per key (PR@head); at most
 * `maxConcurrent` runs at once, the rest wait FIFO. Entries leave the map when
 * their run settles, so a later tick can dispatch the same PR@head again if the
 * closer decides it should (e.g. after a genuine failure).
 */
export function createAmaHammerBackgroundQueue({
  maxConcurrent = DEFAULT_AMA_HAMMER_BACKGROUND_MAX_CONCURRENT,
  nowMs = () => Date.now(),
} = {}) {
  const limit = Math.max(1, Number.parseInt(String(maxConcurrent), 10) || 1);
  const entries = new Map();
  const waiting = [];
  let running = 0;

  function launch(entry) {
    running += 1;
    entry.state = 'running';
    entry.startedAtMs = nowMs();
    let settled;
    try {
      settled = Promise.resolve(entry.run());
    } catch (err) {
      settled = Promise.reject(err);
    }
    entry.promise = settled
      .then(
        (result) => {
          entry.onSettled?.({ ok: true, result, elapsedMs: nowMs() - entry.startedAtMs });
          return result;
        },
        (error) => {
          entry.onSettled?.({ ok: false, error, elapsedMs: nowMs() - entry.startedAtMs });
          return null;
        },
      )
      .finally(() => {
        running -= 1;
        entries.delete(entry.key);
        const next = waiting.shift();
        if (next) launch(next);
      });
  }

  return {
    /**
     * @returns {{state: 'started'|'queued'|'in-flight', key: string, queuedAtMs: number}}
     */
    submit({ key, run, onSettled = null }) {
      const existing = entries.get(key);
      if (existing) {
        return { state: 'in-flight', key, queuedAtMs: existing.queuedAtMs };
      }
      const entry = { key, run, onSettled, state: 'queued', queuedAtMs: nowMs(), promise: null };
      entries.set(key, entry);
      if (running < limit) {
        launch(entry);
        return { state: 'started', key, queuedAtMs: entry.queuedAtMs };
      }
      waiting.push(entry);
      return { state: 'queued', key, queuedAtMs: entry.queuedAtMs };
    },
    snapshot() {
      return {
        running,
        waiting: waiting.length,
        limit,
        keys: [...entries.keys()],
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
let processQueue = null;
export function amaHammerBackgroundQueue() {
  if (!processQueue) processQueue = createAmaHammerBackgroundQueue();
  return processQueue;
}

export function resetAmaHammerBackgroundQueueForTests() {
  processQueue = null;
}
