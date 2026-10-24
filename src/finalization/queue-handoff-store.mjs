import { handoffDigest, handoffJson, normalizeQueueHandoff, validateQueueHandoff } from './queue-handoff.mjs';
import { resolveLaneKey } from './ledger-events.mjs';
import { queueTime } from './queue-store.mjs';
import { queueWaitMs } from './queue-wait.mjs';

function parse(row, entryStmt) {
  if (!row) return null;
  const result = { handoff: JSON.parse(row.handoff_json), evidence: JSON.parse(row.evidence_json), ack: JSON.parse(row.ack_json) };
  const entry = entryStmt.get(row.entry_id);
  const payload = entry && JSON.parse(entry.payload_json);
  const { ack, handoff } = result;
  if (!payload || ack.status !== 'acknowledged' || ack.entryId !== row.entry_id || ack.handoffId !== row.handoff_id
    || ack.ackId !== payload.ackId || ack.payloadDigest !== row.payload_digest || payload.handoffDigest !== row.payload_digest
    || handoffDigest(handoff) !== row.payload_digest || handoff.head !== row.admission_head
    || handoff.prNumber !== row.pr_number || handoff.admissionGeneration !== row.admission_generation
    || handoff.lane.repository !== row.repository || handoff.lane.base !== row.base) {
    throw new Error('inconsistent durable handoff acknowledgement');
  }
  return result;
}

// This resolver is also used by the read-only deployed probe: preparing real
// statements proves that the durable receipt adapter can read the deployed DB.
// It performs no migrations or writes. Opening the queue store owns migration.
export function resolveQueueHandoffStore(store) {
  const db = store.db;
  const select = db.prepare(`SELECT * FROM finalization_queue_handoff
    WHERE repository=? AND base=? AND pr_number=? AND admission_head=? AND admission_generation=?`);
  const byId = db.prepare('SELECT * FROM finalization_queue_handoff WHERE handoff_id=?');
  const entryStmt = db.prepare('SELECT payload_json FROM finalization_queue_entry WHERE entry_id=?');
  function read(key) {
    const lane = resolveLaneKey(key.lane);
    return parse(select.get(lane.repository, lane.base, key.prNumber, key.head, key.admissionGeneration), entryStmt);
  }
  function replay(h) {
    const prior = read(h), named = parse(byId.get(h.handoffId), entryStmt);
    if (!prior && !named) return null;
    if (!prior || !named || prior.ack.ackId !== named.ack.ackId || prior.ack.payloadDigest !== handoffDigest(h)) {
      throw new Error('conflicting handoff acknowledgement');
    }
    return prior.ack;
  }
  return {
    name: 'app-store-handoff-v1', read, replay,
    commit(h, evidence, { at, load, deadline, now = () => at } = {}) {
      // Validate inside the writer boundary too: a caller cannot bypass the
      // validator by invoking commit instead of the async service.
      h = normalizeQueueHandoff(h);
      evidence = JSON.parse(handoffJson(evidence));
      validateQueueHandoff(h, evidence);
      const waitMs = queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: queueTime(now()), load });
      if (!waitMs) throw new Error('handoff commit deadline expired');
      const priorWait = db.pragma('busy_timeout', { simple: true });
      db.pragma(`busy_timeout = ${waitMs}`);
      try { return store.tx(() => {
        const existing = replay(h);
        if (existing) return existing;
        at = queueTime(now());
        if (deadline && Date.parse(at) >= Date.parse(deadline)) throw new Error('handoff commit deadline expired');
        const digest = handoffDigest(h);
        const key = handoffDigest([h.lane, h.prNumber, h.head, h.admissionGeneration]);
        const entry = store.acknowledge({ ...h, entryId: `q:${key}`, ackId: `ack:${key}`,
          handoffDigest: digest, at, load });
        const ack = { schemaVersion: 1, status: 'acknowledged', lane: h.lane, prNumber: h.prNumber,
          head: h.head, admissionGeneration: h.admissionGeneration, handoffId: h.handoffId,
          entryId: entry.entryId, ackId: entry.ackId, payloadDigest: digest,
          readinessSeq: entry.readinessSeq, acknowledgedAt: entry.acknowledgedAt };
        db.prepare(`INSERT INTO finalization_queue_handoff
          (handoff_id,entry_id,repository,base,pr_number,admission_head,admission_generation,payload_digest,handoff_json,evidence_json,ack_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(h.handoffId, entry.entryId, h.lane.repository, h.lane.base, h.prNumber, h.head,
            h.admissionGeneration, digest, handoffJson(h), handoffJson(evidence), handoffJson(ack));
        return ack;
      }); } finally { db.pragma(`busy_timeout = ${priorWait}`); }
    },
  };
}

async function readEvidence(adapter, handoff, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => adapter.read({ handoff: structuredClone(handoff), timeoutMs, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('handoff evidence deadline expired'));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Composition-only port. No default evidence source, credentials, dispatch or
 * route activation. The trusted evidence adapter must use sanctioned read and
 * signature-verification surfaces, fully paginate inventory, and honor abort /
 * the already-scaled timeout. It must never invoke another model judgement.
 */
export function createQueueHandoffService({ store, evidenceAdapter, now = () => new Date().toISOString(), load } = {}) {
  const receipts = resolveQueueHandoffStore(store);
  return {
    adapterName: receipts.name,
    readAcknowledgement(key) { return receipts.read(key)?.ack ?? null; },
    readReceipt: receipts.read,
    async submit(input, { deadline } = {}) {
      const h = normalizeQueueHandoff(input);
      const existing = receipts.replay(h);
      if (existing) return existing; // Lost ack retries need no fresh remote read.
      if (typeof evidenceAdapter?.read !== 'function') throw new Error('handoff evidence adapter unavailable');
      const started = queueTime(now());
      deadline = deadline == null ? new Date(Date.parse(started) + 30_000).toISOString() : queueTime(deadline);
      const timeoutMs = queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: started, load });
      if (!timeoutMs) throw new Error('handoff evidence deadline expired');
      const evidence = await readEvidence(evidenceAdapter, h, timeoutMs);
      const at = queueTime(now());
      if (Date.parse(at) >= Date.parse(deadline)) throw new Error('handoff evidence deadline expired');
      // commit() has no awaits. Entry, event, full evidence and ack commit as one
      // immediate transaction before any acknowledgement can leave this process.
      return receipts.commit(h, evidence, { at, load, deadline, now });
    },
  };
}
