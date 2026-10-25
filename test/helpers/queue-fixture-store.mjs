// Explicit queue ownership for the pre-routing queue-service fixtures. Runtime
// stores never infer queue execution from a claim or a schema migration.
import { openFinalizationQueueStore as openStore } from '../../src/finalization/queue-store.mjs';
export function openFinalizationQueueStore(options) {
  const store = openStore(options), ensureLane = store.ensureLane;
  store.ensureLane = lane => {
    ensureLane(lane);
    store.db.prepare(`INSERT INTO finalization_queue_route VALUES (?,?,'queue-v2','fixture',NULL,NULL,?) ON CONFLICT DO NOTHING`)
      .run(lane.repository.toLowerCase(), lane.base, '2026-10-23T00:00:00Z');
  };
  return store;
}
