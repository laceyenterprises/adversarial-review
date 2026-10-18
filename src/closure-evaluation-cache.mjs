import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const MAX_READS = 256;
const MAX_READ_BYTES = 16 * 1024 * 1024;

function evict(scope, entry) {
  scope.entries.delete(entry);
  scope.bytes -= entry.bytes;
  if (entry.reads.get(entry.key) === entry.promise) entry.reads.delete(entry.key);
}

export async function withClosureEvaluationReadCache(run) {
  if (storage.getStore()?.open) return run();
  const scope = { readers: new Map(), entries: new Set(), bytes: 0, open: true };
  try { return await storage.run(scope, run); }
  finally { scope.open = false; scope.readers.clear(); scope.entries.clear(); }
}

export function readClosureImmutable(reader, identity, run, executor = reader) {
  const scope = storage.getStore();
  if (!scope?.open) return run();
  let executors = scope.readers.get(reader);
  if (!executors) { executors = new Map(); scope.readers.set(reader, executors); }
  let reads = executors.get(executor);
  if (!reads) { reads = new Map(); executors.set(executor, reads); }
  const key = JSON.stringify(identity);
  if (!reads.has(key)) {
    const promise = Promise.resolve().then(run);
    reads.set(key, promise);
    const entry = { reads, key, promise, bytes: 0 };
    scope.entries.add(entry);
    while (scope.entries.size > MAX_READS) evict(scope, scope.entries.values().next().value);
    promise.then(value => {
      if (!scope.open || reads.get(key) !== promise) return;
      // History projections can contain blobs. Bound retained bytes as well as
      // keys so a tick with several large PRs cannot retain their entire trees.
      try { entry.bytes = Buffer.byteLength(JSON.stringify(value) || ''); }
      catch { evict(scope, entry); return; }
      scope.bytes += entry.bytes;
      while (scope.bytes > MAX_READ_BYTES) evict(scope, scope.entries.values().next().value);
    }, () => { if (scope.entries.has(entry)) evict(scope, entry); });
  }
  return reads.get(key);
}
