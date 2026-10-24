import { timerDelayMs } from '../load-aware-timeout.mjs';

// Read-only adapters honor abort and consume the supplied, already-scaled budget.
export async function readQueueEvidence(adapter, request, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('queue evidence deadline expired');
  if (typeof adapter?.read !== 'function') throw new Error('queue evidence adapter unavailable');
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => adapter.read({ ...structuredClone(request), timeoutMs, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('queue evidence deadline expired'));
        }, timerDelayMs(timeoutMs));
      }),
    ]);
  } finally { clearTimeout(timer); }
}
