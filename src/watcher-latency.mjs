// Process-wide child observation includes adapter-owned children without passing
// executors through every seam. Record command names only: argv/env can be secret.
import { channel } from 'node:diagnostics_channel';
import { basename } from 'node:path';
import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';

const commands = new Set(['gh', 'git', 'hq', 'psql']);
let activeObserver = null;
const milliseconds = histogram => histogram.count ? {
  p50_ms: histogram.percentile(50) / 1e6,
  p99_ms: histogram.percentile(99) / 1e6,
} : { p50_ms: 0, p99_ms: 0 };
const record = (histogram, elapsedMs) => histogram.record(Math.max(1, Math.round(elapsedMs * 1e6)));

export function observeSynchronousChild(command, run) {
  const started = performance.now();
  try { return run(); }
  finally { activeObserver?.recordChild(command, null, performance.now() - started); }
}

export function createWatcherLatencyMonitor({ logger = console, histogram = monitorEventLoopDelay({ resolution: 20 }) } = {}) {
  const children = new Map();
  const bucket = command => {
    const name = basename(String(command || ''));
    if (!commands.has(name)) return null;
    if (!children.has(name)) children.set(name, { count: 0, completed: 0, spawn: createHistogram(), wall: createHistogram() });
    return children.get(name);
  };
  const observer = {
    async poll(run) {
      try { return await run(); }
      finally { observer.summary(); }
    },
    recordChild(command, spawnMs, wallMs) {
      const entry = bucket(command);
      if (!entry) return;
      entry.count++;
      entry.completed++;
      if (spawnMs !== null) record(entry.spawn, spawnMs);
      record(entry.wall, wallMs);
    },
    summary() {
      const summary = { event: 'watcher-poll-latency', event_loop: milliseconds(histogram), children: {} };
      for (const [command, entry] of children) {
        summary.children[command] = { count: entry.count, completed: entry.completed,
          spawn: milliseconds(entry.spawn), wall: milliseconds(entry.wall) };
      }
      logger.log(`[watcher] poll latency summary ${JSON.stringify(summary)}`);
      children.clear();
      histogram.reset();
      return summary;
    },
    stop() {
      channel('child_process').unsubscribe(onChild);
      histogram.disable();
      if (activeObserver === observer) activeObserver = null;
    },
  };
  function onChild({ process: child }) {
    const started = performance.now();
    // The channel fires at construction, before spawnfile is assigned. The
    // spawn event measures time to spawn readiness, including event-loop delay.
    let spawned = false;
    child.once('spawn', () => {
      spawned = true;
      const entry = bucket(child.spawnfile);
      if (!entry) return;
      entry.count++;
      record(entry.spawn, performance.now() - started);
    });
    child.once('close', () => {
      const entry = bucket(child.spawnfile);
      if (!entry) return;
      if (!spawned) entry.count++;
      entry.completed++;
      record(entry.wall, performance.now() - started);
    });
  }
  channel('child_process').subscribe(onChild);
  histogram.enable();
  activeObserver = observer;
  return observer;
}
