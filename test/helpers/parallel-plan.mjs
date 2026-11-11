// Stable longest-processing-time partitioning. Missing measurements receive the
// median known duration so new files do not all collect in the last shard.
export function workerCount(cpuCount, fileCount) {
  return Math.min(fileCount, 16, Math.max(1, Math.floor(cpuCount) * 8));
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

export function planShards(files, durations, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Expected a positive worker count');
  const duration = estimate(durations);
  const ordered = orderFiles(files, durations);
  const shards = Array.from({ length: Math.min(count, files.length) }, () => ({ files: [], durationMs: 0 }));
  for (const file of ordered) {
    const shard = shards.reduce((best, next) => next.durationMs < best.durationMs ? next : best);
    shard.files.push(file);
    shard.durationMs += duration(file);
  }
  return shards;
}
