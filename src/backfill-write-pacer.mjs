import { performance } from 'node:perf_hooks';
import { sleepSync } from './sqlite-busy-retry.mjs';

// A bulk backfill shares reviews.db with the live review service. SQLite's busy
// handler is not fair: a loop that re-acquires the write lock microseconds after
// each commit starves writers sleeping in their busy handler. The pacer yields
// after every write transaction so the lock is free for most of the wall clock.
export const DEFAULT_BACKFILL_WRITE_DUTY_CYCLE = 0.2;

export function parseWriteDutyCycle(value) {
  const text = String(value ?? '');
  const ratio = Number(text);
  if (!/^(?:0?\.\d+|1(?:\.0+)?)$/.test(text) || !(ratio > 0 && ratio <= 1)) {
    throw new Error('write duty cycle must be a decimal in (0, 1]');
  }
  return ratio;
}

export function createBackfillWritePacer({ maxWriteDutyCycle = DEFAULT_BACKFILL_WRITE_DUTY_CYCLE,
  now = () => performance.now(), sleep = sleepSync } = {}) {
  const ratio = parseWriteDutyCycle(maxWriteDutyCycle);
  const startedAt = now();
  const stats = { writeTransactions: 0, writeMs: 0, yieldMs: 0 };
  return {
    // Every write transaction yields, including ones that change nothing and
    // ones that fail, so pacing never depends on how much a pass inserted.
    write(fn) {
      const started = now();
      try { return fn(); } finally {
        const held = now() - started;
        stats.writeTransactions += 1;
        stats.writeMs += held;
        if (ratio < 1) {
          // Lock wait time counts as held time, so the yield errs long.
          const yieldStarted = now();
          sleep(Math.max(1, Math.ceil(held * (1 / ratio - 1) - 1e-9)));
          stats.yieldMs += now() - yieldStarted;
        }
      }
    },
    summary() {
      const elapsedMs = now() - startedAt;
      return { maxWriteDutyCycle: ratio, ...stats, elapsedMs,
        writeDutyCycle: elapsedMs > 0 ? stats.writeMs / elapsedMs : 0 };
    },
  };
}
