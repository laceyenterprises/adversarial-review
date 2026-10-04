import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { assertAlertSinkOwner, resolveAlertTransportDefaults } from '../alert-delivery.mjs';

// Check before opening SQLite: even opening it can create WAL/SHM sidecars.
export function assertFindingDisputeOwner(rootDir, {
  env = process.env,
  existsSyncImpl = existsSync,
  statSyncImpl = statSync,
  geteuidImpl = typeof process.geteuid === 'function' ? () => process.geteuid() : null,
} = {}) {
  if (!geteuidImpl) throw new Error('finding dispute requires an OS effective uid ownership check');
  const uid = geteuidImpl();
  const dbPath = join(rootDir, 'data', 'reviews.db');
  for (const path of [join(rootDir, 'data'), dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (path !== dbPath && !existsSyncImpl(path)) continue;
    const stat = statSyncImpl(path); // The daemon database must already exist.
    if (stat.uid !== uid) {
      throw new Error(`Finding dispute state ${path} is owned by uid ${stat.uid}; refusing cross-user write as uid ${uid}. Run as the canonical daemon owner.`);
    }
  }
  const alertRoot = resolveAlertTransportDefaults(env).rootDir;
  assertAlertSinkOwner(alertRoot, { existsSyncImpl, statSyncImpl, geteuidImpl });
}
