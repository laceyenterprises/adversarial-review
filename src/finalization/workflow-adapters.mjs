// Existing deployment/PMA and alert routes remain the effect owners. These
// adapters translate receipts; enqueueing a page or a plan is not completion.
export function createWorkflowPageSurface({ deliver, env = process.env } = {}) {
  return { async deliver({ subject, decision, idempotencyKey }) {
    let send = deliver;
    if (!send) {
      if (process.env.NODE_TEST_CONTEXT) throw new Error('offline page transport required');
      send = (await import('../alert-delivery.mjs')).deliverAlert;
    }
    const match = /^(.*)#([1-9][0-9]*)$/.exec(subject.subjectExternalId);
    if (!match) return { delivered: false };
    const result = await send(`Merge lane recovery: ${match[1]} PR ${match[2]}: ${decision?.reason || 'authoritative evidence unavailable'}`, {
      env, event: 'finalization.queue.infrastructure', payload: {
        repo: match[1], pr: Number(match[2]), head: decision?.revisionRef ?? null,
        base: null, dependency: decision?.nextAction ?? 'refresh-evidence',
        reason: decision?.reason ?? 'authoritative evidence unavailable',
        causeKey: `${subject.domainId}:${subject.subjectExternalId}:${idempotencyKey}`,
        owner: decision?.owner ?? { kind: 'workflow', id: 'finalization-evidence-recovery' },
        nextAction: decision?.nextAction ?? 'refresh-evidence', deadline: decision?.deadline ?? null,
      },
    });
    return { delivered: result?.status === 'delivered', sourceRef: result?.id ? `existing-alert:${result.id}` : null };
  } };
}

export function createPostMergeDeliverySurface({ handoff, observe }) {
  return { async reconcile(request) {
    if (typeof handoff !== 'function' || typeof observe !== 'function') return null;
    const admitted = await handoff(request); // Existing PMA/DAG uses this stable key.
    if (!admitted?.planRunId || !admitted.sourceRef) return null;
    const receipt = await observe({ ...request, planRunId: admitted.planRunId });
    if (receipt?.planRunId !== admitted.planRunId || receipt?.mergeSourceRef !== request.merge.sourceRef
      || !receipt.sourceRef) return null;
    return receipt;
  } };
}
