// Subject workflow facts supplement review evidence; no host I/O belongs here.
export const WORKFLOW_EVENT_FIELDS = Object.freeze({
  decision_anchored: ['episode', 'anchorAt', 'nominalMs', 'effectiveMs', 'ceilingMs', 'policyVersion', 'codeVersion', 'loadEvidence'],
  work_consumed: ['workId', 'outcome', 'operationId'],
  worker_killed: ['operationId', 'cause'],
  mergeability_observed: ['revisionRef', 'mergeability'],
  provenance_observed: ['revisionRef', 'builderBoundary', 'primaryChange', 'hammerCommits', 'mergeMain'],
  merge_observed: ['mergedRevision', 'principal', 'planRequired'],
  delivery_observed: ['mergeSourceRef', 'planRunId', 'activation'],
  custody_patch_recorded: ['custodySourceRef', 'patchRef'],
  custody_recovered: ['custodySourceRef', 'patchRef', 'teardown', 'successor'],
  page_delivered: ['episode', 'receipt'],
  evidence_refreshed: ['generation'],
  operation_requested: ['operationId', 'action', 'revisionRef'],
  operation_observed: ['operationId', 'outcome', 'result'],
});

export function initialWorkflow() {
  return { anchors: {}, work: {}, kills: {}, custody: {}, recoveries: {}, patches: {}, pages: {},
    provenance: null, mergeability: null, merge: null, delivery: null,
    operations: {}, unknown: false, primaryUnknown: false, escalation: null };
}

export function foldWorkflow(state, event) {
  const w = state.workflow;
  switch (event.type) {
    case 'decision_anchored':
      // Polls, replay and phase changes cannot slide an episode.
      w.anchors[event.episode] ??= { ...event };
      break;
    case 'evidence_refreshed': w.unknown = false; break;
    case 'remediation_concluded':
      if (event.workId && event.sourceRef && event.outcome === 'completed') w.work[event.workId] ??= { ...event };
      break;
    case 'work_consumed':
      // Only a typed useful conclusion can spend the single subject budget.
      if (['completed', 'findings'].includes(event.outcome)) w.work[event.workId] ??= { ...event };
      break;
    case 'worker_killed': w.kills[event.operationId] = { ...event }; break;
    case 'operation_requested': w.operations[event.operationId] ??= { intent: { ...event }, observation: null }; break;
    case 'operation_observed':
      if (w.operations[event.operationId]) w.operations[event.operationId].observation = { ...event };
      break;
    case 'launch_custody_observed': {
      const previous = Object.hasOwn(w.custody, event.custody.launchRequestId) ? w.custody[event.custody.launchRequestId] : null;
      if (!previous || Date.parse(event.at) >= Date.parse(previous.at)) {
        Object.defineProperty(w.custody, event.custody.launchRequestId, { value: { ...event }, enumerable: true, configurable: true, writable: true });
      }
      break;
    }
    case 'custody_patch_recorded': w.patches[event.custodySourceRef] ??= { ...event }; break;
    case 'custody_recovered': w.recoveries[event.custodySourceRef] = { ...event }; break;
    case 'mergeability_observed': w.mergeability = { ...event }; break;
    case 'provenance_observed':
      if (w.provenance && w.provenance.builderBoundary !== event.builderBoundary) {
        w.primaryUnknown = true;
      }
      w.provenance = { ...event };
      // Once merge-main hides hammer changes, later observations cannot prove
      // primary preservation against the original immutable builder boundary.
      w.primaryUnknown ||= event.mergeMain === true && event.hammerCommits === true;
      break;
    case 'merge_observed': w.merge ??= { ...event }; break;
    case 'delivery_observed':
      if (w.merge?.sourceRef === event.mergeSourceRef) w.delivery = { ...event };
      break;
    case 'page_delivered': w.pages[event.episode] ??= { ...event }; break;
    case 'escalated': w.escalation = { ...event }; break;
    default: break;
  }
}
