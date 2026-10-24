// Mechanical execution slice. Explicit composition only: no daemon route,
// closer dispatch, merge, notice delivery or production activation at import.
import { isDeepStrictEqual } from 'node:util';
import { classifyQueueAdmission, resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { resolveQueueGitAdapter } from './queue-git.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { queueTime } from './queue-store.mjs';
import { resolveLaneKey } from './ledger-events.mjs';
import { handoffDigest } from './queue-handoff.mjs';

const terminal = e => ['merged', 'closed-observed', 'returned-to-closer'].includes(e.phase);
const nonempty = s => typeof s === 'string' && s.length > 0;
export const REBASE_DIVERGENCE_WARNING = 'The queue rewrote branch history. Fetch and rebase local work onto the published head before pushing.';

export function createQueueRebaseService({ store, owner, liveAdapter, gitAdapter, policy,
  now = () => new Date().toISOString(), load } = {}) {
  const receipts = resolveQueueAdmissionAdapters(store);
  const git = gitAdapter ?? resolveQueueGitAdapter({ rootDir: store.rootDir, now, load });
  function current(entry, fence) {
    store.assertFence(fence, queueTime(now()));
    if (!isDeepStrictEqual(store.readEntry(entry.entryId), entry)) throw new Error('rebase observation superseded');
    if (store.operations(entry.lane).length) throw new Error('publication requires drained operation reconciliation');
  }
  function progress(entry, fence, phase, reason, patch = {}) {
    current(entry, fence);
    const priorWait = store.db.pragma('busy_timeout', { simple: true });
    store.db.pragma(`busy_timeout = ${queueWaitMs(5_000, { ceilingMs: 30_000, deadline: entry.patience.deadline, now: now(), load })}`);
    try { return store.progress({ fence, entryId: entry.entryId, phase, at: queueTime(now()), expectedEntry: entry,
      patch: { ...patch, reason } }); }
    finally { store.db.pragma(`busy_timeout = ${priorWait}`); }
  }
  const read = async entry => {
    const wait = queueWaitMs(5_000, { ceilingMs: 30_000, deadline: entry.patience.deadline, now: now(), load });
    if (!wait) return null;
    try { return await readQueueEvidence(liveAdapter, { entry, kind: 'rebase-publication' }, wait); }
    catch { return null; }
  };
  async function verify(entry) {
    if (!entry.candidate || !entry.rebase) return false;
    const proof = await git.verify({ entry: structuredClone(entry), deadline: entry.patience.deadline });
    return proof && isDeepStrictEqual(proof, entry.proof);
  }
  function preflight(entry, receipt, live, head, derived) {
    // Same finalization policy input as the existing executor, never a route
    // selector or a second execution enable setting.
    if (policy?.autonomousExecutionDisabled === true) return { phase: 'parked-hold', reason: 'autonomous-execution-disabled' };
    const decision = classifyQueueAdmission(entry, receipt, live, derived ? { head } : null);
    if (decision.phase !== 'ready') return decision;
    const p = live.permission, target = live.subject;
    if (!nonempty(p.rulesSourceRef) || typeof p.canForcePush !== 'boolean' || typeof p.fork !== 'boolean'
      || typeof p.canWriteHeadRepository !== 'boolean' || typeof p.maintainerCanModify !== 'boolean'
      || p.headRepository !== target.headRepository || p.headRef !== target.headRef) {
      return { phase: 'parked-permission', reason: 'rebase-rights-unavailable' };
    }
    if (!p.canForcePush || !p.canWriteHeadRepository || (p.fork && !p.maintainerCanModify)) {
      return { phase: 'parked-permission', reason: p.fork ? 'fork-rebase-permission-denied' : 'force-push-permission-denied' };
    }
    try { resolveLaneKey({ repository: target.headRepository, base: target.headRef }); }
    catch { return { phase: 'parked-permission', reason: 'head-branch-unavailable' }; }
    return decision;
  }
  function parkOrReturn(entry, fence, decision, live) {
    const notice = decision.phase === 'parked-permission' ? {
      key: `rebase-permission:${entry.entryId}:${decision.reason}`, audience: 'author-and-operator', reason: decision.reason,
    } : null;
    return progress(entry, fence, decision.phase, decision.reason, { rebase: {
      ...entry.rebase, lastObservation: live, ...(notice ? { notice } : {}),
    } });
  }
  return { adapterName: git.name, proofAdapter: git.proofAdapter,
    async run({ fence, entryId }) {
      let entry = store.readEntry(entryId);
      if (!entry || !isDeepStrictEqual(entry.lane, resolveLaneKey(fence.lane))) throw new Error('foreign rebase entry');
      current(entry, fence);
      if (terminal(entry) || entry.phase.startsWith('parked-')) return entry;
      if (!['ready', 'rebasing', 'publishing', 'waiting-checks'].includes(entry.phase)) throw new Error('invalid rebase phase');
      if (policy?.autonomousExecutionDisabled === true) return progress(entry, fence, 'parked-hold', 'autonomous-execution-disabled');
      // Authoritative terminal state outranks unavailable historical receipts or
      // workspaces. Those failures must never return a closed PR to a closer.
      let live = await read(entry);
      current(entry, fence);
      if (nonempty(live?.subject?.sourceRef) && isDeepStrictEqual(live.subject.lane, entry.lane)
        && live.subject.prNumber === entry.prNumber && ['closed', 'merged'].includes(live.subject.state)) {
        return progress(entry, fence, 'closed-observed', `live-${live.subject.state}`, { rebase: { ...entry.rebase, lastObservation: live } });
      }
      let receipt;
      try { receipt = receipts.receipt(entry); } catch { /* unreadable evidence parks */ }
      if (!receipt) return progress(entry, fence, 'parked-infrastructure', 'admission-receipt-unavailable');
      // Persisted candidates are always re-proved, including after a restart.
      let verified = false;
      if (entry.candidate) {
        try { verified = await verify(entry); } catch { /* Missing objects cannot authorize a new push. */ }
        current(entry, fence);
        if (!verified || entry.rebase.sourceReceiptDigest !== handoffDigest(receipt.input ?? receipt.handoff)) {
          return progress(entry, fence, 'returned-to-closer', 'persisted-rebase-proof-unavailable');
        }
      }
      if (Date.parse(now()) >= Date.parse(entry.patience.deadline)) return progress(entry, fence, 'parked-infrastructure', 'rebase-deadline-expired');
      if (entry.phase === 'ready' && verified) {
        // Admission retains the proven candidate and rejoins the FIFO tail.
        // Resume through legal execution phases without preparing another SHA.
        entry = progress(entry, fence, 'rebasing', 'persisted-candidate-resumed');
        entry = progress(entry, fence, 'publishing', 'candidate-preservation-proven');
      }
      const s = live?.subject;
      if (entry.rebase?.workspace && s?.sourceRef && isDeepStrictEqual(s.lane, entry.lane) && s.prNumber === entry.prNumber
        && (s.headRepository !== entry.rebase.headRepository || s.headRef !== entry.rebase.headRef)) {
        return progress(entry, fence, 'returned-to-closer', 'head-branch-changed');
      }
      if (entry.candidate && s?.head === entry.candidate && s.baseSha === entry.exactBase && s.state === 'open'
        && isDeepStrictEqual(s.lane, entry.lane) && s.prNumber === entry.prNumber && nonempty(s.sourceRef)) {
        // Observation is persisted even after a lost push response. No repush,
        // commit creation or stale CI reuse; checks are owned by the next slice.
        return progress(entry, fence, 'waiting-checks', entry.proof.noop ? 'no-op-rebase' : 'candidate-already-published',
          { rebase: { ...entry.rebase, lastObservation: live, publication: { head: s.head, base: s.baseSha, sourceRef: s.sourceRef, observedAt: now() } } });
      }
      const expected = entry.candidate && s?.head === entry.candidate ? entry.candidate : entry.expectedOldHead;
      // A changed base can be replayed again only from the independently proven
      // published candidate. The complete chain stays in the derivation record.
      const derived = expected !== entry.head && verified;
      const decision = preflight(entry, receipt, live, expected, derived);
      if (decision.phase !== 'ready') return parkOrReturn(entry, fence, decision, live);
      if (entry.candidate && s.head === entry.expectedOldHead) {
        const prior = store.db.prepare("SELECT intent_json,result_json FROM finalization_queue_operation WHERE entry_id=? AND kind='push' ORDER BY rowid DESC").all(entryId)
          .find(op => JSON.parse(op.intent_json).candidate === entry.candidate);
        if (prior && JSON.parse(prior.result_json)?.outcome !== 'not-applied') {
          return progress(entry, fence, 'parked-infrastructure', 'publication-success-not-visible', { rebase: { ...entry.rebase, lastObservation: live } });
        }
      }
      if (!entry.candidate || s.baseSha !== entry.exactBase || s.head === entry.candidate) {
        entry = progress(entry, fence, 'rebasing', 'mechanical-rebase-started');
        let prepared;
        try {
          prepared = await git.prepare({ entry: structuredClone(entry), oldHead: s.head, exactBase: s.baseSha,
            headRepository: s.headRepository, headRef: s.headRef, deadline: entry.patience.deadline });
        } catch (error) {
          current(entry, fence);
          const reason = error?.reason;
          const failedProof = ['unsupported-rebase-history', 'rebase-conflict-or-unsupported', 'rebase-preservation-unproven'].includes(reason);
          return progress(entry, fence, failedProof ? 'returned-to-closer' : 'parked-infrastructure', failedProof ? reason : 'rebase-git-unavailable');
        }
        current(entry, fence);
        const { priorDerivations = [], ...priorRebase } = entry.rebase ?? {};
        const rebase = { workspace: prepared.workspace, headRepository: s.headRepository, headRef: s.headRef,
          sourceReceiptDigest: handoffDigest(receipt.input ?? receipt.handoff),
          // Original signatures/dispositions stay in the immutable receipt;
          // original commit signatures stay in proof.sourceCommits (byte strings).
          sourceEntryHead: entry.head, preflight: live, warning: REBASE_DIVERGENCE_WARNING,
          authorNotice: { key: `rebase-warning:${entry.entryId}:${prepared.candidate}`, audience: 'author', body: REBASE_DIVERGENCE_WARNING },
          priorDerivations: [...priorDerivations, ...(entry.candidate ? [{ candidate: entry.candidate,
            expectedOldHead: entry.expectedOldHead, exactBase: entry.exactBase, proof: entry.proof, rebase: priorRebase }] : [])],
        };
        entry = progress(entry, fence, 'publishing', 'candidate-preservation-proven', { candidate: prepared.candidate,
          expectedOldHead: prepared.expectedOldHead, exactBase: prepared.exactBase, proof: prepared.proof, rebase, checks: null });
      }
      // Fresh live rights, holds, head/base and shared policy before issuance.
      // A concurrent author push after this read still loses the remote CAS.
      live = await read(entry); current(entry, fence);
      if (Date.parse(now()) >= Date.parse(entry.patience.deadline)) return progress(entry, fence, 'parked-infrastructure', 'rebase-deadline-expired');
      if (live?.subject?.head === entry.candidate && live.subject.baseSha === entry.exactBase && live.subject.state === 'open'
        && live.subject.sourceRef && isDeepStrictEqual(live.subject.lane, entry.lane) && live.subject.prNumber === entry.prNumber) {
        return progress(entry, fence, 'waiting-checks', entry.proof.noop ? 'no-op-rebase' : 'candidate-already-published',
          { rebase: { ...entry.rebase, lastObservation: live, publication: { head: live.subject.head, base: live.subject.baseSha,
            sourceRef: live.subject.sourceRef, observedAt: now() } } });
      }
      const next = preflight(entry, receipt, live, entry.expectedOldHead, entry.expectedOldHead !== entry.head);
      if (next.phase !== 'ready') return parkOrReturn(entry, fence, next, live);
      if (live.subject.baseSha !== entry.exactBase) return progress(entry, fence, 'rebasing', 'external-base-change', { checks: null });
      if (live.subject.headRepository !== entry.rebase.headRepository || live.subject.headRef !== entry.rebase.headRef) {
        return progress(entry, fence, 'returned-to-closer', 'head-branch-changed');
      }
      // Durable preflight + immutable candidate/proof precede the owner intent.
      entry = progress(entry, fence, 'publishing', 'publication-preflight-validated', { rebase: { ...entry.rebase, lastObservation: live } });
      let proof;
      try { proof = await verify(entry); } catch { /* fail closed */ }
      current(entry, fence);
      if (!proof) return progress(entry, fence, 'returned-to-closer', 'persisted-rebase-proof-unavailable');
      // Owner deduplicates and journals each attempt. An unresolved intent must
      // be drained/reconciled through owner recovery, never retried here.
      const operationId = `push:${handoffDigest([entryId, entry.progressVersion])}`;
      const issued = await owner.issue({ fence, entryId, operationId, kind: 'push', invoke: async intent => {
        // The issuance lock spans this last read and the complete Git process.
        const lastLive = await read(entry);
        let lastDecision = preflight(entry, receipt, lastLive, entry.expectedOldHead, entry.expectedOldHead !== entry.head);
        if (Date.parse(now()) >= Date.parse(entry.patience.deadline)) lastDecision = { phase: 'parked-infrastructure', reason: 'rebase-deadline-expired' };
        if (lastDecision.phase === 'ready' && lastLive.subject.baseSha !== entry.exactBase) lastDecision = { phase: 'rebasing', reason: 'external-base-change' };
        if (lastDecision.phase === 'ready' && (lastLive.subject.headRepository !== entry.rebase.headRepository || lastLive.subject.headRef !== entry.rebase.headRef)) {
          lastDecision = { phase: 'returned-to-closer', reason: 'head-branch-changed' };
        }
        if (lastDecision.phase !== 'ready') return { outcome: 'not-applied', sourceRef: 'queue:push-not-invoked',
          disposition: lastDecision, observation: lastLive };
        store.assertFence(fence, queueTime(now()));
        if (!isDeepStrictEqual(store.readEntry(entryId), entry)) throw new Error('publication observation superseded');
        let result;
        try { result = await git.push({ entry: structuredClone(entry), intent }); }
        catch { /* A failed/lost response is still ambiguous until observed. */ }
        const observed = await read(entry);
        const subject = observed?.subject;
        // Drained, explicit Git results settle the intent even if the API is
        // unavailable or still exposes the old ref. Unknown transport outcomes
        // continue to require authoritative observation or drain reconciliation.
        if (['succeeded', 'not-applied'].includes(result?.outcome) && result.sourceRef) {
          return { ...result, observation: observed };
        }
        if (!subject?.sourceRef || !isDeepStrictEqual(subject.lane, entry.lane) || subject.prNumber !== entry.prNumber) {
          throw new Error('publication-outcome-unavailable');
        }
        // Live old head alone does not prove a timed-out remote request drained.
        // Without an explicit result only a live candidate proves success.
        if (subject.head !== entry.candidate) {
          throw new Error('publication-requires-drain-reconciliation');
        }
        return { outcome: 'succeeded', sourceRef: subject.sourceRef, observation: observed };
      } });
      if (!issued.ok) return store.readEntry(entryId);
      current(entry, fence);
      const subject = issued.result.observation?.subject;
      const observed = subject?.sourceRef && isDeepStrictEqual(subject.lane, entry.lane) && subject.prNumber === entry.prNumber ? subject : null;
      if (issued.result.disposition) return parkOrReturn(entry, fence, issued.result.disposition, issued.result.observation);
      if (issued.result.outcome === 'not-applied') {
        if (!observed) {
          return progress(entry, fence, 'parked-infrastructure', 'publication-observation-unavailable');
        }
        if (observed?.head !== entry.expectedOldHead) return progress(entry, fence, 'returned-to-closer', 'external-head-change',
          { rebase: { ...entry.rebase, lastObservation: issued.result.observation } });
        return progress(entry, fence, 'parked-infrastructure', 'publication-not-applied',
          { rebase: { ...entry.rebase, lastObservation: issued.result.observation } });
      }
      if (['closed', 'merged'].includes(observed?.state)) return progress(entry, fence, 'closed-observed', `live-${observed.state}`,
        { rebase: { ...entry.rebase, lastObservation: issued.result.observation } });
      if (observed?.state !== 'open') return progress(entry, fence, 'parked-infrastructure', 'publication-lifecycle-unavailable');
      if (observed.head !== entry.candidate && observed.head !== entry.expectedOldHead) {
        return progress(entry, fence, 'returned-to-closer', 'external-head-change',
          { rebase: { ...entry.rebase, lastObservation: issued.result.observation } });
      }
      if (!observed || observed.baseSha !== entry.exactBase) return progress(entry, fence, 'rebasing', 'external-base-change', { checks: null });
      return progress(entry, fence, 'waiting-checks', 'candidate-published', { rebase: { ...entry.rebase,
        publication: { head: entry.candidate, base: entry.exactBase, sourceRef: issued.result.sourceRef, observedAt: now() },
        lastObservation: issued.result.observation } });
    },
  };
}
