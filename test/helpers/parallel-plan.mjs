import { localNodeTestConcurrency } from '../../src/node-test-concurrency.mjs';

// Stable longest-first scheduling. Missing measurements receive the median
// known duration so new files are not all scheduled last.
const CI_WORKERS = 8;
// Preserve the eight-worker wall budget's capacity when local runs use fewer
// slots. Explicit higher concurrency never shortens the historical deadline.
export function suiteTimeoutMs(concurrency) {
  return 900_000 * CI_WORKERS / Math.max(1, Math.min(CI_WORKERS, concurrency));
}
// This smoke asserts real per-step wall budgets in its child process tree.
// Keep that measurement independent of the suite's artificial CPU/I/O load.
export const SERIAL_TEST_FILES = new Set(['test/smv.test.mjs']);

export function workerCount(fileCount, env, cores) {
  return Math.min(fileCount, localNodeTestConcurrency(env, cores) ?? CI_WORKERS);
}

function estimate(durations) {
  const known = Object.values(durations).filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  const fallback = known[Math.floor(known.length / 2)] ?? 1_000;
  return (file) => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : fallback;
}

export function orderFiles(files, durations) {
  const duration = estimate(durations);
  return [...files].sort((a, b) => duration(b) - duration(a) || (a < b ? -1 : a > b ? 1 : 0));
}
