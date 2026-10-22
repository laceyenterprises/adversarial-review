import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const MAX_AGE_MS = 10_000;

// One handler in one poll owns these advisory reads. Merge/dispatch freshness
// probes must run after closePostedReviewReadCache(), even on the same head.
export async function withPostedReviewReadCache({ repo, prNumber, headSha }, run) {
  const parent = storage.getStore();
  if (parent?.open && parent.repo === repo && parent.prNumber === prNumber) {
    observePostedReviewHead(repo, prNumber, headSha);
    return run();
  }
  const scope = { repo, prNumber, headSha, readers: new Map(), open: true, firstCompletedAt: undefined };
  try { return await storage.run(scope, run); }
  finally { scope.open = false; scope.readers.clear(); }
}

export function closePostedReviewReadCache() {
  const scope = storage.getStore();
  if (scope) { scope.open = false; scope.readers.clear(); }
}

export function observePostedReviewHead(repo, prNumber, headSha) {
  const scope = storage.getStore();
  if (!scope?.open || scope.repo !== repo || scope.prNumber !== prNumber || !headSha) return;
  if (scope.headSha !== headSha) {
    scope.headSha = headSha;
    scope.readers.clear();
  }
}

export function readPostedReviewResource(kind, repo, prNumber, {
  execFileImpl, env = process.env, currentHeadSha = null, signal = null,
} = {}, run, { now = Date.now, headOf = null } = {}) {
  const scope = storage.getStore();
  if (!scope?.open || scope.repo !== repo || scope.prNumber !== prNumber) return run();
  const time = now();
  // Start freshness when evidence arrives, not during subprocess startup.
  // Nested event projections cannot extend the first response's window.
  if (scope.firstCompletedAt !== undefined
    && (time < scope.firstCompletedAt || time - scope.firstCompletedAt >= MAX_AGE_MS)) {
    closePostedReviewReadCache();
    return run();
  }
  // An explicit different head cannot consume the previous head's provenance.
  if (currentHeadSha) observePostedReviewHead(repo, prNumber, currentHeadSha);
  let reads = scope.readers.get(execFileImpl);
  if (!reads) { reads = new Map(); scope.readers.set(execFileImpl, reads); }
  // Private ephemeral identity only; never log argv, credentials or payloads.
  const cacheKey = () => JSON.stringify([kind, scope.headSha, env.GH_TOKEN, env.GITHUB_TOKEN,
    env.GH_HOST, env.GH_CONFIG_DIR, env.HOME, env.USERPROFILE, env.GHA_ADAPTER_BIN,
    env.AGENT_OS_GITHUB_ADAPTER_BIN, env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY]);
  let key = cacheKey();
  let entry = reads.get(key);
  // Pending work belongs to its cancellation scope. Completed advisory facts
  // can be reused until the existing head/age/effect boundary.
  if (entry && !entry.settled && entry.signal !== signal) entry = null;
  if (!entry) {
    entry = { promise: null, signal, settled: false };
    entry.promise = Promise.resolve().then(run).then(value => {
      signal?.throwIfAborted();
      entry.settled = true;
      if (scope.open && scope.readers.get(execFileImpl) === reads && reads.get(key) === entry) {
        const observedHead = headOf?.(value);
        if (observedHead && observedHead !== scope.headSha) {
          observePostedReviewHead(repo, prNumber, observedHead);
          // Rebind only this successful PR read, whose response establishes
          // the new head. Every other previous-head observation was discarded.
          reads = new Map();
          scope.readers.set(execFileImpl, reads);
          key = cacheKey();
          reads.set(key, entry);
        }
        scope.firstCompletedAt ??= now();
      }
      return value;
    });
    reads.set(key, entry);
    entry.promise.catch(() => { if (reads.get(key) === entry) reads.delete(key); });
  }
  return entry.promise;
}
