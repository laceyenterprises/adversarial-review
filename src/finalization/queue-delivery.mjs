// Stable-key adapters into the EXISTING post-merge accounting and closure audit
// paths. The outbox retries these; each adapter is idempotent by delivery key,
// so a lost receipt write or a restart cannot double an action or accounting.
import { writeMergeActionReceipt } from '../ama/merge-action-receipt.mjs';
import { appendAmaAuditAttempt } from '../ama/audit.mjs';

export const QUEUE_DELIVERY_KINDS = Object.freeze(['merge-action-receipt', 'closure-audit']);

export function queueDeliveryPayloads(receipt) {
  const base = { repo: receipt.lane.repository, prNumber: receipt.prNumber, headSha: receipt.newHead };
  const key = kind => `delivery:${kind}:${receipt.entryId}:${receipt.merge.mergeSha}`;
  return [
    { kind: 'merge-action-receipt', key: key('merge-action-receipt'), payload: { ...base, merged: true,
      executedAt: receipt.merge.mergedAt, producerClass: receipt.attribution.bot.producerClass,
      action: 'gh pr merge', deliveryKey: key('merge-action-receipt') } },
    { kind: 'closure-audit', key: key('closure-audit'), payload: { ...base, now: receipt.merge.mergedAt,
      metadata: { closureAuthority: 'merge-queue-v2' },
      attempt: { outcome: 'succeeded', deliveryKey: key('closure-audit'), attemptPhase: 'queue-squash-merge',
        reviewedHead: receipt.oldHead, validatedHead: receipt.newHead, rebasedOntoBase: receipt.base,
        mergeMethod: receipt.merge.method, mergeCommitSha: receipt.merge.mergeSha, mergedAt: receipt.merge.mergedAt,
        mergedBy: receipt.merge.mergedBy, receiptDigest: receipt.digest, queueEntryId: receipt.entryId } } },
  ];
}

export function createQueueMergeActionDelivery({ hqRoot, write = writeMergeActionReceipt }) {
  return { name: 'existing-merge-action-receipt', read({ payload }) {
    const path = write({ hqRoot, ...payload });
    return { id: payload.deliveryKey, sourceRef: `merge-action:${payload.deliveryKey}`, delivered: Boolean(path) };
  } };
}

export function createQueueClosureAuditDelivery({ hqRoot, append = appendAmaAuditAttempt }) {
  return { name: 'existing-ama-closure-audit', read({ payload }) {
    const { attempt, metadata, now, ...subject } = payload;
    const result = append({ hqRoot, ...subject, attempt, metadata, now });
    return { id: attempt.deliveryKey, sourceRef: `ama-audit:${attempt.deliveryKey}`, replay: result?.replay === true };
  } };
}
