import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const MAX_READS = 256;
const MAX_READ_BYTES = 16 * 1024 * 1024;

// Copy before freezing: a reader or another consumer must not be able to change
// evidence already handed to this pass. Reject executable/non-JSON values.
export function immutableSnapshotValue(value, ancestors = new Set()) {
  if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new TypeError('snapshot evidence must be a plain acyclic value');
  }
  ancestors.add(value);
  try {
    const copy = Array.isArray(value) ? new Array(value.length) : {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('snapshot evidence cannot contain accessors');
      Object.defineProperty(copy, key, { value: immutableSnapshotValue(descriptor.value, ancestors), enumerable: true });
    }
    return Object.freeze(copy);
  } finally { ancestors.delete(value); }
}

function evict(scope, entry) {
  scope.entries.delete(entry);
  scope.bytes -= entry.bytes;
  if (entry.reads.get(entry.key) === entry) entry.reads.delete(entry.key);
}

export async function withClosureEvaluationReadCache(run) {
  if (storage.getStore()?.open) return run();
  const scope = { readers: new Map(), entries: new Set(), bytes: 0, open: true };
  try { return await storage.run(scope, run); }
  finally { scope.open = false; scope.readers.clear(); scope.entries.clear(); }
}

export function readClosureImmutable(reader, identity, run, executor = reader, signal = null) {
  signal?.throwIfAborted();
  const scope = storage.getStore();
  if (!scope?.open) return run();
  let executors = scope.readers.get(reader);
  if (!executors) { executors = new Map(); scope.readers.set(reader, executors); }
  let reads = executors.get(executor);
  if (!reads) { reads = new Map(); executors.set(executor, reads); }
  const key = JSON.stringify(identity);
  let entry = reads.get(key);
  // Completed object-addressed evidence is safe across operation deadlines.
  // In-flight work belongs to its signal: cancellation of one operation must
  // never reject a different operation's read or disable its own deadline.
  if (!entry || (!entry.settled && entry.signal !== signal)) {
    // The previous caller still owns its promise, but the cache must not retain
    // an unindexed result outside its byte budget when that promise completes.
    if (entry) evict(scope, entry);
    const promise = Promise.resolve().then(run).then(value => {
      signal?.throwIfAborted();
      return immutableSnapshotValue(value);
    });
    entry = { reads, key, promise, signal, settled: false, bytes: 0 };
    reads.set(key, entry);
    scope.entries.add(entry);
    while (scope.entries.size > MAX_READS) evict(scope, scope.entries.values().next().value);
    const current = entry;
    promise.then(value => {
      if (!scope.open || reads.get(key) !== current) return;
      current.settled = true;
      // History projections can contain blobs. Bound retained bytes as well as
      // keys so a tick with several large PRs cannot retain their entire trees.
      try { current.bytes = Buffer.byteLength(JSON.stringify(value) || ''); }
      catch { evict(scope, current); return; }
      scope.bytes += current.bytes;
      while (scope.bytes > MAX_READ_BYTES) evict(scope, scope.entries.values().next().value);
    }, () => { if (scope.entries.has(current)) evict(scope, current); });
  }
  return entry.promise;
}
