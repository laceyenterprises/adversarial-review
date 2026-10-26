// Keep conflict diagnostics separate from unreadable declarations. Only the
// contract key is logged; values and source paths may contain private data.
import { PoolConfigConflictError } from './config-token-pool-migration.mjs';

export { PoolConfigConflictError };

const warnedKeys = new Set();

export function warnPoolConfigConflict(error, log) {
  if (!(error instanceof PoolConfigConflictError)) return false;
  for (const key of error.keys) {
    if (warnedKeys.has(key)) continue;
    warnedKeys.add(key);
    log.warn?.(`[agy-identities] pool-config-conflict: ${key}; inspect migration report`);
  }
  return true;
}

// Explicit test/reload boundary; ordinary daemon reads retain process deduplication.
export function resetPoolConfigConflictWarnings() {
  warnedKeys.clear();
}
