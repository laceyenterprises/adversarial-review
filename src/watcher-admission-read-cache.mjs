import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage();
// Check evidence may change on the same head. Share only short-lived reads in
// one drain; never cache PR state/labels, reviews, writes or spawn freshness.
export async function withAdmissionReadCache(run) {
  const cache = { executors: new Map(), open: true };
  try { return await scope.run(cache, run); }
  finally { cache.open = false; cache.executors.clear(); }
}

export function readAdmissionChecks(exec, command, args, options, run, { now = Date.now } = {}) {
  const cache = scope.getStore();
  const eligible = command === 'gh' && args[0] === 'pr' && args[1] === 'view'
    && args[args.indexOf('--json') + 1] === 'headRefOid,statusCheckRollup';
  if (!cache?.open || !eligible || options.signal) return run();
  // Executor + credential + host identity prevent cross-adapter/account reuse.
  // Tokens stay private in this ephemeral key and are never logged or persisted.
  const env = options.env || process.env;
  const key = JSON.stringify([args, env.GH_TOKEN, env.GITHUB_TOKEN, env.GH_HOST, env.GH_CONFIG_DIR, env.GHO_RATE_LIMIT_SHARED_STATE_PATH, options.timeout, options.maxBuffer]);
  let entries = cache.executors.get(exec);
  if (!entries) { entries = new Map(); cache.executors.set(exec, entries); }
  let entry = entries.get(key);
  if (!entry || now() - entry.startedAt >= 10_000) {
    entry = { startedAt: now(), promise: Promise.resolve().then(run) };
    entries.set(key, entry);
    entry.promise.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
  }
  return entry.promise;
}
