// Frozen actors consume MGQ-08 ownership; they do not implement a second route.
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareQueueCloserDispatch } from './queue-closer.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

export async function prepareLegacyActor({ rootDir, repo, base, prNumber, head, cfg = {} }) {
  try {
    if (!base) {
      // Old callers may omit base only on an installation with no migrated lane.
      // A durable route survives selector removal and makes that omission unsafe.
      if (cfg.laneRoutes?.length) return { ok: false, reason: 'lane-identity-unavailable' };
      const path = join(rootDir, 'data/reviews.db');
      if (existsSync(path)) {
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
          db.pragma(`busy_timeout = ${loadAwareTimeoutMs(1000, { maxMs: 5000 })}`);
          const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finalization_queue_route'").get();
          if (installed && db.prepare('SELECT 1 FROM finalization_queue_route WHERE repository=? LIMIT 1').get(repo.toLowerCase())) {
            return { ok: false, reason: 'lane-identity-unavailable' };
          }
        } finally { db.close(); }
      }
      return { ok: true, executor: 'legacy' };
    }
    const result = await prepareQueueCloserDispatch({ rootDir, cfg, lane: { repository: repo, base }, prNumber, head });
    return result.executor === 'legacy' ? { ok: true, executor: 'legacy' }
      : { ok: false, queued: result.queued === true, reason: result.reason || 'queue-v2-owns-lane' };
  } catch { return { ok: false, reason: 'lane-routing-evidence-unavailable' }; }
}
