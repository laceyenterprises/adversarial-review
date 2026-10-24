// Wait/parking belongs to the v2 finalization port. This service installs no
// route, performs no merge and never dispatches or charges remediation.
import { isDeepStrictEqual } from 'node:util';
import { classifyQueueChecks } from './queue-check-reader.mjs';
import { classifyQueueAdmission, resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { handoffDigest } from './queue-handoff.mjs';
import { verifyQueueDerivation } from './queue-rebase-proof.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { resolveLaneKey } from './ledger-events.mjs';

export function resolveQueueChecksAdapter({ db }) {
  // Prepare real statements now, so an absent deployment schema fails closed.
  const observations = db.prepare(`SELECT entry_id,phase,payload_json FROM finalization_queue_entry
    WHERE json_extract(payload_json,'$.checks') IS NOT NULL OR json_extract(payload_json,'$.infrastructure') IS NOT NULL
    ORDER BY rowid DESC LIMIT 100`);
  const pages = db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(receipt_json IS NULL),0) AS pending FROM finalization_queue_check_page');
  return { name: 'app-store-checks-parking-v1', read() {
    return { observations: observations.all().map(row => {
      const e = JSON.parse(row.payload_json);
      return { entryId: row.entry_id, phase: row.phase, candidate: e.candidate, base: e.exactBase,
        patience: e.patience, checks: e.checks, infrastructure: e.infrastructure ?? null };
    }), pages: pages.get(), sampleLimit: 100 };
  } };
}

// Explicit composition into the existing durable Sentinel/alert path only.
export function createQueueInfrastructurePageAdapter({ deliverAlert, env }) {
  return { name: 'existing-alert-delivery', async read({ payload }) {
    const receipt = await deliverAlert('Merge queue infrastructure patience expired; inspect dependency evidence.', {
      event: 'finalization.queue.infrastructure', payload, env,
    });
    if (!receipt?.id) throw new Error('page-enqueue-unavailable');
    return { id: receipt.id, status: receipt.status };
  } };
}

export function createQueueChecksService({ store, owner, checkReader, liveAdapter, gitAdapter, pageAdapter,
  now = () => new Date().toISOString(), load } = {}) {
  const receipts = resolveQueueAdmissionAdapters(store);
  // Initial reads and post-expiry bookkeeping must never borrow the connection's
  // default lock patience. They either complete immediately or fail closed.
  const nonblocking = action => {
    const prior = store.db.pragma('busy_timeout', { simple: true });
    store.db.pragma('busy_timeout = 0');
    try { return action(); } finally { store.db.pragma(`busy_timeout = ${prior}`); }
  };
  const wait = deadline => queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: now(), load });
  const current = (entry, fence) => nonblocking(() => {
    store.assertFence(fence, now());
    if (!isDeepStrictEqual(store.readEntry(entry.entryId), entry)) throw new Error('checks observation superseded');
    if (store.operations(entry.lane).length) throw new Error('checks require drained operations');
  });
  function progress(entry, fence, phase, reason, patch = {}, readmit = false) {
    current(entry, fence);
    const prior = store.db.pragma('busy_timeout', { simple: true });
    store.db.pragma(`busy_timeout = ${wait(entry.patience.deadline)}`);
    try { return store.progress({ fence, entryId: entry.entryId, at: now(), phase, expectedEntry: entry,
      readmit, patch: { ...patch, reason } }); }
    finally { store.db.pragma(`busy_timeout = ${prior}`); }
  }
  async function read(adapter, entry, deadline) {
    const timeoutMs = wait(deadline);
    if (!timeoutMs) return null;
    try { return await readQueueEvidence(adapter, { entry, deadline }, timeoutMs); }
    catch (error) {
      const reason = error?.authOutage === true ? 'credential-outage'
        : ['required-set-unresolved', 'required-set-changed', 'checks-partial-pages', 'checks-moving-pages', 'checks-stale-sha'].includes(error?.message)
          ? error.message : 'checks-unreadable';
      return { complete: false, head: entry.candidate, base: entry.exactBase, reason, observedAt: now() };
    }
  }
  async function release(fence) {
    const result = await nonblocking(() => owner.release({ fence }));
    if (!result?.ok) throw new Error('checks-lane-release-deferred');
  }
  async function flushPages(entryId) {
    if (!pageAdapter) return;
    const rows = nonblocking(() => store.db.prepare('SELECT * FROM finalization_queue_check_page WHERE entry_id=? AND receipt_json IS NULL LIMIT 100').all(entryId));
    for (const row of rows) {
      // Delivery is a separate bounded enqueue, after lane release. The existing
      // bus owns its own bounded network retries and stable-id deduplication.
      const timeoutMs = queueWaitMs(5_000, { ceilingMs: 30_000, load });
      let receipt;
      try { receipt = await readQueueEvidence(pageAdapter, { payload: JSON.parse(row.payload_json) }, timeoutMs); }
      catch { continue; }
      if (receipt?.id) nonblocking(() => store.db.prepare('UPDATE finalization_queue_check_page SET receipt_json=? WHERE cause_key=? AND receipt_json IS NULL')
        .run(JSON.stringify(receipt), row.cause_key));
    }
  }
  async function park(entry, fence, reason, checks) {
    const cause = { dependency: reason === 'credential-outage' ? 'credentials' : 'checks', head: entry.candidate, base: entry.exactBase, reason };
    const causeKey = handoffDigest([entry.entryId, cause]);
    const payload = { ...cause, causeKey, repo: entry.lane.repository, pr: entry.prNumber,
      deadline: entry.patience.deadline };
    if (!checks) checks = { head: entry.candidate, base: entry.exactBase, complete: false, observedAt: now(),
      lastSnapshot: entry.checks?.complete ? entry.checks : entry.checks?.lastSnapshot ?? null };
    const parked = nonblocking(() => store.tx(() => {
      const result = progress(entry, fence, 'parked-infrastructure', reason, { checks,
        infrastructure: { ...entry.infrastructure, ...cause, causeKey, parkedAt: now(),
          nextProbeAt: new Date(Date.parse(now()) + 60_000).toISOString(), recovered: false } });
      store.db.prepare('INSERT INTO finalization_queue_check_page VALUES (?,?,?,NULL) ON CONFLICT DO NOTHING')
        .run(causeKey, entry.entryId, JSON.stringify(payload));
      return result;
    }));
    await release(fence);
    await flushPages(entry.entryId);
    return parked;
  }
  function subjectDecision(entry, live) {
    const s = live?.subject;
    if (!s?.sourceRef || !isDeepStrictEqual(s.lane, entry.lane) || s.prNumber !== entry.prNumber) return null;
    if (['closed', 'merged'].includes(s.state)) return { phase: 'closed-observed', reason: `live-${s.state}` };
    if (s.state !== 'open') return null;
    if (s.head !== entry.candidate) return { phase: 'returned-to-closer', reason: 'external-head-change' };
    if (s.baseSha !== entry.exactBase) return { phase: 'rebasing', reason: 'external-base-change' };
    return { phase: 'waiting-checks' };
  }
  return { adapterName: 'exact-candidate-checks-v1', flushPages,
    async poll({ fence, entryId }) {
      let entry = nonblocking(() => store.readEntry(entryId));
      if (!entry || !isDeepStrictEqual(entry.lane, resolveLaneKey(fence.lane))) throw new Error('foreign checks entry');
      current(entry, fence);
      if (entry.phase === 'parked-infrastructure' && entry.infrastructure) {
        await release(fence); await flushPages(entryId); return entry;
      }
      if (entry.phase === 'ready' && entry.infrastructure?.recovered === true) {
        // Recovery rejoined the tail. Resume the published candidate only when
        // it becomes first; no push/rebase or fresh patience is manufactured.
        for (const phase of ['rebasing', 'publishing', 'waiting-checks']) entry = progress(entry, fence, phase, 'recovered-candidate-resumed');
      }
      if (entry.phase !== 'waiting-checks' || entry.rebase?.publication?.head !== entry.candidate
        || entry.rebase.publication.base !== entry.exactBase) throw new Error('checks require exact published candidate');
      const expired = Date.parse(now()) >= Date.parse(entry.patience.deadline);
      // A recovered, already-green dependency gets one bounded observation,
      // never another CI wait. Failure parks immediately with the original bound.
      const deadline = expired && entry.infrastructure?.recovered
        ? new Date(Date.parse(now()) + queueWaitMs(5_000, { ceilingMs: 30_000, load })).toISOString() : entry.patience.deadline;
      const live = await read(liveAdapter, entry, deadline); current(entry, fence);
      const decision = subjectDecision(entry, live);
      if (decision && decision.phase !== 'waiting-checks') {
        if (decision.phase === 'rebasing' && expired) return park(entry, fence, 'checks-deadline-expired', null);
        const result = progress(entry, fence, decision.phase, decision.reason, { checks: null });
        if (decision.phase !== 'rebasing') await release(fence);
        return result;
      }
      const checks = decision ? await read(checkReader, entry, deadline) : null;
      current(entry, fence);
      // Do not accept a reader's observation at another head/base or after its
      // allotted read window. Local validation remains in the source receipt.
      const valid = checks?.head === entry.candidate && checks?.base === entry.exactBase
        && Date.parse(now()) < Date.parse(deadline);
      const classified = valid && checks.complete === true ? classifyQueueChecks(checks) : { kind: 'wait',
        reason: checks?.reason ?? live?.reason ?? (expired && /^(missing-required-check:|checks-pending|credential-outage|required-set-)/.test(entry.reason ?? '')
          ? entry.reason : 'checks-unreadable') };

      if (classified.kind === 'green') return progress(entry, fence, 'finalizing', classified.reason, { checks });
      if (classified.kind === 'red') {
        const result = progress(entry, fence, 'returned-to-closer', classified.reason, { checks });
        await release(fence); return result;
      }
      if (expired || Date.parse(now()) >= Date.parse(entry.patience.deadline)) return park(entry, fence, classified.reason, checks);
      return progress(entry, fence, 'waiting-checks', classified.reason, { checks });
    },
    async reprobe({ fence, entryId }) {
      let entry = nonblocking(() => store.readEntry(entryId));
      if (!entry || !isDeepStrictEqual(entry.lane, resolveLaneKey(fence.lane))) throw new Error('foreign checks entry');
      current(entry, fence);
      try {
        if (entry.phase !== 'parked-infrastructure' || !entry.infrastructure
          || Date.parse(now()) < Date.parse(entry.infrastructure.nextProbeAt)) return entry;
        // Persist the separate bounded reprobe window before I/O. Patience is
        // immutable. Unknown recovery retains work outside actionable FIFO.
        const deadline = new Date(Date.parse(now()) + queueWaitMs(5_000, { ceilingMs: 30_000, load })).toISOString();
        entry = progress(entry, fence, entry.phase, entry.reason, { infrastructure: { ...entry.infrastructure,
          probeDeadline: deadline, nextProbeAt: new Date(Date.parse(deadline) + 60_000).toISOString() } });
        const live = await read(liveAdapter, entry, deadline); current(entry, fence);
        const subject = subjectDecision(entry, live);
        if (subject && ['closed-observed', 'returned-to-closer'].includes(subject.phase)) {
          return progress(entry, fence, subject.phase, subject.reason);
        }
        if (subject?.phase !== 'waiting-checks') return entry;
        const checks = await read(checkReader, entry, deadline); current(entry, fence);
        if (checks?.head !== entry.candidate || checks?.base !== entry.exactBase) return entry;
        const classified = classifyQueueChecks(checks);
        if (classified.kind === 'red') return progress(entry, fence, 'returned-to-closer', classified.reason, { checks });
        if (classified.kind !== 'green') return entry;
        let receipt, proof = false;
        try {
          receipt = nonblocking(() => receipts.receipt(entry));
          if (receipt && entry.rebase?.sourceReceiptDigest === handoffDigest(receipt.input ?? receipt.handoff)) {
            proof = await verifyQueueDerivation({ entry: structuredClone(entry), git: gitAdapter, deadline });
          }
        } catch { /* Unavailable currency/proof is not recovery. */ }
        current(entry, fence);
        if (!proof || Date.parse(now()) >= Date.parse(deadline)) return entry;
        // Refresh after proof and check pagination; re-check holds, identity and
        // all existing structural predicates before assigning new readiness.
        const fresh = await read(liveAdapter, entry, deadline); current(entry, fence);
        const finalSubject = subjectDecision(entry, fresh);
        if (finalSubject && ['closed-observed', 'returned-to-closer'].includes(finalSubject.phase)) {
          return progress(entry, fence, finalSubject.phase, finalSubject.reason);
        }
        if (finalSubject?.phase !== 'waiting-checks') return entry;
        const admission = classifyQueueAdmission(entry, receipt, fresh,
          entry.candidate !== entry.head ? { head: entry.candidate } : null);
        if (admission.phase === 'returned-to-closer') return progress(entry, fence, admission.phase, admission.reason, { checks });
        if (admission.phase !== 'ready' || Date.parse(now()) >= Date.parse(deadline)) return entry;
        return progress(entry, fence, 'ready', 'infrastructure-recovered-at-tail', { checks,
          infrastructure: { ...entry.infrastructure, recovered: true, recoveredAt: now() } }, true);
      } finally { await release(fence); }
    },
  };
}
