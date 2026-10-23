import { loadAwareTimeoutMs, MAX_TIMER_DELAY_MS } from '../load-aware-timeout.mjs';

// Nominal inputs only; an expired absolute budget gives zero, never a 1ms retry.
export function queueWaitMs(nominalMs, { ceilingMs, deadline, now, load = {} } = {}) {
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) throw new TypeError('finite wait ceiling required');
  const remaining = deadline == null ? Infinity : Date.parse(deadline) - Date.parse(now);
  if (Number.isNaN(remaining)) throw new TypeError('invalid wait deadline');
  return Math.max(0, Math.min(remaining, ceilingMs, MAX_TIMER_DELAY_MS,
    loadAwareTimeoutMs(nominalMs, { ...load, maxMs: ceilingMs })));
}

export function queuePatience(at, load) {
  const nominalMs = 1_800_000;
  const ceilingMs = 3_600_000;
  const effectiveMs = queueWaitMs(nominalMs, { ceilingMs, load });
  return { startedAt: at, nominalMs, effectiveMs, ceilingMs,
    deadline: new Date(Date.parse(at) + effectiveMs).toISOString() };
}
