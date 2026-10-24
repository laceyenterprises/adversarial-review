// FIFO admission is an ordering/read port, never authority to merge or dispatch.
import { isDeepStrictEqual } from 'node:util';
import { evaluateMergeEligibility } from '../ama/merge-eligibility.mjs';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
import { QUEUE_ACTIONABLE_PHASES, resolveLaneKey } from './ledger-events.mjs';
import { resolveQueueHandoffStore } from './queue-handoff-store.mjs';
import { validateQueueHandoff } from './queue-handoff.mjs';
import { resolveCleanReviewStore } from './queue-clean-review.mjs';
import { queueTime } from './queue-store.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { readQueueEvidence } from './queue-read.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const sameSha = (a, b) => sha(a) && sha(b) && a.toLowerCase() === b.toLowerCase();
const terminal = phase => ['merged', 'closed-observed', 'returned-to-closer'].includes(phase);
const parked = phase => phase.startsWith('parked-');
const disposition = (phase, reason) => ({ phase, reason });

// Execution may supply a mechanically verified derivation from the immutable
// admission head. It reuses structural policy without inventing a new review
// or rebinding the signed current-head review to the derived SHA.
export function classifyQueueAdmission(entry, receipt, live, derivation = null) {
  const s = live?.subject;
  if (!text(s?.sourceRef) || !isDeepStrictEqual(s.lane, entry.lane) || s.prNumber !== entry.prNumber) {
    return disposition('parked-infrastructure', 'subject-unavailable');
  }
  // Lifecycle reconciliation needs no review, labels, closer, or merge call.
  if (['closed', 'merged'].includes(s.state)) return disposition('closed-observed', `live-${s.state}`);
  if (s.state !== 'open' || !sha(s.head) || !sha(s.baseSha)) return disposition('parked-infrastructure', 'subject-unavailable');
  if (!sameSha(s.head, derivation?.head ?? entry.head)) return disposition('returned-to-closer', 'external-head-change');
  if (!Array.isArray(s.labels) || s.labels.some(l => !text(typeof l === 'string' ? l : l?.name))) {
    return disposition('parked-hold', 'labels-unavailable');
  }
  const labels = s.labels.map(l => typeof l === 'string' ? l : l.name);
  if (isOperatorHeld(labels)) return disposition('parked-hold', 'operator-hold');
  if (!receipt) return disposition('parked-infrastructure', 'admission-receipt-unavailable');
  if (!derivation && (receipt.kind === 'clean' || receipt.handoff.dispositions.length === 0)) {
    const review = live.currentReview;
    if (review?.complete !== true || !text(review.sourceRef)) return disposition('parked-infrastructure', 'current-head-review-unavailable');
    if (String(review.id) !== String((receipt.input ?? receipt.handoff).sourceReview.id) || !sameSha(review.commitId, s.head)
      || review.verdict !== 'settled-success' || !Array.isArray(review.findings) || review.findings.length) {
      return disposition('returned-to-closer', 'current-head-review-not-clean');
    }
  }
  if (live.identity?.ok !== true || !text(live.identity.sourceRef)) return disposition('parked-infrastructure', 'identity-unavailable');
  if (!text(live.permission?.sourceRef) || typeof live.permission.canPush !== 'boolean') return disposition('parked-permission', 'write-permission-unavailable');
  if (!live.permission.canPush) return disposition('parked-permission', 'write-permission-denied');
  if (!text(live.structuralSourceRef) || !live.eligibility) return disposition('parked-infrastructure', 'structural-eligibility-unavailable');
  // Retain the primary-change evidence's exact spelling for the shared predicate
  // only when it names this same head. Never rewrite signed/nested evidence.
  const primaryHead = live.eligibility.primaryChange?.headSha;
  const candidateHead = sameSha(primaryHead, s.head) ? primaryHead : s.head;
  const eligibility = evaluateMergeEligibility({ ...live.eligibility,
    // Ordering uses the real owner fence in the caller. Checks and BEHIND are
    // execution-stage inputs; they are retained below, never turned green.
    leaseHeld: true, labels, prState: 'OPEN', candidateHead,
    validatedHead: candidateHead, requirePrimaryChange: true,
    verdict: receipt.kind === 'clean' ? 'settled-success' : 'ham_terminal_remediation_validated',
  });
  const reasons = eligibility.reasons.filter(reason => reason !== 'ci-not-green'
    && !(reason === 'pr-not-mergeable' && live.eligibility.mergeable === 'MERGEABLE'
      && live.eligibility.mergeStateStatus === 'BEHIND'));
  const closerReason = reasons.find(reason => reason === 'primary-change-reverted'
    || (reason === 'pr-not-mergeable' && live.eligibility.mergeable === 'CONFLICTING'));
  if (closerReason) return disposition('returned-to-closer', closerReason);
  if (reasons.length) return disposition('parked-infrastructure', reasons[0]);
  return { phase: 'ready', reason: 'admission-validated', eligibility };
}

export function resolveQueueAdmissionAdapters(store) {
  const handoffs = resolveQueueHandoffStore(store), clean = resolveCleanReviewStore(store);
  return { name: 'app-store-fifo-admission-v1',
    receipt(entry) {
      const direct = clean.read(entry.entryId);
      if (direct) return { kind: 'clean', ...direct };
      const receipt = handoffs.read(entry);
      if (!receipt) return null;
      if (receipt.ack.entryId !== entry.entryId) throw new Error('foreign admission receipt');
      validateQueueHandoff(receipt.handoff, receipt.evidence);
      return { kind: 'remediated', ...receipt };
    },
    order(lane) {
      const all = store.entries(resolveLaneKey(lane));
      return { actionable: all.filter(e => QUEUE_ACTIONABLE_PHASES.includes(e.phase)),
        parked: all.filter(e => parked(e.phase)), terminal: all.filter(e => terminal(e.phase)) };
    },
  };
}

/** Trusted live adapter must freshly resolve subject/head/base/complete labels,
 * identity, branch rights, rules and existing primary-change/structural inputs.
 * Clean admissions additionally read the final current-head review; complete
 * terminal adjudications use the immutable MGQ-02 exception without re-review.
 * No default credentials, production routing, model judgement or mutation.
 */
export function createQueueAdmissionService({ store, liveAdapter, now = () => new Date().toISOString(), load } = {}) {
  const adapters = resolveQueueAdmissionAdapters(store);
  return { adapterName: adapters.name, order: adapters.order,
    async reconcile({ fence, entryId, deadline }) {
      const entry = store.readEntry(entryId);
      if (!entry || !isDeepStrictEqual(entry.lane, resolveLaneKey(fence.lane))) throw new Error('foreign queue entry');
      store.assertFence(fence, queueTime(now()));
      if (terminal(entry.phase)) return entry;
      if (!['acknowledged', 'ready'].includes(entry.phase) && !parked(entry.phase)) throw new Error('entry belongs to execution recovery');
      const started = queueTime(now());
      deadline = deadline == null ? entry.patience.deadline : queueTime(deadline);
      deadline = new Date(Math.min(Date.parse(deadline), Date.parse(entry.patience.deadline))).toISOString();
      const wait = queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: started, load });
      let live = null, receipt = null, decision;
      if (wait) {
        try { receipt = adapters.receipt(entry); } catch { /* Lifecycle reads still reconcile terminal PRs. */ }
        try {
          live = await readQueueEvidence(liveAdapter, { entry, kind: receipt?.kind ?? null }, wait);
        } catch { /* Unknown evidence parks, never dispatches. */ }
      }
      const at = queueTime(now());
      if (Date.parse(at) >= Date.parse(deadline)) decision = disposition('parked-infrastructure', 'admission-deadline-expired');
      else decision = classifyQueueAdmission(entry, receipt, live);
      // Snapshot CAS spans the await: a late recovery cannot overwrite a newer
      // hold, terminal observation, or recovery, even after an ABA phase cycle.
      const priorWait = store.db.pragma('busy_timeout', { simple: true });
      store.db.pragma(`busy_timeout = ${queueWaitMs(5_000, { ceilingMs: 30_000, deadline, now: at, load })}`);
      try { return store.tx(() => {
        store.assertFence(fence, queueTime(now()));
        const current = store.readEntry(entryId);
        if (!isDeepStrictEqual(current, entry)) return current;
        if (Date.parse(now()) >= Date.parse(deadline)) decision = disposition('parked-infrastructure', 'admission-deadline-expired');
        if (decision.phase === 'ready' && !parked(entry.phase)
          && adapters.order(entry.lane).actionable[0]?.entryId !== entryId) return current;
        if (decision.phase === entry.phase && decision.reason === entry.reason) return current;
        return store.progress({ fence, entryId, phase: decision.phase, at: queueTime(now()), expectedEntry: entry,
          readmit: parked(entry.phase) && decision.phase === 'ready', patch: {
            reason: decision.reason, admission: { kind: receipt?.kind ?? null, observedAt: at,
              subject: live?.subject ?? null, structuralSourceRef: live?.structuralSourceRef ?? null,
              eligibility: decision.eligibility ?? null, currentReview: live?.currentReview ?? null,
              identity: live?.identity ?? null, permission: live?.permission ?? null },
          } });
      }); } finally { store.db.pragma(`busy_timeout = ${priorWait}`); }
    },
  };
}
