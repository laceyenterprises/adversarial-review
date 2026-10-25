// Final eligibility, guarded squash merge and durable receipt delivery for the
// v2 queue. Explicit composition only: no daemon route, closer dispatch, notice
// or production activation at import. The live owner fence replaces ONLY the
// legacy merge-lease execution input; every other existing condition is reread.
import { isDeepStrictEqual } from 'node:util';
import { classifyQueueAdmission, resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { classifyQueueChecks } from './queue-check-reader.mjs';
import { createQueueChecksService } from './queue-checks.mjs';
import { handoffDigest } from './queue-handoff.mjs';
import { resolveQueueGitAdapter } from './queue-git.mjs';
import { verifyQueueDerivation } from './queue-rebase-proof.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { queueTime } from './queue-store.mjs';
import { finalized, resolveLaneKey } from './ledger-events.mjs';
import { fold } from './ledger-fold.mjs';
import { openFinalizationLedgerStore } from './ledger-store.mjs';
import { checkIdentityAttestation } from './execution-surfaces.mjs';
import { queueDeliveryPayloads } from './queue-delivery.mjs';

const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const same = (a, b) => sha(a) && sha(b) && a.toLowerCase() === b.toLowerCase();
const text = v => typeof v === 'string' && v.trim().length > 0;
const jsonCopy = v => JSON.parse(JSON.stringify(v));
const PRODUCERS = ['closer-hammer', 'ama-daemon'];
const releasing = phase => !['rebasing', 'waiting-checks', 'finalizing'].includes(phase);
export const queueMergeSubject = entry => ({ domainId: 'code-pr', subjectExternalId: `${entry.lane.repository}#${entry.prNumber}` });

/** Pure authoritative classification of one expected-head merge. A reply is
 * never evidence: only live merged state at this candidate, a structured merge
 * SHA and the attributed bot as merger prove success. `drained` is true only
 * after the issuing request is proven stopped or explicitly refused; only then
 * does an open candidate prove not-applied. Null means still ambiguous. */
export function reconcileQueueMergeObservation(entry, observation, { bot, reportedSha = null, drained = false } = {}) {
  const s = observation?.subject;
  if (!text(s?.sourceRef) || !isDeepStrictEqual(s.lane, entry.lane) || s.prNumber !== entry.prNumber) return null;
  const notApplied = (phase, reason) => ({ outcome: 'not-applied', sourceRef: s.sourceRef, reason, disposition: { phase, reason } });
  if (s.state === 'merged') {
    if (!same(s.head, entry.candidate)) return notApplied('closed-observed', 'merged-head-mismatch');
    if (!sha(s.mergeCommitSha) || !Number.isFinite(Date.parse(s.mergedAt))
      || (reportedSha !== null && !same(reportedSha, s.mergeCommitSha))) return null;
    if (!text(s.mergedBy) || !text(bot?.login) || s.mergedBy !== bot.login) return notApplied('closed-observed', 'merged-by-other-actor');
    return { outcome: 'succeeded', sourceRef: s.sourceRef, mergeSha: s.mergeCommitSha.toLowerCase(),
      mergedAt: new Date(s.mergedAt).toISOString(), mergedBy: s.mergedBy };
  }
  if (s.state === 'closed') return notApplied('closed-observed', 'live-closed');
  if (s.state !== 'open') return null;
  if (!same(s.head, entry.candidate)) return notApplied('returned-to-closer', 'external-head-change');
  return drained ? { outcome: 'not-applied', sourceRef: s.sourceRef, reason: 'merge-refused', disposition: null } : null;
}

/** Takeover helper for an owner recovery adapter. Call only AFTER the prior
 * execution tree is stopped and drained; it never invokes a merge. */
export async function observeQueueMergeOperation({ store, liveAdapter, operation, load }) {
  const intent = operation.intent ?? JSON.parse(operation.intent_json);
  const entry = store.readEntry(intent.entryId);
  const bot = entry?.decision?.attribution?.bot;
  if (intent.kind !== 'merge' || !entry || !bot) return null;
  const pinned = { ...entry, candidate: intent.candidate };
  const observation = await readQueueEvidence(liveAdapter, { entry: pinned, kind: 'merge-reconcile' },
    queueWaitMs(5_000, { ceilingMs: 30_000, load }));
  const result = reconcileQueueMergeObservation(pinned, observation, { bot, drained: true });
  return result && { ...result, observation };
}

export function resolveQueueMergeAdapter({ db }) {
  // Prepare real statements now, so an absent deployment schema fails closed.
  const receipts = db.prepare(`SELECT entry_id,repository,base,pr_number,candidate,merge_sha,operation_id,
    json_extract(receipt_json,'$.attribution.bot.login') AS bot,
    json_extract(receipt_json,'$.merge.mergedAt') AS recordedAt FROM finalization_queue_merge_receipt ORDER BY rowid DESC LIMIT 100`);
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM finalization_queue_merge_receipt) AS receipts,
    COUNT(*) AS deliveries, COALESCE(SUM(receipt_json IS NULL),0) AS pending FROM finalization_queue_delivery`);
  const pending = db.prepare(`SELECT delivery_key AS deliveryKey,kind,entry_id AS entryId,attempts,last_error AS lastError
    FROM finalization_queue_delivery WHERE receipt_json IS NULL ORDER BY rowid LIMIT 100`);
  const unresolved = db.prepare("SELECT COUNT(*) AS n FROM finalization_queue_operation WHERE kind='merge' AND result_json IS NULL");
  return { name: 'app-store-merge-receipt-outbox-v1', read() {
    return { ...counts.get(), unresolvedMergeOperations: unresolved.get().n, recentReceipts: receipts.all(),
      pendingDeliveries: pending.all(), sampleLimit: 100 };
  } };
}

export function createQueueMergeService({ store, owner, liveAdapter, checkReader, gitAdapter, identitySurface, mergeSurface,
  policy, deliveryAdapters = {}, pageAdapter, now = () => new Date().toISOString(), load } = {}) {
  const receipts = resolveQueueAdmissionAdapters(store);
  const ledger = openFinalizationLedgerStore({ db: store.db });
  const pages = createQueueChecksService({ store, owner, pageAdapter, now, load });
  const git = () => gitAdapter ?? resolveQueueGitAdapter({ rootDir: store.rootDir, now, load });
  // The existing emergency execution brake, read at every mutation boundary.
  // An unreadable policy is treated as engaged.
  const brake = () => {
    try { return (typeof policy === 'function' ? policy() : policy)?.autonomousExecutionDisabled === true; }
    catch { return true; }
  };
  const wait = deadline => queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: now(), load });
  function current(entry, fence) {
    store.assertFence(fence, queueTime(now()));
    if (!isDeepStrictEqual(store.readEntry(entry.entryId), entry)) throw new Error('merge observation superseded');
    if (store.operations(entry.lane).length) throw new Error('merge requires drained operation reconciliation');
  }
  function progress(entry, fence, phase, reason, patch = {}) {
    current(entry, fence);
    const prior = store.db.pragma('busy_timeout', { simple: true });
    store.db.pragma(`busy_timeout = ${wait(entry.patience.deadline)}`);
    try { return store.progress({ fence, entryId: entry.entryId, phase, at: queueTime(now()), expectedEntry: entry,
      patch: { ...patch, reason } }); }
    finally { store.db.pragma(`busy_timeout = ${prior}`); }
  }
  async function read(adapter, request, timeoutMs) {
    if (!timeoutMs) return null;
    try { return await readQueueEvidence(adapter, request, timeoutMs); } catch { return null; }
  }
  async function release(fence) {
    const result = await owner.release({ fence });
    if (!result?.ok) throw new Error('merge-lane-release-deferred');
  }
  async function park(entry, fence, reason) {
    const dependency = /identity/.test(reason) ? 'identity' : /git/.test(reason) ? 'git' : 'merge';
    const cause = { dependency, head: entry.candidate, base: entry.exactBase, reason };
    const causeKey = handoffDigest([entry.entryId, cause]);
    const parked = store.tx(() => {
      const result = progress(entry, fence, 'parked-infrastructure', reason, { decision: null,
        infrastructure: { ...entry.infrastructure, ...cause, causeKey, parkedAt: now(),
          nextProbeAt: new Date(Date.parse(now()) + 60_000).toISOString(), recovered: false } });
      store.db.prepare('INSERT INTO finalization_queue_check_page VALUES (?,?,?,NULL) ON CONFLICT DO NOTHING').run(causeKey, entry.entryId,
        JSON.stringify({ ...cause, causeKey, repo: entry.lane.repository, pr: entry.prNumber, deadline: entry.patience.deadline }));
      return result;
    });
    await release(fence);
    await pages.flushPages(entry.entryId);
    return parked;
  }
  async function dispose(entry, fence, verdict) {
    if (verdict.phase === 'parked-infrastructure') return park(entry, fence, verdict.reason);
    // Base movement discards stale readiness (checks + decision) and re-enters
    // rebase under the SAME persisted patience; nothing here can extend it.
    const patch = verdict.phase === 'rebasing' ? { checks: null, decision: null }
      : { decision: null, ...(verdict.checks !== undefined ? { checks: verdict.checks } : {}) };
    const result = progress(entry, fence, verdict.phase, verdict.reason, patch);
    if (releasing(verdict.phase)) await release(fence);
    return result;
  }
  function lifecycle(entry, receipt, live) {
    const s = live?.subject;
    if (!text(s?.sourceRef) || !isDeepStrictEqual(s.lane, entry.lane) || s.prNumber !== entry.prNumber) {
      return { phase: 'parked-infrastructure', reason: 'final-observation-unavailable' };
    }
    if (['closed', 'merged'].includes(s.state)) return { phase: 'closed-observed', reason: `live-${s.state}` };
    if (s.state !== 'open') return { phase: 'parked-infrastructure', reason: 'final-observation-unavailable' };
    if (!same(s.head, entry.candidate)) return { phase: 'returned-to-closer', reason: 'external-head-change' };
    if (!same(s.baseSha, entry.exactBase) || live.eligibility?.mergeStateStatus === 'BEHIND') {
      return { phase: 'rebasing', reason: 'external-base-change' };
    }
    // Shared holds/identity/permission/primary-change/structural predicate.
    const admission = classifyQueueAdmission(entry, receipt, live, same(entry.candidate, entry.head) ? null : { head: entry.candidate });
    return admission.phase === 'ready' ? null : admission;
  }
  function settledMerge(entry) {
    const rows = store.db.prepare("SELECT operation_id,intent_json,result_json FROM finalization_queue_operation WHERE entry_id=? AND kind='merge' AND result_json IS NOT NULL ORDER BY rowid DESC")
      .all(entry.entryId).map(row => ({ id: row.operation_id, intent: JSON.parse(row.intent_json), result: JSON.parse(row.result_json) }))
      .filter(op => op.intent.candidate === entry.candidate);
    // A succeeded merge always wins. Otherwise only this decision's own result
    // is still owed; a superseded attempt re-decides with a fresh intent.
    return rows.find(op => op.result.outcome === 'succeeded')
      ?? rows.find(op => op.id === mergeOperationId(entry) && !['superseded', 'merge-already-settled'].includes(op.result.reason)) ?? null;
  }
  const mergeOperationId = entry => `merge:${handoffDigest([entry.entryId, entry.candidate, entry.exactBase, entry.progressVersion])}`;

  async function evaluate(entry, deadline) {
    if (brake()) return { phase: 'parked-hold', reason: 'autonomous-execution-disabled' };
    const ledgerState = fold(ledger.read(queueMergeSubject(entry)));
    if (ledgerState.terminal) return { phase: 'parked-hold', reason: 'subject-ledger-terminal' };
    let receipt = null;
    try { receipt = receipts.receipt(entry); } catch { /* unreadable evidence parks */ }
    if (!receipt) return { phase: 'parked-infrastructure', reason: 'admission-receipt-unavailable' };
    const receiptDigest = handoffDigest(receipt.input ?? receipt.handoff);
    const publication = entry.rebase?.publication;
    if (!publication || publication.head !== entry.candidate || publication.base !== entry.exactBase
      || entry.rebase.sourceReceiptDigest !== receiptDigest) return { phase: 'returned-to-closer', reason: 'disposition-currency-changed' };
    const live = await read(liveAdapter, { entry, kind: 'final-merge' }, wait(deadline));
    const changed = lifecycle(entry, receipt, live);
    if (changed) return changed;
    let proof;
    try { proof = await verifyQueueDerivation({ entry: structuredClone(entry), git: git(), deadline }); }
    catch { return { phase: 'parked-infrastructure', reason: 'rebase-git-unavailable' }; }
    if (!proof) return { phase: 'returned-to-closer', reason: 'persisted-rebase-proof-unavailable' };
    const checks = await read(checkReader, { entry, deadline }, wait(deadline));
    const classified = checks?.head === entry.candidate && checks?.base === entry.exactBase && checks.complete === true
      ? classifyQueueChecks(checks) : { kind: 'wait', reason: checks?.reason ?? 'checks-unreadable' };
    if (classified.kind === 'red') return { phase: 'returned-to-closer', reason: classified.reason, checks };
    if (classified.kind !== 'green') return { phase: 'waiting-checks', reason: classified.reason, checks: checks ?? null };
    // Identity read-through is mandatory here: absence is not local mode,
    // because the receipt must attribute the bot that performs the merge.
    let identity = null;
    if (identitySurface && typeof identitySurface.check === 'function') {
      identity = await read({ read: ctx => checkIdentityAttestation(identitySurface, ctx) },
        { subjectKey: queueMergeSubject(entry), revisionRef: entry.candidate, decision: { kind: 'finalize-now' } }, wait(deadline));
    }
    if (identity?.ok !== true || !text(identity.login) || !PRODUCERS.includes(identity.producerClass) || !text(identity.sourceRef)) {
      return { phase: 'parked-infrastructure', reason: 'merge-identity-unavailable' };
    }
    const handoff = receipt.input ?? receipt.handoff;
    const s = live.subject;
    const decision = { kind: 'eligible', at: now(), head: entry.candidate, base: entry.exactBase,
      liveSourceRef: s.sourceRef, labels: s.labels.map(l => typeof l === 'string' ? l : l.name), holds: 'none',
      checksReason: classified.reason, requiredSetVersion: checks.requiredSet.version,
      structuralSourceRef: live.structuralSourceRef, primaryChange: live.eligibility.primaryChange ?? null,
      proofDigest: entry.proof?.digest ?? null, receiptDigest, admissionKind: receipt.kind,
      subjectLedgerEventCount: ledgerState.eventCount, executionOwnership: 'lane-fence-replaces-merge-lease',
      attribution: { bot: { login: identity.login, producerClass: identity.producerClass, sourceRef: identity.sourceRef },
        closer: receipt.handoff?.closer ?? null, worker: handoff.worker ?? null } };
    return { phase: 'finalizing', decision: { ...decision, id: `decision:${handoffDigest(jsonCopy(decision))}` },
      checks, receipt, ledgerCount: ledgerState.eventCount };
  }

  async function invokeMerge(entry, fence, verdict, intent) {
    const notApplied = (reason, disposition = null, observation = null) => ({ outcome: 'not-applied',
      sourceRef: 'queue:merge-not-invoked', reason, disposition, observation });
    const brakeHold = { phase: 'parked-hold', reason: 'autonomous-execution-disabled' };
    if (brake()) return notApplied(brakeHold.reason, brakeHold);
    try { current(entry, fence); } catch (error) {
      // The new intent itself is the only unresolved operation at this point.
      if (error.message !== 'merge requires drained operation reconciliation') return notApplied('superseded');
      store.assertFence(fence, queueTime(now()));
      if (!isDeepStrictEqual(store.readEntry(entry.entryId), entry)) return notApplied('superseded');
    }
    if (settledMerge(entry)?.result.outcome === 'succeeded') return notApplied('merge-already-settled');
    const ledgerState = fold(ledger.read(queueMergeSubject(entry)));
    if (ledgerState.terminal || ledgerState.eventCount !== verdict.ledgerCount) {
      return notApplied('subject-ledger-moved', { phase: 'parked-hold', reason: 'subject-ledger-moved' });
    }
    // The issuance lock spans this last live read and the complete merge call.
    const last = await read(liveAdapter, { entry, kind: 'merge-preflight' }, wait(entry.patience.deadline));
    const changed = lifecycle(entry, verdict.receipt, last);
    if (changed) return notApplied(changed.reason, changed, last);
    if (brake()) return notApplied(brakeHold.reason, brakeHold, last);
    const timeoutMs = Math.min(intent.timeoutMs, queueWaitMs(30_000, { ceilingMs: 60_000, deadline: entry.patience.deadline, now: now(), load }));
    if (!timeoutMs) return notApplied('merge-deadline-expired', { phase: 'parked-infrastructure', reason: 'merge-deadline-expired' }, last);
    let response = null, threw = false;
    try {
      // Existing entitled squash surface; GitHub refuses a moved head.
      response = await mergeSurface.merge({ subjectKey: queueMergeSubject(entry), subjectExternalId: queueMergeSubject(entry).subjectExternalId,
        revisionRef: entry.candidate, mergeMethod: 'squash', timeoutMs });
    } catch { threw = true; }
    if (!threw && response?.ok === false && ['adapter-unavailable', 'unsupported-subject', 'no-revision'].includes(response.reason)) {
      return notApplied('merge-surface-unavailable', { phase: 'parked-infrastructure', reason: 'merge-surface-unavailable' }, last);
    }
    const refused = !threw && response?.ok === false && response.reason === 'merge-refused';
    const payload = response?.ok === true ? response.payload ?? {} : {};
    const reported = [payload.sha, payload.mergeCommitSha, payload.data?.sha].find(sha) ?? null;
    // Reconciliation runs on its own bounded window: an elapsed entry budget
    // cannot turn a possibly-applied merge into a skipped observation.
    const observed = await read(liveAdapter, { entry, kind: 'merge-reconcile' }, queueWaitMs(5_000, { ceilingMs: 30_000, load }));
    const result = reconcileQueueMergeObservation(entry, observed, { bot: verdict.decision.attribution.bot, reportedSha: reported, drained: refused });
    if (!result) throw new Error('merge-requires-drain-reconciliation');
    return { ...result, observation: observed,
      response: { ok: response?.ok === true, reason: threw ? 'surface-threw' : response?.reason ?? null, via: mergeSurface.name ?? null } };
  }

  async function record(entry, fence, operationId, result) {
    const decision = entry.decision;
    if (decision?.kind !== 'eligible' || decision.head !== entry.candidate) throw new Error('merge receipt requires the persisted final decision');
    const proof = entry.proof ?? {};
    const body = jsonCopy({ schemaVersion: 1, entryId: entry.entryId, lane: entry.lane, prNumber: entry.prNumber,
      handoffId: entry.handoffId, ackId: entry.ackId, admissionKind: decision.admissionKind,
      oldHead: entry.head, expectedOldHead: entry.expectedOldHead, newHead: entry.candidate, base: entry.exactBase,
      rebase: { sourceReceiptDigest: entry.rebase.sourceReceiptDigest, publication: entry.rebase.publication,
        proof: { kind: proof.kind ?? null, noop: proof.noop ?? null, digest: proof.digest ?? null, fork: proof.fork ?? null,
          replayedCommits: proof.replayedCommits ?? [] }, derivationHops: (entry.rebase.priorDerivations?.length ?? 0) + 1 },
      checks: entry.checks, decision,
      merge: { operationId, method: 'squash', mergeSha: result.mergeSha, mergedAt: result.mergedAt, mergedBy: result.mergedBy,
        sourceRef: result.sourceRef, via: result.response?.via ?? null },
      attribution: decision.attribution,
      owner: { ownerId: fence.ownerId, generation: fence.generation, routeGeneration: fence.routeGeneration } });
    const receipt = { ...body, digest: handoffDigest(body) };
    const deliveries = queueDeliveryPayloads(receipt);
    const merged = store.tx(() => {
      const next = progress(entry, fence, 'merged', 'squash-merge-reconciled', {
        merge: receipt.merge, delivery: { receiptDigest: receipt.digest, keys: deliveries.map(d => d.key) } });
      store.db.prepare('INSERT INTO finalization_queue_merge_receipt VALUES (?,?,?,?,?,?,?,?,?)').run(entry.entryId,
        entry.lane.repository, entry.lane.base, entry.prNumber, entry.candidate, result.mergeSha, operationId, receipt.digest, JSON.stringify(receipt));
      const insert = store.db.prepare('INSERT INTO finalization_queue_delivery(delivery_key,entry_id,kind,payload_json) VALUES (?,?,?,?)');
      for (const d of deliveries) insert.run(d.key, entry.entryId, d.kind, JSON.stringify(d.payload));
      const subject = queueMergeSubject(entry);
      if (fold(ledger.read(subject)).finalized?.revisionRef !== entry.candidate) {
        ledger.append(finalized(subject, { at: queueTime(now()), revisionRef: entry.candidate, method: 'squash',
          sourceRef: `github:merge:${result.mergeSha}` }));
      }
      return next;
    });
    await release(fence);
    await deliver({ entryId: entry.entryId });
    return merged;
  }

  async function apply(entry, fence, operationId, result) {
    if (result.outcome === 'succeeded') return record(entry, fence, operationId, result);
    if (['superseded', 'merge-already-settled'].includes(result.reason)) return store.readEntry(entry.entryId);
    if (result.disposition) return dispose(entry, fence, result.disposition);
    return park(entry, fence, result.reason ?? 'merge-not-applied');
  }

  /** Outbox delivery. Not lane-fenced: it never merges, and every adapter is
   * idempotent by key. Missing/failed delivery stays visible as pending.
   * Retain the store's busy timeout after lane release for transient writers. */
  async function deliver({ entryId = null, limit = 100 } = {}) {
    const rows = store.db.prepare(`SELECT * FROM finalization_queue_delivery WHERE receipt_json IS NULL
      ${entryId ? 'AND entry_id=?' : ''} ORDER BY rowid LIMIT ?`).all(...(entryId ? [entryId] : []), Math.min(Math.max(1, limit), 100));
    const outcome = { delivered: 0, pending: 0 };
    for (const row of rows) {
      const adapter = deliveryAdapters[row.kind];
      let receipt = null, error = 'delivery-adapter-unavailable';
      if (adapter) {
        try {
          receipt = await readQueueEvidence(adapter, { key: row.delivery_key, kind: row.kind, payload: JSON.parse(row.payload_json) },
            queueWaitMs(5_000, { ceilingMs: 30_000, load }));
        } catch (failure) { error = /^[a-z0-9-]{1,80}$/.test(failure?.message ?? '') ? failure.message : 'delivery-failed'; }
      }
      const delivered = receipt?.id === row.delivery_key && text(receipt.sourceRef);
      store.db.prepare(`UPDATE finalization_queue_delivery SET attempts=attempts+1,last_error=?,
        receipt_json=COALESCE(receipt_json,?) WHERE delivery_key=?`).run(delivered ? null : (receipt ? 'delivery-receipt-invalid' : error),
        delivered ? JSON.stringify({ id: receipt.id, sourceRef: receipt.sourceRef, at: now() }) : null, row.delivery_key);
      outcome[delivered ? 'delivered' : 'pending']++;
    }
    return outcome;
  }

  return { adapterName: 'guarded-squash-merge-v1', deliver,
    async finalize({ fence, entryId }) {
      let entry = store.readEntry(entryId);
      if (!entry || !isDeepStrictEqual(entry.lane, resolveLaneKey(fence.lane))) throw new Error('foreign merge entry');
      if (entry.phase === 'merged') { await deliver({ entryId }); return store.readEntry(entryId); }
      store.assertFence(fence, queueTime(now()));
      if (entry.phase !== 'finalizing') throw new Error('merge requires a finalizing candidate');
      // Unresolved intents belong to owner drain reconciliation, never a retry.
      if (store.operations(entry.lane).length) return entry;
      const settled = settledMerge(entry);
      if (settled) return apply(entry, fence, settled.id, settled.result);
      const deadline = entry.patience.deadline;
      if (Date.parse(now()) >= Date.parse(deadline)) return park(entry, fence, 'merge-deadline-expired');
      const verdict = await evaluate(entry, deadline);
      current(entry, fence);
      if (['finalizing', 'waiting-checks'].includes(verdict.phase) && Date.parse(now()) >= Date.parse(deadline)) {
        return park(entry, fence, 'merge-deadline-expired');
      }
      if (verdict.phase !== 'finalizing') return dispose(entry, fence, verdict);
      // Persist the final decision before the intent; the owner journals the
      // intent before invoking, and both precede the remote mutation.
      entry = progress(entry, fence, 'finalizing', 'final-eligibility-validated', { decision: verdict.decision, checks: verdict.checks });
      const operationId = mergeOperationId(entry);
      const issued = await owner.issue({ fence, entryId, operationId, kind: 'merge',
        invoke: intent => invokeMerge(entry, fence, verdict, intent) });
      if (!issued.ok) return store.readEntry(entryId);
      return apply(entry, fence, operationId, issued.result);
    },
  };
}
