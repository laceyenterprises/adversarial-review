import { CI_TEST_WORKERS, nodeTestWorkerLimit } from '../../src/node-test-concurrency.mjs';

// Scale only when the configured limit queues parallel files. Selecting fewer
// files must not weaken the historical hang protection.
export function suiteTimeoutMs(fileCount, env, cores) {
  const limit = nodeTestWorkerLimit(env, cores);
  if (fileCount <= limit) return 900_000;
  return 900_000 * CI_TEST_WORKERS / Math.min(CI_TEST_WORKERS, limit);
}
// This smoke asserts real per-step wall budgets in its child process tree.
// Keep that measurement independent of the suite's artificial CPU/I/O load.
export const SERIAL_TEST_FILES = new Set(['test/smv.test.mjs']);

export function workerCount(fileCount, env, cores) {
  return Math.min(fileCount, nodeTestWorkerLimit(env, cores));
}

// Stable longest-first scheduling. Missing measurements receive the median
// known duration so new files are not all scheduled last.
function estimate(durations) {
  const known = Object.values(durations).filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  const fallback = known[Math.floor(known.length / 2)] ?? 1_000;
  return (file) => Number.isFinite(durations[file]) && durations[file] > 0 ? durations[file] : fallback;
}

export function orderFiles(files, durations) {
  const duration = estimate(durations);
  return [...files].sort((a, b) => duration(b) - duration(a) || (a < b ? -1 : a > b ? 1 : 0));
}
