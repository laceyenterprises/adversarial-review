import { deriveNextActionSnapshot, nextAction } from '../pr-next-action.mjs';
import { closureOwnerShadowEvidence } from '../pr-next-action-consumer.mjs';
import { registerSharedNextAction, resolveSharedNextAction } from '../pr-next-action-shadow.mjs';
import { observeClosureWait } from './closure-wait.mjs';
import { checkPrimaryChange } from './primary-change.mjs';
import { classifyCheckRollup } from '../checks-summary.mjs';
import { isTransientDaemonDecline } from './daemon-decline.mjs';
import { closureGateFactsKey } from './closure-gate-facts.mjs';

const decisionsByResult = new WeakMap();
export function bindClosureNextAction(result, shared) {
  if (result && shared) decisionsByResult.set(result, shared);
  return result;
}
export const readClosureNextAction = result => decisionsByResult.get(result);

export { closureOwnerFromDecision } from './closure-owner.mjs';

export function closureDecisionMatches(shared, { repo, prNumber, headSha }) {
  return Boolean(shared?.snapshot?.subjectKey === `${repo}#${prNumber}`
    && shared.snapshot.head === headSha && shared.decision?.head === headSha);
}

// Repair intent never replaces the executor's eligibility, arming or lease
// checks. Only this exact subject/head's selected dispatch reaches admission.
export function hasHammerDispatchIntent(shared, identity) {
  const decision = shared?.decision;
  return closureDecisionMatches(shared, identity) && decision.action === 'hammer'
    && decision.actor === 'hammer' && decision.queue?.intent === 'dispatch';
}

// A refreshed executor may invalidate queued intent, but cannot silently turn
// a hammer request into an unrelated refresh. Return the exact replacement pair
// so closure can select its successor once without rebuilding partial evidence.
export function hammerDispatchMismatch(selected, fresh, identity) {
  if (!hasHammerDispatchIntent(selected, identity)
    || (hasHammerDispatchIntent(fresh, identity)
      && selected.decision.decisionKey === fresh.decision.decisionKey)) return null;
  return { dispatched: false, skipMergeAgent: true, recoveryWait: true,
    reason: 'closure-decision-mismatch', nextActionShared: fresh,
    decisionMismatch: {
      selectedKey: selected.decision.decisionKey, selectedGeneration: selected.snapshot.generation,
      resolvedKey: fresh.decision.decisionKey, resolvedGeneration: fresh.snapshot.generation,
      resolvedAction: fresh.decision.action, resolvedReason: fresh.decision.reason,
    } };
}

export async function resolveClosureNextAction({ input, passSnapshot = null, readLaunches, ...options }) {
  const evidence = closureOwnerShadowEvidence(input, options);
  if (readLaunches) evidence.readLaunches = readLaunches;
  const shared = await resolveSharedNextAction({ passSnapshot, evidence, refreshEvidence: true });
  if (options.rootDir && shared.decision.deadline?.anchorSource === 'observed') {
    try {
      const separator = shared.snapshot.subjectKey.lastIndexOf('#');
      const anchor = await observeClosureWait({ rootDir: options.rootDir,
        repo: shared.snapshot.subjectKey.slice(0, separator), prNumber: Number(shared.snapshot.subjectKey.slice(separator + 1)),
        headSha: shared.decision.head, now: Date.parse(shared.snapshot.observedAt),
        reason: `action=${shared.decision.action} actor=${shared.decision.actor} reason=${shared.decision.reason}`,
        anchorOnly: true });
      const snapshot = deriveNextActionSnapshot({ base: shared.snapshot,
        anchors: { firstActionableAt: new Date(anchor.startedAt).toISOString() } });
      return registerSharedNextAction(passSnapshot, Object.freeze({ snapshot, decision: nextAction(snapshot) }));
    } catch { /* Anchor persistence cannot refuse an otherwise authorized action. */ }
  }
  return shared;
}

// Yielding proofs/preflight can change facts within a pass. Keep the previous
// immutable pair intact; publish a new generation for subsequent consumers.
export function reviseClosureNextAction(shared, observations, passSnapshot = null) {
  const changedFields = Object.entries(observations).filter(([name, value]) => {
    if (value === undefined) return false;
    const prior = shared.snapshot.observations[name];
    const wrapped = value && Object.hasOwn(value, 'state') && Object.hasOwn(value, 'value');
    const key = ['pr', 'checks', 'reviews'].includes(name) ? closureGateFactsKey : JSON.stringify;
    return wrapped ? prior?.state !== value.state || key(prior?.value) !== key(value.value)
      : prior?.state !== 'complete' || key(prior?.value) !== key(value);
  }).map(([name]) => name);
  if (!changedFields.length) return registerSharedNextAction(passSnapshot, shared);
  // A refreshed gate supersedes a transient execution observation. Preserve a
  // newly supplied result, unrelated/permanent refusals and other progress. A
  // newly passing primary predicate supersedes its own old refusal only.
  const execution = shared.snapshot.observations.progress?.value?.daemonExecution;
  const progressWrapped = observations.progress && Object.hasOwn(observations.progress, 'state')
    && Object.hasOwn(observations.progress, 'value');
  const progress = progressWrapped ? observations.progress.value : observations.progress;
  const primaryRefreshed = progress?.primaryChange?.ok === true
    && progress.primaryChange.headSha === shared.snapshot.head
    && shared.snapshot.observations.progress?.value?.primaryChange?.ok === false;
  const primaryDeclineSuperseded = primaryRefreshed && execution?.permanent !== true
    && ['not-eligible', 'gate-not-eligible', 'primary-change-needs-operator'].includes(execution?.reason)
    && Array.isArray(execution.reasons) && execution.reasons.length > 0
    && execution.reasons.every(reason => ['primary-change-reverted', 'primary-change-unknown',
      'primary-change-read-failed', 'history-read-failed'].includes(reason));
  if ((primaryDeclineSuperseded || (isTransientDaemonDecline(execution)
    && (primaryRefreshed || changedFields.some(name => ['pr', 'checks', 'reviews'].includes(name)))))
    && (!progressWrapped || observations.progress.state === 'complete')
    && (!Object.hasOwn(progress || {}, 'daemonExecution') || progress.daemonExecution === execution)) {
    const value = { ...shared.snapshot.observations.progress?.value, ...progress, daemonExecution: null };
    observations = { ...observations, progress: progressWrapped ? { ...observations.progress, value } : value };
  }
  const derived = deriveNextActionSnapshot({ base: shared.snapshot,
    head: observations.pr?.headSha || shared.snapshot.head, observations });
  const snapshot = Object.freeze({ ...derived, generation: (shared.snapshot.generation || 0) + 1 });
  return registerSharedNextAction(passSnapshot, Object.freeze({ snapshot, decision: nextAction(snapshot) }));
}

export function revalidateClosurePr(shared, live, { checksConclusion } = {}) {
  live = live && typeof live === 'object' ? live : {};
  const prior = shared.snapshot.observations.pr.value;
  const pr = { ...prior, state: live.state, headSha: live.headSha,
    ...(Object.hasOwn(prior, 'headRefOid') ? { headRefOid: live.headSha } : {}) };
  for (const name of ['isDraft', 'mergeable', 'mergeStateStatus', 'labels']) {
    if (Object.hasOwn(live, name)) pr[name] = live[name];
  }
  if (prior.mergeStateStatus != null && Object.hasOwn(live, 'mergeable') && !Object.hasOwn(live, 'mergeStateStatus')) pr.mergeStateStatus = null;
  const changed = ['state', 'headSha', 'headRefOid', 'isDraft', 'mergeable', 'mergeStateStatus', 'labels'].some(name => {
    const normalize = value => typeof value === 'string' && !['headSha', 'headRefOid'].includes(name) ? value.toUpperCase() : value;
    return JSON.stringify(normalize(pr[name])) !== JSON.stringify(normalize(prior[name]));
  });
  const checks = Array.isArray(live.statusCheckRollup) ? {
    ...shared.snapshot.observations.checks?.value, conclusion: checksConclusion ?? null,
    rollup: live.statusCheckRollup,
  } : null;
  return changed || checks ? reviseClosureNextAction(shared, { pr, ...(checks ? { checks } : {}) }) : shared;
}

// NXA-06: executor observations replace facts, never select a second owner.
// Partial/read-error observations retain their provenance instead of borrowing
// green checks or a head from the preceding generation.
export function observeDaemonGate(shared, live, passSnapshot = null) {
  if (!shared) return shared;
  if (live.readError) return reviseClosureNextAction(shared, {
    pr: { state: 'error', value: null, provenance: { sourceRef: 'daemon-live-gate' } },
  }, passSnapshot);
  const pr = { ...shared.snapshot.observations.pr?.value,
    headSha: live.candidateHead, headRefOid: live.candidateHead, state: live.prState,
    mergeable: live.mergeable, mergeStateStatus: live.mergeStateStatus,
    ...(Array.isArray(live.labels) ? { labels: live.labels } : {}) };
  const requiredContexts = [...new Set([
    ...(shared.snapshot.observations.checks?.value?.requiredContexts || []),
    ...(live.requiredCheckContexts || []),
  ])];
  const checks = { requiredContexts,
    conclusion: live.requiredChecks === true ? 'SUCCESS'
      : live.ciRecoveryPending === true ? 'PENDING'
      : Array.isArray(live.requiredChecks)
        ? classifyCheckRollup(live.requiredChecks, { requiredContexts }) || 'PENDING' : null,
    ...(Array.isArray(live.requiredChecks) ? { rollup: live.requiredChecks } : {}) };
  const primary = live.primaryChange ? checkPrimaryChange(live.primaryChange, live.candidateHead,
    { strictNonBlockingRemediation: (live.strictNonBlockingRemediation
      ?? shared.snapshot.observations.policy?.value?.strictNonBlockingRemediation) !== false }) : null;
  const progress = { ...shared.snapshot.observations.progress?.value,
    ...(primary ? { primaryChange: { ok: primary.ok, reason: primary.reason, headSha: live.candidateHead } } : {}),
    ...(Object.hasOwn(live, 'terminalReviewValidated') ? { terminalReview: { validated: live.terminalReviewValidated === true,
      headSha: live.candidateHead, reviewedHeadSha: shared.snapshot.observations.reviews?.value?.headSha } } : {}) };
  return reviseClosureNextAction(shared, {
    pr: live.candidateHead ? pr : { state: 'unknown', value: null,
      provenance: { sourceRef: 'daemon-live-gate' } }, checks, progress,
  }, passSnapshot);
}

export function observeDaemonResult(shared, result, passSnapshot = null) {
  if (!shared || !result) return shared;
  if (result.remoteMergedConfirmed === true) return reviseClosureNextAction(shared, {
    pr: { ...shared.snapshot.observations.pr.value, state: 'MERGED' },
  }, passSnapshot);
  return reviseClosureNextAction(shared, {
    ...(result.ciMergePathPending === true && !result.merged ? { checks: {
      ...shared.snapshot.observations.checks?.value, conclusion: 'PENDING',
    } } : {}),
    progress: {
      ...shared.snapshot.observations.progress?.value,
      ...(result.exactHeadReview === true ? { terminalReview: null, closerAuthoredStale: {
        decision: 'rereview-exact-head', currentHead: shared.decision.head,
        reviewedHead: shared.snapshot.observations.reviews?.value?.headSha,
      } } : {}),
      ...(result.merged ? { mergeReceipt: { merged: true, headSha: shared.decision.head, path: 'daemon-merge' } }
        : { daemonExecution: { headSha: shared.decision.head, reason: result.reason,
          reasons: result.reasons || [], disposition: result.disposition,
          permanent: result.permanent, attempts: result.attempts || 0 } }),
    },
  }, passSnapshot);
}

// The existing watchdog's absence proof can discover an owner at an older head.
// Fold that observation into a new generation without repeating its I/O.
export function observeClosureOwnership(shared, owner, passSnapshot = null) {
  if (!shared || (!owner?.owned && !owner?.uncertain)) return shared;
  if (owner.owned && owner.actor === 'hammer' && owner.launchProbe) {
    return reviseClosureNextAction(shared, { launches: { closer: {
      headSha: shared.decision.head, launchRequestId: owner.launchRequestId,
      probe: owner.launchProbe,
    } } }, passSnapshot);
  }
  if (owner.owned && owner.lease) return reviseClosureNextAction(shared, {
    leases: { closer: owner.lease },
  }, passSnapshot);
  if (owner.owned && owner.actor === 'reviewer') return reviseClosureNextAction(shared, {
    reviews: { ...shared.snapshot.observations.reviews?.value, reviewerLive: true },
  }, passSnapshot);
  if (owner.owned && owner.actor === 'remediator') return reviseClosureNextAction(shared, {
    remediation: { ...shared.snapshot.observations.remediation?.value,
      job: { status: 'in_progress', headSha: shared.decision.head } },
  }, passSnapshot);
  return reviseClosureNextAction(shared, { leases: { state: 'unknown', value: null,
    provenance: { sourceRef: 'watchdog-ownership' } } }, passSnapshot);
}

// Execution observations invalidate intent; they do not create new refusals.
export function observeClosureResult(shared, result, passSnapshot = null) {
  if (!shared || !result) return shared;
  const policy = shared.snapshot.observations.policy?.value || {};
  if (['hammer-retry-cap-exhausted', 'hammer-lifetime-cap-exhausted'].includes(result.reason)) {
    return reviseClosureNextAction(shared, { policy: { ...policy, hammerCap: {
      ...policy.hammerCap, headSha: shared.decision.head,
      ...(result.reason === 'hammer-lifetime-cap-exhausted' ? { lifetimeExhausted: true } : { retryExhausted: true }),
    } } }, passSnapshot);
  }
  if (result.reason === 'deferred-by-drain') return reviseClosureNextAction(shared, {
    policy: { ...policy, drain: { active: true, epoch: result.drainEpoch } },
  }, passSnapshot);
  if (['existing-dispatch-unknown', 'dispatch-retry-chain-unreadable'].includes(result.reason)) {
    return reviseClosureNextAction(shared, { leases: { state: 'unknown', value: null,
      provenance: { sourceRef: 'closer-intent-reconciliation' } } }, passSnapshot);
  }
  if (['dispatch-retry-exhausted', 'dispatch-branch-holder-block-exhausted'].includes(result.reason)) {
    return reviseClosureNextAction(shared, { controls: { ...shared.snapshot.observations.controls?.value,
      stop: { deterministic: true, fingerprint: result.reason } } }, passSnapshot);
  }
  if (result.capacity) return reviseClosureNextAction(shared, {
    policy: { ...policy, capacity: { ...policy.capacity, hammer: result.capacity } },
  }, passSnapshot);
  if (result.safetyRefusal) return reviseClosureNextAction(shared, {
    controls: { ...shared.snapshot.observations.controls?.value,
      safetyRefusal: { deterministic: true, reason: result.operatorReason || result.reason } },
  }, passSnapshot);
  if (result.hammerStop) return reviseClosureNextAction(shared, {
    controls: { ...shared.snapshot.observations.controls?.value,
      stop: { deterministic: result.hammerStop.deterministic !== false, fingerprint: result.hammerStop.stopKey || result.hammerStop.predicate,
        headSha: result.hammerStop.headSha || shared.decision.head,
        recordedAt: result.hammerStop.recordedAt ?? result.hammerStop.recorded_at ?? null },
      ...(result.hammerStop.refusal ? { safetyRefusal: {
        deterministic: true, reason: result.hammerStop.predicate,
        headSha: result.hammerStop.headSha || shared.decision.head, refusal: result.hammerStop.refusal,
      } } : {}) },
  }, passSnapshot);
  if (result.reason === 'daemon-merged') return observeDaemonResult(shared, result.daemonCleanMerge || { merged: true }, passSnapshot);
  return shared;
}
