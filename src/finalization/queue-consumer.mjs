import { randomUUID } from 'node:crypto';
import { isMergeDisabledForRepository } from '../merge-disabled-repositories.mjs';
import { withRepositoryStateRead } from '../repository-state-lock.mjs';
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

function nextParkedWake(entry) {
  if (entry.phase === 'parked-infrastructure' && entry.infrastructure?.nextProbeAt) {
    return Date.parse(entry.infrastructure.nextProbeAt);
  }
  return Math.min(Date.parse(entry.updatedAt) + 60_000, Date.parse(entry.patience.deadline));
}

/** The watcher owns scheduling. A tick only advances persisted work on lanes
 * for which BOTH the selector and durable route name the queue. Every phase
 * uses the existing owner/issuance fence. Unknown remote work stays pending. */
export function createQueueConsumer({ rootDir, compose, readConfig = loadEffectiveMergeAuthorityConfig,
  openStore = openFinalizationQueueStore, now = () => new Date().toISOString(), logger = console,
  stallWarningMs = 180_000 } = {}) {
  let startedAt = null;
  let warned = false;
  const ownerId = `watcher:${randomUUID()}`;

  async function advance(store, route, cfg) {
    const durable = withRepositoryStateRead(rootDir, () => ownedRoute(store, route));
    if (!durable) return;
    const { lane } = route;
    const adapters = compose({ store, cfg, now, ownerId });
    const owner = createQueueOwner({ store, now, recoveryAdapter: adapters.recoveryAdapter });
    const policy = {
      get autonomousExecutionDisabled() {
        try {
          const latest = readConfig({ rootDir });
          const current = resolveLaneRoute(latest, lane);
          return latest.enabled !== true || current.executor !== 'queue-v2' || !current.autonomousExecutionEnabled
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
    function selectParked(parked = admission.order(lane).parked) {
      const at = Date.parse(now());
      return parked
        .map(entry => ({ entry, wake: nextParkedWake(entry) }))
        .filter(({ wake }) => wake <= at)
        .sort((a, b) => a.wake - b.wake)[0]?.entry;
    }
    const selectActionable = () => admission.order(lane).actionable[0];
    async function processEntry(select, maxSteps) {
      const claim = await owner.claim({ lane, ownerId, routeGeneration: durable.route_generation,
        expiresAt: new Date(Date.parse(now()) + 300_000).toISOString() });
      if (!claim.ok) return;
      const { fence } = claim;
      const stillOwned = () => {
        const current = store.readOwner(lane);
        return current?.owner_state === 'active' && current.owner_id === ownerId
          && current.generation === fence.generation && current.route_generation === fence.routeGeneration
          && Date.parse(current.expires_at) > Date.parse(now());
      };
      try {
        // Read FIFO after claiming: another process may have advanced the lane.
        let entry = select();
        for (let step = 0; step < maxSteps && entry && stillOwned(); step++) {
          if (policy.autonomousExecutionDisabled || store.executionHold() || store.operations(lane).length) return;
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
                result = entry.phase === 'parked-infrastructure' && entry.infrastructure?.nextProbeAt
                  ? await checks.reprobe(args) : await admission.reconcile(args);
              }
          }
          if (result?.phase === 'returned-to-closer') await adapters.returnSubject?.(result);
          if (result?.phase === 'returned-to-closer') break;
          // Wait for the next wake when a phase has no new action. A final
          // reread that sends us back to checks also yields to the next tick.
          if (!result || result.phase === entry.phase || (entry.phase === 'finalizing' && result.phase === 'waiting-checks')
            || result.phase.startsWith('parked-')) break;
          entry = result;
        }
      } finally {
        if (stillOwned()) await owner.release({ fence, parkPending: true });
      }
    }
    const order = withRepositoryStateRead(rootDir, () => admission.order(lane));
    const due = selectParked(order.parked);
    if (due) await processEntry(selectParked, 1);
    if ((due ? selectActionable() : order.actionable[0]) || store.operations(lane).length) {
      await processEntry(selectActionable, 6);
    }
  }

  return { async tick() {
    if (startedAt !== null) {
      if (!warned && Date.parse(now()) - startedAt >= stallWarningMs) {
        warned = true;
        logger.warn('[finalization-queue] prior tick is still running beyond its stall threshold');
      }
      return;
    }
    startedAt = Date.parse(now());
    warned = false;
    try {
      const cfg = readConfig({ rootDir });
      if (cfg.enabled !== true) return;
      const routes = (cfg.laneRoutes ?? []).filter(route => route.executor === 'queue-v2')
        .map(({ repository, base }) => resolveLaneRoute(cfg, { repository, base }))
        .filter(route => route.autonomousExecutionEnabled
          && !isMergeDisabledForRepository(cfg, route.lane.repository));
      if (!routes.length) return;
      const store = withRepositoryStateRead(rootDir, () => openStore({ rootDir }));
      try {
        for (const route of routes) {
          try { await advance(store, route, cfg); }
          catch (error) {
            const reason = /^[a-z-]{1,100}$/.test(error.message) ? error.message : error.name;
            logger.warn(`[finalization-queue] ${route.lane.repository}/${route.lane.base}: ${reason}`);
          }
        }
      } finally { store.close(); }
    } finally { startedAt = null; }
  } };
}
