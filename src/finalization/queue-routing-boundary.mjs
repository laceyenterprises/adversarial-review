import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { resolveLaneRoute, createLaneRoutingController } from './queue-routing.mjs';
import { openFinalizationQueueStore } from './queue-store.mjs';
import { QUEUE_RUNNING_BUILD } from './queue-build.mjs';

const runtime = { build: QUEUE_RUNNING_BUILD, pid: process.pid, loadedAt: new Date().toISOString() };

// Minimal frozen-v1 boundary. Unmigrated installations retain their legacy
// behavior. Once a lane has a durable route, cached legacy config cannot bypass
// it, including when the selector is removed during rollback.
export async function routeFinalizationWriter({ rootDir, cfg, lane, kind, subject = null, legacy, queue }) {
  if (!lane?.repository || !lane?.base) {
    if (cfg?.laneRoutes?.length) return { ok: false, taken: false, dispatched: false, skipMergeAgent: true, reason: 'lane-identity-unavailable' };
    return legacy();
  }
  resolveLaneRoute(cfg, lane);
  const store = openFinalizationQueueStore({ rootDir });
  try {
    const result = await createLaneRoutingController({ store, runtime }).run({ cfg, lane, kind, subject, legacy, queue });
    return result?.ok === false ? { ...result, taken: false, dispatched: false, skipMergeAgent: true } : result;
  } finally { store.close(); }
}

// Subject-level v2 executor composition. A trusted live reader supplies the base;
// never infer main from a PR number or grant a per-subject route override.
export function createFinalizationLaneRouting({ rootDir, readLane, admitQueue,
  readConfig = loadEffectiveMergeAuthorityConfig, now = () => new Date().toISOString(), load } = {}) {
  if (typeof readLane !== 'function') throw new Error('live lane reader required');
  return { async run({ subject, revisionRef, legacy, deadline }) {
    const cfg = readConfig({ rootDir });
    const lane = await readQueueEvidence({ read: readLane }, { subject, revisionRef },
      queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: now(), load }));
    resolveLaneRoute(cfg, lane);
    return routeFinalizationWriter({ rootDir, cfg, lane, kind: 'daemon', subject: { ...subject, revisionRef }, legacy,
      queue: typeof admitQueue === 'function' ? async route => {
        if (!queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: now(), load })) throw new Error('queue admission deadline expired');
        const acknowledgement = await admitQueue({ subject, revisionRef, route, deadline });
        const ack = acknowledgement?.ack ?? acknowledgement;
        if (!ack?.entryId || !ack?.ackId || ack.head !== revisionRef
          || ack.lane?.repository !== route.lane.repository || ack.lane?.base !== route.lane.base
          || subject?.subjectExternalId?.toLowerCase() !== `${route.lane.repository}#${ack.prNumber}`) throw new Error('queue admission acknowledgement unavailable or foreign');
        return { ok: true, queued: true, reason: 'queue-handoff-acknowledged', acknowledgement };
      } : undefined });
  } };
}
