// Closeout adapts observations to the shared policy. It never launches an agent
// or grants merge permission; the successor revalidates its own execution gates.
import { readAmaCloserLease } from './ama/closer-lease.mjs';
import { amaCloserDispatchFilePath } from './ama/dispatch-record-read.mjs';
import { readFileSync } from 'node:fs';
import { deriveNextActionSnapshot, nextAction } from './pr-next-action.mjs';
import { normalizeEffectiveReviewVerdict } from './kernel/verdict.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { loadDomainConfig } from './domain-config.mjs';
import { resolveMergeAuthorityConfigFromDomain } from './domain-policy.mjs';
import { join } from 'node:path';
import { remediationJobOwnership } from './remediation-job-ownership.mjs';

export function remediationCloseout({ rootDir, job, headSha, workerPushedHeadSha = null,
  lifecycle = null, ciGate = null, completedAt, snapshot = null }) {
  const plan = job.remediationPlan || {};
  const round = Number(plan.currentRound || 0);
  const max = Number(plan.maxRounds);
  const roundsLeft = job.finalRound === 'comment-only' ? false : Number.isFinite(max) ? round < max : null;
  const final = roundsLeft === false;
  const head = headSha || lifecycle?.headSha || job.revisionRef;
  let leases = snapshot?.observations?.leases;
  if (!leases) {
    try { leases = { closer: readAmaCloserLease(rootDir, { repo: job.repo, prNumber: job.prNumber, headSha: head }) }; }
    catch { leases = { state: 'error', value: null, provenance: { sourceRef: 'closer-lease' } }; }
  }
  const lease = leases.value?.closer || leases.closer;
  let launches = snapshot?.observations?.launches;
  let receipt = null;
  if (!launches || (launches.state === 'unknown' && !launches.provenance?.sourceRef)) {
    try {
      receipt = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, {
        repo: job.repo, prNumber: job.prNumber, headSha: lease?.rekeyedFromHeadSha || head }), 'utf8'));
      launches = { state: 'complete', provenance: { sourceRef: 'closer-dispatch-receipt' },
        value: { closer: lease?.status !== 'handed-to-review' && receipt?.launchRequestId
          ? { launchRequestId: receipt.launchRequestId, headSha: head, retryChainUnreadable: true,
            retryChainReadState: 'unresolved' } : null } };
    } catch (error) {
      launches = { state: error.code === 'ENOENT' ? 'complete' : 'error', value: { closer: null },
        provenance: { sourceRef: 'closer-dispatch-receipt' } };
      if (error.code !== 'ENOENT') leases = { state: 'error', value: null,
        provenance: { sourceRef: 'closer-dispatch-receipt' } };
    }
  }
  const findings = parseReviewFindings(job.reviewBody);
  const observedReviews = snapshot?.observations?.reviews;
  const reviews = observedReviews && (observedReviews.state !== 'unknown' || observedReviews.provenance?.sourceRef)
    ? observedReviews : { verdict: normalizeEffectiveReviewVerdict(job.reviewBody), headSha: job.revisionRef,
      blockingFindingState: findings.blocking.state, blockingFindingCount: findings.blocking.count,
      nonBlockingFindingState: findings.nonBlocking.state, nonBlockingFindingCount: findings.nonBlocking.count };
  let policy = snapshot?.observations?.policy;
  if (!policy) {
    try {
      const cfg = loadConfigCached({ modulePaths: [join(import.meta.dirname, '..', 'config.yaml')] });
      policy = resolveMergeAuthorityConfigFromDomain(loadDomainConfig(rootDir, job.domainId || 'code-pr'),
        cfg.getMergeAuthorityConfig(), { fallbackSources: cfg.sources || {} });
    } catch { policy = { state: 'error', value: null, provenance: { sourceRef: 'merge-authority-policy' } }; }
  }
  const checksValue = ciGate && ciGate.headSha === head
    ? { conclusion: ({ green: 'SUCCESS', failed: 'FAILURE', pending: 'PENDING' })[ciGate.state] || 'PENDING',
      ...(ciGate.infrastructureOnly ? { infrastructureOnly: true, failedChecks: ciGate.failedChecks } : {}),
      ...(ciGate.runnerless ? { runnerless: ciGate.runnerless } : {}) }
    : { conclusion: 'PENDING' };
  const checkReadState = ciGate?.headSha !== head ? 'unknown'
    : ['green', 'failed', 'pending'].includes(ciGate?.state) ? 'complete' : ciGate?.error ? 'error' : 'unknown';
  // Without a proven publish, failed CI still belongs to the active job's
  // existing retry path. Completing that owner here would strand legacy jobs
  // whose review head is missing before reconciliation can requeue them.
  const retryActiveJob = roundsLeft === true && job.status === 'in_progress'
    && workerPushedHeadSha !== head && checkReadState === 'complete' && ciGate.state === 'failed';
  // The normalized observer conclusion is pending, while the original read
  // state stays explicit in both the snapshot and the decision's evidence refs.
  const checks = { state: 'complete', value: checksValue,
    provenance: { sourceRef: `remediation-ci-regression:${checkReadState}`, readState: checkReadState } };
  const observedPr = snapshot?.observations?.pr;
  const pr = lifecycle || observedPr?.state === 'complete'
    ? { state: 'OPEN', ...observedPr?.value, headSha: head, headRefOid: head,
      ...(lifecycle?.prState ? { state: lifecycle.prState } : {}),
      ...Object.fromEntries(['labels', 'isDraft', 'mergeable', 'mergeStateStatus']
        .filter(key => lifecycle?.[key] !== undefined).map(key => [key, lifecycle[key]])) }
    : observedPr?.state === 'error' ? observedPr : { headSha: head, state: 'OPEN' };
  const derived = deriveNextActionSnapshot({ base: snapshot, subjectKey: `${job.repo}#${job.prNumber}`, head,
    observedAt: completedAt, anchors: { firstActionableAt: job.reReview?.nextAction?.deadline?.anchoredAt
      || job.ciRegressionGuard?.firstObservedAt || job.completedAt || completedAt }, observations: {
      // Recovery callers supply an authoritative head of an open PR. Ordinary
      // reconciliation has already applied its independent lifecycle stop gate.
      pr,
      reviews,
      remediation: { completedRounds: round, maxRounds: max, roundsLeft,
        job: { status: retryActiveJob ? 'in_progress' : 'completed', headSha: head,
          live: retryActiveJob && remediationJobOwnership(job, { now: completedAt }).live },
        ...(final && workerPushedHeadSha === head ? { finalPush: { headSha: head, suppressed: true } } : {}) },
      checks, leases, launches, policy,
      ...((lease?.terminalOutcome === 'succeeded' || receipt?.terminalOutcome === 'succeeded' || receipt?.outcome === 'succeeded')
        ? { progress: { ...snapshot?.observations?.progress?.value,
          mergeReceipt: { merged: true, headSha: head, path: 'hammer' } } } : {}),
      // Do not erase caller-owned policy, structural restrictions or launch
      // evidence. An unreadable descendant stays unknown in the shared table.
    } });
  const decision = nextAction(derived);
  return Object.freeze({ snapshot: derived, decision });
}

export function closeoutRereview(shared, reason = null) {
  const decision = shared.decision;
  // Register durable admission intent before completing a non-final job. The
  // watcher, rather than the terminal queue record, observes CI settlement:
  // green admits review; red requeues the remaining remediation round.
  // This queues intent only; reviewer-ci-admission still requires green CI.
  const awaitingCiAdmission = ((decision.action === 'wait-for-CI' && decision.actor === 'ci')
    || (decision.action === 'remediate' && decision.actor === 'remediator'))
    && shared.snapshot.observations.remediation.value.roundsLeft === true;
  const requested = (decision.action === 'review' && decision.queue.intent === 'dispatch') || awaitingCiAdmission;
  return { requested, requestedAt: shared.snapshot.observedAt,
    status: requested ? 'pending' : 'suppressed', reason,
    ...(!requested ? { suppressed: 'shared-next-action' } : {}), nextAction: decision };
}

// An existing state-machine refusal changes the evidence generation. Describe
// its recovery owner through the same table rather than leaving a queued-review
// claim in a completed/stopped record. This adds no refusal or retry authority.
export function refusedCloseout(shared, outcome) {
  const snapshot = deriveNextActionSnapshot({ base: { ...shared.snapshot,
    generation: Number(shared.snapshot.generation || 0) + 1 }, observations: {
    controls: { ...shared.snapshot.observations.controls?.value,
      stop: { deterministic: true, fingerprint: outcome?.reason || 'rereview-blocked' } },
    ...(outcome?.reviewRow?.review_status === 'reviewing'
      ? { reviews: { ...shared.snapshot.observations.reviews?.value, reviewerLive: true } } : {}),
  } });
  return Object.freeze({ snapshot, decision: nextAction(snapshot) });
}
