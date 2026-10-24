import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeQueueEvent, QUEUE_ACTIONABLE_PHASES, QUEUE_PHASES, resolveLaneKey } from './ledger-events.mjs';
import { queuePatience, queueWaitMs } from './queue-wait.mjs';
import { reconcileQueuePublication } from './ledger-fold.mjs';

const migration = new URL('../../migrations/20261023_finalization_queue.sql', import.meta.url);
export function ensureFinalizationQueueSchema(db) {
  db.exec(readFileSync(migration, 'utf8'));
  db.exec(readFileSync(new URL('../../migrations/20261024_finalization_queue_handoff.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../migrations/20261025_finalization_queue_admission.sql', import.meta.url), 'utf8'));
}

export function assertQueueStoreOwner(rootDir) {
  const data = join(rootDir, 'data');
  const uid = process.getuid?.();
  for (const path of [rootDir, data, join(data, 'reviews.db')]) {
    if (existsSync(path) && (!Number.isInteger(uid) || statSync(path).uid !== uid)) {
      throw new Error('refusing cross-user queue store access');
    }
  }
}

export function queueId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,159}$/i.test(value)
    || ['constructor', 'prototype', '__proto__'].includes(value)) throw new TypeError('invalid queue identity');
  return value;
}
export function queueTime(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('invalid queue timestamp');
  return new Date(value).toISOString();
}
const parse = row => row ? JSON.parse(row.payload_json) : null;

/** Not activated by opening: no owner is claimed, no external adapter is called. */
export function openFinalizationQueueStore({ rootDir, db, busyTimeoutMs = 5_000 } = {}) {
  let database = db;
  if (!database) {
    rootDir = realpathSync(resolve(rootDir));
    assertQueueStoreOwner(rootDir);
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    database = new Database(join(rootDir, 'data', 'reviews.db'));
    database.pragma(`busy_timeout = ${queueWaitMs(busyTimeoutMs, { ceilingMs: 30_000 })}`);
  }
  ensureFinalizationQueueSchema(database);
  const tx = fn => database.transaction(fn).immediate();
  const laneArgs = lane => Object.values(resolveLaneKey(lane));
  const readOwner = lane => database.prepare('SELECT * FROM finalization_queue_lane WHERE repository=? AND base=?').get(...laneArgs(lane)) ?? null;
  const ensureLane = lane => database.prepare('INSERT INTO finalization_queue_lane(repository,base) VALUES (?,?) ON CONFLICT DO NOTHING').run(...laneArgs(lane));
  const append = (type, lane, fields) => {
    const event = makeQueueEvent(type, lane, fields);
    const row = database.prepare('INSERT INTO finalization_queue_event(repository,base,event_type,at,payload_json) VALUES (?,?,?,?,?)')
      .run(...laneArgs(lane), type, fields.at, JSON.stringify(event));
    return { ...event, seq: Number(row.lastInsertRowid) };
  };
  const readEntry = id => parse(database.prepare('SELECT payload_json FROM finalization_queue_entry WHERE entry_id=?').get(queueId(id)));
  const entries = lane => database.prepare('SELECT payload_json FROM finalization_queue_entry WHERE repository=? AND base=? ORDER BY readiness_seq,entry_id').all(...laneArgs(lane)).map(parse);
  const assertFence = (fence, now) => {
    const row = readOwner(fence.lane);
    if (!row || row.owner_state !== 'active' || row.owner_id !== fence.ownerId
      || row.generation !== fence.generation || row.route_generation !== fence.routeGeneration
      || !Number.isFinite(Date.parse(row.expires_at))
      || Date.parse(row.expires_at) <= Date.parse(queueTime(now))) throw new Error('stale queue owner fence');
    return row;
  };
  const operations = lane => database.prepare('SELECT * FROM finalization_queue_operation WHERE repository=? AND base=? AND result_json IS NULL').all(...laneArgs(lane));
  const writeEntry = entry => database.prepare('UPDATE finalization_queue_entry SET readiness_seq=?,phase=?,payload_json=? WHERE entry_id=?')
    .run(entry.readinessSeq, entry.phase, JSON.stringify(entry), entry.entryId);

  const store = {
    db: database, rootDir, tx, readOwner, assertFence,
    // Internal transaction primitives used by queue-owner under the issuance lock.
    ensureLane, append, operations,
    readEntry, entries,
    readEvents(lane) {
      return database.prepare('SELECT seq,payload_json FROM finalization_queue_event WHERE repository=? AND base=? ORDER BY seq')
        .all(...laneArgs(lane)).map(row => ({ ...parse(row), seq: row.seq }));
    },
    acknowledge({ lane, entryId, prNumber, head, admissionGeneration, handoffId, ackId, at, load, handoffDigest = null }) {
      lane = resolveLaneKey(lane); at = queueTime(at);
      [entryId, handoffId, ackId].forEach(queueId);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || typeof head !== 'string' || !head
        || !Number.isSafeInteger(admissionGeneration) || admissionGeneration <= 0) throw new TypeError('invalid queue admission');
      return tx(() => {
        ensureLane(lane);
        const existing = database.prepare(`SELECT payload_json FROM finalization_queue_entry
          WHERE repository=? AND base=? AND ((pr_number=? AND admission_head=? AND admission_generation=?) OR handoff_id=? OR ack_id=?)`)
          .all(...laneArgs(lane), prNumber, head, admissionGeneration, handoffId, ackId).map(parse);
        if (existing.length) {
          if (existing.length !== 1 || existing[0].prNumber !== prNumber || existing[0].head !== head
            || existing[0].admissionGeneration !== admissionGeneration || existing[0].handoffId !== handoffId
            || existing[0].ackId !== ackId || (existing[0].handoffDigest ?? null) !== handoffDigest) throw new Error('conflicting queue acknowledgement');
          return existing[0];
        }
        const readinessSeq = database.prepare('UPDATE finalization_queue_lane SET readiness_seq=readiness_seq+1 WHERE repository=? AND base=? RETURNING readiness_seq')
          .get(...laneArgs(lane)).readiness_seq;
        const entry = { lane, entryId, prNumber, head, admissionGeneration, handoffId, ackId, handoffDigest,
          readinessSeq, phase: 'acknowledged', acknowledgedAt: at, updatedAt: at,
          candidate: null, expectedOldHead: head, exactBase: null, reason: null,
          patience: queuePatience(at, load), proof: null, checks: null, decision: null, delivery: null };
        database.prepare(`INSERT INTO finalization_queue_entry VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(entryId, ...laneArgs(lane), prNumber, head, admissionGeneration, handoffId, ackId, readinessSeq, entry.phase, JSON.stringify(entry));
        append('acknowledged', lane, { at, entry });
        return entry;
      });
    },
    progress({ fence, entryId, phase, patch = {}, at, readmit = false, recoveryObservation, expectedEntry }) {
      at = queueTime(at);
      if (!QUEUE_PHASES.includes(phase)) throw new TypeError('invalid queue phase');
      const allowed = ['candidate', 'expectedOldHead', 'exactBase', 'reason', 'proof', 'checks', 'decision', 'delivery', 'admission'];
      if (Object.keys(patch).some(key => !allowed.includes(key))) throw new TypeError('immutable queue entry field');
      return tx(() => {
        assertFence(fence, at);
        const entry = readEntry(entryId);
        if (!entry || JSON.stringify(entry.lane) !== JSON.stringify(resolveLaneKey(fence.lane))) throw new Error('foreign queue entry');
        if (expectedEntry && !isDeepStrictEqual(entry, expectedEntry)) throw new Error('queue admission observation superseded');
        if (operations(fence.lane).length) throw new Error('unreconciled queue operation');
        if (['merged','closed-observed','returned-to-closer'].includes(entry.phase)) throw new Error('terminal queue entry');
        if (recoveryObservation) {
          if (!['publishing', 'waiting-checks', 'finalizing'].includes(entry.phase)) throw new Error('invalid publication recovery phase');
          const recovery = reconcileQueuePublication(entry, recoveryObservation);
          phase = recovery.phase;
          patch = { ...recovery, phase: undefined };
          delete patch.phase;
        }
        const wasActive = QUEUE_ACTIONABLE_PHASES.includes(entry.phase);
        const becomesActive = QUEUE_ACTIONABLE_PHASES.includes(phase);
        if (!wasActive && becomesActive && !(readmit && phase === 'ready')) throw new Error('recovery requires readmission');
        if (becomesActive && wasActive && entries(fence.lane).find(e => QUEUE_ACTIONABLE_PHASES.includes(e.phase))?.entryId !== entryId) {
          throw new Error('queue predecessor active');
        }
        if (readmit && (wasActive || phase !== 'ready')) throw new Error('invalid readmission');
        if (wasActive && becomesActive && QUEUE_ACTIONABLE_PHASES.indexOf(phase) !== QUEUE_ACTIONABLE_PHASES.indexOf(entry.phase) + 1
          && phase !== entry.phase && phase !== 'rebasing' && !recoveryObservation) throw new Error('invalid queue transition');
        if (phase === 'merged' && entry.phase !== 'finalizing') throw new Error('invalid merged transition');
        const progressVersion = (entry.progressVersion ?? 0) + 1;
        if (!Number.isSafeInteger(progressVersion)) throw new Error('queue progress version exhausted');
        const update = { ...patch, phase, updatedAt: at, progressVersion };
        if (readmit) update.readinessSeq = database.prepare('UPDATE finalization_queue_lane SET readiness_seq=readiness_seq+1 WHERE repository=? AND base=? RETURNING readiness_seq').get(...laneArgs(fence.lane)).readiness_seq;
        const priorPhase = entry.phase;
        Object.assign(entry, update); writeEntry(entry);
        append('progress', fence.lane, { at, entryId, patch: update, generation: fence.generation, routeGeneration: fence.routeGeneration,
          priorPhase,
          ...(recoveryObservation ? { observation: recoveryObservation } : {}) });
        return entry;
      });
    },
    close() { if (!db) database.close(); },
  };
  return store;
}
