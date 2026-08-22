/**
 * Daemon liveness for Screen B (ARF-04).
 *
 * The pipeline's own doctrine is that `launchd`-"running" is not liveness and
 * that liveness is checked heartbeat-first, so this reads a heartbeat rather
 * than a job state: a stalled watcher whose process still exists is the exact
 * case a job-state probe calls healthy.
 *
 * Three states, and the third is the point:
 *
 *   `up`      — a heartbeat, newer than the stale threshold.
 *   `stale`   — a heartbeat, older than the threshold. The daemon exists but is
 *               not ticking; PRs sit unclaimed while it looks installed.
 *   `down`    — a configured heartbeat source with no heartbeat at all.
 *   `unknown` — **no source configured, or one that could not be read.**
 *
 * `unknown` is a first-class answer because only the watcher writes a
 * daemon-level heartbeat file today. The follow-up daemon heartbeats per *job*,
 * and the Python auto-merge daemon has no heartbeat of its own, so ARF is given
 * their sources by config or it reports that it does not know. Rendering an
 * un-probed daemon as `down` would be the same lie in the other direction — and
 * for the auto-merge daemon specifically it would be a dangerous one, since its
 * liveness IS its arm state (no merge-authority key disarms that path).
 */

import { readFileSync, statSync } from 'node:fs';

import { DAEMONS } from './keys.mjs';

/** Heartbeat fields ARF will accept as "when this daemon last ticked". */
const TIMESTAMP_FIELDS = ['updated_at', 'last_poll_at', 'updatedAt', 'timestamp', 'ts'];

/** The watcher's stall watchdog fires at 10 minutes; match it by default. */
export const DEFAULT_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

function parseInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The heartbeat instant from a source descriptor.
 *
 * `field: 'mtime'` reads the file's modification time instead of a field inside
 * it, so a daemon that only touches a file still has a usable probe.
 */
function readHeartbeat(source) {
  let stat;
  try {
    stat = statSync(source.path);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { beatAtMs: null, reason: null, missing: true };
    }
    return { beatAtMs: null, reason: `heartbeat ${source.path} is unreadable: ${err.message}` };
  }
  if (source.field === 'mtime') return { beatAtMs: stat.mtimeMs, reason: null };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(source.path, 'utf8'));
  } catch (err) {
    return { beatAtMs: null, reason: `heartbeat ${source.path} is not readable JSON: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { beatAtMs: null, reason: `heartbeat ${source.path} is not a JSON object` };
  }
  const fields = source.field ? [source.field] : TIMESTAMP_FIELDS;
  for (const field of fields) {
    const instant = parseInstant(parsed[field]);
    if (instant !== null) return { beatAtMs: instant, reason: null, payload: parsed };
  }
  return {
    beatAtMs: null,
    // A heartbeat file that exists but carries no timestamp ARF recognises is
    // not evidence of a down daemon — it is evidence of a probe pointed at the
    // wrong field. Say that, rather than reporting an outage.
    reason: `heartbeat ${source.path} has no recognised timestamp field `
      + `(looked for: ${fields.join(', ')})`,
  };
}

/**
 * Probe every daemon.
 *
 * @param {object} options
 * @param {Record<string, {path: string, field?: string}|null>} options.sources by daemon id
 * @param {number} [options.staleAfterMs]
 * @param {() => number} [options.now]
 * @returns {Record<string, object>} by daemon id
 */
export function probeDaemons({ sources = {}, staleAfterMs = DEFAULT_HEARTBEAT_STALE_MS, now = Date.now } = {}) {
  const at = now();
  const probes = {};
  for (const daemon of Object.values(DAEMONS)) {
    probes[daemon.id] = probeDaemon(daemon, sources[daemon.id] ?? null, { at, staleAfterMs });
  }
  return probes;
}

function probeDaemon(daemon, source, { at, staleAfterMs }) {
  const base = {
    id: daemon.id,
    label: daemon.label,
    job: daemon.job,
    mergeCapable: daemon.mergeCapable,
    note: daemon.note,
    state: 'unknown',
    lastBeatAt: null,
    ageMs: null,
    staleAfterMs,
    source: null,
    reason: null,
  };

  if (!source || !source.path) {
    return {
      ...base,
      reason: `no liveness source configured for ${daemon.job}; configure `
        + `pipeline.heartbeats.${daemon.id} to probe it`,
    };
  }

  const descriptor = { path: source.path, field: source.field ?? null };
  const { beatAtMs, reason, missing } = readHeartbeat(descriptor);

  if (beatAtMs === null) {
    return {
      ...base,
      source: descriptor,
      // A configured source with no file is a real "down" signal; a configured
      // source ARF could not interpret is not, and stays unknown.
      state: missing ? 'down' : 'unknown',
      reason: missing ? `no heartbeat at ${source.path}` : reason,
    };
  }

  const ageMs = Math.max(0, at - beatAtMs);
  return {
    ...base,
    source: descriptor,
    state: ageMs <= staleAfterMs ? 'up' : 'stale',
    lastBeatAt: new Date(beatAtMs).toISOString(),
    ageMs,
  };
}
