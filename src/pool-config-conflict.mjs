// Keep conflict diagnostics separate from unreadable declarations. Only the
// contract key is logged; values and source paths may contain private data.
import { PoolConfigConflictError } from './config-token-pool-migration.mjs';

export { PoolConfigConflictError };

const warnedKeys = new Set();

export function warnPoolConfigConflict(error, log) {
  if (!(error instanceof PoolConfigConflictError)) return false;
  if (!warnedKeys.has(error.key)) {
    warnedKeys.add(error.key);
    log.warn?.(`[agy-identities] pool-config-conflict: ${error.key}; inspect migration report`);
  }
  return true;
}
