import { owesExhaustedHeadVerdict, hasUnreviewedBuilderHead } from './exhausted-head-verdict.mjs';
// ── NXA-02 consumer seam for the next-action shadow ──────────────────────────
//
// What the current closure consumers import: faithful legacy adapters, evidence
// builders, and a hook that copies a consumer's evidence synchronously and only
// then loads the shadow (src/pr-next-action-shadow.mjs) lazily. This module
// imports only the pure ceiling contract, so short-lived consumers do not pay
// for the full policy module until they reach a shadow call.
// Nothing here throws into a caller or changes a legacy decision.
import { isUnresolvedLaunchReference } from './launch-reference.mjs';
import { reviewCeilingOwner } from './review-ceiling-owner.mjs';
import { remediationJobOwnership } from './remediation-job-ownership.mjs';

// ── Legacy adapters: old outputs expressed as owned workflows ────────────────
// Faithful translation, not correction: a legacy page stays an operator hold
// here so the shadow surfaces where the new table assigns a recovery owner.
const text = value => (typeof value === 'string' ? value.trim() : '');
const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

const LEGACY_HAMMER_REASONS = Object.freeze({
  'ci-blocked-remediation-exhausted': 'ci-red-final',
  'required-checks-red': 'ci-red-final',
  'review-ceiling-stale-head': 'review-ceiling',
  'review-findings': 'review-findings-final',
  'conflict-rebase': 'conflict-rebase',
});
const LEGACY_PAGE_REASONS = Object.freeze({
  'hammer-retry-cap': 'retry-exhausted',
  'hammer-lifetime-cap': 'lifetime-exhausted',
  'primary-change-needs-operator': 'primary-change-repair',
  'in-flight-lease-expired': 'lease-expired',
  'pending-gate-budget-exhausted': 'checks-pending',
  'review-rounds-exhausted': 'review-findings-final',
});

export function fromLegacyClosureOwner(legacy) {
  const owner = text(legacy?.owner);
  const reason = text(legacy?.reason);
  const of = (action, actor, mapped) => Object.freeze({ action, actor, reason: mapped, legacyOwner: owner || null, legacyReason: reason || null });
  if (owner === 'daemon-merge') return of('daemon-merge', 'daemon', reason === 'daemon-merged' ? 'merged-this-pass' : 'clean-exact-head');
  if (owner === 'hammer') return of('hammer', 'hammer', reason === 'dispatched' || reason === 'ama-dispatched' ? 'live-owner'
    : LEGACY_HAMMER_REASONS[reason] || reason || 'hammer');
  if (owner === 'conflict-rebase') return of('hammer', 'hammer', 'conflict-rebase');
  if (owner === 'review') return of('review', 'reviewer', reason.startsWith('handed-to-review') ? 'handed-to-review' : 'exact-head-review');
  if (owner === 'remediation') return of('remediate', 'remediator', 'review-findings');
  if (owner === 'follow-up-drain') return of('remediate', 'remediator', 'clean-review-drain');
  if (owner === 'close') return of('hammer', 'closure-recovery', 'empty-diff-close');
  if (owner === 'wait') {
    if (reason === 'pending-required-checks') return of('wait-for-CI', 'ci', 'checks-pending');
    if (reason === 'pending-mergeability') return of('wait-for-CI', 'ci', 'mergeability-unknown');
    if (reason.startsWith('in-flight') || reason.startsWith('dispatch-status-')) return of('hammer', 'hammer', 'live-owner');
    if (reason.startsWith('handed-to-review')) return of('review', 'reviewer', 'handed-to-review');
    return of('wait-for-CI', 'watcher', 'snapshot-refresh');
  }
  if (owner === 'page') return of('operator-hold', 'operator', LEGACY_PAGE_REASONS[reason] || reason || 'page');
  return of('wait-for-CI', 'watcher', 'snapshot-refresh');
}

// Posted-review handler outcomes (coexistence and its early returns). Outcomes
// carrying the closure owner are compared at closure orchestration already;
// `includeClosureOwner` adapts them too for callers outside that funnel.
export function fromLegacyPostedReviewOutcome(result, { includeClosureOwner = true } = {}) {
  if (!plain(result)) return null;
  const of = (action, actor, reason) => Object.freeze({ action, actor, reason, legacyOwner: text(result.outcome) || 'posted-review',
    legacyReason: text(result.reason) || text(result.terminalReason) || null });
  if (result.prTerminal === true || result.outcome === 'pr-terminal') {
    return of('done', 'none', ['merged', 'closed'].includes(result.terminalReason) ? result.terminalReason : 'terminal-observed');
  }
  if (result.outcome === 'operator-skip-label') return of('operator-hold', 'operator', 'hold-label');
  if (result.outcome === 'await-operator') return of('operator-hold', 'operator', 'needs-operator');
  if (!includeClosureOwner) return null;
  if (result.outcome === 'ama-dispatched') return fromLegacyClosureOwner({ owner: 'hammer', reason: 'dispatched' });
  const owner = result.amaClosureResult?.closureOwner;
  return owner ? fromLegacyClosureOwner(owner) : null;
}

// The no-progress lane's only ownership claim is "operator decision required".
export function fromLegacyNoProgressLane(lane) {
  if (lane?.lane !== 'operator-blocked') return null;
  return Object.freeze({ action: 'operator-hold', actor: 'operator', reason: 'operator-decision-required',
    legacyOwner: 'no-progress-lane', legacyReason: lane.reason || null });
}

// The watcher's handed-to-review wake: its legacy effect is the bounded wait.
export const handoffWakeLegacy = headSha => fromLegacyClosureOwner({ owner: 'wait', reason: `handed-to-review:${headSha}` });

// ── Evidence builders (held values plus bounded worker identity probes) ─────
export const NEXT_ACTION_SHADOW_LAUNCH_READ_MS = 5_000;
const pick = (value, keys) => (value && typeof value === 'object'
  ? Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null);
const REVIEW_KEYS = ['verdict', 'headSha', 'riskClass', 'blockingFindingState', 'blockingFindingCount', 'nonBlockingFindingState',
  'nonBlockingFindingCount', 'remediationPending', 'postedAt', 'commentOnlyFinalRoundPush', 'attestation', 'operatorApprovedEvidence',
  'operatorLabelFindings'];
const LEASE_KEYS = ['status', 'lrqId', 'headSha', 'acquiredAt', 'updatedAt', 'terminalOutcome', 'deadlineAt'];

// NXA-01's ledger observation as the `launches` source. Any confirmed terminal
// launch on an open PR is a no-merge; the PR observation owns merge truth and
// selects done before inspecting launches. A stale lease cannot erase failure.
export function launchSource(observation, lease, cap) {
  if (observation?.state !== 'complete' || !observation.value) {
    return { state: observation?.state === 'error' ? 'error' : 'unknown', value: null,
      provenance: { sourceRef: 'launch-requests' } };
  }
  const value = observation.value;
  const terminalNoMerge = value.terminal === true;
  return { state: 'complete', provenance: { sourceRef: 'launch-requests' }, value: { closer: {
    row: value.launch, retryChain: value.retryChain ?? undefined, retryChainUnreadable: value.retryChainUnreadable === true,
    retryChainReadState: value.retryChainUnreadable === true ? 'failed' : 'complete',
    launchRequestId: value.liveRetryLaunchRequestId || value.launchRequestId || null, headSha: lease?.headSha ?? null,
    attempt: value.launch?.attempt ?? value.attempt ?? null,
    outcome: terminalNoMerge ? 'no-merge' : null,
    retryable: terminalNoMerge ? !(cap.retryExhausted || cap.lifetimeExhausted) : null,
  } } };
}

// Bounded NXA-01 ledger read. The seam loads lazily so the shadow can never
// break a consumer's module graph. Each SDK read shares the recovery deadline
// and abort signal; a failed read remains unreadable ownership evidence.
function boundedLaunchRead(rootDir, lease, cap) {
  return ({ signal = null, timeoutMs = NEXT_ACTION_SHADOW_LAUNCH_READ_MS } = {}) => {
    const controller = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    return import('./session-ledger-read-adapter.mjs')
      .then(({ readLaunchRequestObservationFromLedgerAsync: read }) => read({ rootDir, launchRequestId: lease.lrqId,
        timeoutMs, signal: readSignal }))
      .then(observation => (readSignal.aborted ? { state: 'unknown', value: null } : observation))
      .then(observation => launchSource(observation, lease, cap))
      .finally(() => clearTimeout(timer));
  };
}

export function snapshotLaunchReferenceRead(snapshot, rootDir) {
  const launches = snapshot?.observations?.launches;
  if (!rootDir || !isUnresolvedLaunchReference(launches)) return null;
  const closer = launches.value.closer;
  if (!closer.launchRequestId) return null;
  return boundedLaunchRead(rootDir, { lrqId: closer.launchRequestId, headSha: closer.headSha || snapshot.head },
    snapshot.observations.policy?.value?.hammerCap || {});
}

/**
 * Evidence a closure-owner consumer already holds, in snapshot observation
 * form. Values absent from `input` stay unknown. Raw primary-change evidence is
 * evaluated by the shadow with the shared pure helper, never here.
 */
export function closureOwnerShadowEvidence(input = {}, { subjectKey = null, candidate = null, labels, checksRollup,
  autonomousMergeExecutionEnabled, rootDir = null, observedAt = null, anchors = null } = {}) {
  const pr = candidate ? { headSha: candidate.headSha ?? null, state: candidate.prState ?? null,
    isDraft: candidate.isDraft === true, mergeable: candidate.mergeable ?? null,
    mergeStateStatus: candidate.mergeStateStatus ?? null, labels: Array.isArray(labels) ? labels : candidate.labels } : null;
  const head = input.currentHead || pr?.headSha || null;
  const lease = pick(input.lease, LEASE_KEYS);
  const launchRecord = input.launchRecord;
  const launchOwner = lease?.status === 'handed-to-review' ? null
    : lease?.lrqId && ['pending', 'dispatched', 'terminal'].includes(lease.status) ? lease
      : launchRecord?.launchRequestId ? { lrqId: launchRecord.launchRequestId, headSha: head } : null;
  const mergedReceipt = lease?.terminalOutcome === 'succeeded'
    || launchRecord?.terminalOutcome === 'succeeded' || launchRecord?.outcome === 'succeeded';
  const staleBuilderHead = hasUnreviewedBuilderHead({ ...input, currentHead: head });
  const exhaustedBuilderHead = owesExhaustedHeadVerdict({
    exhausted: input.reviewState?.reviewCycleExhausted === true,
    headSha: head, reviewedHeadSha: input.reviewState?.headSha,
    closerAuthored: !staleBuilderHead,
    deliveredReviews: input.deliveredReviews,
  });
  const cap = { headSha: staleBuilderHead ? input.reviewState.headSha : head, recordedAt: input.hammerCapRecordedAt ?? null, retryExhausted: input.retryExhausted === true, lifetimeExhausted: input.lifetimeExhausted === true,
    ...(input.operatorApprovalApplied === true ? { operatorApprovalApplied: true } : {}) };
  const explicitReview = input.closerAuthoredStale?.decision === 'rereview-exact-head'
    && head && input.reviewState?.headSha
    && input.closerAuthoredStale.currentHead === head
    && input.closerAuthoredStale.reviewedHead === input.reviewState.headSha;
  const closerAuthoredStale = !explicitReview && input.attested === true && input.reviewState?.headSha
    ? { decision: 'carry-forward', carryForward: true, reviewedHead: input.reviewState.headSha, currentHead: head }
    : pick(input.closerAuthoredStale, ['decision', 'carryForward', 'reviewedHead', 'currentHead']);
  const observations = {
    reviews: input.reviewState ? { ...pick(input.reviewState, REVIEW_KEYS), verdict: input.reviewState.verdict ?? null } : undefined,
    remediation: { roundsLeft: typeof input.roundsLeft === 'boolean' ? input.roundsLeft : null,
      ...(input.finalPush ? { finalPush: input.finalPush } : {}),
      ...(input.followUpJob !== undefined ? { job: input.followUpJob ? {
        ...pick(input.followUpJob, ['status', 'clean', 'headSha', 'createdAt']),
        live: remediationJobOwnership(input.followUpJob).live,
        headSha: input.followUpJob.headSha || input.followUpJob.revisionRef || null,
      } : null } : {}) },
    leases: input.lease === undefined ? undefined : { closer: lease },
    // A readable receipt proves a launch reference even when its lease is gone.
    // Until the ledger resolves it, descendant liveness is explicitly unknown.
    launches: launchOwner && rootDir ? { state: 'complete', value: { closer: {
      launchRequestId: launchOwner.lrqId, headSha: head, retryChainUnreadable: true, retryChainReadState: 'unresolved',
    } }, provenance: { sourceRef: lease === launchOwner ? 'closer-lease' : 'closer-dispatch-receipt' } }
      : launchRecord?.reason === 'ci-infrastructure-recovered' && launchRecord.recoveredLaunchRequestId
        ? { closer: null } : undefined,
    checks: input.checks === undefined && checksRollup === undefined ? undefined
      : { conclusion: input.checks ?? null, ...(Array.isArray(checksRollup) ? { rollup: checksRollup } : {}) },
    policy: { strictMode: input.strictMode !== false, strictNonBlockingRemediation: input.strictNonBlockingRemediation !== false,
      ...(input.operatorLogins ? { operatorLogins: input.operatorLogins } : {}),
      ...(input.operatorLabelActorEnforcement ? { operatorLabelActorEnforcement: input.operatorLabelActorEnforcement } : {}),
      exhaustedBuilderHead,
      reviewCeilingReached: reviewCeilingOwner({ row: input.reviewAdmissionRow, headSha: head,
        ...(typeof input.reviewCeilingReached === 'boolean' ? { ceilingReached: input.reviewCeilingReached } : {}) }) === 'hammer', hammerCap: cap,
      ...(typeof autonomousMergeExecutionEnabled === 'boolean' ? { autonomousMergeExecutionEnabled } : {}) },
    progress: { diffEmpty: input.diffEmpty === true,
      hammerResume: pick(input.hammerResume, ['headSha', 'attemptNumber']),
      ...((input.hammerHead || input.closerAuthoredStale?.hammerHead)
        ? { hammerHead: pick(input.hammerHead || input.closerAuthoredStale.hammerHead, ['headSha', 'reason']) } : {}), ...(closerAuthoredStale ? { closerAuthoredStale } : {}),
      ...(input.terminalReview ? { terminalReview: pick(input.terminalReview, ['validated', 'headSha', 'reviewedHeadSha']) } : {}),
      ...(mergedReceipt ? { mergeReceipt: { merged: true, headSha: head, path: 'hammer' } } : {}) },
    ...(input.hammerStop ? { controls: {
      stop: { deterministic: input.hammerStop.deterministic !== false, fingerprint: input.hammerStop.stopKey || input.hammerStop.predicate,
        headSha: input.hammerStop.headSha || head,
        recordedAt: input.hammerStop.recordedAt ?? input.hammerStop.recorded_at ?? null },
      ...(input.hammerStop.refusal ? { safetyRefusal: {
        deterministic: true, reason: input.hammerStop.predicate,
        headSha: input.hammerStop.headSha || head, refusal: input.hammerStop.refusal,
      } } : {}),
    } } : {}),
    ...(pr ? { pr: { ...pr, headSha: head, mergeable: input.mergeable ?? pr.mergeable } } : {}),
  };
  // A retained receipt can outlive its lease. Explicit review handoff stays
  // with review; historical hammer receipts cannot take it back.
  const readLaunches = launchOwner && rootDir
    ? boundedLaunchRead(rootDir, launchOwner, cap) : null;
  const primaryChangeInput = input.primaryChange ? { evidence: input.primaryChange, head,
    strictNonBlockingRemediation: input.strictNonBlockingRemediation !== false } : null;
  return { subjectKey, head, observedAt, anchors, observations, readLaunches, primaryChangeInput };
}

// The handoff wake: a non-terminal subject, its handoff lease and the raw
// review row (whose verdict stays unknown).
export function handoffWakeShadowEvidence({ subjectKey, headSha, isDraft = false, lease = null, reviewRow = null,
  observedAt = null } = {}) {
  return { subjectKey, head: headSha, observedAt, observations: {
    pr: { headSha, state: 'OPEN', isDraft: isDraft === true },
    leases: { closer: pick(lease, LEASE_KEYS) },
    reviews: reviewRow ? { reviewer_head_sha: reviewRow.reviewer_head_sha ?? null,
      review_status: reviewRow.review_status ?? null, posted_at: reviewRow.posted_at ?? null } : null,
  } };
}

// A pass key for consumers without an NXA-01 pass (the hammer-owner route):
// closure orchestration registers its decision under it.
export function createNextActionPassKey({ subjectKey, head, observedAt }) {
  return Object.freeze({ subjectKey, head: head || null, passId: null, generation: null, observedAt,
    anchors: Object.freeze({}), observations: Object.freeze({}) });
}

// ── Lazy hook ───────────────────────────────────────────────────────────────
let testSinkInstalled = false;
const pending = new Set();

export function markNextActionShadowTestSink(installed) { testSinkInstalled = Boolean(installed); }

// Plain-value copy taken before the caller resumes; functions and class
// instances other than Date are dropped, cycles are cut.
function copyPlain(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    return ['function', 'symbol', 'bigint'].includes(typeof value) ? undefined : value;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return undefined;
  if (Object.isFrozen(value)) return value;
  seen.add(value);
  let copy;
  if (Array.isArray(value)) copy = value.map(item => copyPlain(item, seen) ?? null);
  else {
    copy = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) continue;
      const item = copyPlain(descriptor.value, seen);
      if (item !== undefined) copy[key] = item;
    }
  }
  seen.delete(value);
  return copy;
}

function track(promise) {
  const settled = promise.catch(() => null);
  pending.add(settled);
  settled.finally(() => pending.delete(settled));
  return settled;
}

const inert = (sink, env) => !testSinkInstalled && !sink && Boolean(env?.NODE_TEST_CONTEXT);

/**
 * The consumer call. `legacy` and `evidence` may be thunks; both are evaluated
 * and copied here, synchronously, inside the guard. Returns a promise that
 * never rejects; callers use `void` and never await it for control flow.
 */
export function shadowNextActionLater({ legacy = null, evidence = null, env = process.env, sink = null, ...rest } = {}) {
  try {
    if (inert(sink, env)) return Promise.resolve(null);
    const legacyValue = copyPlain(typeof legacy === 'function' ? legacy() : legacy) ?? null;
    let evidenceValue = typeof evidence === 'function' ? evidence() : evidence;
    if (evidenceValue) {
      const { readLaunches = null, ...fields } = evidenceValue;
      evidenceValue = { ...copyPlain(fields), readLaunches };
    }
    return track(import('./pr-next-action-shadow.mjs').then(({ shadowNextAction }) =>
      shadowNextAction({ ...rest, env, sink, legacy: legacyValue, evidence: evidenceValue || null })));
  } catch {
    return Promise.resolve(null);
  }
}

export function noteNextActionLegacyLater({ source, subjectKey, head, legacy, env = process.env } = {}) {
  try {
    if (inert(null, env) || !subjectKey || !head) return;
    const legacyValue = copyPlain(typeof legacy === 'function' ? legacy() : legacy);
    if (!legacyValue) return;
    track(import('./pr-next-action-shadow.mjs').then(({ noteNextActionLegacy }) =>
      noteNextActionLegacy({ source, subjectKey, head, legacy: legacyValue, env })));
  } catch { /* observation only */ }
}

// Tests await every lazily started shadow before asserting on its records.
export async function settleNextActionShadowsForTesting() {
  while (pending.size) await Promise.all([...pending]);
}
