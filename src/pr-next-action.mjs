// ── NXA-02: one shared next action per open PR ───────────────────────────────
//
// `nextAction(snapshot)` is pure and total. It reads one frozen NXA-01 pass
// snapshot (src/merge-agent-candidate-snapshot.mjs) and returns exactly one
// owned decision. It reads no clock, environment, file, process or network:
// every time comes from the snapshot's observation clock and durable anchors.
//
// A decision is ownership, never merge authority. Every executor still runs the
// live exact-head eligibility predicate, provenance/HCP checks, required checks,
// protection policy and lease CAS before any mutation. Repair admission (a red
// or DIRTY head needing a hammer) is not merge permission.
//
// Until an authorized rollout switches a caller, `decideClosureOwner`
// (src/ama/closure-owner.mjs, frozen v1) keeps authority. This module is its
// successor policy owner: `fromLegacyClosureOwner` (src/pr-next-action-consumer.mjs)
// expresses every legacy owner/reason in this vocabulary so the shadow
// (src/pr-next-action-shadow.mjs) compares one table against the other. docs/NEXT-ACTION-REASON-INVENTORY.md
// maps legacy reasons to rows; it is design documentation, not a registry.
import { createHash } from 'node:crypto';
import { classifyCheckRollup } from './checks-summary.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
import { isDaemonMergeReviewAllowed } from './ama/daemon-merge.mjs';
import { launchRequestOwned, withLiveLaunchRetry } from './ama/launch-request-status.mjs';
import { AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS, AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS } from './ama/closer-lease.mjs';
import { OPERATOR_HOLD_LABELS } from './operator-hold-labels.mjs';

export const NEXT_ACTIONS = Object.freeze([
  'wait-for-CI', 'review', 'remediate', 'hammer', 'daemon-merge', 'operator-hold', 'done',
]);
export const NEXT_ACTION_ACTORS = Object.freeze([
  'ci', 'watcher', 'reviewer', 'remediator', 'hammer', 'daemon', 'closure-recovery', 'operator', 'none',
]);

// Proposed deadline targets (spec). The observer bound is the legacy pending-gate
// bound and the live-owner windows are the closer-lease reclaim ages, unscaled:
// the executing paths keep their own load-aware bounds. Deadlines report; they
// never refuse work.
export const NEXT_ACTION_DEADLINE_MS = Object.freeze({
  refresh: 60_000,
  admission: 5 * 60_000,
  recovery: 5 * 60_000,
  observer: AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS,
  livePending: AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS,
  liveDispatched: AMA_CLOSER_DISPATCHED_LEASE_RECLAIM_AGE_MS,
});

const AUTOMATION_ACTOR_KINDS = new Set(['automation', 'bot', 'app', 'watcher', 'hammer']);
const SEMANTIC_PROOF_KINDS = new Set(['context-only-rebase']);

const text = value => (typeof value === 'string' ? value.trim() : '');
const upper = value => text(value).toUpperCase();
const lower = value => text(value).toLowerCase();
const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const sameHead = (left, right) => Boolean(text(left) && text(right) && text(left) === text(right));

function observation(snapshot, name) {
  const raw = plain(snapshot?.observations?.[name]);
  const declared = ['complete', 'unknown', 'error'].includes(raw?.state) ? raw.state : 'unknown';
  const value = declared === 'complete' ? plain(raw.value) : null;
  return {
    name,
    // A "complete" observation without an object value is unusable evidence.
    state: declared === 'complete' && !value ? 'unknown' : declared,
    value,
    sourceRef: text(raw?.provenance?.sourceRef) || null,
  };
}

function timeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function normalizeLabels(...candidates) {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.map((label) => {
      if (typeof label === 'string') return { name: lower(label), actorKind: null };
      const entry = plain(label) || {};
      const kind = lower(entry.actorKind ?? entry.actor_kind ?? entry.appliedBy?.kind ?? entry.actor?.type);
      return { name: lower(entry.name), actorKind: kind || null };
    }).filter(label => label.name);
  }
  return null;
}

function checksFacts(checks) {
  const value = checks.value || {};
  const runnerless = Array.isArray(value.runnerless) ? value.runnerless.length > 0 : false;
  let conclusion = upper(value.conclusion) || null;
  if (!conclusion && checks.state === 'complete') {
    const rollup = Array.isArray(value.rollup) ? value.rollup
      : Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : null;
    const requiredContexts = Array.isArray(value.requiredContexts) ? value.requiredContexts
      : Array.isArray(value.branchProtection?.requiredContexts) ? value.branchProtection.requiredContexts : [];
    // One CI classifier (CIDEDUPE-01). An empty rollup fails closed as pending.
    conclusion = rollup ? (classifyCheckRollup(rollup, { requiredContexts,
      excludeContexts: Array.isArray(value.excludeContexts) ? value.excludeContexts : null }) || 'PENDING') : null;
  }
  const state = runnerless ? 'FAILURE'
    : !conclusion ? 'UNKNOWN'
      : conclusion === 'SUCCESS' || conclusion === 'PENDING' ? conclusion : 'FAILURE';
  const rows = Array.isArray(value.rollup) ? value.rollup
    : Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup : [];
  const transitions = rows.flatMap(row => [row?.startedAt, row?.completedAt].map(timeMs)).filter(ms => ms !== null);
  return { state, runnerless, conclusion, progressMs: transitions.length ? Math.max(...transitions) : null };
}

function reviewFacts(reviews, head, policy) {
  const value = reviews.value || {};
  // Normalized review state carries `verdict`; a raw review row carries only the
  // reviewed head and posting status, so its verdict remains unknown.
  const normalized = typeof value.verdict === 'string' || value.verdict === null;
  const reviewedHead = text(value.headSha) || text(value.reviewedHeadSha) || text(value.reviewer_head_sha) || null;
  const verdict = normalized ? lower(value.verdict) || null : null;
  const strictMode = policy?.strictMode !== false;
  const attestation = ['valid', 'invalid', 'unknown'].includes(lower(value.attestation)) ? lower(value.attestation) : null;
  return {
    known: reviews.state === 'complete',
    normalized,
    reviewedHead,
    verdict,
    // A readable review state proves absence of a current-head verdict only
    // when it names a different reviewed head or carries no verdict at all.
    currentHeadVerdictAbsent: reviews.state === 'complete'
      && (normalized ? !verdict || !sameHead(reviewedHead, head) : !sameHead(reviewedHead, head)),
    clean: Boolean(verdict && SETTLED_SUCCESS_VERDICTS.has(verdict) && isDaemonMergeReviewAllowed(value, { strictMode })),
    attestation,
    live: value.reviewerLive === true,
    suppressedFinalPush: value.commentOnlyFinalRoundPush === true,
    postedMs: timeMs(value.postedAt ?? value.posted_at),
  };
}

function remediationFacts(remediation) {
  const value = remediation.value || {};
  const job = plain(value.job) || (Object.hasOwn(value, 'status') ? value : null);
  const plan = plain(job?.remediationPlan);
  const completed = finite(value.completedRounds) ?? finite(plan?.currentRound);
  const max = finite(value.maxRounds) ?? finite(plan?.maxRounds);
  const roundsLeft = typeof value.roundsLeft === 'boolean' ? value.roundsLeft
    : completed !== null && max !== null ? completed < max : null;
  const finalPush = plain(value.finalPush);
  return {
    known: remediation.state === 'complete',
    roundsLeft: remediation.state === 'complete' ? roundsLeft : null,
    nextRound: completed !== null ? completed + 1 : null,
    jobStatus: lower(job?.status) || null,
    jobClean: job?.clean === true,
    jobHead: text(job?.headSha) || null,
    jobDeadlineMs: timeMs(job?.deadlineAt ?? job?.heartbeatDeadlineAt),
    finalPush: finalPush && finalPush.suppressed === true ? { headSha: text(finalPush.headSha) || null } : null,
  };
}

function launchFacts(launches, head) {
  const value = launches.value || {};
  const closer = plain(value.closer);
  if (!closer) return { known: launches.state === 'complete', present: false, owned: null };
  const probe = plain(closer.probe) || { ok: true, row: plain(closer.row) || { status: closer.status },
    retryChain: Array.isArray(closer.retryChain) ? closer.retryChain : undefined,
    retryChainUnreadable: closer.retryChainUnreadable === true };
  const effective = withLiveLaunchRetry(probe);
  return {
    known: launches.state === 'complete',
    present: true,
    forHead: !text(closer.headSha) || sameHead(closer.headSha, head),
    // true: running or parked; false: terminal with readable descendants;
    // null: unknown. Unreadable retry descendants are unknown, never absence.
    owned: launchRequestOwned(probe),
    retryChainUnreadable: probe.retryChainUnreadable === true,
    outcome: lower(closer.outcome) || null,
    retryable: typeof closer.retryable === 'boolean' ? closer.retryable : null,
    attempt: finite(closer.attempt),
    launchRef: text(effective?.liveRetryLaunchRequestId) || text(closer.launchRequestId) || null,
    deadlineMs: timeMs(closer.deadlineAt ?? closer.heartbeatDeadlineAt),
  };
}

function leaseFacts(leases, head) {
  const value = leases.value || {};
  const lease = plain(value.closer);
  if (!lease) return { known: leases.state === 'complete', present: false };
  const status = lower(lease.status) || null;
  const atMs = timeMs(lease.updatedAt) ?? timeMs(lease.acquiredAt);
  const windowMs = status === 'pending' ? NEXT_ACTION_DEADLINE_MS.livePending
    : status === 'dispatched' ? NEXT_ACTION_DEADLINE_MS.liveDispatched : null;
  return {
    known: leases.state === 'complete',
    present: true,
    forHead: !text(lease.headSha) || sameHead(lease.headSha, head),
    status,
    lrqRef: text(lease.lrqId) || null,
    deadlineMs: timeMs(lease.deadlineAt) ?? (atMs !== null && windowMs !== null ? atMs + windowMs : null),
  };
}

function snapshotFacts(snapshot) {
  const sources = Object.fromEntries(['pr', 'candidate', 'checks', 'reviews', 'remediation', 'launches',
    'leases', 'controls', 'policy', 'progress', 'history'].map(name => [name, observation(snapshot, name)]));
  const prValue = sources.pr.value || {};
  const head = text(prValue.headRefOid) || text(prValue.headSha) || text(snapshot?.head) || null;
  const prState = upper(prValue.state);
  const policyValue = sources.policy.value || {};
  const controlsValue = sources.controls.value || {};
  const progressValue = sources.progress.value || {};
  const labels = normalizeLabels(controlsValue.labels, prValue.labels, sources.candidate.value?.labels);
  return {
    sources,
    head,
    observedMs: timeMs(snapshot?.observedAt),
    pr: {
      known: sources.pr.state === 'complete' && ['OPEN', 'MERGED', 'CLOSED'].includes(prState),
      merged: prState === 'MERGED',
      closed: prState === 'CLOSED',
      draft: prValue.isDraft === true,
      mergeable: upper(prValue.mergeable) || null,
      mergeState: upper(prValue.mergeStateStatus) || null,
    },
    labels,
    checks: checksFacts(sources.checks),
    review: reviewFacts(sources.reviews, head, policyValue),
    remediation: remediationFacts(sources.remediation),
    launch: launchFacts(sources.launches, head),
    lease: leaseFacts(sources.leases, head),
    policy: sources.policy.state === 'complete' ? policyValue : null,
    controls: sources.controls.state === 'complete' ? controlsValue : null,
    progress: sources.progress.state === 'complete' ? progressValue : null,
  };
}

// Durable anchors only: the latest progress/first-actionable evidence at or
// before the observation. Future stamps (clock skew) are ignored. Without a
// durable anchor the observation time is used and labelled non-durable.
function anchorFor(snapshot, facts, extraMs = []) {
  const anchors = plain(snapshot?.anchors) || {};
  const observed = facts.observedMs;
  const durable = [...Object.values(anchors).map(timeMs), ...extraMs]
    .filter(ms => ms !== null && (observed === null || ms <= observed));
  if (durable.length) return { ms: Math.max(...durable), source: 'durable' };
  return { ms: observed, source: observed === null ? 'none' : 'observed' };
}

function deadline(snapshot, facts, kind, { atMs = null, extraMs = [] } = {}) {
  if (kind === null) return null;
  const anchor = anchorFor(snapshot, facts, extraMs);
  const budgetMs = NEXT_ACTION_DEADLINE_MS[kind] ?? null;
  const at = atMs ?? (anchor.ms !== null && budgetMs !== null ? anchor.ms + budgetMs : null);
  return Object.freeze({ at: iso(at), anchoredAt: iso(anchor.ms), anchorSource: atMs !== null ? 'owner' : anchor.source,
    class: kind, budgetMs });
}

function evidenceRefs(facts, extra = []) {
  const refs = Object.values(facts.sources).map(source =>
    `${source.name}:${source.state}${source.sourceRef ? `:${source.sourceRef}` : ''}`);
  return Object.freeze([...refs, ...extra.filter(Boolean)]);
}

function decisionKey(snapshot, fields) {
  return createHash('sha256').update(JSON.stringify([text(snapshot?.subjectKey) || null, fields.head,
    fields.action, fields.actor, fields.reason, fields.round ?? null, fields.attempt ?? null,
    fields.deadline?.anchoredAt ?? null])).digest('hex').slice(0, 32);
}

// Rows in policy order. Each returns a partial decision or null. A row whose
// guard evidence is unknown never falls through to a later, more permissive row;
// it returns the owned snapshot refresh instead.
const DISPATCH_ACTORS = new Set(['reviewer', 'remediator', 'hammer']);

function selectRow(facts) {
  const { pr, review, remediation, launch, lease, checks, policy, controls, progress, head } = facts;
  const refresh = (reason, refs = []) => ({ row: 'R16-refresh', action: 'wait-for-CI', actor: 'watcher', reason,
    deadlineKind: 'refresh', queue: 'observe', refs });

  // R00: nothing below is decidable without the PR's state and head.
  if (!pr.known || !head) return refresh('pr-unknown');
  // R01: only confirmed merged/closed PRs are done.
  if (pr.merged || pr.closed) {
    return { row: 'R01-terminal', action: 'done', actor: 'none', reason: pr.merged ? 'merged' : 'closed',
      deadlineKind: null, queue: 'none' };
  }
  // R02: explicit hold, draft or disabled-policy intent. Hold labels with
  // automation provenance are automatic stops (R07), not operator intent.
  const holdLabels = (facts.labels || []).filter(label => OPERATOR_HOLD_LABELS.includes(label.name));
  const explicitHold = holdLabels.find(label => !AUTOMATION_ACTOR_KINDS.has(label.actorKind));
  if (explicitHold) {
    return { row: 'R02-hold', action: 'operator-hold', actor: 'operator', reason: 'hold-label', deadlineKind: null,
      queue: 'none', refs: [`label:${explicitHold.name}:${explicitHold.actorKind || 'provenance-unknown'}`] };
  }
  if (pr.draft) return { row: 'R02-hold', action: 'operator-hold', actor: 'operator', reason: 'draft', deadlineKind: null, queue: 'none' };
  if (policy?.autonomousMergeExecutionEnabled === false) {
    return { row: 'R02-hold', action: 'operator-hold', actor: 'operator', reason: 'merge-execution-disabled',
      deadlineKind: null, queue: 'none' };
  }

  // R03: a proven live owner keeps the PR until its own deadline. Terminal
  // launch evidence outranks a stale lease or worker projection.
  const leaseRef = `lease:${lease.status || 'unknown'}:${lease.lrqRef || 'unassigned'}`;
  const leaseForHead = lease.present && lease.forHead;
  const leaseInFlight = leaseForHead && ['pending', 'dispatched'].includes(lease.status);
  const launchForHead = launch.present && launch.forHead;
  if (launchForHead && launch.owned === true) {
    return { row: 'R03-live-owner', action: 'hammer', actor: 'hammer', reason: 'live-owner', deadlineKind: 'liveDispatched',
      deadlineAtMs: launch.deadlineMs ?? lease.deadlineMs, queue: 'owned', refs: [`launch:${launch.launchRef || 'unidentified'}`] };
  }
  if (remediation.jobStatus === 'in_progress' && (!remediation.jobHead || sameHead(remediation.jobHead, head))) {
    return { row: 'R03-live-owner', action: 'remediate', actor: 'remediator', reason: 'live-owner', deadlineKind: 'liveDispatched',
      deadlineAtMs: remediation.jobDeadlineMs, queue: 'owned', round: remediation.nextRound };
  }
  if (review.live) {
    return { row: 'R03-live-owner', action: 'review', actor: 'reviewer', reason: 'live-owner', deadlineKind: 'liveDispatched', queue: 'owned' };
  }
  // R04: ownership reconciliation. Unreadable lease/launch evidence never
  // licenses a speculative launch; the recovery owner re-reads it. A launch
  // needs this head's lease, so with no lease an unreadable ledger owns nothing.
  const reconcile = (reason, refs) => ({ row: 'R04-ownership', action: 'hammer', actor: 'closure-recovery', reason,
    deadlineKind: 'recovery', queue: 'reconcile', refs });
  if (!lease.known) return reconcile('ownership-unreadable', ['lease:unreadable']);
  const leaseReferencesLaunch = leaseForHead && lease.lrqRef && ['pending', 'dispatched', 'terminal'].includes(lease.status);
  if ((launchForHead && launch.owned === null) || (leaseReferencesLaunch && !launch.known)) {
    return reconcile('ownership-unreadable', [leaseRef, launch.retryChainUnreadable ? 'launch:retry-chain-unreadable' : 'launch:unreadable']);
  }
  if (leaseInFlight && !(launchForHead && launch.owned === false)) {
    // In flight with no recorded launch: live until the lease window lapses.
    if (lease.deadlineMs !== null && facts.observedMs !== null && facts.observedMs < lease.deadlineMs) {
      return { row: 'R03-live-owner', action: 'hammer', actor: 'hammer', reason: 'live-owner',
        deadlineKind: lease.status === 'pending' ? 'livePending' : 'liveDispatched', deadlineAtMs: lease.deadlineMs,
        queue: 'owned', refs: [leaseRef] };
    }
    return reconcile('lease-expired', [leaseRef]);
  }

  // Keep established owners and ownership reconciliation above. New work
  // requires a readable execution switch; absence is not implicit enablement.
  if (policy?.autonomousMergeExecutionEnabled !== true) return refresh('policy-unknown');

  // R05: existing structural restriction recovery (empty-diff closure and the
  // primary-change preservation gate) and deterministic safety refusals.
  if (progress?.diffEmpty === true) {
    return { row: 'R05-structural', action: 'hammer', actor: 'closure-recovery', reason: 'empty-diff-close',
      deadlineKind: 'recovery', queue: 'reconcile' };
  }
  const primary = plain(progress?.primaryChange);
  if (primary && primary.ok === false) {
    const primaryReason = text(primary.reason) || 'primary-change-unknown';
    const refs = [`primary-change:${primaryReason}`];
    if (['primary-change-read-failed', 'history-read-failed'].includes(primaryReason)) {
      return { row: 'R05-structural', action: 'hammer', actor: 'closure-recovery', reason: 'primary-change-unreadable',
        deadlineKind: 'recovery', queue: 'reconcile', refs };
    }
    if (['primary-change-reverted', 'primary-change-unknown'].includes(primaryReason)) {
      return { row: 'R05-structural', action: 'hammer', actor: 'hammer', reason: 'primary-change-repair',
        deadlineKind: 'admission', queue: 'dispatch', refs };
    }
    return refresh('structural-restriction-pending', refs);
  }
  const refusal = plain(controls?.safetyRefusal);
  if (refusal && refusal.deterministic === true) {
    return { row: 'R05-structural', action: 'hammer', actor: 'closure-recovery', reason: 'safety-refusal',
      deadlineKind: 'recovery', queue: 'reconcile', refs: [`refusal:${text(refusal.reason) || 'unnamed'}`] };
  }

  // R06: a merge receipt is not a merge. Only the remote PR state confirms it.
  const receipt = plain(progress?.mergeReceipt);
  if (receipt && receipt.merged === true && (!text(receipt.headSha) || sameHead(receipt.headSha, head))) {
    return { row: 'R06-merge-receipt', action: lower(receipt.path) === 'daemon-merge' ? 'daemon-merge' : 'hammer',
      actor: 'closure-recovery', reason: 'merge-receipt-unconfirmed', deadlineKind: 'recovery', queue: 'reconcile',
      refs: [`receipt:${lower(receipt.path) || 'unknown-path'}`] };
  }

  // R07: deterministic automatic stops and existing retry exhaustion keep a
  // recovery owner. Real caps stay real: no relaunch is queued here.
  const stop = plain(controls?.stop);
  const automatedHold = (facts.labels || []).find(label => OPERATOR_HOLD_LABELS.includes(label.name));
  if ((stop && stop.deterministic === true) || automatedHold) {
    return { row: 'R07-stop', action: 'hammer', actor: 'closure-recovery', reason: 'automated-stop',
      deadlineKind: 'recovery', queue: 'reconcile',
      refs: [stop ? `stop:${text(stop.fingerprint) || 'unfingerprinted'}` : `label:${automatedHold.name}:automation`] };
  }
  const cap = plain(policy?.hammerCap);
  if (cap?.lifetimeExhausted === true || (cap?.retryExhausted === true && (!text(cap.headSha) || sameHead(cap.headSha, head)))) {
    return { row: 'R07-stop', action: 'hammer', actor: 'closure-recovery',
      reason: cap.lifetimeExhausted === true ? 'lifetime-exhausted' : 'retry-exhausted', deadlineKind: 'recovery', queue: 'reconcile' };
  }
  if (launchForHead && launch.owned === false && launch.outcome === 'no-merge' && launch.retryable === false) {
    // The hammer's final adjudication on this head; a new head is new work.
    return { row: 'R07-stop', action: 'hammer', actor: 'closure-recovery', reason: 'hammer-final-no-merge',
      deadlineKind: 'recovery', queue: 'reconcile', attempt: launch.attempt };
  }
  // R08: terminal no-merge with retry remaining (exit zero is not merged).
  if (launchForHead && launch.owned === false && launch.outcome === 'no-merge' && launch.retryable === true) {
    return { row: 'R08-retry', action: 'hammer', actor: 'hammer', reason: 'retry-no-merge', deadlineKind: 'admission',
      queue: 'dispatch', attempt: launch.attempt !== null ? launch.attempt + 1 : null };
  }

  // R09: failed CI goes to a remaining remediation round or the final hammer.
  if (checks.state === 'FAILURE') {
    if (checks.runnerless) {
      return { row: 'R09-ci-red', action: 'hammer', actor: 'hammer', reason: 'ci-runnerless', deadlineKind: 'admission', queue: 'dispatch' };
    }
    if (remediation.roundsLeft === null) return refresh('rounds-unknown', ['checks:failure']);
    return remediation.roundsLeft
      ? { row: 'R09-ci-red', action: 'remediate', actor: 'remediator', reason: 'ci-red', deadlineKind: 'admission',
        queue: 'dispatch', round: remediation.nextRound }
      : { row: 'R09-ci-red', action: 'hammer', actor: 'hammer', reason: 'ci-red-final', deadlineKind: 'admission', queue: 'dispatch' };
  }
  // R10: confirmed conflict or DIRTY needs a rebase owner.
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') {
    return { row: 'R10-conflict', action: 'hammer', actor: 'hammer', reason: 'conflict-rebase', deadlineKind: 'admission', queue: 'dispatch' };
  }
  // R11: pending checks or uncomputed mergeability go to the bounded observer.
  if (checks.state === 'PENDING' || pr.mergeable === 'UNKNOWN') {
    return { row: 'R11-pending', action: 'wait-for-CI', actor: 'ci',
      reason: checks.state === 'PENDING' ? 'checks-pending' : 'mergeability-unknown', deadlineKind: 'observer', queue: 'observe',
      extraAnchorMs: [checks.progressMs] };
  }
  // R12: a proven, suppressed final-round push is owned by the final hammer.
  if (review.suppressedFinalPush || (remediation.finalPush && sameHead(remediation.finalPush.headSha, head))) {
    return { row: 'R12-final-push', action: 'hammer', actor: 'hammer', reason: 'suppressed-final-push',
      deadlineKind: 'admission', queue: 'dispatch' };
  }

  // R13: an unproven head gets an exact-head review. Context-only rebase proof
  // must be semantic; ancestry, inherited trailers or ticket ownership are not.
  if (!review.known) return refresh('reviews-unknown');
  const proof = plain(progress?.contentProof);
  // HAMATTEST-02 closer carry is accepted only for this exact head pair.
  const closerCarry = plain(progress?.closerAuthoredStale);
  const closerPair = Boolean(closerCarry && sameHead(closerCarry.currentHead, head)
    && sameHead(closerCarry.reviewedHead, review.reviewedHead));
  const handedToReview = leaseForHead && lease.status === 'handed-to-review';
  const carryable = review.currentHeadVerdictAbsent && Boolean(review.verdict);
  const semanticCarry = carryable && Boolean(proof && SEMANTIC_PROOF_KINDS.has(lower(proof.kind))
    && proof.semantic === true && sameHead(proof.fromHead, review.reviewedHead) && sameHead(proof.toHead, head));
  const attestedCarry = carryable && closerPair && closerCarry.carryForward === true
    && closerCarry.decision !== 'rereview-exact-head' && !handedToReview;
  const carried = semanticCarry || attestedCarry;
  if (review.attestation === 'invalid') {
    return { row: 'R13-review', action: 'review', actor: 'reviewer', reason: 'attestation-invalid', deadlineKind: 'admission', queue: 'dispatch' };
  }
  if (closerPair && closerCarry.decision === 'rereview-exact-head') {
    return { row: 'R13-review', action: 'review', actor: 'reviewer', reason: 'exact-head-review', deadlineKind: 'admission', queue: 'dispatch' };
  }
  if (review.currentHeadVerdictAbsent && !carried) {
    if (policy?.reviewCeilingReached === true && !handedToReview) {
      return { row: 'R13-review', action: 'hammer', actor: 'hammer', reason: 'review-ceiling', deadlineKind: 'admission', queue: 'dispatch' };
    }
    return { row: 'R13-review', action: 'review', actor: 'reviewer',
      reason: handedToReview ? 'handed-to-review' : review.reviewedHead && review.verdict ? 'stale-verdict' : 'exact-head-review',
      deadlineKind: 'admission', queue: 'dispatch' };
  }
  if (!review.verdict) return refresh('verdict-unknown');

  // R14: findings go to a remaining remediation round or the final hammer.
  if (!review.clean) {
    if (handedToReview || attestedCarry) {
      return { row: 'R14-findings', action: 'hammer', actor: 'hammer', reason: 'review-findings-final', deadlineKind: 'admission', queue: 'dispatch' };
    }
    if (remediation.roundsLeft === null) return refresh('rounds-unknown');
    return remediation.roundsLeft
      ? { row: 'R14-findings', action: 'remediate', actor: 'remediator', reason: 'review-findings', deadlineKind: 'admission',
        queue: 'dispatch', round: remediation.nextRound }
      : { row: 'R14-findings', action: 'hammer', actor: 'hammer', reason: 'review-findings-final', deadlineKind: 'admission', queue: 'dispatch' };
  }
  // R15: a valid clean (or carried terminal-head) review on a green, mergeable
  // head is the daemon's. Execution still re-proves every merge predicate.
  if (checks.state === 'SUCCESS' && pr.mergeable === 'MERGEABLE' && review.attestation !== 'unknown') {
    return { row: 'R15-daemon', action: 'daemon-merge', actor: 'daemon', reason: carried ? 'carried-clean-head' : 'clean-exact-head',
      deadlineKind: 'admission', queue: 'daemon' };
  }
  // R16: every other combination is an owned snapshot refresh.
  return refresh(checks.state === 'UNKNOWN' ? 'checks-unknown' : review.attestation === 'unknown' ? 'attestation-unknown' : 'snapshot-refresh');
}

// Drain and capacity apply once, after semantic selection, and only to a new
// unowned agent dispatch. Drain wins over capacity. The decision keeps its
// action, actor, reason and queue intent; only the deferral is recorded.
function constraintFor(facts, selected) {
  if (selected.queue !== 'dispatch' || !DISPATCH_ACTORS.has(selected.actor)) return null;
  const drain = plain(facts.policy?.drain);
  if (drain?.active === true) return { by: 'drain', ref: `drain:${text(String(drain.epoch ?? '')) || 'epoch-unknown'}` };
  const capacity = plain(plain(facts.policy?.capacity)?.[selected.actor]);
  const inFlight = finite(capacity?.inFlight);
  const capLimit = finite(capacity?.cap);
  if (inFlight !== null && capLimit !== null && inFlight >= capLimit) {
    return { by: 'capacity', ref: `capacity:${text(capacity.workerClass) || selected.actor}:${inFlight}/${capLimit}` };
  }
  return null;
}

/**
 * The shared decision contract.
 * @param {object} snapshot frozen NXA-01 pass snapshot
 * @returns {Readonly<{action:string, actor:string, reason:string, deadline:object|null, head:string|null,
 *   round?:number|null, evidenceRefs:string[], decisionKey:string, row:string,
 *   queue:{intent:string, deferredBy:string|null}, generation:number|null, passId:string|null}>}
 */
export function nextAction(snapshot) {
  let facts;
  let selected;
  try {
    facts = snapshotFacts(snapshot);
    selected = selectRow(facts);
  } catch {
    // Totality: malformed evidence is an owned refresh, never an exception.
    facts = snapshotFacts(null);
    selected = { row: 'R16-refresh', action: 'wait-for-CI', actor: 'watcher', reason: 'snapshot-malformed',
      deadlineKind: 'refresh', queue: 'observe' };
  }
  const constraint = constraintFor(facts, selected);
  const decided = {
    action: selected.action,
    actor: selected.actor,
    reason: selected.reason,
    deadline: deadline(snapshot, facts, selected.deadlineKind, {
      atMs: selected.deadlineAtMs ?? null, extraMs: (selected.extraAnchorMs || []).filter(ms => ms !== null) }),
    head: facts.head,
    ...(selected.round !== undefined ? { round: selected.round } : {}),
    attempt: selected.attempt ?? null,
  };
  return Object.freeze({
    ...decided,
    evidenceRefs: evidenceRefs(facts, [...(selected.refs || []), constraint?.ref]),
    decisionKey: decisionKey(snapshot, decided),
    row: selected.row,
    queue: Object.freeze({ intent: selected.queue, deferredBy: constraint?.by ?? null }),
    generation: finite(snapshot?.generation),
    passId: text(snapshot?.passId) || null,
  });
}

// ── Snapshot derivation for consumers that already read their evidence ──────
// Same observation format as the NXA-01 collector, built synchronously from
// values the consumer already holds (no new reads). When the consumer has the
// pass snapshot, its passId/generation/anchors/observedAt and every observation
// the consumer does not supply are kept, so all consumers in a pass share it.
export const SHADOW_SOURCE_REF = 'consumer-evidence';

function freezeDeep(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? undefined : value;
  }
  if (seen.has(value)) return undefined;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  seen.add(value);
  const copy = Array.isArray(value) ? value.map(item => freezeDeep(item, seen)) : {};
  if (!Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value')) continue;
      const item = freezeDeep(descriptor.value, seen);
      if (item !== undefined) copy[key] = item;
    }
  }
  seen.delete(value);
  return Object.freeze(copy);
}

export function deriveNextActionSnapshot({ base = null, subjectKey = null, head = null, observedAt = null,
  anchors = null, observations = {} } = {}) {
  const baseObservations = plain(base?.observations) || {};
  const merged = { ...baseObservations };
  for (const [name, value] of Object.entries(observations || {})) {
    if (value === undefined) continue;
    merged[name] = value && typeof value === 'object' && ['complete', 'unknown', 'error'].includes(value.state) && Object.hasOwn(value, 'value')
      ? value
      : { state: value === null ? 'unknown' : 'complete', value, provenance: { sourceRef: SHADOW_SOURCE_REF } };
  }
  return freezeDeep({
    subjectKey: base?.subjectKey ?? subjectKey,
    head: text(head) || base?.head || null,
    passId: base?.passId ?? null,
    generation: base?.generation ?? null,
    observedAt: base?.observedAt ?? observedAt,
    derivedFrom: base ? { passId: base.passId ?? null, generation: base.generation ?? null } : null,
    anchors: { ...(plain(base?.anchors) || {}), ...(plain(anchors) || {}) },
    observations: merged,
  });
}

export const __testables__ = Object.freeze({ snapshotFacts, selectRow, anchorFor });
