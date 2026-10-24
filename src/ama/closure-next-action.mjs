import { deriveNextActionSnapshot, nextAction } from '../pr-next-action.mjs';
import { closureOwnerShadowEvidence } from '../pr-next-action-consumer.mjs';
import { registerSharedNextAction, resolveSharedNextAction } from '../pr-next-action-shadow.mjs';
import { observeClosureWait } from './closure-wait.mjs';

const decisionsByResult = new WeakMap();
export function bindClosureNextAction(result, shared) {
  if (result && shared) decisionsByResult.set(result, shared);
  return result;
}
export const readClosureNextAction = result => decisionsByResult.get(result);

// NXA-05: compatibility outputs describe the selected workflow, including
// recovery. A page or a capacity observation cannot replace its actor.
export function closureOwnerFromDecision(decision) {
  const owner = { review: 'review', remediate: 'remediation', hammer: 'hammer',
    'daemon-merge': 'daemon-merge', 'wait-for-CI': 'wait',
    'operator-hold': 'operator-hold', done: 'done' }[decision.action];
  return Object.freeze({ owner, actor: decision.actor, action: decision.action,
    reason: decision.reason, head: decision.head, deadline: decision.deadline,
    decisionKey: decision.decisionKey, queue: decision.queue });
}

export function closureDecisionMatches(shared, { repo, prNumber, headSha }) {
  return Boolean(shared?.snapshot?.subjectKey === `${repo}#${prNumber}`
    && shared.snapshot.head === headSha && shared.decision?.head === headSha);
}

// Repair intent never replaces the executor's eligibility, arming or lease
// checks. Only this exact subject/head's selected dispatch reaches admission.
export function hasHammerDispatchIntent(shared, identity) {
  const decision = shared?.decision;
  return closureDecisionMatches(shared, identity) && decision.action === 'hammer'
    && decision.actor === 'hammer' && decision.queue.intent === 'dispatch';
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
  const changed = Object.entries(observations).some(([name, value]) => {
    if (value === undefined) return false;
    const prior = shared.snapshot.observations[name];
    const wrapped = value && Object.hasOwn(value, 'state') && Object.hasOwn(value, 'value');
    return wrapped ? prior?.state !== value.state || JSON.stringify(prior?.value) !== JSON.stringify(value.value)
      : prior?.state !== 'complete' || JSON.stringify(prior.value) !== JSON.stringify(value);
  });
  if (!changed) return registerSharedNextAction(passSnapshot, shared);
  const derived = deriveNextActionSnapshot({ base: shared.snapshot,
    head: observations.pr?.headSha || shared.snapshot.head, observations });
  const snapshot = Object.freeze({ ...derived, generation: (shared.snapshot.generation || 0) + 1 });
  return registerSharedNextAction(passSnapshot, Object.freeze({ snapshot, decision: nextAction(snapshot) }));
}

export function revalidateClosurePr(shared, live, { checksConclusion } = {}) {
  live = live && typeof live === 'object' ? live : {};
  const prior = shared.snapshot.observations.pr.value;
  const pr = { ...prior, state: live.state, headSha: live.headSha };
  for (const name of ['isDraft', 'mergeable', 'mergeStateStatus', 'labels']) {
    if (Object.hasOwn(live, name)) pr[name] = live[name];
  }
  const changed = ['state', 'headSha', 'isDraft', 'mergeable', 'mergeStateStatus', 'labels'].some(name => {
    const normalize = value => typeof value === 'string' && name !== 'headSha' ? value.toUpperCase() : value;
    return JSON.stringify(normalize(pr[name])) !== JSON.stringify(normalize(prior[name]));
  });
  const checks = Array.isArray(live.statusCheckRollup) ? {
    ...shared.snapshot.observations.checks?.value, conclusion: checksConclusion ?? null,
    rollup: live.statusCheckRollup,
  } : null;
  return changed || checks ? reviseClosureNextAction(shared, { pr, ...(checks ? { checks } : {}) }) : shared;
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
      stop: { deterministic: true, fingerprint: result.hammerStop.predicate },
      ...(result.hammerStop.refusal ? { safetyRefusal: {
        deterministic: true, reason: result.hammerStop.predicate,
      } } : {}) },
  }, passSnapshot);
  if (result.reason === 'daemon-merged') return reviseClosureNextAction(shared, {
    pr: { ...shared.snapshot.observations.pr.value, state: 'MERGED' },
  }, passSnapshot);
  return shared;
}
