/**
 * Watcher-side scheduling for the stale-state reaper (CLR-02).
 *
 * `recovery-reaper.mjs` owns *what* gets reclaimed. This leaf module owns *when*
 * the watcher runs it, which is the part that was wrong: `runStartupStaleStateReaper`
 * had exactly one call site, above the poll loop, so a reclaimer that
 * demonstrably works (`[reaper] startup stale-state sweep: ... released 18 closer
 * lease(s)` in the live log) ran once per process lifetime and never again. On
 * 2026-08-26 that left 11 of 11 non-terminal AMA closer leases stale with dead
 * holder pids, 0 reclaimed, oldest 15.4h — see SEV
 * `closer-lease-reaper-runs-only-at-watcher-startup`.
 *
 * Both triggers are needed and they are not interchangeable:
 *
 *   - startup, because recovery from a host outage cannot wait a tick interval;
 *   - periodic, because a watcher that stays up for a day would otherwise
 *     reclaim nothing for a day.
 *
 * Kept out of `watcher.mjs` so the ARC-18 scheduler ratchet keeps holding —
 * scheduling policy is exactly the kind of orchestration that gate wants in a
 * leaf module rather than back in the monolith.
 *
 * @module watcher-stale-state-reaper
 */

import { createStaleStateReaperTicker, runStartupStaleStateReaper } from './recovery-reaper.mjs';

/**
 * Run the startup sweep, then hand back the ticker that drives the same sweep
 * from the poll loop.
 *
 * The ticker's clock starts when it is constructed — i.e. immediately after the
 * startup sweep returns — so the first periodic sweep lands one interval later
 * rather than duplicating the startup one.
 *
 * Never throws: `runStartupStaleStateReaper` already contains its own failures,
 * and the returned `tick()` contains its own. A recovery failure must not stop
 * the watcher from starting, nor from polling once it has.
 *
 * @param {object} args
 * @param {string} args.rootDir
 * @param {object} args.db                 open better-sqlite3 handle
 * @param {(pid:number)=>boolean} args.isProcessAlive
 * @returns {Promise<{ intervalMs: number, tick: Function }>}
 */
export async function startWatcherStaleStateReaper({
  rootDir,
  db,
  env = process.env,
  logger = console,
  isProcessAlive = null,
} = {}) {
  await runStartupStaleStateReaper({ rootDir, db, env, logger, isProcessAlive });
  return createStaleStateReaperTicker({ rootDir, db, env, logger, isProcessAlive });
}
