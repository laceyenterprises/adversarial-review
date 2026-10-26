// Whole-lane migration boundary. The issuance lock is shared with queue-owner;
// no expiry or cached selector can confer ownership across a transfer.
import { createHash, randomUUID } from 'node:crypto';
import { resolveLaneExecutor, normalizeLaneRoutes } from '../config-lane-routes.mjs';
import { resolveLaneKey } from './ledger-events.mjs';
import { handoffDigest, handoffJson } from './queue-handoff.mjs';
import { resolveQueueOwnerAdapter } from './queue-owner.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { queueTime } from './queue-store.mjs';

const digest = value => 'sha256:' + createHash('sha256').update(handoffJson(value)).digest('hex');
export function resolveLaneRoute(cfg, lane) {
  lane = resolveLaneKey(lane);
  const routes = normalizeLaneRoutes(cfg?.laneRoutes ?? []);
  return { lane, executor: resolveLaneExecutor(routes, lane), configGeneration: digest(JSON.parse(JSON.stringify({ ...cfg, laneRoutes: routes }))),
    autonomousExecutionEnabled: cfg?.autonomousMergeExecutionEnabled !== false && cfg?.autonomous_merge_execution_enabled !== false };
}
const terminal = e => ['merged', 'closed-observed', 'returned-to-closer'].includes(e.phase);
const proven = result => result && ['succeeded', 'not-applied'].includes(result.outcome)
  && typeof result.sourceRef === 'string' && result.sourceRef.length > 0;

// Also resolved by read-only status/probe. Preparing the actual statements
// verifies store capabilities without schema convergence or lock creation.
export function resolveQueueRoutingStore({ db }) {
  const route = db.prepare(`SELECT r.*,l.route_generation,l.owner_id,l.generation AS fence,l.owner_state
    FROM finalization_queue_route r JOIN finalization_queue_lane l USING(repository,base)
    WHERE repository=? AND base=?`);
  const writers = db.prepare(`SELECT * FROM finalization_queue_legacy_writer
    WHERE repository=? AND base=? AND result_json IS NULL ORDER BY writer_id`);
  const returns = db.prepare(`SELECT r.* FROM finalization_queue_route_return r
    JOIN finalization_queue_entry e USING(entry_id) WHERE e.repository=? AND e.base=? AND r.receipt_json IS NULL ORDER BY r.entry_id`);
  return { name: 'app-store-lane-routing-v1', read(lane) {
    lane = resolveLaneKey(lane);
    const row = route.get(lane.repository, lane.base);
    return { route: row ? { ...row, runtime: row.runtime_json ? JSON.parse(row.runtime_json) : null,
      transition: row.transition_json ? JSON.parse(row.transition_json) : null } : null,
    legacyWriters: writers.all(lane.repository, lane.base),
    pendingReturns: returns.all(lane.repository, lane.base).map(r => ({ ...r, payload: JSON.parse(r.payload_json) })) };
  } };
}

export function createLaneRoutingController({ store, now = () => new Date().toISOString(), runtime = null } = {}) {
  const db = store.db, reader = resolveQueueRoutingStore(store);
  const ownerAdapter = resolveQueueOwnerAdapter({ rootDir: store.rootDir, db });
  const args = lane => [lane.repository, lane.base];
  const initialize = route => store.tx(() => {
    store.ensureLane(route.lane);
    db.prepare(`INSERT INTO finalization_queue_route VALUES (?,?,'legacy',?,NULL,NULL,?) ON CONFLICT DO NOTHING`)
      .run(...args(route.lane), route.configGeneration, queueTime(now()));
  });
  async function locked(lane, action, legacyDeadline) {
    lane = resolveLaneKey(lane);
    const started = performance.now();
    let release = ownerAdapter.tryLock(lane);
    if (!release && legacyDeadline) release = await ownerAdapter.waitForLock(lane, { deadline: legacyDeadline, now });
    if (!release) return { ok: false, reason: 'owner-operation-in-flight',
      ...(legacyDeadline ? { outcome: 'lane-busy', waitedMs: Math.round(performance.now() - started) } : {}) };
    try { return await action(lane); } finally { release(); }
  }
  return {
    adapterName: reader.name, read: reader.read,
    // This is the sole writer-route decision for both legacy invocation paths.
    async run({ cfg, lane, kind, subject = null, legacy, queue, legacyDeadline }) {
      const desired = resolveLaneRoute(cfg, lane);
      if (!desired.autonomousExecutionEnabled) return { ok: false, reason: 'autonomous-merge-execution-disabled' };
      return locked(desired.lane, async lane => {
        initialize(desired);
        const { route, legacyWriters } = reader.read(lane);
        if (route.transition || route.executor !== desired.executor) return { ok: false, reason: 'lane-transfer-required', route };
        if ((route.executor === 'queue-v2' && legacyWriters.length) || store.operations(lane).length) return { ok: false, reason: 'lane-reconciliation-required' };
        db.prepare('UPDATE finalization_queue_route SET config_generation=?,runtime_json=?,updated_at=? WHERE repository=? AND base=?')
          .run(desired.configGeneration, runtime ? JSON.stringify(runtime) : null, queueTime(now()), ...args(lane));
        const selected = route.executor === 'legacy' ? legacy : queue;
        if (typeof selected !== 'function') return { ok: false, reason: 'queue-composition-unavailable' };
        // Queue admission does not issue mutations. Its owner later rechecks the
        // persisted route/fence under this same lock for every push and merge.
        if (route.executor === 'queue-v2') return selected({ ...desired, routeGeneration: route.route_generation });
        if (!['daemon', 'closer'].includes(kind)) throw new Error('invalid legacy writer kind');
        const id = randomUUID(), intent = { lane, kind, subject, runtime, at: queueTime(now()), routeGeneration: route.route_generation };
        db.prepare('INSERT INTO finalization_queue_legacy_writer VALUES (?,?,?,?,?,?,NULL)')
          .run(id, ...args(lane), route.route_generation, kind, JSON.stringify(intent));
        const result = await selected({ ...desired, routeGeneration: route.route_generation });
        // Exceptions retain intent. The external drain adapter must additionally
        // inventory independently running closers and older deployed writers.
        if (!(result?.attempts > 0 && !result.merged && !result.permanent)) {
          db.prepare('UPDATE finalization_queue_legacy_writer SET result_json=? WHERE writer_id=?')
            .run(JSON.stringify({ outcome: 'succeeded', sourceRef: `local-return:${id}` }), id);
        }
        return result;
      }, desired.executor === 'legacy' ? legacyDeadline : undefined);
    },
    async transfer({ cfg, lane, expectedGeneration, drainAdapter, returnAdapter, deadline, load }) {
      const desired = resolveLaneRoute(cfg, lane);
      return locked(desired.lane, async lane => {
        initialize(desired);
        let state = reader.read(lane), prior = state.route;
        if (prior.route_generation !== expectedGeneration) return { ok: false, reason: 'route-generation-mismatch' };
        if (!prior.transition && prior.executor === desired.executor) return { ok: true, replay: true, route: prior };
        if (prior.transition && prior.transition.to !== desired.executor) return { ok: false, reason: 'different-transfer-pending' };
        if (!prior.transition) {
          if (!Number.isSafeInteger(prior.route_generation + 1)) throw new Error('route generation exhausted');
          store.tx(() => {
            const transition = { from: prior.executor, to: desired.executor, startedAt: queueTime(now()) };
            db.prepare('UPDATE finalization_queue_route SET transition_json=?,updated_at=? WHERE repository=? AND base=?')
              .run(JSON.stringify(transition), queueTime(now()), ...args(lane));
            // Invalidate paused queue work before any await. New claims are
            // blocked until both drain and authoritative reconciliation finish.
            db.prepare("UPDATE finalization_queue_lane SET route_generation=route_generation+1,owner_state='parked',reason='route-transfer' WHERE repository=? AND base=?")
              .run(...args(lane));
            store.append('owner-parked', lane, { at: queueTime(now()), owner: store.readOwner(lane) });
          });
        }
        state = reader.read(lane);
        const started = queueTime(now());
        deadline ??= new Date(Date.parse(started) + 60_000).toISOString();
        const wait = () => queueWaitMs(30_000, { ceilingMs: 60_000, deadline, now: queueTime(now()), load });
        const operations = store.operations(lane);
        let evidence;
        try { evidence = await readQueueEvidence(drainAdapter, { lane, prior: state.route,
          legacyWriters: state.legacyWriters, operations }, wait()); } catch { /* keep both routes fenced */ }
        if (evidence?.quiescent !== true || !evidence.sourceRef || !wait()
          || state.legacyWriters.some(w => !proven(evidence.results?.[w.writer_id]))
          || operations.some(op => !proven(evidence.results?.[op.operation_id]))) return { ok: false, reason: 'route-drain-unproven' };
        // Do not settle a successful remote intent until its durable outcome
        // (including merge receipt) has been materialized by reconciliation.
        for (const op of operations) {
          if (evidence.results[op.operation_id].outcome !== 'succeeded') continue;
          const entry = store.readEntry(op.entry_id), intent = JSON.parse(op.intent_json);
          const receiptRow = op.kind === 'merge' && db.prepare('SELECT * FROM finalization_queue_merge_receipt WHERE entry_id=?').get(op.entry_id);
          const receipt = receiptRow ? JSON.parse(receiptRow.receipt_json) : null;
          let receiptValid = false;
          if (receipt) {
            const { digest, ...body } = receipt;
            receiptValid = digest === handoffDigest(body) && digest === receiptRow.receipt_digest
              && receipt.entryId === op.entry_id && receipt.newHead === intent.candidate && receipt.base === intent.exactBase
              && receipt.merge?.operationId === op.operation_id && receipt.merge.mergeSha === receiptRow.merge_sha
              && receiptRow.candidate === intent.candidate && receiptRow.operation_id === op.operation_id
              && entry?.merge?.mergeSha === receipt.merge.mergeSha;
          }
          const reconciled = entry?.candidate === intent.candidate && entry?.exactBase === intent.exactBase
            && (op.kind === 'merge' ? entry?.phase === 'merged' && receiptValid
              : entry?.rebase?.publication?.head === intent.candidate && entry.rebase.publication.base === intent.exactBase
                && !!entry.rebase.publication.sourceRef);
          if (!reconciled) return { ok: false, reason: 'operation-receipt-reconciliation-required' };
        }
        store.tx(() => {
          for (const w of state.legacyWriters) db.prepare('UPDATE finalization_queue_legacy_writer SET result_json=? WHERE writer_id=?')
            .run(JSON.stringify(evidence.results[w.writer_id]), w.writer_id);
          for (const op of operations) {
            const result = evidence.results[op.operation_id];
            db.prepare('UPDATE finalization_queue_operation SET result_json=? WHERE operation_id=?').run(JSON.stringify(result), op.operation_id);
            store.append('operation-result', lane, { at: queueTime(now()), operationId: op.operation_id, result });
          }
          // Reconciliation must materialize successful push/merge outcomes and
          // receipts before transfer. Merely resolving an intent is insufficient.
          if (desired.executor === 'legacy') for (const entry of store.entries(lane).filter(e => !terminal(e))) {
            const key = `route-return:${entry.entryId}`;
            db.prepare('INSERT INTO finalization_queue_route_return VALUES (?,?,?,NULL) ON CONFLICT DO NOTHING')
              .run(entry.entryId, key, JSON.stringify({ lane, entry, deliveryKey: key }));
          }
        });
        for (const row of reader.read(lane).pendingReturns) {
          let receipt;
          try { receipt = await readQueueEvidence(returnAdapter, row.payload, wait()); } catch { /* durable retry key */ }
          if (receipt?.acknowledged !== true || receipt.deliveryKey !== row.delivery_key || !receipt.sourceRef || !wait()) {
            return { ok: false, reason: 'legacy-return-unacknowledged' };
          }
          store.tx(() => {
            db.prepare('UPDATE finalization_queue_route_return SET receipt_json=? WHERE entry_id=?').run(JSON.stringify(receipt), row.entry_id);
            const entry = store.readEntry(row.entry_id);
            if (!terminal(entry)) {
              const at = queueTime(now()), progressVersion = (entry.progressVersion ?? 0) + 1;
              if (!Number.isSafeInteger(progressVersion)) throw new Error('queue progress version exhausted');
              const patch = { phase: 'returned-to-closer', reason: 'route-rollback', updatedAt: at, progressVersion };
              db.prepare('UPDATE finalization_queue_entry SET phase=?,payload_json=? WHERE entry_id=?')
                .run(patch.phase, JSON.stringify({ ...entry, ...patch }), entry.entryId);
              store.append('progress', lane, { at, entryId: entry.entryId, patch, priorPhase: entry.phase,
                generation: store.readOwner(lane).generation, routeGeneration: store.readOwner(lane).route_generation });
            }
          });
        }
        store.tx(() => {
          db.prepare('UPDATE finalization_queue_route SET executor=?,config_generation=?,runtime_json=NULL,transition_json=NULL,updated_at=? WHERE repository=? AND base=?')
            .run(desired.executor, desired.configGeneration, queueTime(now()), ...args(lane));
          db.prepare("UPDATE finalization_queue_lane SET owner_id=NULL,owner_state='idle',reason=NULL WHERE repository=? AND base=?").run(...args(lane));
          store.append('owner-released', lane, { at: queueTime(now()), owner: store.readOwner(lane) });
        });
        return { ok: true, route: reader.read(lane).route };
      });
    },
  };
}
