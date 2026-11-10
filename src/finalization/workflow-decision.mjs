import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

export function workflowEpisode(state, policy) {
  const pending = state.remediation.dispatched.find(d => d.revisionRef === state.currentRevision
    && !state.remediation.concluded.some(c => c.revisionRef === d.revisionRef && c.round === d.round));
  return JSON.stringify([state.currentRevision, policy.policyVersion, policy.codeVersion,
    state.operatorOverrides.length, pending?.operationId ?? null]);
}

// Clock/load enter as observations. Never sample host state in a pure fold.
export function workflowDecision(state, policy, observation, core) {
  const w = state.workflow;
  const at = observation.observedAt ?? state.lastEventAt;
  const head = state.currentRevision ?? '';
  const episode = workflowEpisode(state, policy);
  const persisted = w?.anchors[episode];
  const nominalMs = Math.max(policy.checksPatienceMs, policy.verdictPatienceMs, policy.attestationPatienceMs);
  const ceilingMs = Math.max(nominalMs, policy.deadlineCeilingMs);
  const effectiveMs = persisted?.effectiveMs ?? loadAwareTimeoutMs(nominalMs, {
    enabled: true, maxMultiplier: 6, loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100,
    ...observation.load, maxMs: ceilingMs,
  });
  const pending = state.remediation.dispatched.find(d => d.revisionRef === head
    && !state.remediation.concluded.some(c => c.revisionRef === head && c.round === d.round));
  const anchorAt = persisted?.anchorAt ?? pending?.admittedAt
    ?? state.revisions?.[head]?.revisionAdvancedAt ?? state.lastEventAt ?? at;
  const deadline = Number.isFinite(Date.parse(anchorAt))
    ? new Date(Date.parse(anchorAt) + effectiveMs).toISOString() : null;
  const base = { subjectKey: state.subjectKey, revisionRef: head, observedAt: at,
    episode, deadline, anchorAt, nominalMs, effectiveMs, ceilingMs, policyVersion: policy.policyVersion, codeVersion: policy.codeVersion,
    loadEvidence: persisted?.loadEvidence ?? { loadAvg1m: 0, cpuCount: 1, cpuBusyPercent: 100, ...observation.load },
    owner: { kind: 'workflow', id: 'finalization-executor', head },
    nextAction: 'observe', evidence: [w?.provenance?.sourceRef, w?.mergeability?.sourceRef, state.revisions?.[head]?.checks?.sourceRef,
      ...(state.revisions?.[head]?.verdicts ?? []).map(v => v.sourceRef),
      ...Object.values(w?.custody ?? {}).map(c => c.sourceRef)].filter(Boolean) };
  const D = (kind, nextAction, reason, extra = {}) => ({ ...base, kind, nextAction, reason, ...extra });
  const blocked = (action, reason, extra = {}) => D('wait', action, reason, extra);
  if (state.terminal?.kind === 'closed' || state.finalized) return { ...base, ...core, nextAction: 'settled' };
  if (w?.merge) {
    const delivery = w.delivery;
    if (delivery && (delivery.activation === 'verified'
      || (!w.merge.planRequired && delivery.activation === 'not-required'))) {
      return D('finalize-now', 'settle-delivery', 'merge and delivery verified');
    }
    return blocked('deliver', 'merged; post-merge activation pending', {
      owner: { kind: 'workflow', id: 'post-merge-delivery', head },
    });
  }
  if (policy.autonomousExecutionDisabled) return D('escalate', 'monitor-hold', 'autonomous execution disabled');
  const override = state.operatorOverrides?.at(-1);
  if (override?.overrideKind === 'halt') return D('halt', 'monitor-hold', override.reason);
  if (override?.overrideKind === 'close') return { ...base, ...core, nextAction: 'close' };
  if (state.terminal?.kind === 'halted'
    && !(state.terminal.codeVersion && state.terminal.codeVersion !== policy.codeVersion)
    && !(state.terminal.policyVersion && state.terminal.policyVersion !== policy.policyVersion)) {
    return blocked('recover-coverage', state.terminal.reason ?? 'automated stop requires relevant evidence');
  }
  if (w?.unknown) return blocked('refresh-evidence', 'unknown safety-relevant event');
  for (const custody of Object.values(w?.custody ?? {})) {
    const c = custody.custody;
    if (Object.hasOwn(w.recoveries, custody.sourceRef)) continue;
    const age = Date.parse(at) - Date.parse(custody.at);
    const fresh = age >= 0 && age <= c.freshnessSeconds * 1000;
    // A launch from another head can still hold this branch. Never ignore it.
    if (c.state === 'workspace') {
      if (fresh && c.launchLiveness === 'terminal' && c.dirty === true) {
        return blocked('recover-custody', 'terminal launch retains dirty workspace', { custody });
      }
      return blocked('reconcile-custody', 'workspace release requires exact holder evidence', { custody });
    }
    if (['requested', 'admitted', 'leased', 'starting', 'running', 'waiting_approval', 'waiting_input', 'suspended'].includes(c.state)) {
      if (!fresh) return blocked('reconcile-custody', 'launch observation expired', { custody });
      if (c.state === 'running' && c.verified === true && c.progressRef && custody.revisionRef === head) {
        return blocked('monitor-agent', 'verified launch in progress', {
          owner: { kind: 'agent', id: c.launchRequestId, head, verified: true, status: 'running' }, custody,
        });
      }
      return blocked('reconcile-custody', 'launch requires verified progress', { custody });
    }
  }
  const killed = Object.values(w?.kills ?? {}).find(kill => !['absent', 'completed', 'merged'].includes(w.operations[kill.operationId]?.observation?.outcome));
  if (killed) return blocked('reconcile-effects', 'worker kill requires effect reconciliation', { operationId: killed.operationId });
  const unresolved = Object.values(w?.operations ?? {}).find(op => !op.observation);
  if (unresolved) return blocked('reconcile-effects', 'operation effect requires readback', { operationId: unresolved.intent.operationId });
  if (w?.provenance && (w.provenance.revisionRef !== head || w.primaryUnknown || w.provenance.primaryChange !== 'preserved')) {
    return blocked('recover-primary', 'primary-change evidence unknown');
  }
  if (w?.mergeability?.revisionRef === head) {
    if (['DIRTY', 'CONFLICTING'].includes(w.mergeability.mergeability)) {
      return blocked(w.provenance?.hammerCommits ? 'merge-main' : 'conflict-rebase', 'conflict requires owned repair');
    }
    if (w.mergeability.mergeability !== 'MERGEABLE') return blocked('refresh-evidence', 'mergeability unknown');
  }
  if (pending) return blocked('reconcile-dispatch', 'remediation admission or completion pending', { operationId: pending.operationId });
  if (core.kind === 'halt') return blocked('recover-coverage', 'failed final remediation requires recovery');
  if (core.kind === 'finalize-now' && !w?.provenance) {
    return blocked('recover-primary', 'primary-change provenance unavailable');
  }
  return { ...base, ...core, deadline,
    nextAction: core.kind === 'remediate' ? 'dispatch-remediation'
      : core.kind === 'finalize-now' ? 'merge' : core.kind === 'halt' ? 'recover-coverage' : 'refresh-evidence',
    mergeMethod: w?.provenance?.hammerCommits ? 'merge' : 'squash' };
}

export function projectWorkflow(state, decision, observedAt) {
  const due = Date.parse(decision.deadline);
  return { subjectKey: state.subjectKey, head: state.currentRevision,
    state: state.finalized ? 'finalized' : state.workflow?.merge ? 'delivery' : decision.kind,
    owner: decision.owner, nextAction: decision.nextAction, deadline: decision.deadline,
    overdueMs: Number.isFinite(due) ? Math.max(0, Date.parse(observedAt) - due) : null,
    episode: decision.episode, reason: decision.reason, evidence: decision.evidence, generation: state.eventCount, observedAt,
    policyVersion: decision.policyVersion, codeVersion: decision.codeVersion,
    pageAcknowledged: Boolean(state.workflow?.pages[decision.episode]),
    freshnessMs: Math.max(0, Date.parse(observedAt) - Date.parse(state.lastEventAt)) };
}
