import { randomUUID } from 'node:crypto';
import { isMergeDisabledForRepository } from '../merge-disabled-repositories.mjs';
import { withRepositoryStateCycle } from '../repository-state-lock.mjs';
import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { createQueueAdmissionService } from './queue-admission.mjs';
import { createQueueChecksService } from './queue-checks.mjs';
import { createQueueMergeService } from './queue-merge.mjs';
import { createQueueOwner } from './queue-owner.mjs';
import { createQueueRebaseService } from './queue-rebase.mjs';
import { resolveLaneRoute, resolveQueueRoutingStore } from './queue-routing.mjs';
import { openFinalizationQueueStore } from './queue-store.mjs';

function ownedRoute(store, route) {
  const { route: durable, legacyWriters } = resolveQueueRoutingStore(store).read(route.lane);
  return durable?.executor === 'queue-v2' && !durable.transition && !legacyWriters.length ? durable : null;
}

/** The watcher owns scheduling. A tick only advances persisted work on lanes
 * for which BOTH the selector and durable route name the queue. Every phase
 * uses the existing owner/issuance fence. Unknown remote work stays pending. */
export function createQueueConsumer({ rootDir, compose, readConfig = loadEffectiveMergeAuthorityConfig,
  openStore = openFinalizationQueueStore, now = () => new Date().toISOString(), logger = console } = {}) {
  let running = false;
  const ownerId = `watcher:${randomUUID()}`;

  async function advance(store, route, cfg) {
    const durable = ownedRoute(store, route);
    if (!durable) return;
    const { lane } = route;
    const adapters = compose({ store, cfg, now });
    const owner = createQueueOwner({ store, now, recoveryAdapter: adapters.recoveryAdapter });
    const policy = {
      get autonomousExecutionDisabled() {
        try {
          const latest = readConfig({ rootDir });
          const current = resolveLaneRoute(latest, lane);
          return current.executor !== 'queue-v2' || !current.autonomousExecutionEnabled
            || isMergeDisabledForRepository(latest, lane.repository);
        } catch { return true; }
      },
    };
    const inputs = { ...adapters, store, owner, policy, now };
    const admission = createQueueAdmissionService(inputs);
    const rebase = createQueueRebaseService(inputs);
    const checks = createQueueChecksService(inputs);
    const merge = createQueueMergeService(inputs);

    if (policy.autonomousExecutionDisabled || store.executionHold()) return;

    // Delivery is independent of merge issuance and idempotent at its sinks.
    const pending = store.db.prepare(`SELECT e.entry_id FROM finalization_queue_delivery d
      JOIN finalization_queue_entry e USING(entry_id)
      WHERE e.repository=? AND e.base=? AND d.receipt_json IS NULL ORDER BY d.attempts,d.rowid LIMIT 1`)
      .get(lane.repository, lane.base);
    if (pending) await merge.deliver({ entryId: pending.entry_id });
    const page = store.db.prepare(`SELECT p.entry_id FROM finalization_queue_check_page p
      JOIN finalization_queue_entry e USING(entry_id)
      WHERE e.repository=? AND e.base=? AND p.receipt_json IS NULL ORDER BY p.rowid LIMIT 1`)
      .get(lane.repository, lane.base);
    if (page) await checks.flushPages(page.entry_id);

    if (policy.autonomousExecutionDisabled || store.executionHold()) return;
    const order = admission.order(lane);
    const due = order.parked.find(entry => entry.infrastructure?.nextProbeAt
      ? Date.parse(entry.infrastructure.nextProbeAt) <= Date.parse(now())
      : Date.parse(entry.patience.deadline) > Date.parse(now()));
    if (!order.actionable.length && !due && !store.operations(lane).length) return;
    async function processEntry(select, maxSteps) {
      const claim = await owner.claim({ lane, ownerId, routeGeneration: durable.route_generation,
        expiresAt: new Date(Date.parse(now()) + 300_000).toISOString() });
      if (!claim.ok) return;
      const { fence } = claim;
      const stillOwned = () => {
        const current = store.readOwner(lane);
        return current?.owner_state === 'active' && current.owner_id === ownerId
          && current.generation === fence.generation && current.route_generation === fence.routeGeneration
          && Date.parse(current.expires_at) > Date.parse(now()) && !store.operations(lane).length;
      };
      try {
        // Read FIFO after claiming: another process may have advanced the lane.
        let entry = select();
        for (let step = 0; step < maxSteps && entry && stillOwned(); step++) {
          if (policy.autonomousExecutionDisabled || store.executionHold()) return;
          const args = { fence, entryId: entry.entryId };
          let result;
          switch (entry.phase) {
            case 'acknowledged': result = await admission.reconcile(args); break;
            case 'ready':
              result = entry.infrastructure?.recovered ? await checks.poll(args) : await rebase.run(args);
              break;
            case 'rebasing':
            case 'publishing': result = await rebase.run(args); break;
            case 'waiting-checks': result = await checks.poll(args); break;
            case 'finalizing': result = await merge.finalize(args); break;
            default:
              if (entry.phase.startsWith('parked-')) {
                result = entry.infrastructure ? await checks.reprobe(args) : await admission.reconcile(args);
              }
          }
          if (result?.phase === 'returned-to-closer') await adapters.returnSubject?.(result);
          // Wait for the next wake when a phase has no new action. A final
          // reread that sends us back to checks also yields to the next tick.
          if (!result || result.phase === entry.phase || (entry.phase === 'finalizing' && result.phase === 'waiting-checks')
            || result.phase.startsWith('parked-')) break;
          entry = result;
        }
      } finally {
        if (stillOwned()) await owner.release({ fence });
      }
    }
    if (due) await processEntry(() => store.readEntry(due.entryId), 1);
    await processEntry(() => admission.order(lane).actionable[0], 6);
  }

  return { async tick() {
    if (running) return;
    running = true;
    try {
      const cfg = readConfig({ rootDir });
      const routes = (cfg.laneRoutes ?? []).filter(route => route.executor === 'queue-v2')
        .map(route => resolveLaneRoute(cfg, route)).filter(route => route.autonomousExecutionEnabled
          && !isMergeDisabledForRepository(cfg, route.lane.repository));
      if (!routes.length) return;
      const store = openStore({ rootDir });
      try {
        for (const route of routes) {
          try { await withRepositoryStateCycle(rootDir, () => advance(store, route, cfg)); }
          catch (error) {
            const reason = /^[a-z-]{1,100}$/.test(error.message) ? error.message : error.name;
            logger.warn(`[finalization-queue] ${route.lane.repository}/${route.lane.base}: ${reason}`);
          }
        }
      } finally { store.close(); }
    } finally { running = false; }
  } };
}
