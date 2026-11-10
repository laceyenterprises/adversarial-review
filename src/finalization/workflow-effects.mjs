import { createHash } from 'node:crypto';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { makeFinalizationEvent } from './ledger-events.mjs';
import { fold } from './ledger-fold.mjs';

// These ports adapt existing custody teardown, PMA and Sentinel routes. Missing
// capabilities retain the workflow owner and deadline; they never fake success.
export function createWorkflowEffects({ ledgerStore, recoverySurface, deliverySurface, pageSurface }) {
  const invoke = async (fn, args) => {
    try {
      return await readQueueEvidence({ read: fn }, args, loadAwareTimeoutMs(5000, { maxMs: 30000 }));
    } catch { return null; }
  };
  const emit = (subject, at, type, fields) => ledgerStore.append(makeFinalizationEvent(type, subject, {
    at, sourceRef: `executor:${type}`, idempotencyKey: `${type}:${type === 'decision_anchored' ? fields.episode : createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`,
    ...fields,
  }));

  async function page(subject, decision, at) {
    const state = fold(ledgerStore.read(subject));
    if (state.workflow.pages[decision.episode]) return { delivered: true };
    if (!pageSurface?.deliver) return { delivered: false, reason: 'existing-page-route-unavailable' };
    const receipt = await invoke(args => pageSurface.deliver(args), { subject, decision, idempotencyKey: decision.episode, observedAt: at, deadline: decision.deadline });
    if (!receipt?.delivered || !receipt.sourceRef) return { delivered: false };
    emit(subject, at, 'page_delivered', { episode: decision.episode, receipt: receipt.sourceRef, sourceRef: receipt.sourceRef });
    return { delivered: true };
  }

  async function recover(subject, decision, at) {
    if (!recoverySurface?.reconcile) return { ok: false, reason: 'recovery-capability-unavailable' };
    // Reconcile controls before replay, including a timeout after their effect.
    const result = await invoke(args => recoverySurface.reconcile(args), { subject, decision, observedAt: at, deadline: decision.deadline, idempotencyKey: `${decision.episode}:${decision.nextAction}` });
    if (!result?.sourceRef) return { ok: false, reason: 'recovery-evidence-unavailable' };
    if (decision.nextAction === 'recover-custody') {
      const custody = decision.custody;
      const patch = fold(ledgerStore.read(subject)).workflow.patches[custody.sourceRef];
      // The host adapter owns exact-holder probing, salvage, successor custody
      // and the existing teardown. It must return all four durable receipts.
      if (result.custodySourceRef !== custody.sourceRef || !result.patchRef || patch?.patchRef !== result.patchRef
        || !result.successor || result.teardown !== 'completed') {
        return { ok: false, reason: 'custody-transfer-unverified' };
      }
      emit(subject, at, 'custody_recovered', result);
    }
    for (const event of result.events ?? []) {
      // All returned observations cross the ordinary strict append boundary.
      if (event.subjectKey?.domainId !== subject.domainId
        || event.subjectKey?.subjectExternalId !== subject.subjectExternalId) throw new Error('foreign recovery observation');
      ledgerStore.append(makeFinalizationEvent(event.type, event.subjectKey, event));
    }
    return result;
  }

  async function deliver(subject, decision, at) {
    const state = fold(ledgerStore.read(subject));
    const merge = state.workflow.merge;
    if (!merge || !deliverySurface?.reconcile) return { ok: false, reason: 'post-merge-delivery-unavailable' };
    const result = await invoke(args => deliverySurface.reconcile(args), {
      subject, merge, idempotencyKey: `pma:${merge.sourceRef}`, observedAt: at, deadline: decision.deadline,
    });
    if (!result?.sourceRef || !result.planRunId || !result.activation) {
      return { ok: false, reason: 'post-merge-receipt-unavailable' };
    }
    emit(subject, at, 'delivery_observed', { ...result, mergeSourceRef: merge.sourceRef });
    return { ok: ['verified', 'not-required'].includes(result.activation), ...result };
  }
  return { page, recover, deliver, emit };
}
