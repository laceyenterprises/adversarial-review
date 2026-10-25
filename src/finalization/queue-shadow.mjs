// Pure predictions over observations. No executor, owner, Git or delivery port.
import { isDeepStrictEqual } from 'node:util';
import { classifyQueueAdmission, resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { classifyQueueChecks } from './queue-check-reader.mjs';
import { foldQueue } from './ledger-fold.mjs';
import { QUEUE_ACTIONABLE_PHASES, resolveLaneKey } from './ledger-events.mjs';
import { handoffDigest } from './queue-handoff.mjs';

export const QUEUE_SHADOW_ADAPTER = 'app-store-queue-shadow-v1';
const same = (a, b) => typeof a === 'string' && a.length > 0 && a.toLowerCase() === b?.toLowerCase();

// The existing receipt adapters only read. Deliberately expose no store handle
// or claim/progress methods to the consumer. The caller owns the read-only DB.
export function resolveQueueShadowAdapter({ db }) {
  if (!db.readonly) throw new Error('shadow requires a read-only database');
  const entry = db.prepare('SELECT payload_json FROM finalization_queue_entry WHERE entry_id=?');
  const events = db.prepare('SELECT payload_json FROM finalization_queue_event WHERE repository=? AND base=? ORDER BY seq');
  const receipts = resolveQueueAdmissionAdapters({ db });
  return { name: QUEUE_SHADOW_ADAPTER, mode: 'observe', read(entryId) {
    return db.transaction(() => {
      const row = entry.get(entryId);
      if (!row) throw new Error('shadow entry unavailable');
      const value = JSON.parse(row.payload_json);
      return { entry: value, receipt: receipts.receipt(value),
        queueEvents: events.all(value.lane.repository, value.lane.base).map(r => JSON.parse(r.payload_json)) };
    })();
  } };
}

export function predictQueueShadow(snapshot, { observedAt, policy, ledgerState } = {}) {
  const { entry, receipt, live, checks, derivation, identity, queueEvents } = snapshot;
  const lane = resolveLaneKey(entry.lane);
  if (!Array.isArray(queueEvents) || queueEvents.some(e => !isDeepStrictEqual(e.lane, lane)
    || !Number.isFinite(Date.parse(e.at)) || Date.parse(e.at) > Date.parse(observedAt))) throw new Error('invalid shadow event window');
  const replay = foldQueue(queueEvents);
  if (!isDeepStrictEqual(replay.entries[entry.entryId], entry)) throw new Error('shadow queue fold mismatch');
  const order = Object.values(replay.entries).filter(e => isDeepStrictEqual(e.lane, lane)
    && QUEUE_ACTIONABLE_PHASES.includes(e.phase)).sort((a, b) => a.readinessSeq - b.readinessSeq || a.entryId.localeCompare(b.entryId));
  const position = order.findIndex(e => e.entryId === entry.entryId) + 1;
  const derived = same(live?.subject?.head, entry.candidate) && !same(entry.candidate, entry.head);
  const proof = derivation?.verified === true && derivation.sourceRef && same(derivation.head, entry.candidate)
    && same(derivation.base, entry.exactBase) && derivation.receiptDigest === handoffDigest(receipt?.input ?? receipt?.handoff ?? null);
  let admission = classifyQueueAdmission(entry, receipt, live, derived && proof ? { head: entry.candidate } : null);
  if (derived && !proof && live?.subject?.state === 'open') admission = { phase: 'parked-infrastructure', reason: 'shadow-derivation-unavailable' };
  const check = same(checks?.head, entry.candidate) && same(checks?.base, entry.exactBase)
    ? classifyQueueChecks(checks) : { kind: 'wait', reason: 'checks-unreadable' };
  let proposed = { kind: 'wait', reason: 'predecessor-active' };
  let rebase = 'not-ready', finalEligibility = 'unknown';
  if (admission.phase === 'closed-observed') proposed = { kind: 'wait', reason: admission.reason };
  else if (admission.phase === 'returned-to-closer') proposed = { kind: 'remediate', reason: admission.reason };
  else if (admission.phase !== 'ready') proposed = { kind: 'wait', reason: admission.reason };
  else if (position === 1) {
    const baseMoved = !same(live.subject.baseSha, entry.exactBase) || live.eligibility?.mergeStateStatus === 'BEHIND';
    rebase = baseMoved || !entry.candidate ? 'propose-rebase' : 'observed-candidate';
    proposed = { kind: 'wait', reason: rebase === 'propose-rebase' ? 'rebase-required' : check.reason };
    if (rebase !== 'propose-rebase') {
      if (check.kind === 'red') proposed = { kind: 'remediate', reason: check.reason };
      else if (check.kind === 'green') {
        if (!proof) proposed = { kind: 'wait', reason: 'derivation-unverified' };
        else if (identity?.ok !== true || !identity.sourceRef || !identity.login
          || !['closer-hammer', 'ama-daemon'].includes(identity.producerClass)) {
          proposed = { kind: 'wait', reason: 'identity-unresolved' };
        } else if (entry.rebase?.publication?.head !== entry.candidate || entry.rebase.publication.base !== entry.exactBase
          || entry.rebase.sourceReceiptDigest !== derivation.receiptDigest) {
          proposed = { kind: 'wait', reason: 'publication-unverified' };
        } else if (!ledgerState?.terminal) {
          finalEligibility = 'eligible';
          proposed = { kind: 'finalize-now', reason: 'observed queue eligibility; proposal only' };
        }
      }
    }
  }
  if (policy?.autonomousExecutionDisabled === true || ledgerState?.terminal) {
    proposed = { kind: 'wait', reason: ledgerState?.terminal ? 'subject-ledger-terminal' : 'autonomous-execution-disabled' };
    finalEligibility = 'withheld';
  } else if (!['closed-observed', 'merged', 'returned-to-closer'].includes(entry.phase)
    && Date.parse(entry.patience?.deadline) <= Date.parse(observedAt)) {
    proposed = { kind: 'escalate', reason: 'shadow-infrastructure-deadline-expired' };
    finalEligibility = 'withheld';
  }
  return { lane, entryId: entry.entryId, admissionKind: receipt?.kind ?? null,
    phase: entry.phase, head: live?.subject?.head ?? null, base: live?.subject?.baseSha ?? null,
    candidate: entry.candidate, exactBase: entry.exactBase, readinessSeq: entry.readinessSeq,
    position: position || null, order: order.map(e => e.entryId), admission, rebase,
    checks: check, finalEligibility, proposed,
    // The full durable lifecycle supplies denominators and exact interval times.
    lifecycle: queueEvents.filter(e => ['acknowledged', 'progress'].includes(e.type)),
    evidence: { liveSourceRef: live?.subject?.sourceRef ?? null, structuralSourceRef: live?.structuralSourceRef ?? null,
      requiredSetVersion: checks?.requiredSet?.version ?? null, derivationSourceRef: derivation?.sourceRef ?? null,
      identitySourceRef: identity?.sourceRef ?? null } };
}
