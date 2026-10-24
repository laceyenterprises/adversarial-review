import { handoffDigest, handoffJson, normalizeQueueHandoff, validateQueueHandoff } from './queue-handoff.mjs';
import { queueTime } from './queue-store.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { readQueueEvidence } from './queue-read.mjs';

// Reuse the complete signed provenance validator. On direct admission the
// builder is the producer; there is no closer or finding disposition to invent.
export function normalizeCleanReview(input) {
  if (input?.closer !== undefined || input?.dispositions !== undefined) throw new Error('clean review cannot carry closer adjudication');
  const h = normalizeQueueHandoff({ ...input, closer: input?.worker, dispositions: [] });
  if (h.sourceReview.commitId !== h.head) throw new Error('clean review requires exact head');
  delete h.closer; delete h.dispositions;
  return h;
}
export function validateCleanReview(input, evidence) {
  const h = normalizeCleanReview(input);
  if (evidence?.review?.verdict !== 'settled-success' || evidence?.review?.findings?.length !== 0
    || evidence?.currency?.proof !== 'exact-head') throw new Error('clean review is not current and zero-finding');
  return validateQueueHandoff({ ...h, closer: h.worker, dispositions: [] }, {
    ...evidence, identities: { ...evidence.identities, closer: evidence.identities?.worker },
  });
}

// The same resolver is used by the read-only deployed probe. Preparing the
// actual reader proves schema availability without migrations or writes.
export function resolveCleanReviewStore(store) {
  const readStmt = store.db.prepare(`SELECT c.*,e.payload_json FROM finalization_queue_clean_review c
    JOIN finalization_queue_entry e USING(entry_id) WHERE c.entry_id=?`);
  const insertStmt = store.db.prepare('INSERT INTO finalization_queue_clean_review VALUES (?,?,?)');
  function read(entryId) {
    const row = readStmt.get(entryId);
    if (!row) return null;
    const input = JSON.parse(row.input_json), evidence = JSON.parse(row.evidence_json), entry = JSON.parse(row.payload_json);
    if (entry.handoffDigest !== handoffDigest(input) || entry.head !== input.head || entry.prNumber !== input.prNumber
      || entry.admissionGeneration !== input.admissionGeneration || handoffJson(entry.lane) !== handoffJson(input.lane)) {
      throw new Error('inconsistent clean review receipt');
    }
    validateCleanReview(input, evidence);
    return { input, evidence, entry };
  }
  return { name: 'app-store-clean-review-v1', read,
    commit(input, evidence, { at, load }) {
      input = normalizeCleanReview(input);
      evidence = JSON.parse(handoffJson(evidence));
      validateCleanReview(input, evidence);
      return store.tx(() => {
        const key = handoffDigest([input.lane, input.prNumber, input.head, input.admissionGeneration]);
        const entry = store.acknowledge({ ...input, entryId: `q:${key}`, ackId: `ack:${key}`,
          handoffDigest: handoffDigest(input), at, load });
        const prior = read(entry.entryId);
        if (!prior) insertStmt.run(entry.entryId, handoffJson(input), handoffJson(evidence));
        return entry;
      });
    },
  };
}

export function createCleanReviewService({ store, evidenceAdapter, now = () => new Date().toISOString(), load } = {}) {
  const receipts = resolveCleanReviewStore(store);
  return { adapterName: receipts.name, readReceipt: receipts.read,
    async submit(input, { deadline } = {}) {
      input = normalizeCleanReview(input);
      const key = handoffDigest([input.lane, input.prNumber, input.head, input.admissionGeneration]);
      const prior = receipts.read(`q:${key}`);
      if (prior) {
        if (handoffDigest(prior.input) !== handoffDigest(input)) throw new Error('conflicting clean review acknowledgement');
        return prior.entry;
      }
      const started = queueTime(now());
      deadline = deadline == null ? new Date(Date.parse(started) + 30_000).toISOString() : queueTime(deadline);
      const timeoutMs = queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: started, load });
      if (!timeoutMs) throw new Error('clean review deadline expired');
      const evidence = await readQueueEvidence(evidenceAdapter, { review: input }, timeoutMs);
      const at = queueTime(now());
      const wait = queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: at, load });
      if (!wait) throw new Error('clean review deadline expired');
      const priorWait = store.db.pragma('busy_timeout', { simple: true });
      store.db.pragma(`busy_timeout = ${wait}`);
      try {
        return store.tx(() => {
          if (Date.parse(now()) >= Date.parse(deadline)) throw new Error('clean review deadline expired');
          return receipts.commit(input, evidence, { at: queueTime(now()), load });
        });
      } finally { store.db.pragma(`busy_timeout = ${priorWait}`); }
    },
  };
}
