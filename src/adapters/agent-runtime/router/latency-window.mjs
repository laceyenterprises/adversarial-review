// A fixed-size rolling window of dispatch-acceptance latencies, feeding the
// probe's p95 signal (v2 app architecture §6.2). Only successful dispatch
// acceptances are recorded; an empty window reports `null` p95 (no data — the
// probe treats "no data" as healthy, so a quiet system never self-fails-over).

function createLatencyWindow({ size = 20 } = {}) {
  const capacity = Number.isInteger(size) && size > 0 ? size : 20;
  const samples = [];

  function record(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return;
    samples.push(value);
    while (samples.length > capacity) samples.shift();
  }

  function percentile(p) {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    // Nearest-rank: ceil(p * N), clamped into range, then 0-indexed.
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[idx];
  }

  return {
    record,
    p95: () => percentile(95),
    percentile,
    size: () => samples.length,
    capacity: () => capacity,
    reset: () => { samples.length = 0; },
  };
}

export { createLatencyWindow };
