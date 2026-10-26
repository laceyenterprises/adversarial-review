import fsExt from 'fs-ext';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, realpathSync, utimesSync, watch } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveLaneKey, QUEUE_ACTIONABLE_PHASES } from './ledger-events.mjs';
import { assertQueueStoreOwner, queueId, queueTime } from './queue-store.mjs';
import { queueWaitMs } from './queue-wait.mjs';

/** Single-host issuance adapter. Lock inodes are persistent and never unlinked.
 * Acquiring a DB lease without this lock is insufficient to authorize a write.
 * The lock spans intent, adapter invocation AND drain/result persistence.
 */
export function resolveQueueOwnerAdapter({ rootDir, db }) {
  assertQueueStoreOwner(rootDir);
  const root = realpathSync(rootDir);
  if (resolve(db.name) !== join(root, 'data', 'reviews.db')) throw new Error('queue lock and DB root mismatch');
  if (typeof fsExt.flockSync !== 'function') throw new Error('queue owner locking unavailable');
  const lockPath = lane => {
    const key = createHash('sha256').update(JSON.stringify(resolveLaneKey(lane))).digest('hex');
    const dir = join(root, 'data', 'finalization-queue-locks');
    mkdirSync(dir, { recursive: true });
    return join(dir, key + '.lock');
  };
  const adapter = {
    name: 'single-host-flock-v1',
    tryLock(lane) {
      const path = lockPath(lane);
      const fd = openSync(path, 'a', 0o600);
      try { fsExt.flockSync(fd, 'exnb'); }
      catch (error) {
        closeSync(fd);
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return null;
        throw error;
      }
      return () => {
        closeSync(fd);
        // Like the merge-lease directory wake, this is only an acquisition
        // hint. Notify AFTER unlocking; the persistent inode is never replaced.
        try { const at = new Date(); utimesSync(path, at, at); } catch { /* deadline remains the fallback */ }
      };
    },
    async waitForLock(lane, { deadline, now = () => new Date().toISOString() }) {
      const remaining = Date.parse(deadline) - Date.parse(now());
      if (!Number.isFinite(remaining)) throw new TypeError('invalid lane wait deadline');
      if (remaining <= 0) return null;
      const path = lockPath(lane);
      return new Promise((resolve, reject) => {
        let watcher, timer, settled = false;
        const finish = (release, error) => {
          if (settled) { release?.(); return; }
          settled = true;
          clearTimeout(timer);
          watcher?.close();
          if (error) reject(error); else resolve(release);
        };
        const started = performance.now();
        const acquire = () => {
          if (settled) return;
          if (performance.now() - started >= remaining || Date.parse(now()) >= Date.parse(deadline)) return finish(null);
          try {
            const release = adapter.tryLock(lane);
            if (release) finish(release);
          } catch (error) { finish(null, error); }
        };
        timer = setTimeout(() => finish(null), Math.min(remaining, 2 ** 31 - 1));
        try {
          // Register before rechecking the CAS, so release cannot be lost
          // between the initial refusal and subscription. No polling sleeps.
          watcher = watch(dirname(path), (_event, filename) => {
            if (filename == null || String(filename) === basename(path) || String(filename) === basename(dirname(path))) acquire();
          });
          watcher.on('error', () => watcher.close());
        } catch { /* An unavailable wake waits only for the caller's deadline. */ }
        acquire();
      });
    },
  };
  return adapter;
}

const args = lane => Object.values(resolveLaneKey(lane));
function validResult(result) {
  return result && ['succeeded','not-applied'].includes(result.outcome)
    && typeof result.sourceRef === 'string' && result.sourceRef.length > 0;
}

/** This seam is inert until explicitly composed by a later executor slice.
 * Remote adapters must settle only after all subprocesses/requests have drained.
 * A rejected/unknown result leaves the durable intent unresolved. Recovery must
 * stop AND drain the prior execution tree and authoritatively observe every
 * operation before returning { quiescent:true, sourceRef, results:{id:result} }.
 * Missing recovery evidence parks the lane; expiry alone never clears intent.
 */
export function createQueueOwner({ store, now = () => new Date().toISOString(), recoveryAdapter = null } = {}) {
  const adapter = resolveQueueOwnerAdapter({ rootDir: store.rootDir, db: store.db });
  const db = store.db;
  async function locked(lane, action) {
    lane = resolveLaneKey(lane);
    const release = adapter.tryLock(lane);
    if (!release) return { ok: false, reason: 'owner-operation-in-flight' };
    try { return await action(lane); } finally { release(); }
  }
  const park = (lane, at, reason) => store.tx(() => {
    const prior = store.readOwner(lane);
    if (prior.owner_state === 'parked' && prior.reason === reason) return { ok: false, reason };
    db.prepare("UPDATE finalization_queue_lane SET owner_state='parked',reason=? WHERE repository=? AND base=?").run(reason, ...args(lane));
    store.append('owner-parked', lane, { at, owner: store.readOwner(lane) });
    return { ok: false, reason };
  });
  function settle(lane, operation, result, at) {
    if (!validResult(result)) throw new Error('unproven queue operation outcome');
    db.prepare('UPDATE finalization_queue_operation SET result_json=? WHERE operation_id=? AND result_json IS NULL')
      .run(JSON.stringify(result), operation.operation_id);
    store.append('operation-result', lane, { at, operationId: operation.operation_id, result });
  }
  return {
    adapterName: adapter.name,
    async claim({ lane, ownerId, expiresAt, routeGeneration = 0 }) {
      queueId(ownerId); expiresAt = queueTime(expiresAt);
      if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 0) throw new TypeError('invalid route generation');
      return locked(lane, async lane => {
        let at = queueTime(now());
        if (Date.parse(expiresAt) <= Date.parse(at)) throw new TypeError('owner expiry must be in the future');
        store.tx(() => store.ensureLane(lane));
        const route = db.prepare('SELECT executor,transition_json FROM finalization_queue_route WHERE repository=? AND base=?').get(...args(lane));
        if (!route || route.executor !== 'queue-v2' || route.transition_json !== null) return { ok: false, reason: 'queue-route-not-owned' };
        const prior = store.readOwner(lane);
        if (prior.route_generation !== routeGeneration) return { ok: false, reason: 'route-generation-mismatch' };
        if (prior.owner_state === 'active' && Date.parse(prior.expires_at) > Date.parse(at)) return { ok: false, reason: 'held' };
        const pending = store.operations(lane);
        let evidence;
        if (pending.length) {
          try {
            evidence = await recoveryAdapter?.stopDrainAndReconcile?.({ lane, prior, timeoutMs: queueWaitMs(30_000, { ceilingMs: 60_000 }), operations: pending.map(op => ({
              ...op, intent: JSON.parse(op.intent_json),
            })) });
          } catch { /* Unknown quiescence must stay parked. */ }
          at = queueTime(now());
          if (evidence?.quiescent !== true || !evidence?.sourceRef
            || pending.some(op => !validResult(evidence.results?.[op.operation_id]))) {
            return park(lane, at, 'prior-operation-quiescence-unproven');
          }
        } else if (prior.owner_state === 'parked') return { ok: false, reason: prior.reason };
        if (Date.parse(expiresAt) <= Date.parse(at)) return { ok: false, reason: 'claim-deadline-expired' };
        return store.tx(() => {
          // The issuance lock spans all await boundaries and every claimant.
          const row = store.readOwner(lane);
          if (row.generation !== prior.generation || row.route_generation !== routeGeneration) throw new Error('queue ownership moved');
          if (!Number.isSafeInteger(row.generation + 1)) throw new Error('queue generation exhausted');
          // Results and successor generation commit together, including recovery
          // from parked state. A crash cannot strand a reconciled parked owner.
          for (const op of pending) settle(lane, op, { ...evidence.results[op.operation_id], drainSourceRef: evidence.sourceRef }, at);
          db.prepare(`UPDATE finalization_queue_lane SET generation=generation+1, owner_id=?, owner_state='active',
            acquired_at=?, heartbeat_at=?, expires_at=?, reason=NULL WHERE repository=? AND base=?`)
            .run(ownerId, at, at, expiresAt, ...args(lane));
          const owner = store.readOwner(lane);
          store.append('owner-claimed', lane, { at, owner });
          return { ok: true, fence: { lane, ownerId, generation: owner.generation, routeGeneration }, owner };
        });
      });
    },
    renew({ fence, expiresAt }) {
      expiresAt = queueTime(expiresAt);
      return locked(fence.lane, lane => store.tx(() => {
        const at = queueTime(now()); store.assertFence(fence, at);
        if (Date.parse(expiresAt) <= Date.parse(at)) throw new TypeError('invalid owner expiry');
        db.prepare('UPDATE finalization_queue_lane SET heartbeat_at=?,expires_at=? WHERE repository=? AND base=?').run(at, expiresAt, ...args(lane));
        store.append('owner-renewed', lane, { at, owner: store.readOwner(lane) });
        return { ok: true };
      }));
    },
    release({ fence }) {
      return locked(fence.lane, lane => store.tx(() => {
        const at = queueTime(now()); store.assertFence(fence, at);
        if (store.operations(lane).length) throw new Error('unreconciled queue operation');
        db.prepare("UPDATE finalization_queue_lane SET owner_state='idle',owner_id=NULL WHERE repository=? AND base=?").run(...args(lane));
        store.append('owner-released', lane, { at, owner: store.readOwner(lane) });
        return { ok: true };
      }));
    },
    async issue({ fence, entryId, operationId, kind, invoke }) {
      queueId(operationId);
      if (!['push','merge'].includes(kind) || typeof invoke !== 'function') throw new TypeError('invalid mutation adapter');
      return locked(fence.lane, async lane => {
        const at = queueTime(now());
        const prepared = store.tx(() => {
          store.assertFence(fence, at);
          const existing = db.prepare('SELECT * FROM finalization_queue_operation WHERE operation_id=?').get(operationId);
          if (existing) {
            if (existing.entry_id !== entryId || existing.kind !== kind || existing.repository !== lane.repository || existing.base !== lane.base) throw new Error('conflicting operation identity');
            const entry = store.readEntry(entryId);
            const intent = JSON.parse(existing.intent_json);
            if (!entry || intent.candidate !== entry.candidate || intent.exactBase !== entry.exactBase
              || intent.expectedOldHead !== entry.expectedOldHead || intent.fence.routeGeneration !== fence.routeGeneration) {
              throw new Error('operation intent currency changed');
            }
            return { row: existing, fresh: false };
          }
          if (store.operations(lane).length) throw new Error('unreconciled queue operation');
          const entry = store.readEntry(entryId);
          if (!entry || store.entries(lane).find(e => QUEUE_ACTIONABLE_PHASES.includes(e.phase))?.entryId !== entryId
            || entry.phase !== (kind === 'push' ? 'publishing' : 'finalizing')
            || !entry.candidate || !entry.exactBase || !entry.expectedOldHead) throw new Error('invalid mutation phase/candidate');
          const timeoutMs = queueWaitMs(30_000, { ceilingMs: 60_000, deadline: entry.patience.deadline, now: at });
          if (!timeoutMs) throw new Error('queue infrastructure deadline expired');
          const intent = { operationId, kind, entryId, fence, at, candidate: entry.candidate,
            expectedOldHead: entry.expectedOldHead, exactBase: entry.exactBase,
            deadline: entry.patience.deadline, timeoutMs };
          db.prepare('INSERT INTO finalization_queue_operation VALUES (?,?,?,?,?,?,?,?,NULL)')
            .run(operationId, ...args(lane), entryId, fence.generation, fence.routeGeneration, kind, JSON.stringify(intent));
          store.append('operation-intent', lane, { at, operation: intent });
          return { row: db.prepare('SELECT * FROM finalization_queue_operation WHERE operation_id=?').get(operationId), fresh: true };
        });
        const operation = prepared.row;
        if (operation.result_json) return { ok: true, replay: true, result: JSON.parse(operation.result_json) };
        // An existing intent may already have reached the remote. Reconcile it,
        // never invoke it again, even when a response was lost before persistence.
        const intent = JSON.parse(operation.intent_json);
        if (!prepared.fresh) throw new Error('operation requires reconciliation');
        // Never infer freshness from the timestamp: only a newly inserted intent
        // may issue. The invocation below is still within the same issuance lock.
        const result = await invoke(intent);
        store.tx(() => {
          store.assertFence(fence, queueTime(now()));
          settle(lane, operation, result, queueTime(now()));
        });
        return { ok: true, result };
      });
    },
  };
}
