import { setTimeout as delay } from 'node:timers/promises';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';

// Nominal idle budgets: 30s/pass, 10s/snapshot, 8s/individual read.
export function ownershipReadBudgets(options = {}) {
  const load = options.loadOptions || {};
  return {
    pass: options.scanBudgetMs ?? loadAwareTimeoutMs(30_000, load),
    snapshot: options.snapshotTimeoutMs ?? loadAwareTimeoutMs(10_000, load),
    launch: options.launchReadTimeoutMs ?? loadAwareTimeoutMs(8_000, load),
  };
}
export async function boundedOwnershipRead(read, timeoutMs, signal) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false,
        reason: 'scan-read-timeout', timedOut: true }), timeoutMs); }),
    ]);
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'ETIMEDOUT') return { ok: false, reason: 'scan-read-timeout', timedOut: true };
    return { ok: false, reason: 'scan-read-error' };
  } finally { clearTimeout(timer); }
}

// NXA pass, reference and wake observations use the closer census deadlines.
// Retry unavailable evidence within one pass; no failed snapshot is reusable.
export async function readOwnershipObservation(read, options = {}) {
  const budgets = ownershipReadBudgets(options);
  const deadline = Date.now() + budgets.pass;
  const unknown = result => ({ state: result?.reason === 'scan-read-error' ? 'error' : 'unknown', value: null,
    provenance: { sourceRef: 'launch-requests', reason: result?.reason || 'ownership-read-unavailable',
      timedOut: result?.timedOut === true } });
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return unknown({ reason: 'ownership-read-deferred' });
    const timeoutMs = Math.min(budgets.launch, remaining);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      result = await boundedOwnershipRead(() => read({ signal, timeoutMs }), timeoutMs, signal);
    } finally { controller.abort(); }
    if (result?.state === 'complete') return result;
    if (attempt < 2 && deadline > Date.now()) {
      await delay(Math.min(100 * 2 ** attempt, deadline - Date.now()), undefined, { signal: options.signal });
    }
  }
  return result?.state ? result : unknown(result);
}
